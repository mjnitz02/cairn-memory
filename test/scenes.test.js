import { describe, expect, it } from 'vitest';
import {
    QVINK_DEFAULTS,
    QVINK_EXTENSION,
    cairnStart,
    SCENE_HISTORY,
    pendingScenes,
    qvinkExcluding,
    qvinkRunning,
    qvinkSummarising,
    sceneHistory,
    qvinkInjecting,
    readScenes,
} from '../src/memory/scenes.js';
import { makeQvinkChat, makeQvinkData } from './mocks/qvink.js';
import { createContext } from './mocks/sillytavern.js';
import { cairnStore, cairnSummary, makeMixedChat } from './mocks/cairn.js';

describe('reading tier 2 out of message.extra', () => {
    it('reads one scene per summarised message, in chat order', () => {
        const scenes = readScenes(makeQvinkChat({ length: 12 }));

        expect(scenes).toHaveLength(12);
        expect(scenes.map((scene) => scene.index)).toEqual([...Array(12).keys()]);
        expect(scenes[0].chars).toBe(scenes[0].text.length);
    });

    it('skips messages with no summary rather than emitting empty scenes', () => {
        const chat = makeQvinkChat({ length: 4 });
        chat[2].extra.qvink_memory.memory = '';
        delete chat[3].extra.qvink_memory;

        expect(readScenes(chat).map((scene) => scene.index)).toEqual([0, 1]);
    });

    it('leaves the prefill out, as qvink does by default (its index.js:113, :3521)', () => {
        const chat = makeQvinkChat({ length: 1 });

        expect(readScenes(chat)[0].text.startsWith('Summary: ')).toBe(false);
    });

    it('drops excluded scenes but lets a remembered one through anyway', () => {
        const chat = makeQvinkChat({ length: 6, exclude: [1, 2], remember: [2] });
        const eligible = readScenes(chat).filter((scene) => scene.eligible).map((s) => s.index);

        expect(eligible).toEqual([0, 2, 3, 4, 5]);
    });

    it('never mutates the chat it read', () => {
        const chat = makeQvinkChat({ length: 3 });
        const before = JSON.stringify(chat);
        readScenes(chat);

        expect(JSON.stringify(chat)).toBe(before);
    });
});

/**
 * Two sources, one scene per message (docs/decisions.md D-0037). qvink's summaries are
 * read and never rewritten; Cairn's count only while their hash still matches.
 */
describe('reading qvink and Cairn scenes together', () => {
    it('reads qvink scenes then Cairn scenes, in chat order, each named by source', () => {
        const chat = makeMixedChat({ length: 20, qvinkThrough: 9, cairnThrough: 17 });
        const scenes = readScenes(chat);

        expect(scenes.map((scene) => scene.index)).toEqual([...Array(18).keys()]);
        expect(scenes.slice(0, 10).every((scene) => scene.source === 'qvink')).toBe(true);
        expect(scenes.slice(10).every((scene) => scene.source === 'cairn')).toBe(true);
        expect(scenes[12]).toMatchObject({ text: cairnSummary(12), chars: cairnSummary(12).length, eligible: true });
    });

    it('lets the Cairn scene win when a message has both', () => {
        const chat = makeQvinkChat({ length: 3 });
        chat[1].extra.cairn = cairnStore(chat[1], 'Cairn wrote this one.');

        const scene = readScenes(chat)[1];
        expect(scene).toMatchObject({ source: 'cairn', text: 'Cairn wrote this one.' });
    });

    it('drops a scene whose message was edited, and does not fall back to an older qvink one', () => {
        // A qvink summary on the same message is at least as old as the edit made
        // Cairn's, so it is no better (docs/decisions.md D-0037).
        const chat = makeQvinkChat({ length: 3 });
        chat[1].extra.cairn = cairnStore(chat[1], 'Before the edit.');
        chat[1].mes += ' An afterthought.';

        expect(readScenes(chat).map((scene) => scene.index)).toEqual([0, 2]);
    });

    it('falls back to qvink when the Cairn store is unreadable', () => {
        const chat = makeQvinkChat({ length: 2 });
        chat[1].extra.cairn = { v: 1, scene: { text: '' } };

        expect(readScenes(chat)[1].source).toBe('qvink');
    });

    it('never mutates the chat it read', () => {
        const chat = makeMixedChat({ length: 12, qvinkThrough: 4, cairnThrough: 10 });
        chat[7].mes += ' edited';
        const before = JSON.stringify(chat);
        readScenes(chat);
        pendingScenes(chat);

        expect(JSON.stringify(chat)).toBe(before);
    });
});

describe('which messages are waiting for a summary', () => {
    it('starts after the newest qvink summary, whatever qvink skipped before it', () => {
        const chat = makeMixedChat({ length: 20, qvinkThrough: 9, cairnThrough: 9 });
        delete chat[3].extra.qvink_memory.memory;

        expect(cairnStart(chat)).toBe(10);
        expect(pendingScenes(chat)).toEqual([10, 11, 12, 13, 14, 15, 16, 17, 18]);
    });

    it('starts at the top of a chat qvink never touched', () => {
        const chat = makeMixedChat({ length: 6, qvinkThrough: -1, cairnThrough: -1 });

        expect(cairnStart(chat)).toBe(0);
        expect(pendingScenes(chat)).toEqual([0, 1, 2, 3, 4]);
    });

    it('never includes the last message, which can still be swiped or edited', () => {
        for (let length = 0; length <= 14; length++) {
            const chat = makeMixedChat({ length, qvinkThrough: -1, cairnThrough: -1 });
            expect(pendingScenes(chat)).not.toContain(length - 1);
        }
        // Even when everything before it is done.
        const done = makeMixedChat({ length: 14, qvinkThrough: 5, cairnThrough: 12 });
        expect(pendingScenes(done)).toEqual([]);
    });

    it('skips short and hidden messages, which never get a summary', () => {
        const chat = makeMixedChat({ length: 14, qvinkThrough: 5, cairnThrough: 12, short: [8], hidden: [10] });

        expect(pendingScenes(chat)).toEqual([]);
    });

    it('queues a gap and an edited message, oldest first', () => {
        const chat = makeMixedChat({ length: 14, qvinkThrough: 5, cairnThrough: 12, gaps: [9] });
        chat[7].mes += ' An afterthought.';

        expect(pendingScenes(chat)).toEqual([7, 9]);
    });

    it('leaves a newer Cairn\'s store alone rather than queueing a summary it cannot write', () => {
        const chat = makeMixedChat({ length: 14, qvinkThrough: 5, cairnThrough: 12, gaps: [9] });
        chat[9].extra.cairn = { v: 99, scene: { text: 'from the future' } };

        expect(pendingScenes(chat)).toEqual([]);
    });
});

describe('the history sent with a summary request', () => {
    it('is the five scenes just before the message, oldest first, from either source', () => {
        const chat = makeMixedChat({ length: 14, qvinkThrough: 5, cairnThrough: 12 });

        const history = sceneHistory(chat, 9);

        expect(SCENE_HISTORY).toBe(5);
        expect(history.map((scene) => scene.index)).toEqual([4, 5, 6, 7, 8]);
        expect(history.map((scene) => scene.source)).toEqual(['qvink', 'qvink', 'cairn', 'cairn', 'cairn']);
    });

    it('skips gaps and edited scenes rather than sending one that no longer matches its message', () => {
        const chat = makeMixedChat({ length: 14, qvinkThrough: 5, cairnThrough: 12, gaps: [7] });
        chat[8].mes += ' An afterthought.';

        expect(sceneHistory(chat, 10).map((scene) => scene.index)).toEqual([3, 4, 5, 6, 9]);
    });

    it('leaves out a summary the user excluded from memory', () => {
        const chat = makeQvinkChat({ length: 10, exclude: [7] });

        expect(sceneHistory(chat, 9).map((scene) => scene.index)).toEqual([3, 4, 5, 6, 8]);
    });

    it('is empty at the top of a chat', () => {
        expect(sceneHistory(makeMixedChat({ length: 6, qvinkThrough: -1, cairnThrough: -1 }), 0)).toEqual([]);
    });
});

describe('the fixture itself', () => {
    it('carries every key the real data has', () => {
        // A reader that depends on a key we did not model has to fail here, not
        // in play (CLAUDE.md §3.11).
        expect(Object.keys(makeQvinkData()).sort()).toEqual([
            'edited', 'error', 'exclude', 'hash', 'include',
            'lagging', 'memory', 'prefill', 'reasoning', 'remember', 'remember_auto',
        ]);
    });

    it('produces summaries in the range the corpus showed', () => {
        const scenes = readScenes(makeQvinkChat({ length: 30 }));
        const lengths = scenes.map((scene) => scene.chars);

        expect(Math.min(...lengths)).toBeGreaterThanOrEqual(196);
        expect(Math.max(...lengths)).toBeLessThanOrEqual(641);
        expect(new Set(scenes.map((scene) => scene.text)).size).toBe(30);
    });
});

/**
 * What the handover gate reads (src/prompt/handover.js). Both of these are about
 * the *other* extension's live state, and getting either wrong means two writers
 * in one prompt with nothing on screen to say so.
 */
describe('whether qvink is still writing', () => {
    it('sees a parked, placed injection', () => {
        const prompts = { qvink_memory_short: { value: '[recap]', position: 0 } };

        expect(qvinkInjecting(prompts)).toEqual(['qvink_memory_short']);
    });

    it('treats "Macro Only" as silent — the value stays, nothing places it', () => {
        // extension_prompt_types.NONE (public/script.js:484) matches no collected
        // position, so the value is parked and never placed.
        const prompts = { qvink_memory_short: { value: '[recap]', position: -1 } };

        expect(qvinkInjecting(prompts)).toEqual([]);
    });

    it('treats an empty injection as silent, and a missing one as not installed', () => {
        expect(qvinkInjecting({ qvink_memory_short: { value: '', position: 0 } })).toEqual([]);
        expect(qvinkInjecting({})).toEqual([]);
        expect(qvinkInjecting(undefined)).toEqual([]);
    });

    it('names both injections, because they are the same prompt', () => {
        const prompts = {
            qvink_memory_short: { value: 'a', position: 0 },
            qvink_memory_long: { value: 'b', position: 0 },
        };

        expect(qvinkInjecting(prompts)).toEqual(['qvink_memory_long', 'qvink_memory_short']);
    });
});

/**
 * ST keeps an extension's settings after it is disabled or removed, so a setting
 * alone says nothing about whether qvink still runs.
 */
describe('whether qvink is running', () => {
    const withQvink = (extensions = [QVINK_EXTENSION]) => createContext({ chat: [], extensions });

    it('is running when installed and enabled', () => {
        expect(qvinkRunning(withQvink())).toBe(true);
    });

    it('is not running when uninstalled, or disabled (public/scripts/extensions.js:626)', () => {
        const disabled = withQvink();
        disabled.extensionSettings.disabledExtensions.push(QVINK_EXTENSION);

        expect(qvinkRunning(withQvink([]))).toBe(false);
        expect(qvinkRunning(disabled)).toBe(false);
    });

    it('is running under another folder name once it has parked a block, even an empty one', () => {
        // Its refresh parks both keys on every chat (its index.js:4004-4005, :4022-4023).
        const renamed = withQvink(['third-party/my-qvink']);
        renamed.setExtensionPrompt('qvink_memory_short', '', -1, 2);

        expect(qvinkRunning(renamed)).toBe(true);
    });

    it('is not running on a bare or missing context', () => {
        expect(qvinkRunning({})).toBe(false);
        expect(qvinkRunning(undefined)).toBe(false);
    });
});

describe('whether qvink is still taking messages out of the history', () => {
    const running = (settings) => {
        const context = createContext({ chat: [], extensions: [QVINK_EXTENSION] });
        context.extensionSettings.qvink_memory = settings;
        return context;
    };

    it('reads its own setting', () => {
        expect(qvinkExcluding(running({ exclude_messages_after_threshold: true }))).toBe(true);
        expect(qvinkExcluding(running({ exclude_messages_after_threshold: false }))).toBe(false);
    });

    it('assumes its default when it has not been configured', () => {
        // Its own default is on (its index.js:136), so an unconfigured install is
        // still excluding and the gate stays shut.
        expect(qvinkExcluding(running({}))).toBe(true);
        expect(qvinkExcluding(running(undefined))).toBe(true);
    });

    it('is not excluding anything when it is not running, whatever its settings say', () => {
        const uninstalled = createContext({ chat: [] });
        uninstalled.extensionSettings.qvink_memory = { exclude_messages_after_threshold: true };

        expect(qvinkExcluding(uninstalled)).toBe(false);
        expect(qvinkExcluding(undefined)).toBe(false);
    });
});

/**
 * Two extensions summarising the same message pay for it twice and race to
 * write it. qvink's Auto Summarize has to be off before Cairn starts
 * (docs/how-it-works.md, "Writing summaries").
 */
describe('whether qvink is still summarising', () => {
    const running = (settings) => {
        const context = createContext({ chat: [], extensions: [QVINK_EXTENSION] });
        context.extensionSettings.qvink_memory = settings;
        return context;
    };

    it('reads its Auto Summarize setting', () => {
        expect(qvinkSummarising(running({ auto_summarize: true }))).toBe(true);
        expect(qvinkSummarising(running({ auto_summarize: false }))).toBe(false);
    });

    it('assumes its default, on, when it has not been configured', () => {
        // its index.js:116, read through `?? default_settings[key]` (:655).
        expect(QVINK_DEFAULTS.autoSummarize).toBe(true);
        expect(qvinkSummarising(running({}))).toBe(true);
    });

    it('is not summarising anything when it is not running, whatever its settings say', () => {
        const disabled = running({ auto_summarize: true });
        disabled.extensionSettings.disabledExtensions.push(QVINK_EXTENSION);
        const uninstalled = createContext({ chat: [] });
        uninstalled.extensionSettings.qvink_memory = { auto_summarize: true };

        expect(qvinkSummarising(disabled)).toBe(false);
        expect(qvinkSummarising(uninstalled)).toBe(false);
        expect(qvinkSummarising(undefined)).toBe(false);
    });
});
