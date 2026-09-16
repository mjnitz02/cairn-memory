import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { markMessages, renderMark } from '../src/ui/chat-marks.js';
import { MAX_ATTEMPTS, createSummarizer } from '../src/pipeline/summarizer.js';
import { resetToasts } from '../src/util/log.js';
import { cairnStore, cairnSummary, makeMixedChat } from './mocks/cairn.js';
import { badOutputs, createRequestService, deferred } from './mocks/llm.js';
import { createContext } from './mocks/sillytavern.js';

const MEMORY = { id: 'memory-profile', name: 'GLM (memory)' };

/** A finished reply the parser accepts; `cairnSummary` is cut mid-sentence to a length. */
const finished = (index) => `Wren and Aster settled matter ${index} before the tide turned, and agreed to wait for the ferry.`;

/** Plain data, as the summarizer reports it: nothing waiting, nothing out. */
const idle = (overrides = {}) => ({ gate: 'ready', inFlight: null, failed: [], ...overrides });

const states = (marks) => Object.fromEntries([...marks].map(([index, mark]) => [index, mark.state]));

/** Qvink summarised 0-9 and Cairn 10-11, so 12 waits and 13 is the last message. */
const chat = () => makeMixedChat({ length: 14, qvinkThrough: 9, cairnThrough: 11 });

describe('what each message shows', () => {
    it('shows Cairn\'s own summaries and leaves qvink\'s to qvink', () => {
        const marks = markMessages(chat(), null);

        expect(states(marks)).toEqual({ 10: 'written', 11: 'written' });
        expect(marks.get(10).text).toBe(cairnSummary(10));
    });

    it('marks the waiting messages, but never the last one', () => {
        expect(states(markMessages(chat(), idle()))).toEqual({ 10: 'written', 11: 'written', 12: 'waiting' });
    });

    it('says nothing is waiting while the gate is closed, because nothing is coming', () => {
        expect(states(markMessages(chat(), idle({ gate: 'qvink-summarising' })))).toEqual({ 10: 'written', 11: 'written' });
    });

    it('marks the message a request is out for', () => {
        expect(markMessages(chat(), idle({ inFlight: 12 })).get(12)).toEqual({ state: 'writing' });
    });

    it('tells a failure it will retry apart from one it has given up on', () => {
        const status = idle({ failed: [{ index: 12, attempts: 1, reason: 'truncated' }] });
        const givenUp = idle({ failed: [{ index: 12, attempts: MAX_ATTEMPTS, reason: 'refusal' }] });

        expect(markMessages(chat(), status).get(12)).toEqual({ state: 'failed', attempts: 1, reason: 'truncated' });
        expect(markMessages(chat(), givenUp).get(12)).toMatchObject({ state: 'given-up' });
    });

    it('drops an edited message\'s summary and shows it waiting again', () => {
        const edited = chat();
        edited[11].mes += ' An afterthought.';

        expect(states(markMessages(edited, idle()))).toEqual({ 10: 'written', 11: 'waiting', 12: 'waiting' });
    });
});

describe('how a mark reads', () => {
    it('escapes summary text rather than rendering it', () => {
        const html = renderMark({ state: 'written', text: 'Aster wrote <img src=x onerror=alert(1)> & left.' });

        expect(html).toContain('&lt;img src=x onerror=alert(1)&gt; &amp; left.');
        expect(html).not.toContain('<img');
    });

    it('names the failure, and what happens next', () => {
        expect(renderMark({ state: 'failed', reason: 'truncated', attempts: 1 })).toContain('(truncated)');
        expect(renderMark({ state: 'given-up', reason: 'refusal', attempts: 3 })).toContain('after 3 failures');
        expect(renderMark({ state: 'writing' })).toContain('fa-spin');
    });
});

/** The marks against a real summarizer run, so the status they read has the real shape. */
describe('following a summarizer run', () => {
    beforeEach(() => {
        vi.stubGlobal('toastr', { warning: vi.fn() });
        vi.spyOn(console, 'warn').mockImplementation(() => {});
    });

    afterEach(() => {
        resetToasts();
        vi.unstubAllGlobals();
        vi.restoreAllMocks();
    });

    function run(responses) {
        const context = createContext({
            chat: makeMixedChat({ length: 14, qvinkThrough: 9, cairnThrough: 9 }),
            profiles: [MEMORY],
            requestService: createRequestService({ responses }),
        });
        const seen = [];
        const summarizer = createSummarizer(() => context, {
            settings: () => ({ memoryProfileId: MEMORY.id }),
            onUpdate: () => seen.push(states(markMessages(context.chat, summarizer.status))),
        });
        return { context, summarizer, seen };
    }

    it('shows the one being written, the ones behind it waiting, and each as it lands', async () => {
        const answer = deferred();
        const { context, summarizer, seen } = run([answer.promise, finished(11), finished(12)]);

        summarizer.start();
        await new Promise((resolve) => setTimeout(resolve, 0));
        expect(states(markMessages(context.chat, summarizer.status))).toEqual({ 10: 'writing', 11: 'waiting', 12: 'waiting' });

        answer.resolve(finished(10));
        await summarizer.idle();
        // The panel is told after each write, so its last redraw shows every summary.
        expect(seen.at(-1)).toEqual({ 10: 'written', 11: 'written', 12: 'written' });
        expect(seen).toContainEqual({ 10: 'written', 11: 'writing', 12: 'waiting' });
    });

    it('shows a failure with its reason until the retry', async () => {
        const { context, summarizer } = run([badOutputs.truncated(finished(10))]);

        summarizer.start();
        await summarizer.idle();

        expect(markMessages(context.chat, summarizer.status).get(10)).toEqual({ state: 'failed', attempts: 1, reason: 'truncated' });
        context.chat[10].extra.cairn = cairnStore(context.chat[10], finished(10));
        expect(markMessages(context.chat, summarizer.status).get(10).state).toBe('written');
    });
});
