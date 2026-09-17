import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { MAX_ATTEMPTS, createSummarizer } from '../src/pipeline/summarizer.js';
import { QVINK_EXTENSION, readScenes } from '../src/memory/scenes.js';
import { readScene } from '../src/store/chat-store.js';
import { refusalMessage } from '../src/ui/resummarise-button.js';
import { resetToasts } from '../src/util/log.js';
import { badOutputs, createRequestService, deferred } from './mocks/llm.js';
import { cairnSummary, makeMixedChat } from './mocks/cairn.js';
import { createContext } from './mocks/sillytavern.js';

/**
 * Summarising a message on the user's word (docs/decisions.md D-0050): the same request
 * as the queue's, for any message long enough, replacing what is there only on success.
 */

const MEMORY = { id: 'memory-profile', name: 'GLM (memory)' };
const ROLEPLAY = { id: 'roleplay-profile', name: 'Local (roleplay)' };

/** Synthetic and finished, so the parser accepts it. */
const summary = (index) => `Wren and Aster went back over matter ${index} by the harbour wall, and agreed to wait for the ferry.`;

/** qvink summarised 0-9 and Cairn 10-12, so nothing waits: every request here is asked for. */
function harness({ responses = [], settings = {}, chat, context: contextOptions = {} } = {}) {
    const service = createRequestService({ responses });
    const context = createContext({
        chat: chat ?? makeMixedChat({ length: 14, qvinkThrough: 9, cairnThrough: 12 }),
        profiles: [MEMORY, ROLEPLAY],
        selectedProfile: ROLEPLAY.id,
        requestService: service,
        ...contextOptions,
    });
    const summarizer = createSummarizer(() => context, {
        settings: () => ({ memoryProfileId: MEMORY.id, worldState: false, ...settings }),
    });
    return { context, service, summarizer };
}

const flush = () => new Promise((resolve) => setTimeout(resolve, 0));
const sceneText = (message) => readScene(message).scene?.text;

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

describe('summarising a message again', () => {
    it('replaces a written summary with a fresh one, sent the way the queue sends it', async () => {
        const { context, service, summarizer } = harness({ responses: [summary(11)] });
        summarizer.start();
        await summarizer.idle();

        expect(summarizer.resummarise(11)).toEqual({ queued: true });
        await summarizer.idle();

        expect(sceneText(context.chat[11])).toBe(summary(11));
        expect(service.calls).toHaveLength(1);
        // The five scenes before it go back as history, as for any summary.
        expect(service.calls[0].prompt.at(-1).content).toContain(cairnSummary(10));
        expect(context.saved.chat).toBe(1);
    });

    it('summarises the last message, which the queue never does', async () => {
        const { context, summarizer } = harness({ responses: [summary(13)] });
        summarizer.start();

        summarizer.resummarise(13);
        await summarizer.idle();

        expect(sceneText(context.chat[13])).toBe(summary(13));
    });

    it('replaces a qvink summary, and the block reads Cairn\'s in its place', async () => {
        const { context, summarizer } = harness({ responses: [summary(4)] });
        summarizer.start();

        summarizer.resummarise(4);
        await summarizer.idle();

        const scene = readScenes(context.chat).find((entry) => entry.index === 4);
        expect(scene).toMatchObject({ source: 'cairn', text: summary(4) });
        expect(context.chat[4].extra.qvink_memory.memory).toBeTruthy();
    });

    it('keeps the old summary when the new one fails, and says so every time', async () => {
        const { context, summarizer } = harness({ responses: [badOutputs.refusal(), badOutputs.truncated(summary(11))] });
        summarizer.start();

        summarizer.resummarise(11);
        await summarizer.idle();
        summarizer.resummarise(11);
        await summarizer.idle();

        expect(sceneText(context.chat[11])).toBe(cairnSummary(11));
        expect(warning).toHaveBeenCalledTimes(2);
        expect(warning.mock.calls[1][0]).toContain('Summarising message #11 failed (truncated). Nothing was changed.');
    });

    it('discards the reply when the message is edited while the request is out', async () => {
        const answer = deferred();
        const { context, summarizer } = harness({ responses: [answer.promise] });
        summarizer.start();

        summarizer.resummarise(11);
        await flush();
        context.chat[11].mes += ' Reworded.';
        answer.resolve(summary(11));
        await summarizer.idle();

        expect(context.chat[11].extra.cairn.scene.text).toBe(cairnSummary(11));
        expect(readScene(context.chat[11]).status).toBe('stale');
    });

    it('sends one request for a double click, and for a click while it is out', async () => {
        const answer = deferred();
        const { service, summarizer } = harness({ responses: [answer.promise] });
        summarizer.start();

        summarizer.resummarise(11);
        summarizer.resummarise(11);
        await flush();
        expect(summarizer.resummarise(11)).toEqual({ queued: true });
        answer.resolve(summary(11));
        await summarizer.idle();

        expect(service.calls).toHaveLength(1);
    });

    it('goes ahead of the rest of the queue, and a failure doesn\'t stop the queue behind it', async () => {
        const chat = makeMixedChat({ length: 14, qvinkThrough: 9, cairnThrough: 10 });
        const answer = deferred();
        const { context, service, summarizer } = harness({ chat, responses: [answer.promise, badOutputs.refusal(), summary(12)] });
        summarizer.start();
        await flush();

        // Asked while 11 is out, so it goes next, ahead of 12.
        summarizer.resummarise(4);
        answer.resolve(summary(11));
        await summarizer.idle();

        expect(service.calls).toHaveLength(3);
        expect(service.calls[1].prompt.at(-1).content).toContain(context.chat[4].mes.slice(0, 40));
        expect(sceneText(context.chat[11])).toBe(summary(11));
        expect(sceneText(context.chat[12])).toBe(summary(12));
    });

    it('tries a message the queue gave up on, with a fresh count', async () => {
        const chat = makeMixedChat({ length: 14, qvinkThrough: 9, cairnThrough: 9 });
        const refusals = Array(MAX_ATTEMPTS).fill(badOutputs.refusal());
        const { context, summarizer } = harness({ chat, responses: [...refusals, summary(10), summary(11), summary(12)] });
        summarizer.start();
        await summarizer.idle();
        for (let attempt = 1; attempt < MAX_ATTEMPTS; attempt++) await summarizer.drain();
        expect(summarizer.givenUp()).toEqual([10]);

        summarizer.resummarise(10);
        await summarizer.idle();

        expect(sceneText(context.chat[10])).toBe(summary(10));
        expect(summarizer.givenUp()).toEqual([]);
    });
});

describe('what it refuses', () => {
    it('refuses while Cairn is off', () => {
        const { service, summarizer } = harness();

        expect(summarizer.resummarise(11)).toEqual({ queued: false, reason: 'off' });
        expect(service.calls).toHaveLength(0);
    });

    it('refuses a message the queue could never summarise', async () => {
        const chat = makeMixedChat({ length: 14, qvinkThrough: 9, cairnThrough: 12, short: [11], hidden: [12] });
        chat[10].extra.cairn = { v: 99 };
        const { service, summarizer } = harness({ chat });
        summarizer.start();
        await summarizer.idle();

        expect(summarizer.resummarise(11)).toEqual({ queued: false, reason: 'too-short' });
        expect(summarizer.resummarise(12)).toEqual({ queued: false, reason: 'hidden' });
        expect(summarizer.resummarise(10)).toEqual({ queued: false, reason: 'future' });
        expect(summarizer.resummarise(40)).toEqual({ queued: false, reason: 'no-message' });
        await summarizer.idle();
        expect(service.calls).toHaveLength(0);
    });

    it('refuses behind a closed gate, with the gate\'s reason', async () => {
        const noProfile = harness({ settings: { memoryProfileId: '' } });
        const qvink = harness({ context: { extensions: [QVINK_EXTENSION] } });
        qvink.context.extensionSettings.qvink_memory = { auto_summarize: true };
        noProfile.summarizer.start();
        qvink.summarizer.start();

        expect(noProfile.summarizer.resummarise(11)).toEqual({ queued: false, reason: 'no-profile' });
        expect(qvink.summarizer.resummarise(11)).toEqual({ queued: false, reason: 'qvink-summarising' });
        await Promise.all([noProfile.summarizer.idle(), qvink.summarizer.idle()]);
        expect(noProfile.service.calls).toHaveLength(0);
        expect(qvink.service.calls).toHaveLength(0);
    });

    it('forgets what was asked when stopped', async () => {
        const answer = deferred();
        const { service, summarizer } = harness({ responses: [answer.promise, summary(12)] });
        summarizer.start();
        summarizer.resummarise(11);
        summarizer.resummarise(12);
        await flush();

        summarizer.stop();
        answer.resolve(summary(11));
        summarizer.start();
        await summarizer.idle();

        expect(service.calls).toHaveLength(1);
    });

    it('words each refusal as the reason, and a gate as the panel does', () => {
        expect(refusalMessage(11, 'too-short')).toBe('Cairn can\'t summarise message #11: the message is too short to summarise.');
        expect(refusalMessage(3, 'no-profile')).toBe('Cairn can\'t summarise message #3: no memory connection chosen.');
        expect(refusalMessage(3, 'qvink-summarising')).toBe('Cairn can\'t summarise message #3: Qvink\'s Auto Summarize is on.');
        expect(refusalMessage(3, 'something-new')).toContain('something-new');
    });
});
