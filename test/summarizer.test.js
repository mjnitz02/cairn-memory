import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { MAX_ATTEMPTS, createSummarizer } from '../src/pipeline/summarizer.js';
import { DEFAULT_SUMMARY_PROMPT, SUMMARY_MAX_TOKENS, perMessage } from '../src/memory/scene-strategy.js';
import { QVINK_EXTENSION, pendingScenes } from '../src/memory/scenes.js';
import { readScene } from '../src/store/chat-store.js';
import { STORE_VERSION } from '../src/store/schema.js';
import { hashString } from '../src/util/hash.js';
import { resetToasts } from '../src/util/log.js';
import { badOutputs, createRequestService, deferred } from './mocks/llm.js';
import { makeMixedChat } from './mocks/cairn.js';
import { makeMessage as makeProse, makeSummary } from './mocks/qvink.js';
import { createContext, openChat, receiveMessage } from './mocks/sillytavern.js';

const MEMORY = { id: 'memory-profile', name: 'GLM (memory)' };
const ROLEPLAY = { id: 'roleplay-profile', name: 'Local (roleplay)' };
const CLOCK = Date.parse('2026-09-16T18:00:00.000Z');

/** Synthetic, finished, and the length of a real reply: the corpus median is ~350 characters. */
const summary = (index) => `Wren and Aster settled matter ${index} before the tide turned, and agreed to speak of it again at dawn. `
    + 'Aster admitted the lamp had been moved from the lighthouse stair, and Wren, uneasy, asked who else still held a key. '
    + 'They decided to wait for the ferry rather than cross the causeway in the fog, and Wren said, "Not a word to the keeper."';

/** A long character reply, as `makeMixedChat` builds them: summarisable. */
function reply(index) {
    return { name: 'Aster', is_user: false, send_date: '2026-01-01T00:00:00.000Z', mes: makeProse(index, 1_650), extra: {} };
}

/** A chat of 14 where qvink summarised 0-9, so Cairn's queue is 10, 11, 12. */
function harness({ responses = [], settings = {}, chat, service, context: contextOptions = {}, strategy, clock = () => CLOCK, onUpdate } = {}) {
    const requests = service ?? createRequestService({ responses });
    const context = createContext({
        chat: chat ?? makeMixedChat({ length: 14, qvinkThrough: 9, cairnThrough: 9 }),
        profiles: [MEMORY, ROLEPLAY],
        selectedProfile: ROLEPLAY.id,
        requestService: requests,
        ...contextOptions,
    });
    const summarizer = createSummarizer(() => context, {
        // The state tier has its own tests (test/state-queue.test.js); these are the summaries'.
        settings: () => ({ memoryProfileId: MEMORY.id, worldState: false, ...settings }),
        clock,
        onUpdate,
        // The block is qvink's in these tests, which shuts the index gate the way
        // `worldState: false` shuts the state's: a record nothing would read is not
        // written (pipeline/gates.js, docs/decisions.md D-0075). The index batch has its
        // own tests in test/index-queue.test.js.
        memory: () => ({ writing: false }),

        ...(strategy ? { strategy } : {}),
    });
    return { context, service: requests, summarizer };
}

/** Let a request go out: the summarizer awaits nothing before it sends. */
const flush = () => new Promise((resolve) => setTimeout(resolve, 0));

const written = (chat) => chat.flatMap((message, index) => (message.extra?.cairn ? [index] : []));

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

describe('summarising the queue', () => {
    it('writes one scene per waiting message, oldest first, and saves the chat', async () => {
        const { context, service, summarizer } = harness({ responses: [summary(10), summary(11), summary(12)] });

        summarizer.start();
        await summarizer.idle();

        expect(written(context.chat)).toEqual([10, 11, 12]);
        expect(context.chat[11].extra.cairn).toEqual({
            v: STORE_VERSION,
            scene: {
                text: summary(11),
                hash: hashString(context.chat[11].mes),
                prompt: hashString(DEFAULT_SUMMARY_PROMPT),
                at: '2026-09-16T18:00:00.000Z',
            },
        });
        expect(pendingScenes(context.chat)).toEqual([]);
        expect(service.pending).toBe(0);
        expect(context.saved.chat).toBe(3);
    });

    it('sends the strategy\'s request through the memory profile, with an abort signal', async () => {
        const { context, service, summarizer } = harness({ responses: [summary(10), summary(11), summary(12)] });

        summarizer.start();
        await summarizer.idle();

        const [call] = service.calls;
        expect(call.profileId).toBe(MEMORY.id);
        expect(call.maxTokens).toBe(SUMMARY_MAX_TOKENS);
        expect(call.custom).toMatchObject({ stream: false, includePreset: true, includeInstruct: true });
        expect(call.custom.signal).toBeInstanceOf(AbortSignal);
        expect(call.prompt).toEqual(perMessage.build({
            message: context.chat[10],
            history: [5, 6, 7, 8, 9].map((index) => makeSummary(index)),
            expand: (text) => context.substituteParams(text),
        }).messages);
    });

    it('sends the five scenes before each message, including the ones it just wrote', async () => {
        const { service, summarizer } = harness({ responses: [summary(10), summary(11), summary(12)] });

        summarizer.start();
        await summarizer.idle();

        const third = service.calls[2].prompt[0].content;
        expect(third).toContain(`${makeSummary(9)}\n${summary(10)}\n${summary(11)}`);
        expect(third).not.toContain(makeSummary(6));
    });

    it('never summarises the last message', async () => {
        const { context, summarizer } = harness({ responses: [summary(10), summary(11), summary(12)] });

        summarizer.start();
        await summarizer.idle();

        expect(context.chat.at(-1).extra.cairn).toBeUndefined();
    });

    it('writes onto the live message, and a neighbour\'s Symbol flag survives (DESIGN.md §9)', async () => {
        const { context, summarizer } = harness({ responses: [summary(10), summary(11), summary(12)] });
        const target = context.chat[10];
        const extra = target.extra;
        context.chat[9].extra[context.symbols.ignore] = true;

        summarizer.start();
        await summarizer.idle();

        expect(context.chat[10]).toBe(target);
        expect(context.chat[10].extra).toBe(extra);
        expect(context.chat[9].extra[context.symbols.ignore]).toBe(true);
    });

    it('passes chat text to the model literally, macros and all', async () => {
        const chat = makeMixedChat({ length: 12, qvinkThrough: 9, cairnThrough: 9 });
        chat[10].mes += ' Aster wrote {{user}} and {{char}} on the slate.';
        const { service, summarizer } = harness({ chat, responses: [summary(10)], settings: { summaryPrompt: 'For {{user}}: {{message}}' } });

        summarizer.start();
        await summarizer.idle();

        const content = service.calls[0].prompt[0].content;
        expect(content.startsWith('For Wren: Wren: ')).toBe(true);
        expect(content).toContain('Aster wrote {{user}} and {{char}} on the slate.');
    });

    it('uses the default for a prompt with no {{message}}, and warns once', async () => {
        const { context, service, summarizer } = harness({
            responses: [summary(10), summary(11), summary(12)],
            settings: { summaryPrompt: 'Summarise {{history}}' },
        });

        summarizer.start();
        await summarizer.idle();

        expect(service.calls).toHaveLength(3);
        expect(service.calls[0].prompt[0].content).toContain('Message to summarize:');
        expect(context.chat[10].extra.cairn.scene.prompt).toBe(hashString(DEFAULT_SUMMARY_PROMPT));
        expect(warning).toHaveBeenCalledTimes(1);
        expect(warning.mock.calls[0][0]).toMatch(/\{\{message\}\}/);
    });
});

describe('when it runs', () => {
    it('does not hold up ST, which awaits MESSAGE_RECEIVED before rendering the reply', async () => {
        const answer = deferred();
        const chat = makeMixedChat({ length: 12, qvinkThrough: 10, cairnThrough: 10 });
        const { context, service, summarizer } = harness({ chat, responses: [answer.promise] });
        summarizer.start();
        await summarizer.idle();

        await receiveMessage(context, reply(12));

        // The emit is back while the request is still out.
        expect(service.calls).toHaveLength(1);
        expect(written(context.chat)).toEqual([]);
        answer.resolve(summary(11));
        await summarizer.idle();
        expect(written(context.chat)).toEqual([11]);
    });

    it('runs one request at a time, and picks up messages that arrived meanwhile', async () => {
        const first = deferred();
        const { context, service, summarizer } = harness({ responses: [first.promise, summary(11), summary(12), summary(13), summary(14)] });
        let open = 0;
        let most = 0;
        const send = service.sendRequest.bind(service);
        context.ConnectionManagerRequestService = {
            async sendRequest(...args) {
                open++;
                most = Math.max(most, open);
                try {
                    return await send(...args);
                } finally {
                    open--;
                }
            },
        };

        summarizer.start();
        await flush();
        await receiveMessage(context, reply(14));
        await receiveMessage(context, reply(15));
        first.resolve(summary(10));
        await summarizer.idle();

        expect(most).toBe(1);
        expect(written(context.chat)).toEqual([10, 11, 12, 13, 14]);
    });

    it('does nothing without a memory profile', async () => {
        const { context, service, summarizer } = harness({ settings: { memoryProfileId: '' } });

        summarizer.start();
        await summarizer.idle();

        expect(service.calls).toHaveLength(0);
        expect(written(context.chat)).toEqual([]);
        expect(warning).not.toHaveBeenCalled();
        expect(summarizer.status.gate).toBe('no-profile');
    });

    it('does nothing while qvink is still summarising, and starts once it stops', async () => {
        const { context, service, summarizer } = harness({
            responses: [summary(10), summary(11), summary(12), summary(13)],
            context: { extensions: [QVINK_EXTENSION] },
        });
        context.extensionSettings.qvink_memory = { auto_summarize: true };

        summarizer.start();
        await summarizer.idle();
        expect(service.calls).toHaveLength(0);
        expect(summarizer.status.gate).toBe('qvink-summarising');

        context.extensionSettings.qvink_memory.auto_summarize = false;
        await receiveMessage(context, reply(14));
        await summarizer.idle();
        expect(written(context.chat)).toEqual([10, 11, 12, 13]);
    });

    it('says once that the memory profile is gone, and calls nothing', async () => {
        const { service, summarizer } = harness({ settings: { memoryProfileId: 'deleted-profile' } });

        summarizer.start();
        await summarizer.idle();
        await summarizer.drain();

        expect(service.calls).toHaveLength(0);
        expect(warning).toHaveBeenCalledTimes(1);
    });

    it('warns once when the memory profile is the chat\'s own, and still summarises', async () => {
        const { context, summarizer } = harness({
            responses: [summary(10), summary(11), summary(12)],
            context: { selectedProfile: MEMORY.id },
        });

        summarizer.start();
        await summarizer.idle();

        expect(written(context.chat)).toEqual([10, 11, 12]);
        expect(warning).toHaveBeenCalledTimes(1);
    });

    it('stops listening and abandons the request in flight when stopped', async () => {
        const answer = deferred();
        const { context, service, summarizer } = harness({ responses: [answer.promise] });
        const { MESSAGE_RECEIVED, CHAT_CHANGED } = context.eventTypes;

        summarizer.start();
        summarizer.start();
        expect(context.eventSource.listenerCount(MESSAGE_RECEIVED)).toBe(1);
        expect(context.eventSource.listenerCount(CHAT_CHANGED)).toBe(1);
        await flush();

        summarizer.stop();
        await summarizer.idle();

        expect(service.calls[0].custom.signal.aborted).toBe(true);
        expect(written(context.chat)).toEqual([]);
        expect(context.eventSource.listenerCount(MESSAGE_RECEIVED)).toBe(0);
        expect(context.eventSource.listenerCount(CHAT_CHANGED)).toBe(0);
        expect(warning).not.toHaveBeenCalled();
    });
});

/** docs/decisions.md D-0037: before writing, the chat, the message and its text are all checked again. */
describe('a reply that arrives after the world moved on', () => {
    it('is discarded when you have left the chat, and the request is aborted', async () => {
        const answer = deferred();
        const { context, service, summarizer } = harness({ responses: [answer.promise] });
        summarizer.start();
        await flush();
        const left = [...context.chat];

        await openChat(context, { chatId: 'another-chat', messages: makeMixedChat({ length: 4, qvinkThrough: 2, cairnThrough: 2 }) });
        await summarizer.idle();

        expect(service.calls[0].custom.signal.aborted).toBe(true);
        expect(written(left)).toEqual([]);
        expect(written(context.chat)).toEqual([]);
        expect(warning).not.toHaveBeenCalled();
        expect(summarizer.status.failures).toBe(0);
    });

    it('is discarded even if the transport ignores the abort', async () => {
        const answer = deferred();
        const service = {
            calls: [],
            async sendRequest(...args) {
                this.calls.push(args);
                return { content: await answer.promise, reasoning: '' };
            },
        };
        const { context, summarizer } = harness({ service });
        summarizer.start();
        await flush();
        const left = [...context.chat];

        await openChat(context, { chatId: 'another-chat', messages: makeMixedChat({ length: 4, qvinkThrough: 2, cairnThrough: 2 }) });
        answer.resolve(summary(10));
        await summarizer.idle();

        expect(written(left)).toEqual([]);
    });

    it('is discarded when the same chat was reloaded, which replaces every message object', async () => {
        const answer = deferred();
        const { context, summarizer } = harness({ responses: [answer.promise, summary(10), summary(11), summary(12)] });
        summarizer.start();
        await flush();
        const before = [...context.chat];

        // Same id, same content, new objects (public/script.js:7658).
        const reloaded = makeMixedChat({ length: 14, qvinkThrough: 9, cairnThrough: 9 });
        await openChat(context, { chatId: context.chatId, messages: reloaded });
        answer.resolve(summary(10));
        await summarizer.idle();

        expect(written(before)).toEqual([]);
        expect(written(context.chat)).toEqual([10, 11, 12]);
    });

    it('is discarded when the message was edited meanwhile, and the new text is summarised next time', async () => {
        const answer = deferred();
        const { context, service, summarizer } = harness({ responses: [answer.promise, summary(10), summary(11), summary(12)] });
        summarizer.start();
        await flush();

        context.chat[10].mes += ' An afterthought.';
        answer.resolve(summary(10));
        await summarizer.idle();
        expect(written(context.chat)).toEqual([]);

        await summarizer.drain();
        expect(service.calls[1].prompt[0].content).toContain('An afterthought.');
        expect(readScene(context.chat[10]).status).toBe('valid');
    });

    it('is discarded when the message was deleted meanwhile', async () => {
        const answer = deferred();
        const { context, summarizer } = harness({ responses: [answer.promise] });
        summarizer.start();
        await flush();

        const [deleted] = context.chat.splice(10, 1);
        answer.resolve(summary(10));
        await summarizer.idle();

        expect(deleted.extra.cairn).toBeUndefined();
        expect(written(context.chat)).toEqual([]);
    });
});

/** CLAUDE.md §4.17: a failure writes nothing, and says so once per streak. */
describe('failure', () => {
    const rejected = Object.keys(badOutputs).filter((name) => !perMessage.parse(badOutputs[name](summary(10))).ok);

    it('covers the rejected bad outputs', () => {
        expect(rejected.sort()).toEqual(['empty', 'json', 'overlong', 'refusal', 'truncated', 'unterminatedReasoning']);
    });

    for (const name of rejected) {
        it(`writes nothing for ${name}, and toasts once`, async () => {
            const { context, service, summarizer } = harness({ responses: [badOutputs[name](summary(10))] });

            summarizer.start();
            await summarizer.idle();

            expect(service.calls).toHaveLength(1);
            expect(written(context.chat)).toEqual([]);
            expect(context.saved.chat).toBe(0);
            expect(warning).toHaveBeenCalledTimes(1);
        });
    }

    it('stores the cleaned summary for a bad output the parser can recover', async () => {
        const { context, summarizer } = harness({
            responses: [badOutputs.preambleAndFence(summary(10)), badOutputs.leakedReasoning(summary(11)), badOutputs.bulleted(summary(12))],
        });

        summarizer.start();
        await summarizer.idle();

        expect([10, 11, 12].map((index) => context.chat[index].extra.cairn.scene.text)).toEqual([summary(10), summary(11), summary(12)]);
        expect(warning).not.toHaveBeenCalled();
    });

    it('writes nothing for a thrown error, and toasts once', async () => {
        const { context, summarizer } = harness({ responses: [new Error('502 Bad Gateway')] });

        summarizer.start();
        await summarizer.idle();

        expect(written(context.chat)).toEqual([]);
        expect(warning).toHaveBeenCalledTimes(1);
        expect(summarizer.status).toMatchObject({ calls: 1, failures: 1, lastReason: 'error' });
    });

    it('stops the run at the failure, so an outage costs one request per reply', async () => {
        const { context, service, summarizer } = harness({ responses: [new Error('timeout'), summary(10), summary(11), summary(12)] });

        summarizer.start();
        await summarizer.idle();
        expect(service.calls).toHaveLength(1);

        await summarizer.drain();
        expect(written(context.chat)).toEqual([10, 11, 12]);
    });

    it('toasts once per streak: a success ends it, and the next failure toasts again', async () => {
        const { summarizer } = harness({
            responses: [badOutputs.refusal(), new Error('502'), summary(10), badOutputs.empty()],
        });

        summarizer.start();
        await summarizer.idle();
        await summarizer.drain();
        expect(warning).toHaveBeenCalledTimes(1);

        // 10 succeeds, and the run goes on to 11, which fails.
        await summarizer.drain();
        expect(warning).toHaveBeenCalledTimes(2);
    });

    it(`gives up on a message after ${MAX_ATTEMPTS} failures, and the step holds before it`, async () => {
        const refusals = Array(MAX_ATTEMPTS).fill(badOutputs.refusal());
        const { context, service, summarizer } = harness({ responses: [...refusals, summary(11), summary(12)] });

        summarizer.start();
        await summarizer.idle();
        for (let attempt = 1; attempt < MAX_ATTEMPTS; attempt++) await summarizer.drain();
        expect(summarizer.givenUp()).toEqual([10]);

        await summarizer.drain();
        expect(written(context.chat)).toEqual([11, 12]);
        expect(service.calls).toHaveLength(MAX_ATTEMPTS + 2);
        // Still waiting, so the scheduler's clamp holds the step before it.
        expect(pendingScenes(context.chat)[0]).toBe(10);
    });

    it('keeps a given-up message given up across a chat reload, but not after an edit', async () => {
        const refusals = Array(MAX_ATTEMPTS).fill(badOutputs.refusal());
        const { context, service, summarizer } = harness({ responses: [...refusals, summary(11), summary(12), summary(10)] });
        summarizer.start();
        await summarizer.idle();
        for (let attempt = 1; attempt < MAX_ATTEMPTS; attempt++) await summarizer.drain();

        const reloaded = makeMixedChat({ length: 14, qvinkThrough: 9, cairnThrough: 9 });
        await openChat(context, { chatId: context.chatId, messages: reloaded });
        await summarizer.idle();
        expect(written(context.chat)).toEqual([11, 12]);
        expect(summarizer.givenUp()).toEqual([10]);

        context.chat[10].mes += ' Reworded.';
        await summarizer.drain();
        expect(written(context.chat)).toEqual([10, 11, 12]);
        expect(service.pending).toBe(0);
    });

    it('does not count an abort as a failure', async () => {
        const answer = deferred();
        const { context, summarizer } = harness({ responses: [answer.promise, summary(10), summary(11), summary(12)] });
        summarizer.start();
        await flush();

        await openChat(context, { chatId: context.chatId, messages: makeMixedChat({ length: 14, qvinkThrough: 9, cairnThrough: 9 }) });
        await summarizer.idle();

        expect(summarizer.status.failures).toBe(0);
        expect(warning).not.toHaveBeenCalled();
    });

    it('fails without writing when a newer Cairn stored a scene on the message meanwhile', async () => {
        const answer = deferred();
        const { context, summarizer } = harness({ responses: [answer.promise] });
        summarizer.start();
        await flush();

        context.chat[10].extra.cairn = { v: 99 };
        answer.resolve(summary(10));
        await summarizer.idle();

        expect(context.chat[10].extra.cairn).toEqual({ v: 99 });
        expect(summarizer.status.lastReason).toBe('write');
    });

    it('never lets an error escape into ST\'s event path', async () => {
        const strategy = { ...perMessage, build: () => { throw new Error('a bug in the strategy'); } };
        const { context, summarizer } = harness({ strategy });
        summarizer.start();
        await summarizer.idle();

        await expect(receiveMessage(context, reply(14))).resolves.toBeUndefined();
        await expect(summarizer.idle()).resolves.toBeUndefined();
        expect(written(context.chat)).toEqual([]);
        expect(warning).toHaveBeenCalledTimes(1);
    });

    it('survives a context that throws', async () => {
        let calls = 0;
        const summarizer = createSummarizer(() => {
            calls++;
            if (calls > 1) throw new Error('ST went away');
            return createContext();
        }, { settings: () => ({ memoryProfileId: MEMORY.id }) });

        summarizer.start();
        await expect(summarizer.idle()).resolves.toBeUndefined();
    });
});

/**
 * What the inspector and the log read (docs/decisions.md D-0041). Counts, sizes and times for
 * the open chat — never a summary's text, which the log would carry to disk.
 */
describe('what it reports', () => {
    it('counts requests, writes, failures, tokens and time for the chat', async () => {
        let now = CLOCK;
        const clock = () => (now += 250);
        const { context, summarizer } = harness({
            clock,
            responses: [summary(10), badOutputs.refusal(), { content: summary(11), reasoning: 'Names, not pronouns.' }, summary(12)],
        });

        summarizer.start();
        await summarizer.idle();
        await summarizer.drain();
        const status = summarizer.status;

        expect(status).toMatchObject({ calls: 4, written: 3, failures: 1, lastReason: 'refusal', gate: 'ready', inFlight: null });
        expect(status.lastMs).toBeGreaterThan(0);
        expect(status.ms).toBeGreaterThanOrEqual(status.lastMs * 4);
        // The mock tokenizer is chars/4: every prompt carries its message, every reply its summary.
        expect(status.tokensIn).toBeGreaterThan(Math.ceil(context.chat[10].mes.length / 4) * 4);
        const replies = [summary(10), badOutputs.refusal(), `${summary(11)}Names, not pronouns.`, summary(12)];
        expect(status.tokensOut).toBe(replies.reduce((total, text) => total + Math.ceil(text.length / 4), 0));
        expect(JSON.stringify(status)).not.toContain('Wren and Aster');
    });

    it('says which message a request is out for, and tells the panel as it goes', async () => {
        const answer = deferred();
        const onUpdate = vi.fn();
        const { summarizer } = harness({ responses: [answer.promise, summary(11), summary(12)], onUpdate });

        summarizer.start();
        await flush();
        expect(summarizer.status.inFlight).toBe(10);
        expect(onUpdate).toHaveBeenCalled();

        answer.resolve(summary(10));
        await summarizer.idle();
        expect(summarizer.status.inFlight).toBeNull();
        // Out and back for each of the three, at least.
        expect(onUpdate.mock.calls.length).toBeGreaterThanOrEqual(6);
    });

    it('reports the queue: waiting, given up, and whether the prompt is the default', async () => {
        const refusals = Array(MAX_ATTEMPTS).fill(badOutputs.refusal());
        const { summarizer } = harness({ responses: [...refusals, summary(11), summary(12)] });

        expect(summarizer.status).toMatchObject({ gate: null, pending: 3, givenUp: [], promptDefault: true });

        summarizer.start();
        await summarizer.idle();
        for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) await summarizer.drain();

        expect(summarizer.status).toMatchObject({ pending: 1, givenUp: [10] });
    });

    it('calls a prompt edited only if the edit is what gets sent', () => {
        const status = (summaryPrompt) => harness({ settings: { summaryPrompt } }).summarizer.status.promptDefault;

        expect(status('')).toBe(true);
        expect(status('For {{user}}: {{message}}')).toBe(false);
        // No {{message}}: the default goes out instead (docs/decisions.md D-0039).
        expect(status('Summarise {{history}}')).toBe(true);
    });

    it('reports why it is idle', async () => {
        const { context, summarizer } = harness({ context: { extensions: [QVINK_EXTENSION] } });
        context.extensionSettings.qvink_memory = { auto_summarize: true };

        summarizer.start();
        await summarizer.idle();

        expect(summarizer.status.gate).toBe('qvink-summarising');
    });

    it('starts the counts again in a new chat, and a late reply for the old one does not land in them', async () => {
        const answer = deferred();
        let now = CLOCK;
        const { context, summarizer } = harness({ responses: [summary(10), answer.promise], clock: () => (now += 250) });
        summarizer.start();
        await flush();
        await flush();
        expect(summarizer.status.calls).toBe(2);

        await openChat(context, { chatId: 'another-chat', messages: makeMixedChat({ length: 4, qvinkThrough: 2, cairnThrough: 2 }) });
        answer.resolve(summary(11));
        await summarizer.idle();

        expect(summarizer.status).toMatchObject({ calls: 0, written: 0, failures: 0, ms: 0, tokensIn: 0, tokensOut: 0 });
    });

    it('keeps its counts when the same chat is reloaded (public/script.js:1710-1717)', async () => {
        const { context, summarizer } = harness({ responses: [summary(10), summary(11), summary(12)] });
        summarizer.start();
        await summarizer.idle();

        const reloaded = makeMixedChat({ length: 14, qvinkThrough: 9, cairnThrough: 9 });
        reloaded.forEach((message, index) => { message.extra = context.chat[index].extra; });
        await openChat(context, { chatId: context.chatId, messages: reloaded });
        await summarizer.idle();

        expect(summarizer.status).toMatchObject({ calls: 3, written: 3 });
    });

    it('lists each waiting message that failed, with its count and last reason', async () => {
        const { summarizer } = harness({ responses: [badOutputs.refusal(), badOutputs.truncated(summary(10))] });
        summarizer.start();
        await summarizer.idle();
        await summarizer.drain();

        expect(summarizer.status.failed).toEqual([{ index: 10, attempts: 2, reason: 'truncated' }]);
    });

    it('keeps summarising when the panel throws', async () => {
        const { context, summarizer } = harness({
            responses: [summary(10), summary(11), summary(12)],
            onUpdate: () => { throw new Error('panel gone'); },
        });

        summarizer.start();
        await summarizer.idle();

        expect(written(context.chat)).toEqual([10, 11, 12]);
    });
});
