import { describe, expect, it } from 'vitest';
import {
    QVINK_DEFAULTS,
    QVINK_EXTENSION,
    qvinkExcluding,
    qvinkInjecting,
    qvinkRunning,
    qvinkSummarising,
} from '../src/interop/qvink.js';
import { createContext } from './mocks/sillytavern.js';

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
