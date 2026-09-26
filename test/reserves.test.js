import { describe, expect, it, vi } from 'vitest';
import {
    CARD_FIELDS, RUN_LENGTH, STATE_RESERVE_TOKENS,
    cardText, createReserves, heaviestRun, loreBudget, loreReserve, systemPromptText,
} from '../src/prompt/reserves.js';
import { RAW_WINDOW, STEP } from '../src/pipeline/scheduler.js';
import { MAX_STATE_CHARS } from '../src/memory/state-schema.js';
import { createContext, makeCardFields, makeMessage, makePowerUser } from './mocks/sillytavern.js';
import { makeBook, makeWorldInfoModule } from './mocks/world-info.js';
import { mulberry32 } from './helpers/random.js';

/** The mock context's tokenizer: ~4 characters per token, monotonic in length. */
const tokens = (text) => Math.ceil(text.length / 4);
const sizeOf = async (text) => tokens(String(text ?? ''));

/**
 * Message sizes as the corpus has them (CLAUDE.md §3.13): a median around
 * 266-338 tokens, with heaviest 19-message runs of 5,970 (Elizabeth), 7,089
 * (Risa) and 7,968 (Esin). Synthetic content, real shape.
 */
function corpusMessages(count, seed = 1) {
    const random = mulberry32(seed);
    return Array.from({ length: count }, (_, i) => makeMessage({
        name: i % 2 === 0 ? 'Wren' : 'Aster',
        isUser: i % 2 === 0,
        mes: 'x'.repeat(Math.round((180 + random() * 420) * 4)),
    }));
}

describe('the heaviest run of messages', () => {
    it('is the widest the see-saw window ever gets', () => {
        // The turn before a step: RAW_WINDOW behind the threshold plus a step's
        // worth in front of it, less the message the step itself lands on.
        expect(RUN_LENGTH).toBe(RAW_WINDOW + STEP - 1);
        // The literal is deliberate and it is the reclaim's own number: 8/8 makes
        // the window swing between 8 and 15 messages, which is what takes the
        // reserve from 9,613 tokens to ~7,758 (docs/decisions.md D-0068). Moving
        // the width is allowed; moving it without noticing is not.
        expect(RUN_LENGTH).toBe(15);
    });

    it('finds the heaviest window, not the last one', () => {
        const chat = [10, 10, 900, 10, 10, 10, 10];
        expect(heaviestRun(chat, 3)).toBe(920);
    });

    it('is the whole chat while the chat is shorter than the window', () => {
        expect(heaviestRun([100, 200, 300], 19)).toBe(600);
        expect(heaviestRun([], 19)).toBe(0);
    });

    /**
     * The invariant the cap's stillness rests on: over a growing chat the number
     * can only rise, so it changes on the turn a heavier run is written and on no
     * other turn (docs/decisions.md D-0052).
     */
    it('never falls when a message is appended', () => {
        const random = mulberry32(0x5eed);
        const counts = [];
        let previous = 0;

        for (let i = 0; i < 400; i++) {
            counts.push(Math.floor(random() * 800));
            const run = heaviestRun(counts, 19);
            expect(run).toBeGreaterThanOrEqual(previous);
            previous = run;
        }
    });

    /** Deleting one can lower it — which raises the cap, and costs nothing. */
    it('can fall when a message is deleted', () => {
        const counts = [10, 10, 900, 10, 10];
        expect(heaviestRun(counts, 3)).toBe(920);
        expect(heaviestRun([...counts.slice(0, 2), ...counts.slice(3)], 3)).toBe(30);
    });

    it('treats a missing count as nothing rather than throwing', () => {
        expect(heaviestRun([10, undefined, Number.NaN, -5, 10], 5)).toBe(20);
        expect(heaviestRun(null, 5)).toBe(0);
    });
});

/** public/scripts/world-info.js:4736-4741. */
describe("ST's World Info budget", () => {
    it('is the configured share of the max prompt', () => {
        expect(loreBudget({ maxPromptTokens: 23_040, percent: 25, cap: 0 })).toBe(5_760);
    });

    it('is limited by the cap when one is set', () => {
        expect(loreBudget({ maxPromptTokens: 23_040, percent: 25, cap: 2_000 })).toBe(2_000);
        // A cap above the share does nothing, as ST's `budget > cap` test does.
        expect(loreBudget({ maxPromptTokens: 23_040, percent: 25, cap: 9_000 })).toBe(5_760);
    });

    it('is never zero, as ST\'s `|| 1` is not', () => {
        expect(loreBudget({ maxPromptTokens: 23_040, percent: 0, cap: 0 })).toBe(1);
        expect(loreBudget({ maxPromptTokens: 0, percent: 25, cap: 0 })).toBe(1);
        expect(loreBudget({ maxPromptTokens: undefined, percent: undefined, cap: undefined })).toBe(1);
    });
});

describe('what the lorebooks can cost', () => {
    const entry = (content, extra = {}) => ({ content, disable: false, ignoreBudget: false, ...extra });

    it('is nothing when there are no books', async () => {
        expect(await loreReserve({ entries: [], budget: 5_760, sizeOf }))
            .toEqual({ tokens: 0, bound: 'none' });
    });

    it('is the whole book while it fits under the budget', async () => {
        const entries = [entry('a'.repeat(400)), entry('b'.repeat(800))];

        expect(await loreReserve({ entries, budget: 5_760, sizeOf }))
            .toEqual({ tokens: 300, bound: 'books' });
    });

    it('is the budget when the books come to more', async () => {
        // Akane's shape: a book far larger than any budget could admit.
        const entries = Array.from({ length: 110, }, () => entry('c'.repeat(6_800)));

        expect(await loreReserve({ entries, budget: 5_760, sizeOf }))
            .toEqual({ tokens: 5_760, bound: 'budget' });
    });

    it('stops tokenizing once the budget is passed', async () => {
        const counted = vi.fn(sizeOf);
        const entries = Array.from({ length: 110 }, () => entry('c'.repeat(6_800)));

        await loreReserve({ entries, budget: 5_760, sizeOf: counted });

        // Four 1,700-token entries pass 5,760; the other 106 are never sized.
        expect(counted.mock.calls.length).toBeLessThan(10);
    });

    it('leaves disabled entries out, as the scan does', async () => {
        const entries = [entry('a'.repeat(400)), entry('b'.repeat(800), { disable: true })];

        expect(await loreReserve({ entries, budget: 5_760, sizeOf }))
            .toEqual({ tokens: 100, bound: 'books' });
    });

    it('says `none` when every entry in the books is disabled', async () => {
        const entries = [entry('a'.repeat(400), { disable: true })];

        expect(await loreReserve({ entries, budget: 5_760, sizeOf }))
            .toEqual({ tokens: 0, bound: 'none' });
    });

    /** `ignoreBudget` (world-info.js:5669) skips ST's budget check, so it is added on top. */
    it('adds an entry that ignores the budget on top of it', async () => {
        const entries = [
            ...Array.from({ length: 10 }, () => entry('c'.repeat(4_000))),
            entry('d'.repeat(800), { ignoreBudget: true }),
        ];

        expect(await loreReserve({ entries, budget: 5_760, sizeOf }))
            .toEqual({ tokens: 5_760 + 200, bound: 'budget' });
    });
});

/** public/script.js:4686-4696. */
describe("ST's system prompt", () => {
    const content = 'Write the next reply.';

    it('is the character\'s own when it has one and the preference is on', () => {
        expect(systemPromptText({
            powerUser: makePowerUser({ prefer_character_prompt: true, sysprompt: { enabled: true, content } }),
            cardSystem: 'A card prompt.',
            mainApi: 'textgenerationwebui',
        })).toBe('A card prompt.');
    });

    it('is the instruct system prompt when the card has none', () => {
        expect(systemPromptText({
            powerUser: makePowerUser({ prefer_character_prompt: true, sysprompt: { enabled: true, content } }),
            cardSystem: '',
            mainApi: 'textgenerationwebui',
        })).toBe(content);
    });

    it('is the instruct system prompt when the preference is off', () => {
        expect(systemPromptText({
            powerUser: makePowerUser({ prefer_character_prompt: false, sysprompt: { enabled: true, content } }),
            cardSystem: 'A card prompt.',
            mainApi: 'textgenerationwebui',
        })).toBe(content);
    });

    it('is nothing when the system prompt is off, or on chat completion', () => {
        const powerUser = makePowerUser({ sysprompt: { enabled: false, content } });
        expect(systemPromptText({ powerUser, cardSystem: 'A card prompt.', mainApi: 'textgenerationwebui' })).toBe('');
        expect(systemPromptText({ powerUser: makePowerUser(), cardSystem: 'x', mainApi: 'openai' })).toBe('');
        expect(systemPromptText({})).toBe('');
    });
});

describe('the card as one string', () => {
    it('is the fields ST puts in the story string, and the system prompt', () => {
        const fields = makeCardFields({
            description: 'A description.', personality: 'A personality.', scenario: 'A scenario.',
            persona: 'A persona.', mesExamples: 'Examples.', jailbreak: 'A post-history note.',
            charDepthPrompt: 'A depth prompt.',
        });

        expect(cardText(fields, 'A system prompt.')).toBe([
            'A system prompt.', 'A description.', 'A personality.', 'A scenario.',
            'A persona.', 'Examples.', 'A post-history note.', 'A depth prompt.',
        ].join('\n'));
    });

    it('leaves out what never reaches the prompt', () => {
        const fields = makeCardFields({
            description: 'A description.',
            version: '2.0', creatorNotes: 'Notes.', firstMessage: 'A greeting.',
            alternateGreetings: ['Another greeting.'],
        });

        expect(cardText(fields)).toBe('A description.');
        for (const skipped of ['version', 'creatorNotes', 'firstMessage', 'alternateGreetings']) {
            expect(CARD_FIELDS).not.toContain(skipped);
        }
    });

    it('is empty for an empty card, and survives a missing one', () => {
        expect(cardText(makeCardFields())).toBe('');
        expect(cardText(undefined)).toBe('');
    });
});

describe("the world state's reserve", () => {
    it('is the widest state the schema allows, not the current one', () => {
        // Derived from MAX_STATE_CHARS, so a schema change carries it (D-0043).
        expect(STATE_RESERVE_TOKENS).toBe(Math.ceil(MAX_STATE_CHARS / 4));
        expect(STATE_RESERVE_TOKENS).toBeGreaterThan(330);
    });
});

/** The glue: what it reads from ST, and what it does when a read fails. */
describe('reading the reserves off the chat', () => {
    function setup({ chat = corpusMessages(40), entries = makeBook(), settings, ...rest } = {}) {
        const context = createContext({ chat, ...rest });
        const worldInfo = makeWorldInfoModule({ entries, budget: 25 });
        const reserves = createReserves(() => context, {
            load: async () => worldInfo,
            settings: settings ? () => settings : null,
            scope: {},
        });
        return { context, worldInfo, reserves };
    }

    it('works every reserve out from the chat and the settings', async () => {
        const { reserves } = setup({
            cardFields: makeCardFields({ description: 'd'.repeat(8_000), mesExamples: 'e'.repeat(8_000) }),
        });

        const read = await reserves.read(23_040);

        expect(read.card).toBe(tokens('d'.repeat(8_000) + '\n' + 'e'.repeat(8_000)));
        expect(read.loreBound).toBe('books');
        expect(read.lore).toBeGreaterThan(0);
        // The budget itself, not just what the books weigh against it: the World
        // Info holder trims to this number at a rebuild (docs/decisions.md D-0069).
        expect(read.loreBudget).toBe(5_760);
        expect(read.window).toBeGreaterThan(0);
        expect(read.state).toBe(STATE_RESERVE_TOKENS);
    });

    /**
     * The whole point of deriving rather than measuring (docs/decisions.md
     * D-0033): the same chat gives the same answer however often it is asked, and
     * a fresh reader — a reload — gives the answer the old one had.
     */
    it('is a function of the chat, so a reload changes nothing', async () => {
        const { context, reserves } = setup();
        const first = await reserves.read(23_040);
        const again = await reserves.read(23_040);

        const fresh = createReserves(() => context, {
            load: async () => makeWorldInfoModule({ entries: makeBook(), budget: 25 }),
            scope: {},
        });

        expect(again).toEqual(first);
        expect(await fresh.read(23_040)).toEqual(first);
    });

    it('counts each distinct text once', async () => {
        const { context, reserves } = setup();
        const counting = vi.spyOn(context, 'getTokenCountAsync');

        await reserves.read(23_040);
        const first = counting.mock.calls.length;
        await reserves.read(23_040);

        expect(counting.mock.calls.length).toBe(first);
    });

    it('leaves hidden messages out, as ST leaves them out of coreChat', async () => {
        const chat = corpusMessages(40);
        const { reserves } = setup({ chat });
        const whole = await reserves.read(23_040);

        for (const message of chat.slice(20)) message.is_system = true;
        const { reserves: hidden } = setup({ chat });

        expect((await hidden.read(23_040)).window).toBeLessThanOrEqual(whole.window);
    });

    it('reserves nothing for the world state when it is off', async () => {
        const { reserves } = setup({ settings: { worldState: false } });

        expect((await reserves.read(23_040)).state).toBe(0);
    });

    it('reserves nothing for the world state while a WTracker is loaded', async () => {
        const context = createContext();
        const reserves = createReserves(() => context, {
            load: async () => makeWorldInfoModule({ entries: makeBook() }),
            settings: () => ({ worldState: true }),
            scope: { wtrackerliteGenerateInterceptor: () => {} },
        });

        expect((await reserves.read(23_040)).state).toBe(0);
    });

    /** CLAUDE.md §4.17 — a diagnostic that cannot be read must not break the turn. */
    it('gives up as a whole when the world-info import fails', async () => {
        const context = createContext();
        const reserves = createReserves(() => context, {
            load: async () => { throw new Error('no such module'); },
            scope: {},
        });

        expect(await reserves.read(23_040)).toBeNull();
    });

    it('gives up as a whole when the card cannot be read', async () => {
        const context = createContext();
        context.getCharacterCardFields = () => { throw new Error('no character'); };
        const reserves = createReserves(() => context, {
            load: async () => makeWorldInfoModule({ entries: makeBook() }),
            scope: {},
        });

        expect(await reserves.read(23_040)).toBeNull();
    });

    it('takes the widest window it is given, not its own default', async () => {
        const chat = corpusMessages(40);
        const { reserves } = setup({ chat });

        const narrow = await reserves.read(23_040, { runLength: 5 });
        const wide = await reserves.read(23_040, { runLength: 19 });

        expect(narrow.window).toBeLessThan(wide.window);
    });

    it('starts over on a new chat', async () => {
        const { reserves } = setup();
        await reserves.read(23_040);
        expect(reserves.cached).toBeGreaterThan(0);

        reserves.reset();
        expect(reserves.cached).toBe(0);
    });
});
