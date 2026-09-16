import { describe, expect, it } from 'vitest';
import {
    QVINK_DEFAULTS,
    qvinkExcluding,
    qvinkInjected,
    qvinkInjecting,
    readScenes,
    resolvePlacement,
    resolveRendering,
} from '../src/memory/scenes.js';
import { makeQvinkChat, makeQvinkData, makeQvinkSettings } from './mocks/qvink.js';

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

    it('leaves the prefill out unless qvink is showing it (its index.js:3521)', () => {
        const chat = makeQvinkChat({ length: 1 });

        expect(readScenes(chat)[0].text.startsWith('Summary: ')).toBe(false);
        expect(readScenes(chat, { showPrefill: true })[0].text.startsWith('Summary: ')).toBe(true);
    });

    it('drops excluded scenes but lets a remembered one through anyway', () => {
        const chat = makeQvinkChat({ length: 6, exclude: [1, 2], remember: [2] });
        const eligible = readScenes(chat).filter((scene) => scene.eligible).map((s) => s.index);

        expect(eligible).toEqual([0, 2, 3, 4, 5]);
    });

    it('never mutates the chat it read', () => {
        const chat = makeQvinkChat({ length: 3 });
        const before = JSON.stringify(chat);
        readScenes(chat, { showPrefill: true });

        expect(JSON.stringify(chat)).toBe(before);
    });
});

describe('the set qvink is injecting', () => {
    it('is the included, non-lagging scenes (its index.js:3939)', () => {
        const scenes = readScenes(makeQvinkChat({ length: 20, summarisedThrough: 9 }));

        expect(qvinkInjected(scenes).map((scene) => scene.index)).toEqual([...Array(10).keys()]);
    });

    it('excludes a scene qvink flagged out of the short-term window', () => {
        const chat = makeQvinkChat({ length: 6, summarisedThrough: 5 });
        chat[2].extra.qvink_memory.include = null;

        expect(qvinkInjected(readScenes(chat)).map((s) => s.index)).toEqual([0, 1, 3, 4, 5]);
    });
});

describe('how the block is rendered', () => {
    it('follows qvink live settings so a handover is byte-identical for this user', () => {
        const rendering = resolveRendering({
            qvink_memory: makeQvinkSettings({
                short_template: '[Recap]\n{{memories}}',
                summary_injection_separator: '\n- ',
                show_prefill: true,
            }),
        });

        expect(rendering).toMatchObject({
            template: '[Recap]\n{{memories}}',
            separator: '\n- ',
            showPrefill: true,
            configured: true,
        });
    });

    it('falls back to qvink documented defaults when it is not installed', () => {
        const rendering = resolveRendering({});

        expect(rendering.template).toBe(QVINK_DEFAULTS.template);
        expect(rendering.separator).toBe(QVINK_DEFAULTS.separator);
        expect(rendering.configured).toBe(false);
    });

    it('treats an empty template as unconfigured rather than as an empty block', () => {
        const rendering = resolveRendering({ qvink_memory: { short_template: '' } });

        expect(rendering.template).toBe(QVINK_DEFAULTS.template);
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

describe('where the block goes', () => {
    it('mirrors qvink placement, so the handover moves only the writer', () => {
        const placement = resolvePlacement({
            qvink_memory: makeQvinkSettings({
                short_term_position: 1, short_term_depth: 4, short_term_role: 1, short_term_scan: true,
            }),
        });

        expect(placement).toEqual({ position: 1, depth: 4, role: 1, scan: true });
    });

    it('falls back to qvink own defaults when it is not configured', () => {
        expect(resolvePlacement({})).toEqual({
            position: QVINK_DEFAULTS.position,
            depth: QVINK_DEFAULTS.depth,
            role: QVINK_DEFAULTS.role,
            scan: QVINK_DEFAULTS.scan,
        });
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
        // position, and the value is what the fidelity check compares against.
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

describe('whether qvink is still taking messages out of the history', () => {
    it('reads its own setting', () => {
        expect(qvinkExcluding({ qvink_memory: { exclude_messages_after_threshold: true } })).toBe(true);
        expect(qvinkExcluding({ qvink_memory: { exclude_messages_after_threshold: false } })).toBe(false);
    });

    it('assumes its default when it has not been configured', () => {
        // Its own default is on (its index.js:136), so an unconfigured install is
        // still excluding and the gate stays shut.
        expect(qvinkExcluding({ qvink_memory: {} })).toBe(true);
    });

    it('is not excluding anything when it is not installed at all', () => {
        expect(qvinkExcluding({})).toBe(false);
    });
});
