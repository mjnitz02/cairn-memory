import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { MAX_ATTEMPTS, createSummarizer } from '../src/pipeline/summarizer.js';
import { QVINK_EXTENSION } from '../src/memory/scenes.js';
import { pendingStateJob, WTRACKERS } from '../src/memory/state.js';
import { STATE_MAX_TOKENS, STATE_PROMPT, statePatch } from '../src/memory/state-strategy.js';
import { hashRange, readScene, readState, writeState } from '../src/store/chat-store.js';
import { STORE_VERSION } from '../src/store/schema.js';
import { hashString } from '../src/util/hash.js';
import { resetToasts } from '../src/util/log.js';
import { badStateOutputs, createRequestService, deferred } from './mocks/llm.js';
import { makeMixedChat } from './mocks/cairn.js';
import {
    continueReply, createContext, editMessage, makeChat, makeMessage, openChat, receiveMessage, sendMessage, swipeReply, swipeTo,
} from './mocks/sillytavern.js';

/**
 * The queue's state job (docs/p3-plan.md §3, §5): ahead of summaries, one per run,
 * discarded when the chat moves under it, and failing on its own streak.
 */

const MEMORY = { id: 'memory-profile', name: 'GLM (memory)' };
const ROLEPLAY = { id: 'roleplay-profile', name: 'Local (roleplay)' };
const CLOCK = Date.parse('2026-09-16T18:00:00.000Z');

/** Synthetic states and patches, the shape of test/fixtures/store-v2.js. */
const PIER = Object.freeze({
    location: 'The ferry terminal, waiting room',
    weather: 'Drizzle',
    characters: { Wren: { hair: 'Loose, damp from the rain', outfit: 'Wool coat over a grey jumper, jeans, boots' } },
});
const TO_PIER = { location: 'The ferry terminal, outer pier', characters: { Wren: { outfit: 'Grey jumper, jeans, boots' } } };
const TO_DECK = { location: 'The ferry, upper deck', characters: { Aster: { outfit: 'Oilskin coat' } } };

/** A patch as the model sends it: plain JSON, the plausible good case. */
const reply = (patch) => JSON.stringify(patch);

/** Synthetic, finished, and the length of a real reply: the corpus median is ~350 characters. */
const summary = (index) => `Wren and Aster settled matter ${index} before the tide turned, and agreed to speak of it again at dawn. `
    + 'Aster admitted the lamp had been moved from the lighthouse stair, and Wren, uneasy, asked who else still held a key. '
    + 'They decided to wait for the ferry rather than cross the causeway in the fog, and Wren said, "Not a word to the keeper."';

/** A state on `chat[index]` that read `read` visible messages, as the queue writes it. */
function putState(chat, index, value, read = 2) {
    expect(writeState(chat, index, { value, read, changed: [], prompt: 'h:1', at: 'T' })).toBe(true);
}

/** Six short messages, too short to summarise, with the state brought up to the reply at 3. */
function playedChat() {
    const chat = makeChat(6);
    putState(chat, 3, PIER, 4);
    putState(chat, 5, PIER);
    return chat;
}

function harness({ responses = [], chat, settings = {}, context: contextOptions = {}, stateStrategy, clock = () => CLOCK, onUpdate } = {}) {
    const service = createRequestService({ responses });
    const context = createContext({
        chat: chat ?? makeChat(6),
        profiles: [MEMORY, ROLEPLAY],
        selectedProfile: ROLEPLAY.id,
        requestService: service,
        ...contextOptions,
    });
    const summarizer = createSummarizer(() => context, {
        settings: () => ({ memoryProfileId: MEMORY.id, ...settings }),
        clock,
        onUpdate,
        ...(stateStrategy ? { stateStrategy } : {}),
    });
    return { context, service, summarizer };
}

/** The user's message and the reply to it, as ST adds them. */
async function exchange(context, turn) {
    await sendMessage(context, makeMessage({ name: 'Wren', isUser: true, mes: `Wren says something at turn ${turn}.` }));
    await receiveMessage(context, makeMessage({ mes: `Aster answers at turn ${turn + 1}.` }));
}

const flush = () => new Promise((resolve) => setTimeout(resolve, 0));
const isStateCall = (call) => call.prompt[0].content.startsWith(STATE_PROMPT.slice(0, 60));
const stateOf = (chat, index) => readState(chat, index).state;

let warning;

beforeEach(() => {
    warning = vi.fn();
    vi.stubGlobal('toastr', { warning });
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    vi.spyOn(console, 'error').mockImplementation(() => {});
});

afterEach(() => {
    resetToasts();
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
});

describe('bringing the state up to date', () => {
    it('starts cold from the newest messages, and stores what it applied on the last one', async () => {
        const { context, service, summarizer } = harness({ responses: [reply(TO_PIER)] });
        const job = pendingStateJob(context.chat);

        summarizer.start();
        await summarizer.idle();

        expect(service.calls).toHaveLength(1);
        const [call] = service.calls;
        expect(call.profileId).toBe(MEMORY.id);
        expect(call.maxTokens).toBe(STATE_MAX_TOKENS);
        expect(call.custom).toMatchObject({ stream: false, includePreset: true, includeInstruct: true });
        expect(call.custom.signal).toBeInstanceOf(AbortSignal);
        expect(call.prompt).toEqual(statePatch.build({ ...job, expand: (text) => context.substituteParams(text) }).messages);

        expect(context.chat[5].extra.cairn).toEqual({
            v: STORE_VERSION,
            state: {
                value: TO_PIER,
                read: 6,
                hash: hashRange(context.chat.slice(0, 6)),
                changed: ['location', 'characters.arrived'],
                prompt: hashString(STATE_PROMPT),
                at: '2026-09-16T18:00:00.000Z',
            },
        });
        expect(context.saved.chat).toBe(1);
    });

    it('reads only what came after the newest valid state, and patches that state', async () => {
        const { context, service, summarizer } = harness({ chat: playedChat(), responses: [reply(TO_PIER)] });
        summarizer.start();
        await summarizer.idle();
        expect(service.calls).toHaveLength(0);

        await exchange(context, 6);
        await summarizer.idle();

        const content = service.calls[0].prompt[0].content;
        expect(content).toContain(JSON.stringify(PIER));
        expect(content).toContain('Wren: Wren says something at turn 6.\n\nAster: Aster answers at turn 7.');
        expect(content).not.toContain('turn 5.');
        expect(stateOf(context.chat, 7)).toMatchObject({
            value: { ...PIER, location: TO_PIER.location, characters: { Wren: { ...PIER.characters.Wren, outfit: TO_PIER.characters.Wren.outfit } } },
            read: 2,
            changed: ['location', 'characters.outfit'],
        });
    });

    it('records a reply of {} as read through, with nothing changed', async () => {
        const { context, summarizer } = harness({ chat: playedChat(), responses: [badStateOutputs.noChange()] });
        summarizer.start();
        await exchange(context, 6);
        await summarizer.idle();

        expect(stateOf(context.chat, 7)).toMatchObject({ value: PIER, read: 2, changed: [] });
    });

    it('records the change it applied, not the one claimed: repeated values change nothing (CLAUDE.md §4.18)', async () => {
        const repeated = badStateOutputs.fullState({}, PIER);
        const { context, summarizer } = harness({ chat: playedChat(), responses: [repeated] });
        summarizer.start();
        await exchange(context, 6);
        await summarizer.idle();

        expect(stateOf(context.chat, 7)).toMatchObject({ value: PIER, changed: [] });
    });

    it('never applies a dropped field, and counts it', async () => {
        const { context, summarizer } = harness({ chat: playedChat(), responses: [badStateOutputs.unknownSubKey(TO_PIER)] });
        summarizer.start();
        await exchange(context, 6);
        await summarizer.idle();

        expect(stateOf(context.chat, 7).value.characters.Wren).not.toHaveProperty('mood');
        expect(summarizer.status.state).toMatchObject({ written: 1, failures: 0, dropped: 1 });
    });

    it('writes onto the live message, and a neighbour\'s Symbol flag survives (DESIGN.md §9)', async () => {
        const { context, summarizer } = harness({ responses: [reply(TO_PIER)] });
        const target = context.chat[5];
        const extra = target.extra;
        context.chat[4].extra[context.symbols.ignore] = true;

        summarizer.start();
        await summarizer.idle();

        expect(context.chat[5]).toBe(target);
        expect(context.chat[5].extra).toBe(extra);
        expect(context.chat[4].extra[context.symbols.ignore]).toBe(true);
    });
});

describe('when it runs', () => {
    it('updates the state before the summaries, one request at a time', async () => {
        const chat = makeMixedChat({ length: 14, qvinkThrough: 9, cairnThrough: 9 });
        const { context, service, summarizer } = harness({ chat, responses: [reply(TO_PIER), summary(10), summary(11), summary(12)] });

        summarizer.start();
        await summarizer.idle();

        expect(service.calls.map(isStateCall)).toEqual([true, false, false, false]);
        expect(readState(context.chat, 13).status).toBe('valid');
        expect([10, 11, 12].map((index) => readScene(context.chat[index]).status)).toEqual(['valid', 'valid', 'valid']);
    });

    it('does not hold up ST, which awaits MESSAGE_RECEIVED before rendering the reply', async () => {
        const answer = deferred();
        const { context, service, summarizer } = harness({ chat: playedChat(), responses: [answer.promise] });
        summarizer.start();
        await summarizer.idle();

        await exchange(context, 6);

        expect(service.calls).toHaveLength(1);
        expect(readState(context.chat, 7).status).toBe('none');
        answer.resolve(reply(TO_PIER));
        await summarizer.idle();
        expect(readState(context.chat, 7).status).toBe('valid');
    });

    it('lands a state whose messages are unchanged when a reply arrives meanwhile, then reads on from it', async () => {
        const answer = deferred();
        const { context, service, summarizer } = harness({ responses: [answer.promise, reply(TO_DECK)] });
        summarizer.start();
        await flush();

        await exchange(context, 6);
        answer.resolve(reply(TO_PIER));
        await summarizer.idle();

        expect(service.calls).toHaveLength(2);
        expect(stateOf(context.chat, 5).value).toEqual(TO_PIER);
        expect(stateOf(context.chat, 7)).toMatchObject({
            read: 2,
            value: { location: TO_DECK.location, characters: { Wren: TO_PIER.characters.Wren, Aster: TO_DECK.characters.Aster } },
        });
    });

    it('tries the state once per run, so an outage costs one state request per trigger', async () => {
        const { service, summarizer } = harness({ responses: [new Error('502 Bad Gateway'), reply(TO_PIER)] });

        summarizer.start();
        await summarizer.idle();
        expect(service.calls).toHaveLength(1);

        await summarizer.drain();
        expect(summarizer.status.state).toMatchObject({ calls: 2, written: 1, failures: 1 });
    });

    it('redoes the state as soon as a message it read is edited (public/script.js:8405)', async () => {
        const { context, service, summarizer } = harness({ chat: playedChat(), responses: [reply(TO_PIER)] });
        summarizer.start();
        await summarizer.idle();

        await editMessage(context, 5, 'Aster answers at turn 5, and walks out to the pier.');
        await summarizer.idle();

        expect(service.calls).toHaveLength(1);
        expect(service.calls[0].prompt[0].content).toContain('walks out to the pier');
        expect(stateOf(context.chat, 5)).toMatchObject({ read: 2, value: { location: TO_PIER.location } });
    });

    it('does not call for an edit outside the newest state\'s range', async () => {
        const { context, service, summarizer } = harness({ chat: playedChat() });
        summarizer.start();

        await editMessage(context, 1, 'Aster answers at turn 1, differently.');
        await summarizer.idle();

        expect(service.calls).toHaveLength(0);
    });

    it('redoes a summary as soon as its message is edited, not after the next reply', async () => {
        const chat = makeMixedChat({ length: 14, qvinkThrough: 9, cairnThrough: 12 });
        const { context, service, summarizer } = harness({ chat, settings: { worldState: false }, responses: [summary(11)] });
        summarizer.start();
        await summarizer.idle();

        await editMessage(context, 11, `${context.chat[11].mes} Reworded.`);
        await summarizer.idle();

        expect(service.calls).toHaveLength(1);
        expect(readScene(context.chat[11])).toMatchObject({ status: 'valid' });
    });

    it('rewrites the state for a new swipe, and needs no call to swipe back', async () => {
        const { context, service, summarizer } = harness({ chat: playedChat(), responses: [reply(TO_DECK)] });
        summarizer.start();
        await summarizer.idle();

        await swipeReply(context, 'Aster answers at turn 5 from the upper deck.');
        await summarizer.idle();
        expect(stateOf(context.chat, 5).value.location).toBe(TO_DECK.location);

        // Swiping back restores the old swipe's extra, and its state with it (public/script.js:7015).
        swipeTo(context.chat[5], 0);
        await summarizer.drain();
        expect(service.calls).toHaveLength(1);
        expect(stateOf(context.chat, 5).value).toEqual(PIER);
    });

    it('rewrites the state after a continue changes the reply', async () => {
        const { context, service, summarizer } = harness({ chat: playedChat(), responses: [reply(TO_PIER)] });
        summarizer.start();
        await summarizer.idle();

        await continueReply(context, ' Then Aster heads for the pier.');
        await summarizer.idle();

        expect(service.calls[0].prompt[0].content).toContain('heads for the pier');
        expect(stateOf(context.chat, 5).value.location).toBe(TO_PIER.location);
    });

    it('starts nothing when the user sends a message, so generation never waits on it', async () => {
        const { context, service, summarizer } = harness({ chat: playedChat() });
        summarizer.start();
        await summarizer.idle();

        await sendMessage(context, makeMessage({ name: 'Wren', isUser: true, mes: 'Wren says something at turn 6.' }));
        await summarizer.idle();

        expect(context.eventSource.listenerCount(context.eventTypes.MESSAGE_SENT)).toBe(0);
        expect(service.calls).toHaveLength(0);
    });

    it('stops listening to every trigger when stopped', () => {
        const { context, summarizer } = harness({ chat: playedChat() });
        const { MESSAGE_RECEIVED, MESSAGE_EDITED, CHAT_CHANGED } = context.eventTypes;
        summarizer.start();
        expect([MESSAGE_RECEIVED, MESSAGE_EDITED, CHAT_CHANGED].map((event) => context.eventSource.listenerCount(event))).toEqual([1, 1, 1]);

        summarizer.stop();
        expect([MESSAGE_RECEIVED, MESSAGE_EDITED, CHAT_CHANGED].map((event) => context.eventSource.listenerCount(event))).toEqual([0, 0, 0]);
    });

    it('does nothing with World state off, and summaries still run', async () => {
        const chat = makeMixedChat({ length: 14, qvinkThrough: 9, cairnThrough: 9 });
        const { service, summarizer } = harness({ chat, settings: { worldState: false }, responses: [summary(10), summary(11), summary(12)] });

        summarizer.start();
        await summarizer.idle();

        expect(service.calls.some(isStateCall)).toBe(false);
        expect(summarizer.status.state).toMatchObject({ gate: 'off', pending: true, calls: 0 });
        expect(summarizer.status.written).toBe(3);
    });

    it('stands aside while WTrackerLite is loaded and names it, and summaries still run (decision 8)', async () => {
        const chat = makeMixedChat({ length: 14, qvinkThrough: 9, cairnThrough: 9 });
        const { service, summarizer } = harness({
            chat,
            context: { extensions: [WTRACKERS[0].extension] },
            responses: [summary(10), summary(11), summary(12)],
        });

        summarizer.start();
        await summarizer.idle();

        expect(service.calls.some(isStateCall)).toBe(false);
        expect(summarizer.status.state).toMatchObject({ gate: 'wtracker-loaded', tracker: 'WTrackerLite' });
        expect(summarizer.status.written).toBe(3);
        expect(warning).not.toHaveBeenCalled();
    });

    it('keeps the state while qvink is still summarising, which holds only the summaries', async () => {
        const chat = makeMixedChat({ length: 14, qvinkThrough: 9, cairnThrough: 9 });
        const { context, service, summarizer } = harness({ chat, context: { extensions: [QVINK_EXTENSION] }, responses: [reply(TO_PIER)] });
        context.extensionSettings.qvink_memory = { auto_summarize: true };

        summarizer.start();
        await summarizer.idle();

        expect(service.calls.map(isStateCall)).toEqual([true]);
        expect(summarizer.status).toMatchObject({ gate: 'qvink-summarising', written: 0, state: { gate: 'ready', written: 1 } });
    });
});

/** Anything can happen in the seconds a request is out (docs/p3-plan.md §3, "Before writing"). */
describe('a state reply that arrives after the chat moved on', () => {
    async function outFor(chat = playedChat()) {
        const answer = deferred();
        const setup = harness({ chat, responses: [answer.promise, reply(TO_DECK)] });
        setup.summarizer.start();
        await setup.summarizer.idle();
        await exchange(setup.context, 6);
        return { ...setup, answer };
    }

    it('is discarded when you have left the chat, and the new chat gets its own', async () => {
        const { context, summarizer, answer } = await outFor();
        const left = context.chat[7];

        await openChat(context, { chatId: 'another-chat', messages: makeChat(2) });
        answer.resolve(reply(TO_PIER));
        await summarizer.idle();

        expect(left.extra.cairn).toBeUndefined();
        expect(stateOf(context.chat, 1).value).toEqual(TO_DECK);
        expect(summarizer.status.state.failures).toBe(0);
        expect(warning).not.toHaveBeenCalled();
    });

    it('is discarded when a message it read is edited, and the edit is read next', async () => {
        const { context, service, summarizer, answer } = await outFor();

        await editMessage(context, 6, 'Wren says something at turn 6, from the deck.');
        answer.resolve(reply(TO_PIER));
        await summarizer.idle();

        expect(service.calls).toHaveLength(2);
        expect(service.calls[1].prompt[0].content).toContain('from the deck');
        expect(stateOf(context.chat, 7).value.location).toBe(TO_DECK.location);
        expect(summarizer.status.state).toMatchObject({ written: 1, failures: 0 });
    });

    it('is discarded when the reply it read is swiped, and the new swipe is read next', async () => {
        const { context, service, summarizer, answer } = await outFor();

        await swipeReply(context, 'Aster answers at turn 7, climbing to the deck.');
        answer.resolve(reply(TO_PIER));
        await summarizer.idle();

        expect(service.calls[1].prompt[0].content).toContain('climbing to the deck');
        expect(stateOf(context.chat, 7).value.location).toBe(TO_DECK.location);
        expect(summarizer.status.state.failures).toBe(0);
    });

    it('is discarded when a message it read is deleted or hidden', async () => {
        for (const change of [(chat) => chat.splice(6, 1), (chat) => { chat[6].is_system = true; }]) {
            const { context, summarizer, answer } = await outFor();
            const target = context.chat[7];

            change(context.chat);
            answer.resolve(reply(TO_PIER));
            await summarizer.idle();

            expect(target.extra.cairn).toBeUndefined();
            expect(summarizer.status.state.failures).toBe(0);
        }
    });
});

/** CLAUDE.md §4.17: a failure writes nothing, and says so once per streak. */
describe('state failure', () => {
    const rejected = Object.keys(badStateOutputs).filter((name) => !statePatch.parse(badStateOutputs[name](TO_PIER, PIER)).ok);

    it('covers the rejected bad outputs', () => {
        expect(rejected.sort()).toEqual(['array', 'empty', 'prose', 'refusal', 'truncated', 'unterminatedReasoning']);
    });

    for (const name of rejected) {
        it(`writes nothing for ${name}, and toasts once`, async () => {
            const { context, summarizer } = harness({ responses: [badStateOutputs[name](TO_PIER, {})] });

            summarizer.start();
            await summarizer.idle();

            expect(context.chat.some((message) => message.extra.cairn)).toBe(false);
            expect(context.saved.chat).toBe(0);
            expect(warning).toHaveBeenCalledTimes(1);
            expect(summarizer.status.state).toMatchObject({ calls: 1, written: 0, failures: 1, lastReason: statePatch.parse(badStateOutputs[name](TO_PIER, {})).reason });
        });
    }

    it('writes nothing for a thrown error, and toasts once', async () => {
        const { context, summarizer } = harness({ responses: [new Error('502 Bad Gateway')] });

        summarizer.start();
        await summarizer.idle();

        expect(context.chat.some((message) => message.extra.cairn)).toBe(false);
        expect(warning).toHaveBeenCalledTimes(1);
        expect(summarizer.status.state.lastReason).toBe('error');
    });

    it('leaves the previous valid state standing', async () => {
        const { context, summarizer } = harness({ chat: playedChat(), responses: [badStateOutputs.refusal()] });
        summarizer.start();
        await exchange(context, 6);
        await summarizer.idle();

        expect(readState(context.chat, 7).status).toBe('none');
        expect(stateOf(context.chat, 5).value).toEqual(PIER);
    });

    it('does not stop the summaries, and each kind keeps its own streak', async () => {
        const chat = makeMixedChat({ length: 14, qvinkThrough: 9, cairnThrough: 9 });
        const { context, summarizer } = harness({ chat, responses: [new Error('timeout'), badStateOutputs.refusal()] });

        summarizer.start();
        await summarizer.idle();

        // The state's failure toasts, and so does the first summary's, on its own streak.
        expect(warning).toHaveBeenCalledTimes(2);
        expect(summarizer.status).toMatchObject({ failures: 1, streak: 1, state: { failures: 1, streak: 1 } });
        expect(readScene(context.chat[10]).status).toBe('none');
    });

    it('toasts once per streak: a success ends it, and the next failure toasts again', async () => {
        const { context, summarizer } = harness({
            responses: [badStateOutputs.refusal(), new Error('502'), reply(TO_PIER), badStateOutputs.empty()],
        });

        summarizer.start();
        await summarizer.idle();
        await summarizer.drain();
        expect(warning).toHaveBeenCalledTimes(1);

        await summarizer.drain();
        expect(summarizer.status.state.streak).toBe(0);
        await exchange(context, 6);
        await summarizer.idle();
        expect(warning).toHaveBeenCalledTimes(2);
    });

    it(`gives up on what it read after ${MAX_ATTEMPTS} failures, and tries again once a new message arrives`, async () => {
        const refusals = Array(MAX_ATTEMPTS).fill(badStateOutputs.refusal());
        const { context, service, summarizer } = harness({ responses: [...refusals, reply(TO_PIER)] });

        summarizer.start();
        await summarizer.idle();
        for (let attempt = 1; attempt < MAX_ATTEMPTS; attempt++) await summarizer.drain();
        expect(summarizer.status.state).toMatchObject({
            pending: true, givenUp: true, failed: { index: 5, attempts: MAX_ATTEMPTS, reason: 'refusal' },
        });

        await summarizer.drain();
        expect(service.calls).toHaveLength(MAX_ATTEMPTS);

        await exchange(context, 6);
        await summarizer.idle();
        expect(service.calls).toHaveLength(MAX_ATTEMPTS + 1);
        expect(summarizer.status.state).toMatchObject({ pending: false, givenUp: false, failed: null });
    });

    it('fails without writing when a newer Cairn stored on the message meanwhile', async () => {
        const answer = deferred();
        const { context, summarizer } = harness({ responses: [answer.promise] });
        summarizer.start();
        await flush();

        context.chat[5].extra.cairn = { v: 99 };
        answer.resolve(reply(TO_PIER));
        await summarizer.idle();

        expect(context.chat[5].extra.cairn).toEqual({ v: 99 });
        expect(summarizer.status.state.lastReason).toBe('write');
    });

    it('never lets an error escape into ST\'s event path', async () => {
        const stateStrategy = { ...statePatch, build: () => { throw new Error('a bug in the strategy'); } };
        const { context, summarizer } = harness({ chat: playedChat(), stateStrategy });
        summarizer.start();

        await expect(exchange(context, 6)).resolves.toBeUndefined();
        await expect(summarizer.idle()).resolves.toBeUndefined();
        expect(readState(context.chat, 7).status).toBe('none');
        expect(warning).toHaveBeenCalledTimes(1);
    });
});

/** What the panel and the log will read (docs/p3-plan.md §6): counts and kinds, never the state's text. */
describe('what it reports about the state', () => {
    it('counts requests, writes, failures, dropped fields, tokens and time for the chat', async () => {
        let now = CLOCK;
        const replies = [badStateOutputs.unknownField(TO_PIER), badStateOutputs.refusal()];
        const { context, summarizer } = harness({ responses: replies, clock: () => (now += 250) });

        summarizer.start();
        await summarizer.idle();
        await exchange(context, 6);
        await summarizer.idle();
        const { state } = summarizer.status;

        expect(state).toMatchObject({
            calls: 2, written: 1, failures: 1, lastReason: 'refusal', dropped: 1, gate: 'ready', tracker: null, inFlight: null,
        });
        expect(state.lastMs).toBeGreaterThan(0);
        expect(state.tokensIn).toBeGreaterThan(Math.ceil(STATE_PROMPT.length / 4) * 2);
        expect(state.tokensOut).toBe(replies.reduce((total, text) => total + Math.ceil(text.length / 4), 0));
        const reported = JSON.stringify(summarizer.status);
        expect(reported).not.toContain('ferry');
        expect(reported).not.toContain('Aster answers');
    });

    it('says which message a request is out for and whether an update is waiting, and tells the panel', async () => {
        const answer = deferred();
        const onUpdate = vi.fn();
        const { summarizer } = harness({ responses: [answer.promise], onUpdate });
        expect(summarizer.status.state).toMatchObject({ gate: null, pending: true, inFlight: null });

        summarizer.start();
        await flush();
        expect(summarizer.status.state.inFlight).toBe(5);
        expect(onUpdate).toHaveBeenCalled();

        answer.resolve(reply(TO_PIER));
        await summarizer.idle();
        expect(summarizer.status.state).toMatchObject({ pending: false, inFlight: null });
    });

    it('starts the counts again in a new chat, and keeps them when the same chat is reloaded', async () => {
        const { context, summarizer } = harness({ responses: [reply(TO_PIER), reply(TO_DECK)] });
        summarizer.start();
        await summarizer.idle();

        const reloaded = makeChat(6);
        reloaded.forEach((message, index) => { message.extra = context.chat[index].extra; });
        await openChat(context, { chatId: context.chatId, messages: reloaded });
        await summarizer.idle();
        expect(summarizer.status.state).toMatchObject({ calls: 1, written: 1 });

        await openChat(context, { chatId: 'another-chat', messages: makeChat(2) });
        await summarizer.idle();
        expect(summarizer.status.state).toMatchObject({ calls: 1, written: 1, ms: 0 });
        expect(stateOf(context.chat, 1).value).toEqual(TO_DECK);
    });
});
