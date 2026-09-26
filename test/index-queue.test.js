import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { MAX_ATTEMPTS, createSummarizer } from '../src/pipeline/summarizer.js';
import { INDEX_PROMPT, MAX_BATCH } from '../src/memory/index-strategy.js';
import { pendingIndex } from '../src/pipeline/compactor.js';
import { readIndex, readScene, writeScene } from '../src/store/chat-store.js';
import { resetToasts } from '../src/util/log.js';
import { badIndexOutputs, createRequestService, deferred } from './mocks/llm.js';
import { cairnSummary, makeMixedChat } from './mocks/cairn.js';
import { createContext } from './mocks/sillytavern.js';

/**
 * The queue's index job (docs/decisions.md D-0070, D-0075): one batch of summaries at a
 * time, a record written on each summary's own message, and a failure that changes
 * nothing. The compact tier depends on these records, so what is asserted here is that
 * the records land where the tier will look for them.
 */

const MEMORY = { id: 'memory-profile', name: 'GLM (memory)' };
const ROLEPLAY = { id: 'roleplay-profile', name: 'Local (roleplay)' };
const CLOCK = Date.parse('2026-09-25T09:00:00.000Z');

const record = (n) => ({
    n,
    kind: 'filler',
    who: ['Wren'],
    what: `Wren settled matter ${n} before the tide turned`,
    changed: '',
    because: '',
    background: '',
    line: `Wren settled matter ${n} before the tide turned.`,
});

const reply = (count) => JSON.stringify({ records: Array.from({ length: count }, (_, i) => record(i + 1)) });

/**
 * A chat where every summarisable message carries Cairn's summary and none of them has
 * a record: the summary queue is empty, so the index batch is the next work there is.
 */
function summarised(length = 24) {
    return makeMixedChat({ length, qvinkThrough: -1, cairnThrough: length - 2 });
}

function harness({ responses = [], chat, settings = {}, writing = true, clock = () => CLOCK } = {}) {
    const service = createRequestService({ responses });
    const live = chat ?? summarised();
    const context = createContext({
        chat: live,
        profiles: [MEMORY, ROLEPLAY],
        selectedProfile: ROLEPLAY.id,
        requestService: service,
    });
    const summarizer = createSummarizer(() => context, {
        // The summaries are already written and the state is off: these tests are the
        // index batch's, which runs after both.
        settings: () => ({ memoryProfileId: MEMORY.id, worldState: false, ...settings }),
        clock,
        memory: () => ({ writing }),
    });
    return { context, service, summarizer, chat: live };
}

const isIndexCall = (call) => call.prompt[0].content.startsWith(INDEX_PROMPT.slice(0, 60));
const indexed = (chat) => chat.filter((message) => readIndex(message).status === 'valid').length;

beforeEach(() => {
    resetToasts();
    vi.spyOn(console, 'warn').mockImplementation(() => {});
});
afterEach(() => vi.restoreAllMocks());

describe('what is waiting to be indexed', () => {
    it('is every summary with no record, oldest first', () => {
        const chat = summarised();
        const waiting = pendingIndex(chat, { readScene, readIndex });

        expect(waiting.length).toBeGreaterThan(0);
        expect(waiting.map((entry) => entry.index)).toEqual([...waiting.map((entry) => entry.index)].sort((a, b) => a - b));
        expect(waiting.every((entry) => readScene(chat[entry.index]).status === 'valid')).toBe(true);
        expect(waiting[0].text).toBe(readScene(chat[waiting[0].index]).scene.text);
    });

    it('holds nothing for a chat with no summaries', () => {
        expect(pendingIndex([{ mes: 'raw' }], { readScene, readIndex })).toEqual([]);
        expect(pendingIndex(undefined, { readScene, readIndex })).toEqual([]);
    });

    it('takes at most one batch', () => {
        const waiting = pendingIndex(summarised(60), { readScene, readIndex }, { limit: MAX_BATCH });
        expect(waiting.length).toBe(MAX_BATCH);
    });
});

describe('running an index batch', () => {
    it('writes a record on each summary it read, and saves the chat', async () => {
        const { context, service, summarizer, chat } = harness({ responses: [reply(MAX_BATCH)] });
        const waiting = pendingIndex(chat, { readScene, readIndex }, { limit: MAX_BATCH });

        summarizer.start();
        await summarizer.idle();

        expect(service.calls.filter(isIndexCall).length).toBe(1);
        expect(indexed(chat)).toBe(MAX_BATCH);
        for (const entry of waiting) {
            const { status, index } = readIndex(chat[entry.index]);
            expect(status).toBe('valid');
            expect(index.record.line).toContain('before the tide turned');
        }
        expect(context.saved.chat).toBeGreaterThan(0);
    });

    it('sends the summaries themselves, numbered, with no overlap between batches', async () => {
        const chat = summarised(60);
        const { service, summarizer } = harness({ responses: [reply(MAX_BATCH), reply(MAX_BATCH)], chat });
        const waiting = pendingIndex(chat, { readScene, readIndex });

        summarizer.start();
        await summarizer.idle();
        await summarizer.drain();

        const [first, second] = service.calls.filter(isIndexCall);
        expect(first.prompt[0].content).toContain(`1. ${waiting[0].text}`);
        expect(first.prompt[0].content).toContain(`${MAX_BATCH}. ${waiting[MAX_BATCH - 1].text}`);
        // The batch after it starts where the first one stopped: an extraction pass does
        // not need its neighbours, so nothing is sent twice.
        expect(second.prompt[0].content).toContain(`1. ${waiting[MAX_BATCH].text}`);
        expect(second.prompt[0].content).not.toContain(waiting[MAX_BATCH - 1].text);
    });

    it('writes what came back and leaves the rest pending', async () => {
        // A short reply is normal, not a failure: the unanswered summaries come back in
        // the next batch, because the queue is derived from what is on disk.
        const { service, summarizer, chat } = harness({ responses: [reply(3)] });

        summarizer.start();
        await summarizer.idle();

        expect(indexed(chat)).toBe(3);
        expect(pendingIndex(chat, { readScene, readIndex }).length).toBeGreaterThan(0);
        expect(service.calls.filter(isIndexCall).length).toBe(1);
    });

    it('reads a messy reply, and stores nothing from an unreadable one', async () => {
        const messy = badIndexOutputs.fenced(Array.from({ length: 3 }, (_, i) => record(i + 1)));
        const { summarizer, chat } = harness({ responses: [messy] });
        summarizer.start();
        await summarizer.idle();
        expect(indexed(chat)).toBe(3);

        const refused = harness({ responses: [badIndexOutputs.refusal()] });
        refused.summarizer.start();
        await refused.summarizer.idle();
        expect(indexed(refused.chat)).toBe(0);
    });

    it('never outlives the summary it describes: a resummarise leaves it stale', async () => {
        // One batch covers this chat exactly, so the queue empties.
        const { summarizer, chat } = harness({ responses: [reply(MAX_BATCH)], chat: summarised(MAX_BATCH + 1) });
        summarizer.start();
        await summarizer.idle();

        expect(pendingIndex(chat, { readScene, readIndex })).toEqual([]);
        const first = chat.findIndex((message) => readIndex(message).status === 'valid');
        writeScene(chat[first], { text: cairnSummary(first, 320), prompt: 'h:00000000000001' });

        expect(readIndex(chat[first]).status).toBe('stale');
        expect(pendingIndex(chat, { readScene, readIndex })[0].index).toBe(first);
    });

    it('writes nothing for a message that left the chat while the request was out', async () => {
        const gate = deferred();
        const { summarizer, chat } = harness({ responses: [gate.promise] });
        const waiting = pendingIndex(chat, { readScene, readIndex }, { limit: MAX_BATCH });

        summarizer.start();
        const run = summarizer.idle();
        chat.splice(waiting[0].index, 1);
        gate.resolve(reply(MAX_BATCH));
        await run;

        // The rest still land: only the record whose message went away is dropped.
        expect(indexed(chat)).toBe(MAX_BATCH - 1);
    });
});

describe('when a batch fails', () => {
    it('changes nothing and keeps the block as it is', async () => {
        const { service, summarizer, chat } = harness({ responses: [new Error('gateway')] });

        summarizer.start();
        await expect(summarizer.idle()).resolves.toBeUndefined();

        expect(indexed(chat)).toBe(0);
        expect(service.calls.filter(isIndexCall).length).toBe(1);
    });

    it('gives up on a batch that keeps failing, and stops calling', async () => {
        const { service, summarizer, chat } = harness({ responses: Array(MAX_ATTEMPTS).fill(new Error('gateway')) });

        summarizer.start();
        for (let i = 0; i < MAX_ATTEMPTS; i++) await summarizer.drain();
        expect(summarizer.status.index.givenUp).toBe(true);

        // And it stops: the queue would otherwise burn a request every turn.
        await summarizer.drain();
        expect(service.calls.filter(isIndexCall)).toHaveLength(MAX_ATTEMPTS);
        expect(indexed(chat)).toBe(0);
    });
});

describe('the gate', () => {
    it('writes no records while qvink owns the block', async () => {
        const { service, summarizer, chat } = harness({ responses: [], writing: false });

        summarizer.start();
        await summarizer.idle();

        expect(service.calls.filter(isIndexCall)).toEqual([]);
        expect(indexed(chat)).toBe(0);
    });

    it('indexes with canon turned off, because the compact tier reads the records too', async () => {
        const { service, summarizer, chat } = harness({ responses: [reply(MAX_BATCH)], settings: { keepCanon: false } });

        summarizer.start();
        await summarizer.idle();

        expect(service.calls.filter(isIndexCall).length).toBe(1);
        expect(indexed(chat)).toBeGreaterThan(0);
    });
});
