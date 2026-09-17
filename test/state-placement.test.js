import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createSummarizer } from '../src/pipeline/summarizer.js';
import { createInjector, MEMORY_INJECTION } from '../src/prompt/injector.js';
import { buildInventory, summarizeInventory } from '../src/prompt/inventory.js';
import { STATE_INJECTION, createStatePlacement, placeState } from '../src/prompt/state-placement.js';
import { WTRACKERS } from '../src/memory/state.js';
import { MAX_STATE_CHARS, renderState } from '../src/memory/state-schema.js';
import { readState, writeState } from '../src/store/chat-store.js';
import { resetToasts } from '../src/util/log.js';
import { createRequestService, deferred } from './mocks/llm.js';
import {
    assembleTextPrompt, createContext, makeChat, makeCoreChat, makeMessage, newSwipe, swipeTo,
} from './mocks/sillytavern.js';

/**
 * The world state in the prompt (docs/decisions.md D-0042, D-0045): after the newest
 * message it read, found by `extra` identity, held back once the step has passed it,
 * and one more key from the same single writer.
 */

const IGNORE = Symbol.for('ignore');
const MEMORY = { id: 'memory-profile', name: 'GLM (memory)' };

/** Synthetic states, the shape of test/fixtures/store-v2.js. */
const PIER = Object.freeze({
    location: 'The ferry terminal, outer pier',
    weather: 'Drizzle',
    characters: { Wren: { hair: 'Loose, damp from the rain', outfit: 'Wool coat over a grey jumper, jeans, boots' } },
});
const DECK = Object.freeze({
    location: 'The ferry, upper deck',
    weather: 'Clearing',
    characters: { Wren: { hair: 'Loose, damp from the rain', outfit: 'Grey jumper, jeans, boots' }, Aster: { outfit: 'Oilskin coat' } },
});

/** A state on `chat[index]` that read `read` visible messages, as the queue writes it. */
function putState(chat, index, value, { read = 2, changed = [] } = {}) {
    expect(writeState(chat, index, { value, read, changed, prompt: 'h:1', at: 'T' })).toBe(true);
}

/** Wren and Aster alternating, states on the replies at 1 and 3, and Wren's message at 4 to answer. */
function playedChat() {
    const chat = makeChat(5);
    putState(chat, 1, PIER);
    putState(chat, 3, DECK, { changed: ['location', 'weather', 'characters.arrived', 'characters.outfit'] });
    return chat;
}

/** The plan the assembler hands over, with the see-saw's step in its report. */
function makePlan({ summarisedThrough = -1, writing = true, blank = [] } = {}) {
    return {
        text: 'BLOCK', blank, writing,
        placement: { position: 0, depth: 2, role: 0, scan: false },
        report: { summarisedThrough },
    };
}

function harness({ chat = playedChat(), plan = makePlan(), settings = {}, scope = {}, state } = {}) {
    const context = createContext({ chat });
    const placement = createStatePlacement(() => context, { settings: () => settings, scope });
    const memory = { plan: async () => (typeof plan === 'function' ? plan() : plan) };
    const injector = createInjector(() => context, { memory, state: state ?? placement });
    injector.start();
    const generate = (type) => injector.intercept(makeCoreChat(context.chat, { type }), 8192, () => {}, type);
    return { context, placement, injector, generate };
}

let warning;

beforeEach(() => {
    warning = vi.fn();
    vi.stubGlobal('toastr', { warning });
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    resetToasts();
});

afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
});

describe('which state goes in, and why not', () => {
    const context = (chat) => ({ chat, extensionSettings: { disabledExtensions: [] }, getExtensionManifest: () => null });

    it('places the newest valid state at the depth after its message', () => {
        const chat = playedChat();

        expect(placeState(context(chat), makeCoreChat(chat), { scope: {} })).toMatchObject({
            reason: 'injected', index: 3, depth: 1, text: renderState(DECK),
            changed: ['location', 'weather', 'characters.arrived', 'characters.outfit'],
        });
    });

    it('is off when the setting is false, and on when it is unset', () => {
        const chat = playedChat();

        expect(placeState(context(chat), makeCoreChat(chat), { worldState: false, scope: {} }).reason).toBe('off');
        expect(placeState(context(chat), makeCoreChat(chat), { scope: {} }).reason).toBe('injected');
    });

    it('names the WTracker that is loaded, and places nothing', () => {
        const chat = playedChat();
        const scope = { [WTRACKERS[0].interceptor]: () => {} };

        expect(placeState(context(chat), makeCoreChat(chat), { scope })).toMatchObject({
            reason: 'wtracker-loaded', tracker: 'WTrackerLite', text: '',
        });
    });

    it('has none yet in a chat with no state', () => {
        const chat = makeChat(4);

        expect(placeState(context(chat), makeCoreChat(chat), { scope: {} })).toMatchObject({ reason: 'none-yet', text: '', changed: [] });
    });

    it('says a state with nothing recorded is empty, rather than placing a bare header', () => {
        const chat = makeChat(3);
        putState(chat, 1, {});

        expect(placeState(context(chat), makeCoreChat(chat), { scope: {} })).toMatchObject({ reason: 'empty', index: 1, text: '' });
    });

    it('holds back a state at or before the step, and places one just after it', () => {
        const chat = playedChat();
        const core = makeCoreChat(chat);

        expect(placeState(context(chat), core, { summarisedThrough: 3, scope: {} })).toMatchObject({
            reason: 'behind-step', index: 3, text: '', changed: [],
        });
        expect(placeState(context(chat), core, { summarisedThrough: 2, scope: {} }).reason).toBe('injected');
    });
});

describe('writing the state into the prompt', () => {
    it('parks it in the chat, after the reply it read, as a system prompt out of the scan', async () => {
        const { context, generate } = harness();

        await generate('normal');

        expect(context.extensionPrompts[STATE_INJECTION]).toMatchObject({
            value: renderState(DECK), position: 1, depth: 1, role: 0, scan: false,
        });
    });

    it('lands between the reply it read and the user message it has not', async () => {
        const { context, generate } = harness();

        await generate('normal');
        const prompt = assembleTextPrompt(context, makeCoreChat(context.chat));

        expect(prompt).toContain(`Aster: Aster answers at turn 3.\n${renderState(DECK)}\nWren: Wren says something at turn 4.\n`);
    });

    it('is one writer with the block: both keys belong to Cairn', async () => {
        const { context, generate } = harness();

        await generate('normal');
        const summary = summarizeInventory(await buildInventory(context.extensionPrompts));

        expect(Object.keys(context.extensionPrompts).sort()).toEqual([MEMORY_INJECTION, STATE_INJECTION]);
        expect(summary.writers).toBe(1);
    });

    it('reads the interceptor\'s chat and leaves it as it was: same length, same entries', async () => {
        const { context, injector } = harness();
        const core = makeCoreChat(context.chat);
        const entries = [...core];
        const extras = core.map((entry) => entry.extra);

        await injector.intercept(core, 8192, () => {}, 'normal');

        expect(core).toHaveLength(entries.length);
        core.forEach((entry, at) => {
            expect(entry).toBe(entries[at]);
            expect(entry.extra).toBe(extras[at]);
        });
    });

    it('clones nothing: a Symbol flag on a neighbouring message survives', async () => {
        const chat = playedChat();
        const foreign = Symbol('another extension');
        chat[2].extra[foreign] = 'kept';
        chat[4].extra[IGNORE] = true;
        const { generate } = harness({ chat });

        await generate('normal');

        expect(chat[2].extra[foreign]).toBe('kept');
        expect(chat[4].extra[IGNORE]).toBe(true);
    });

    it('never waits on the queue: with a state request out, the previous state goes in', async () => {
        const answer = deferred();
        const service = createRequestService({ responses: [answer.promise] });
        const context = createContext({ chat: playedChat(), profiles: [MEMORY], requestService: service });
        const summarizer = createSummarizer(() => context, { settings: () => ({ memoryProfileId: MEMORY.id }) });
        const injector = createInjector(() => context, {
            memory: { plan: async () => makePlan() },
            state: createStatePlacement(() => context, { scope: {} }),
        });
        injector.start();
        // Wren's message at 4 is newer than the state at 3, so starting sends an update for it.
        summarizer.start();
        await vi.waitFor(() => expect(summarizer.status.state.inFlight).toBe(4));

        await injector.intercept(makeCoreChat(context.chat), 8192, () => {}, 'normal');

        expect(service.calls).toHaveLength(1);
        expect(summarizer.status.state.inFlight).toBe(4);
        expect(context.extensionPrompts[STATE_INJECTION]).toMatchObject({ value: renderState(DECK), depth: 1 });
        summarizer.stop();
        answer.resolve('{}');
        await summarizer.idle();
    });

    it('leaves a quiet prompt alone', async () => {
        const { context, generate } = harness();

        await generate('quiet');

        expect(context.extensionPrompts[STATE_INJECTION]).toBeUndefined();
    });
});

describe('the ordering invariant (DESIGN.md §6)', () => {
    it('a changed state leaves every byte above it alone, the block included', async () => {
        const chat = playedChat();
        const { context, generate } = harness({ chat });
        await generate('normal');
        const before = assembleTextPrompt(context, makeCoreChat(chat));

        putState(chat, 3, { ...DECK, weather: 'Bright sun, a cold wind' });
        await generate('normal');
        const after = assembleTextPrompt(context, makeCoreChat(chat));

        const above = before.indexOf(renderState(DECK));
        expect(above).toBeGreaterThan(0);
        expect(after.slice(0, above)).toBe(before.slice(0, above));
        expect(after.slice(0, above)).toContain('BLOCK');
        expect(after.slice(0, above)).toMatch(/Aster answers at turn 3\.\n$/);
        expect(after).not.toBe(before);
    });

    it('the state stays below the block, which never moves for it', async () => {
        const { context, generate } = harness();

        await generate('normal');
        const prompt = assembleTextPrompt(context, makeCoreChat(context.chat));

        expect(prompt.indexOf('BLOCK')).toBeLessThan(prompt.indexOf('[Current scene]'));
    });
});

describe('rollback', () => {
    it('does not take the state from a reply a swipe is replacing (public/script.js:4498)', async () => {
        const chat = makeChat(4);
        putState(chat, 1, PIER);
        putState(chat, 3, DECK);
        const { context, generate } = harness({ chat });

        await generate('swipe');

        expect(readState(chat, 3).status).toBe('valid');
        expect(context.extensionPrompts[STATE_INJECTION]).toMatchObject({ value: renderState(PIER), depth: 1 });
    });

    it('a new swipe makes the reply\'s state stale, and swiping back brings it back', async () => {
        const chat = makeChat(4);
        putState(chat, 1, PIER);
        putState(chat, 3, DECK);
        const { context, generate } = harness({ chat });

        newSwipe(chat[3], 'Aster answers another way.');
        await generate('normal');
        expect(context.extensionPrompts[STATE_INJECTION]).toMatchObject({ value: renderState(PIER), depth: 2 });

        swipeTo(chat[3], 0);
        await generate('normal');
        expect(context.extensionPrompts[STATE_INJECTION]).toMatchObject({ value: renderState(DECK), depth: 0 });
    });

    it('a branch takes the newest valid state at or before the cut, at its own depth', async () => {
        const chat = playedChat();
        // bookmarks.js:173 — a branch copies the messages it keeps, `extra` and all.
        const branch = structuredClone(chat.slice(0, 3));
        const { context, generate } = harness({ chat: branch });

        await generate('normal');

        expect(context.extensionPrompts[STATE_INJECTION]).toMatchObject({ value: renderState(PIER), depth: 1 });
    });

    it('an edit inside a state\'s range falls back; one before it changes nothing, with no cascade', async () => {
        const chat = playedChat();
        const { context, generate } = harness({ chat });

        chat[0].mes = 'Wren says something else at the start.';
        await generate('normal');
        expect(context.extensionPrompts[STATE_INJECTION].value).toBe(renderState(DECK));

        chat[2].mes = 'Wren says something else at turn 2.';
        await generate('normal');
        expect(context.extensionPrompts[STATE_INJECTION].value).toBe('');
    });

    it('a hidden message below the state does not count towards its depth', async () => {
        const chat = playedChat();
        chat.push(makeMessage({ name: 'Wren', isUser: true, mes: 'Wren adds a line.' }));
        chat[4].is_system = true;
        const { context, generate } = harness({ chat });

        await generate('normal');

        expect(context.extensionPrompts[STATE_INJECTION].depth).toBe(1);
    });
});

describe('when no state is placed', () => {
    it('parks nothing once the step has passed the state, and takes back one already parked', async () => {
        let step = -1;
        const { context, generate } = harness({ plan: () => makePlan({ summarisedThrough: step }) });

        await generate('normal');
        expect(context.extensionPrompts[STATE_INJECTION].value).toBe(renderState(DECK));

        step = 3;
        await generate('normal');
        expect(context.extensionPrompts[STATE_INJECTION].value).toBe('');
    });

    it('still places the state while the handover gate leaves the block to qvink', async () => {
        const { context, generate } = harness({ plan: makePlan({ writing: false }) });

        await generate('normal');

        expect(context.extensionPrompts[MEMORY_INJECTION]).toBeUndefined();
        expect(context.extensionPrompts[STATE_INJECTION].value).toBe(renderState(DECK));
    });

    it('takes the state back when World state is switched off, and back in when it is on', async () => {
        const settings = {};
        const { context, generate } = harness({ settings });

        await generate('normal');
        settings.worldState = false;
        await generate('normal');
        expect(context.extensionPrompts[STATE_INJECTION].value).toBe('');

        settings.worldState = true;
        await generate('normal');
        expect(context.extensionPrompts[STATE_INJECTION].value).toBe(renderState(DECK));
    });

    it('takes the state back while a WTracker is loaded', async () => {
        const scope = {};
        const { context, generate } = harness({ scope });

        await generate('normal');
        scope[WTRACKERS[1].interceptor] = () => {};
        await generate('normal');

        expect(context.extensionPrompts[STATE_INJECTION].value).toBe('');
    });

    it('releases the state with the block when Cairn stops, and on a chat change', async () => {
        const first = harness();
        await first.generate('normal');
        first.injector.stop();
        expect(first.context.extensionPrompts[STATE_INJECTION].value).toBe('');
        expect(first.context.extensionPrompts[MEMORY_INJECTION].value).toBe('');

        const second = harness();
        await second.generate('normal');
        second.injector.reset();
        expect(second.context.extensionPrompts[STATE_INJECTION].value).toBe('');
    });

    it('keeps last turn\'s state, toasts once, and lets nothing escape when placing fails', async () => {
        let fail = false;
        const context = createContext({ chat: playedChat() });
        const real = createStatePlacement(() => context, { scope: {} });
        const state = {
            plan: (...args) => {
                if (fail) throw new Error('placement exploded');
                return real.plan(...args);
            },
        };
        const injector = createInjector(() => context, { memory: { plan: async () => makePlan() }, state });
        injector.start();
        const generate = () => injector.intercept(makeCoreChat(context.chat), 8192, () => {}, 'normal');

        await generate();
        fail = true;
        await expect(generate()).resolves.toBeUndefined();
        await expect(generate()).resolves.toBeUndefined();

        expect(context.extensionPrompts[STATE_INJECTION].value).toBe(renderState(DECK));
        expect(context.extensionPrompts[MEMORY_INJECTION].value).toBe('BLOCK');
        expect(warning).toHaveBeenCalledTimes(1);
    });

    it('places the state with no clamp when the block\'s plan fails', async () => {
        let fail = false;
        const { context, generate } = harness({
            plan: () => {
                if (fail) throw new Error('assembler exploded');
                return makePlan({ summarisedThrough: 3 });
            },
        });

        await generate('normal');
        expect(context.extensionPrompts[STATE_INJECTION]).toBeUndefined();
        fail = true;
        await generate('normal');

        expect(context.extensionPrompts[STATE_INJECTION].value).toBe(renderState(DECK));
    });
});

describe('on a continue', () => {
    it('a state on the message being continued goes above it (public/script.js:5665)', async () => {
        const chat = makeChat(4);
        putState(chat, 3, DECK);
        const { context, generate } = harness({ chat });

        await generate('continue');
        const prompt = assembleTextPrompt(context, makeCoreChat(chat), { isContinue: true });

        expect(context.extensionPrompts[STATE_INJECTION].depth).toBe(0);
        expect(prompt).toMatch(new RegExp(`${escape(renderState(DECK))}\\nAster: Aster answers at turn 3\\.\\n$`));
    });
});

describe('what the placement reports', () => {
    it('reports depth, size, the kinds of the last change, and whether the text moved since last turn', async () => {
        const chat = playedChat();
        const { placement, generate } = harness({ chat });

        await generate('normal');
        expect(placement.latest).toMatchObject({
            injected: true, reason: 'injected', index: 3, depth: 1,
            chars: renderState(DECK).length, tokens: Math.ceil(renderState(DECK).length / 4),
            changed: null, changeKinds: ['location', 'weather', 'characters.arrived', 'characters.outfit'],
        });

        await generate('normal');
        expect(placement.latest.changed).toBe(false);

        putState(chat, 3, PIER, { changed: ['location'] });
        await generate('normal');
        expect(placement.latest).toMatchObject({ changed: true, changeKinds: ['location'], text: renderState(PIER) });
    });

    it('reports a state taken out as a change, and starts a new baseline on reset', async () => {
        const settings = {};
        const { placement, generate } = harness({ settings });

        await generate('normal');
        settings.worldState = false;
        await generate('normal');
        expect(placement.latest).toMatchObject({ injected: false, reason: 'off', depth: null, chars: 0, tokens: 0, changed: true });

        placement.reset();
        expect(placement.latest).toBeNull();
        await generate('normal');
        expect(placement.latest.changed).toBeNull();
    });

    it('never places more than the schema\'s ceiling', async () => {
        const { placement, generate } = harness();

        await generate('normal');

        expect(placement.latest.chars).toBeLessThanOrEqual(MAX_STATE_CHARS);
    });
});

function escape(text) {
    return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}
