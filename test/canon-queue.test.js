import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { MAX_ATTEMPTS, createSummarizer } from '../src/pipeline/summarizer.js';
import { CANON_PROMPT } from '../src/memory/canon-strategy.js';
import { canonFor } from '../src/memory/canon.js';
import { readCanon, readIndex } from '../src/store/chat-store.js';
import { resetToasts } from '../src/util/log.js';
import { badCanonOutputs, createRequestService, deferred } from './mocks/llm.js';
import { cairnIndexStore } from './mocks/cairn.js';
import { createContext, makeChat as rawChat } from './mocks/sillytavern.js';

/** The store's readers, which `canonFor` takes rather than imports (memory/canon.js). */
const READERS = { readCanon, readIndex };

/**
 * A chat whose messages carry index records, because a pick's facts cite them and a
 * fact whose records are gone is dropped on read (memory/canon.js). Without them the
 * fold would report an empty canon however well the pick went.
 */
function makeChat(length) {
    const chat = rawChat(length);
    chat.forEach((message, index) => {
        message.extra.cairn = cairnIndexStore(message, `Matter ${index} was settled before the tide turned.`);
    });
    return chat;
}

/**
 * The queue's canon job (docs/decisions.md D-0071): last of the four kinds, one pick
 * at a time, and a failure that changes nothing at all.
 *
 * The pending pick is worked out in the assembler, so it comes in through `memory`
 * exactly as index.js wires it. These tests stand that getter in directly, which is
 * also how they say what a pick is *given* rather than how it is worked out —
 * test/compactor.test.js covers the working-out.
 */

const MEMORY = { id: 'memory-profile', name: 'GLM (memory)' };
const ROLEPLAY = { id: 'roleplay-profile', name: 'Local (roleplay)' };
const CLOCK = Date.parse('2026-09-17T09:00:00.000Z');

const MEANT = [
    { fact: 'Wren\'s brother drowned in the spring flood.', entities: ['Wren'], from: [1] },
    { fact: 'Aster promised to get Wren across the water before the feast day.', entities: ['Aster', 'Wren'], from: [4] },
];

const reply = (canon = MEANT) => JSON.stringify({ canon });

/** The index as the assembler hands it over: every valid record, oldest first. */
const indexed = (from, to) => Array.from({ length: to - from + 1 }, (_, i) => ({
    index: from + i,
    record: {
        kind: i % 2 ? 'major' : 'filler',
        who: ['Wren', 'Aster'],
        what: `Wren and Aster settled matter ${from + i} before the tide turned`,
        changed: '',
        because: '',
        background: '',
        line: `Matter ${from + i} was settled before the tide turned.`,
    },
}));

/**
 * A pending pick the way `assembler.pendingPass` reports one. `message` is the live
 * message the batch lands on — the newest record the pick read — and each record
 * carries its own message, because the rows are mapped back by identity.
 */
function pass(chat, { covers = [0, 3], slots = 8, due = true, writing = true } = {}) {
    return {
        due,
        reason: due ? 'no-canon' : 'covered',
        writing,
        covers,
        records: indexed(covers[0], covers[1]).map((entry) => ({ ...entry, message: chat[entry.index] })),
        slots,
        message: chat[covers[1]],
    };
}

function harness({ responses = [], chat, settings = {}, context: contextOptions = {}, memory, clock = () => CLOCK } = {}) {
    const service = createRequestService({ responses });
    const live = chat ?? makeChat(12);
    const context = createContext({
        chat: live,
        profiles: [MEMORY, ROLEPLAY],
        selectedProfile: ROLEPLAY.id,
        requestService: service,
        ...contextOptions,
    });
    const summarizer = createSummarizer(() => context, {
        // The world state off unless a test says otherwise: it runs ahead of every
        // other kind, and these tests are about the one that runs last.
        settings: () => ({ memoryProfileId: MEMORY.id, worldState: false, ...settings }),
        clock,
        // The assembler's once-per-cycle test in miniature: a pass stops being due
        // once a batch in the chat has read that far (memory/canon.js `coveredThrough`).
        // `pendingPick` in miniature: a pick stops being due once a batch in the chat
        // has read that far (pipeline/compactor.js).
        memory: memory ?? (() => {
            const covered = canonFor(live, READERS).coveredThrough;
            return pass(live, { due: covered === null || covered < 3 });
        }),
    });
    return { context, service, summarizer, chat: live };
}

const isCanonCall = (call) => call.prompt[0].content.startsWith(CANON_PROMPT.slice(0, 60));

let warning;

beforeEach(() => {
    warning = vi.fn();
    vi.stubGlobal('toastr', { warning });
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    resetToasts();
});

afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
});

describe('running a canon pick', () => {
    it('writes the batch on the newest record it read, and saves the chat', async () => {
        const run = harness({ responses: [reply()] });
        run.summarizer.start();
        await run.summarizer.idle();

        expect(run.service.calls.filter(isCanonCall)).toHaveLength(1);
        expect(readCanon(run.chat[3])).toEqual({
            status: 'valid',
            canon: {
                // The rows the model cited, mapped back to the messages they came from.
                facts: [
                    { text: MEANT[0].fact, entities: ['Wren'], from: [0] },
                    { text: MEANT[1].fact, entities: ['Aster', 'Wren'], from: [3] },
                ],
                covers: [0, 3],
                slots: 8,
                prompt: expect.any(String),
                at: new Date(CLOCK).toISOString(),
            },
        });
        expect(run.context.saved.chat).toBeGreaterThan(0);
    });

    it('sends the whole index and the slot count it was given', async () => {
        const chat = makeChat(12);
        const run = harness({
            chat,
            responses: [reply([{ ...MEANT[0], from: [1] }])],
            memory: () => pass(chat, { covers: [2, 6], slots: 4 }),
        });
        run.summarizer.start();
        await run.summarizer.idle();

        const sent = run.service.calls.find(isCanonCall).prompt[0].content;
        expect(sent).toContain('matter 2 before the tide turned');
        expect(sent).toContain('matter 6 before the tide turned');
        expect(sent).toContain('Choose exactly 4 facts');
    });

    it('records the applied change, not the model\'s claim', async () => {
        const chat = makeChat(12);
        const run = harness({
            chat,
            // Four facts: one repeated inside the pick, one over its cap, one citing a
            // row that was never sent, one good.
            responses: [JSON.stringify({
                canon: [
                    { fact: 'Wren grew up on the harbour.', entities: [], from: [1] },
                    { fact: 'wren grew up on the harbour', entities: [], from: [2] },
                    { fact: `A fact far too long. ${'x'.repeat(200)}`, entities: [], from: [3] },
                    { ...MEANT[0], from: [4] },
                ],
            })],
            memory: () => pass(chat),
        });
        run.summarizer.start();
        await run.summarizer.idle();

        expect(readCanon(chat[3]).canon.facts).toEqual([
            { text: 'Wren grew up on the harbour.', entities: [], from: [0] },
            { text: MEANT[0].fact, entities: ['Wren'], from: [3] },
        ]);
        expect(run.summarizer.status.canon).toMatchObject({ picked: 2, duplicates: 1, refused: 1 });
    });

    it('replaces the pick in force rather than adding to it', async () => {
        // A pick supersedes (D-0071): the fold reads the newest batch alone, so a
        // second pick that leaves a fact out actually leaves it out.
        const chat = makeChat(12);
        const run = harness({ chat, responses: [reply(), reply([MEANT[1]])], memory: () => pass(chat) });
        run.summarizer.start();
        await run.summarizer.idle();

        expect(canonFor(chat, READERS).facts).toHaveLength(2);

        await run.summarizer.drain();

        expect(canonFor(chat, READERS).facts.map((fact) => fact.text)).toEqual([MEANT[1].fact]);
    });

    it('writes nothing when the pick picked nothing, because that is not an answer', async () => {
        const run = harness({ responses: ['{"canon":[]}'] });
        run.summarizer.start();
        await run.summarizer.idle();

        expect(readCanon(run.chat[3])).toEqual({ status: 'none', canon: null });
        expect(run.summarizer.status.canon.streak).toBe(1);
    });

    it('goes last, behind the state the next prompt carries', async () => {
        const run = harness({
            settings: { worldState: true },
            responses: [JSON.stringify({ location: 'The harbour', weather: 'Fog', characters: {} }), reply()],
        });
        run.summarizer.start();
        await run.summarizer.idle();

        expect(run.service.calls).toHaveLength(2);
        expect(isCanonCall(run.service.calls[0])).toBe(false);
        expect(isCanonCall(run.service.calls[1])).toBe(true);
    });

    it('makes one call however many times the queue drains while the pick stays due', async () => {
        const run = harness({ responses: [reply()] });
        run.summarizer.start();
        await run.summarizer.idle();
        await run.summarizer.drain();
        await run.summarizer.drain();

        // The second and third drains find the index already covered, so `pendingPick`
        // says nothing is due — no flag, and nothing stored about what has run.
        expect(run.service.calls.filter(isCanonCall)).toHaveLength(1);
    });
});

describe('when no pick is made at all', () => {
    const noCall = async (options) => {
        const run = harness({ responses: [], ...options });
        run.summarizer.start();
        await run.summarizer.idle();
        expect(run.service.calls.filter(isCanonCall)).toHaveLength(0);
        return run;
    };

    it('does nothing when the assembler says no pick is due', async () => {
        const chat = makeChat(12);
        await noCall({ chat, memory: () => pass(chat, { due: false }) });
    });

    it('does nothing before the assembler has planned a turn', async () => {
        await noCall({ memory: () => null });
    });

    it('does nothing with Keep canon off, and says so', async () => {
        const run = await noCall({ settings: { keepCanon: false } });

        expect(run.summarizer.status.canon.gate).toBe('off');
    });

    it('does nothing while qvink is still writing the block (decision 9)', async () => {
        const chat = makeChat(12);
        const run = await noCall({ chat, memory: () => pass(chat, { writing: false }) });

        expect(run.summarizer.status.canon.gate).toBe('not-writing');
    });

    it('does nothing with no memory profile', async () => {
        const run = await noCall({ settings: { memoryProfileId: '' } });

        expect(run.summarizer.status.canon.gate).toBe('no-profile');
    });

    it('does nothing in a group chat, which Cairn does not support (DESIGN.md §3.5)', async () => {
        const run = harness({ responses: [] });
        run.context.groupId = 'group-1';
        run.summarizer.start();
        await run.summarizer.idle();

        expect(run.service.calls.filter(isCanonCall)).toHaveLength(0);
        expect(run.summarizer.status.canon.gate).toBe('group-chat');
    });
});

describe('when a pick fails', () => {
    const failing = async (response) => {
        const run = harness({ responses: [response] });
        run.summarizer.start();
        await run.summarizer.idle();
        return run;
    };

    it('writes nothing, so the block keeps the canon it has', async () => {
        for (const shape of ['refusal', 'truncated', 'prose', 'empty', 'uncited']) {
            const run = await failing(badCanonOutputs[shape](MEANT));

            expect(readCanon(run.chat[3]), shape).toEqual({ status: 'none', canon: null });
            expect(canonFor(run.chat, READERS).facts, shape).toEqual([]);
        }
    });

    it('survives a transport error without reaching the caller', async () => {
        const run = await failing(new Error('gateway timeout'));

        expect(readCanon(run.chat[3]).status).toBe('none');
        expect(run.summarizer.status.canon.streak).toBe(1);
    });

    it('toasts once per streak rather than every turn', async () => {
        const run = harness({ responses: [new Error('boom'), new Error('boom'), new Error('boom')] });
        run.summarizer.start();
        await run.summarizer.idle();
        await run.summarizer.drain();
        await run.summarizer.drain();

        expect(warning).toHaveBeenCalledTimes(1);
        expect(run.summarizer.status.canon.streak).toBe(3);
    });

    it('gives up on a range that keeps failing, and says so', async () => {
        const run = harness({ responses: Array(MAX_ATTEMPTS).fill(new Error('boom')) });
        run.summarizer.start();
        for (let i = 0; i < MAX_ATTEMPTS; i++) await run.summarizer.drain();

        expect(run.summarizer.status.canon.givenUp).toBe(true);
        // And it stops calling: the queue would otherwise burn a request every turn.
        await run.summarizer.drain();
        expect(run.service.calls.filter(isCanonCall)).toHaveLength(MAX_ATTEMPTS);
    });
});

describe('when the chat moves while a pick is out', () => {
    it('discards the reply when its message is gone', async () => {
        const settle = deferred();
        const chat = makeChat(12);
        const run = harness({ chat, responses: [settle.promise] });
        run.summarizer.start();

        // A branch takes the chat back past the message the batch would land on.
        run.context.chat = chat.slice(0, 2);
        settle.resolve(reply());
        await run.summarizer.idle();

        expect(canonFor(run.context.chat, READERS).facts).toEqual([]);
        expect(readCanon(chat[3]).status).toBe('none');
    });

    it('writes to the message wherever it has moved to', async () => {
        const settle = deferred();
        const chat = makeChat(12);
        const run = harness({ chat, responses: [settle.promise] });
        run.summarizer.start();

        // A message is deleted above it, so every index below shifts by one.
        const target = chat[3];
        run.context.chat = chat.filter((_, index) => index !== 1);
        settle.resolve(reply());
        await run.summarizer.idle();

        expect(readCanon(target).status).toBe('valid');
        expect(readCanon(target).canon.covers).toEqual([0, 2]);
    });
});
