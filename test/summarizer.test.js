import { describe, expect, it, vi } from 'vitest';
import { createSummarizer } from '../src/pipeline/summarizer.js';
import { failureDetail } from '../src/pipeline/job.js';
import { MAX_ATTEMPTS } from '../src/pipeline/tally.js';
import { DEFAULT_SUMMARY_PROMPT, SUMMARY_MAX_TOKENS, perMessage } from '../src/memory/scene-strategy.js';
import { pendingScenes } from '../src/memory/scenes.js';
import { QVINK_EXTENSION } from '../src/interop/qvink.js';
import { readScene } from '../src/store/chat-store.js';
import { STORE_VERSION } from '../src/store/schema.js';
import { hashString } from '../src/util/hash.js';
import { badOutputs, createRequestService, deferred } from './mocks/llm.js';
import { makeMixedChat } from './mocks/cairn.js';
import { makeProse, makeSummary } from './mocks/qvink.js';
import { createContext, openChat, receiveMessage, startActive, startGeneration } from './mocks/sillytavern.js';
import { MEMORY, ROLEPLAY, queueHarness } from './helpers/summarizer.js';
import { stubToastr } from './helpers/toastr.js';

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
function harness({ chat, ...options } = {}) {
    return queueHarness({
        chat: chat ?? makeMixedChat({ length: 14, qvinkThrough: 9, cairnThrough: 9 }),
        // The state tier has its own tests (test/state-queue.test.js); these are the summaries'.
        defaults: { worldState: false },
        clock: () => CLOCK,
        // The block is qvink's in these tests, which shuts the index gate the way
        // `worldState: false` shuts the state's: a record nothing would read is not
        // written (pipeline/gates.js, docs/decisions.md D-0075). The index batch has its
        // own tests in test/index-queue.test.js.
        memory: () => ({ writing: false }),
        ...options,
    });
}

/** Let a request go out: the summarizer awaits nothing before it sends. */
const flush = () => new Promise((resolve) => setTimeout(resolve, 0));

const written = (chat) => chat.flatMap((message, index) => (message.extra?.cairn ? [index] : []));

const toastr = stubToastr();

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
        expect(toastr.warning).toHaveBeenCalledTimes(1);
        expect(toastr.warning.mock.calls[0][0]).toMatch(/\{\{message\}\}/);
    });
});

describe('when it runs', () => {
    it('does not hold up ST, which awaits every listener to a reply', async () => {
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
        expect(toastr.warning).not.toHaveBeenCalled();
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
        expect(toastr.warning).toHaveBeenCalledTimes(1);
    });

    it('warns once when the memory profile is the chat\'s own, and still summarises', async () => {
        const { context, summarizer } = harness({
            responses: [summary(10), summary(11), summary(12)],
            context: { selectedProfile: MEMORY.id },
        });

        summarizer.start();
        await summarizer.idle();

        expect(written(context.chat)).toEqual([10, 11, 12]);
        expect(toastr.warning).toHaveBeenCalledTimes(1);
    });

    it('stops listening and abandons the request in flight when stopped', async () => {
        const answer = deferred();
        const { context, service, summarizer } = harness({ responses: [answer.promise] });
        const { CHARACTER_MESSAGE_RENDERED, CHAT_CHANGED } = context.eventTypes;

        summarizer.start();
        summarizer.start();
        expect(context.eventSource.listenerCount(CHARACTER_MESSAGE_RENDERED)).toBe(1);
        expect(context.eventSource.listenerCount(CHAT_CHANGED)).toBe(1);
        await flush();

        summarizer.stop();
        await summarizer.idle();

        expect(service.calls[0].custom.signal.aborted).toBe(true);
        expect(written(context.chat)).toEqual([]);
        expect(context.eventSource.listenerCount(CHARACTER_MESSAGE_RENDERED)).toBe(0);
        expect(context.eventSource.listenerCount(CHAT_CHANGED)).toBe(0);
        expect(toastr.warning).not.toHaveBeenCalled();
    });
});

/** docs/decisions.md D-0037: before writing, the chat, the message and its text are all checked again. */
describe('opening a chat (D-0088)', () => {
    /** A summarizer as index.js makes it: started, with nobody having acted yet. */
    function opened(responses) {
        const service = createRequestService({ responses });
        const context = createContext({
            chat: makeMixedChat({ length: 14, qvinkThrough: 9, cairnThrough: 9 }),
            profiles: [MEMORY, ROLEPLAY],
            selectedProfile: ROLEPLAY.id,
            requestService: service,
        });
        const summarizer = createSummarizer(() => context, {
            settings: () => ({ memoryProfileId: MEMORY.id, worldState: false }),
            memory: () => ({ writing: false }),
        });
        return { context, service, summarizer };
    }

    it('makes no call on loading the page or opening a chat with work waiting', async () => {
        const { context, service, summarizer } = opened([]);

        summarizer.start();
        await summarizer.idle();
        await openChat(context, { chatId: 'another-chat', messages: makeMixedChat({ length: 14, qvinkThrough: 9, cairnThrough: 9 }) });
        await summarizer.idle();
        // A settings change is not activity in the chat either.
        await summarizer.drain('the memory profile setting');

        expect(pendingScenes(context.chat).length).toBeGreaterThan(0);
        expect(service.calls).toHaveLength(0);
    });

    it('does not count the greeting ST re-emits when a greeting-only chat opens (public/script.js:7703-7706)', async () => {
        const { context, service, summarizer } = opened([]);
        summarizer.start();

        await context.eventSource.emit(context.eventTypes.MESSAGE_RECEIVED, 0, 'first_message');
        await context.eventSource.emit(context.eventTypes.CHARACTER_MESSAGE_RENDERED, 0, 'first_message');
        await summarizer.idle();

        expect(service.calls).toHaveLength(0);
    });

    it('ignores ST\'s dry runs and other extensions\' quiet generations (public/script.js:4299)', async () => {
        const { context, service, summarizer } = opened([]);
        summarizer.start();

        await startGeneration(context, { dryRun: true });
        await startGeneration(context, { type: 'quiet' });
        await summarizer.drain('a settings change');

        expect(service.calls).toHaveLength(0);
    });

    it('starts on a reply once the user has generated, and not before the reply lands', async () => {
        const { context, service, summarizer } = opened([summary(10), summary(11), summary(12)]);
        summarizer.start();

        await startGeneration(context);
        expect(service.calls).toHaveLength(0);

        await receiveMessage(context, reply(14));
        await summarizer.idle();
        expect(service.calls.length).toBeGreaterThan(0);
    });

    it('starts on a resummarise click, which is activity in the chat', async () => {
        const { service, summarizer } = opened([summary(10), summary(11), summary(12)]);
        summarizer.start();

        expect(summarizer.resummarise(10)).toEqual({ queued: true });
        await summarizer.idle();
        expect(service.calls.length).toBeGreaterThan(0);
    });

    it('asks again for activity after moving to another chat', async () => {
        const { context, service, summarizer } = opened([summary(10), summary(11), summary(12)]);
        summarizer.start();
        await startGeneration(context);

        await openChat(context, { chatId: 'another-chat', messages: makeMixedChat({ length: 14, qvinkThrough: 9, cairnThrough: 9 }) });
        await summarizer.drain('a settings change');
        expect(service.calls).toHaveLength(0);
    });
});

describe('what it asks of the memory model (D-0086)', () => {
    const profile = (api) => ({ ...MEMORY, mode: 'cc', api, model: 'z-ai/glm-5.3' });

    it('asks an OpenRouter profile for no reasoning on every call', async () => {
        const { service, summarizer } = harness({
            responses: [summary(10), summary(11), summary(12)],
            context: { profiles: [profile('openrouter'), ROLEPLAY] },
        });

        summarizer.start();
        await summarizer.idle();

        expect(service.calls).toHaveLength(3);
        expect(service.calls.every((call) => call.overridePayload.reasoning_effort === 'none')).toBe(true);
        expect(summarizer.status).toMatchObject({ model: 'z-ai/glm-5.3', reasoning: 'none' });
    });

    it('steps down to a lower effort when the endpoint refuses none, and remembers it', async () => {
        // OpenRouter: "Reasoning is mandatory for this endpoint and cannot be disabled." The
        // browser sees only the status text (src/endpoints/backends/chat-completions.js:2705-2710).
        const { service, summarizer } = harness({
            responses: [new Error('Bad Request'), summary(10), summary(11), summary(12)],
            context: { profiles: [profile('openrouter'), ROLEPLAY] },
        });

        summarizer.start();
        await summarizer.idle();

        expect(service.calls.map((call) => call.overridePayload.reasoning_effort)).toEqual(['none', 'low', 'low', 'low']);
        expect(summarizer.status).toMatchObject({ written: 3, failures: 0, calls: 4, reasoning: 'low' });
        expect(toastr.warning).toHaveBeenCalledTimes(1);
        expect(toastr.warning.mock.calls[0][0]).toMatch(/refused reasoning effort "none"/);
    });

    it('saves a refusal, so the next page load starts at the lower effort with no refused call (D-0088)', async () => {
        // The real settings are one live object that outlives a page's summarizer.
        const saved = { memoryProfileId: MEMORY.id, worldState: false, memoryReasoning: 'none', reasoningRefused: {} };
        const load = (responses) => {
            const service = createRequestService({ responses });
            const context = createContext({
                chat: makeMixedChat({ length: 14, qvinkThrough: 9, cairnThrough: 9 }),
                profiles: [profile('openrouter'), ROLEPLAY], selectedProfile: ROLEPLAY.id, requestService: service,
            });
            const summarizer = startActive(createSummarizer(() => context, { settings: () => saved, memory: () => ({ writing: false }) }), context);
            return { service, context, summarizer };
        };

        const first = load([new Error('Bad Request'), summary(10), summary(11), summary(12)]);
        first.summarizer.start();
        await first.summarizer.idle();
        expect(saved.reasoningRefused).toEqual({ [`${MEMORY.id}\nz-ai/glm-5.3`]: ['none'] });
        expect(first.context.saved.settings).toBeGreaterThan(0);

        const reloaded = load([summary(10), summary(11), summary(12)]);
        reloaded.summarizer.start();
        await reloaded.summarizer.idle();
        const efforts = reloaded.service.calls.map((call) => call.overridePayload.reasoning_effort);
        expect(efforts.length).toBeGreaterThan(0);
        expect(efforts.every((effort) => effort === 'low')).toBe(true);
    });

    it('starts where the setting says: Low asks for low, and the preset\'s own asks nothing', async () => {
        for (const [setting, expected] of [['low', 'low'], ['preset', undefined]]) {
            const { service, summarizer } = harness({
                responses: [summary(10), summary(11), summary(12)],
                settings: { memoryReasoning: setting },
                context: { profiles: [profile('openrouter'), ROLEPLAY] },
            });
            summarizer.start();
            await summarizer.idle();
            expect(service.calls.map((call) => call.overridePayload.reasoning_effort)).toEqual([expected, expected, expected]);
        }
    });

    it('sends the preset\'s own setting once every effort is refused', async () => {
        const { service, summarizer } = harness({
            responses: [new Error('Bad Request'), new Error('Bad Request'), summary(10), summary(11), summary(12)],
            context: { profiles: [profile('openrouter'), ROLEPLAY] },
        });

        summarizer.start();
        await summarizer.idle();

        expect(service.calls.map((call) => call.overridePayload.reasoning_effort)).toEqual(['none', 'low', undefined, undefined, undefined]);
        expect(summarizer.status).toMatchObject({ written: 3, reasoning: null });
    });

    it('does not retry a failure that is not a refusal: an outage costs one request, as before', async () => {
        const { service, summarizer } = harness({
            responses: [new Error('502 Bad Gateway')],
            context: { profiles: [profile('openrouter'), ROLEPLAY] },
        });

        summarizer.start();
        await summarizer.idle();

        expect(service.calls).toHaveLength(1);
        expect(summarizer.status).toMatchObject({ failures: 1, lastReason: 'error', reasoning: 'none' });
    });

    it('never retries a refusal on a source it asked nothing of', async () => {
        const { service, summarizer } = harness({
            responses: [new Error('Bad Request')],
            context: { profiles: [profile('custom'), ROLEPLAY] },
        });

        summarizer.start();
        await summarizer.idle();

        expect(service.calls).toHaveLength(1);
        expect(summarizer.status.failures).toBe(1);
    });

    it('asks nothing of another source, and still reports the model', async () => {
        const { service, summarizer } = harness({
            responses: [summary(10), summary(11), summary(12)],
            context: { profiles: [profile('custom'), ROLEPLAY] },
        });

        summarizer.start();
        await summarizer.idle();

        expect(service.calls.every((call) => Object.keys(call.overridePayload).length === 0)).toBe(true);
        expect(summarizer.status).toMatchObject({ model: 'z-ai/glm-5.3', reasoning: null });
    });
});

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
        expect(toastr.warning).not.toHaveBeenCalled();
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
            expect(toastr.warning).toHaveBeenCalledTimes(1);
        });
    }

    it('stores the cleaned summary for a bad output the parser can recover', async () => {
        const { context, summarizer } = harness({
            responses: [badOutputs.preambleAndFence(summary(10)), badOutputs.leakedReasoning(summary(11)), badOutputs.bulleted(summary(12))],
        });

        summarizer.start();
        await summarizer.idle();

        expect([10, 11, 12].map((index) => context.chat[index].extra.cairn.scene.text)).toEqual([summary(10), summary(11), summary(12)]);
        expect(toastr.warning).not.toHaveBeenCalled();
    });

    it('names the likely cause when a reply comes back empty or cut off (D-0086)', async () => {
        const { summarizer } = harness({ responses: [badOutputs.empty()] });

        summarizer.start();
        await summarizer.idle();
        expect(toastr.warning.mock.calls[0][0]).toMatch(/spent its reply budget reasoning/);

        // A refusal or an outage says nothing about the budget.
        expect(failureDetail('It failed.', 'refusal')).toBe('It failed.');
        expect(failureDetail('It failed.', 'error')).toBe('It failed.');
        expect(failureDetail('It failed.', 'truncated')).toMatch(/reasoning/);
    });

    it('writes nothing for a thrown error, and toasts once', async () => {
        const { context, summarizer } = harness({ responses: [new Error('502 Bad Gateway')] });

        summarizer.start();
        await summarizer.idle();

        expect(written(context.chat)).toEqual([]);
        expect(toastr.warning).toHaveBeenCalledTimes(1);
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
        expect(toastr.warning).toHaveBeenCalledTimes(1);

        // 10 succeeds, and the run goes on to 11, which fails.
        await summarizer.drain();
        expect(toastr.warning).toHaveBeenCalledTimes(2);
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
        expect(toastr.warning).not.toHaveBeenCalled();
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
        expect(toastr.warning).toHaveBeenCalledTimes(1);
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
