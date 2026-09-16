import { describe, expect, it } from 'vitest';
import {
    QVINK_DEFAULTS,
    cairnStart,
    pendingScenes,
    qvinkExcluding,
    qvinkInjected,
    qvinkInjecting,
    readScenes,
    resolveCap,
    resolvePlacement,
    resolveRendering,
} from '../src/memory/scenes.js';
import { makeQvinkChat, makeQvinkData, makeQvinkSettings } from './mocks/qvink.js';
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

/**
 * Two sources, one scene per message (docs/p2-plan.md §1). qvink's summaries are
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
        // Cairn's, so it is no better (docs/p2-plan.md §1).
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

        expect(placement).toEqual({ position: 1, depth: 4, role: 1, scan: true, defaulted: false });
    });

    it('falls back to qvink own defaults when it is not configured', () => {
        expect(resolvePlacement({})).toEqual({
            position: QVINK_DEFAULTS.position,
            depth: QVINK_DEFAULTS.depth,
            role: QVINK_DEFAULTS.role,
            scan: QVINK_DEFAULTS.scan,
            defaulted: true,
        });
    });

    it('does not mirror "Macro Only" — that is the switch the handover asks for', () => {
        // Mirroring NONE parks our block where nothing collects it, on the very
        // turn we also start holding messages back (docs/decisions.md D-0029).
        const placement = resolvePlacement({
            qvink_memory: makeQvinkSettings({ short_term_position: -1, short_term_depth: 16 }),
        });

        expect(placement.position).toBe(QVINK_DEFAULTS.position);
        expect(placement.defaulted).toBe(true);
        // The rest of the placement is still theirs.
        expect(placement.depth).toBe(16);
    });
});

/**
 * What the handover gate reads (src/prompt/handover.js). Both of these are about
 * the *other* extension's live state, and getting either wrong means two writers
 * in one prompt with nothing on screen to say so.
 */
/**
 * The block's cap is qvink's own limit, resolved as qvink resolves it
 * (its index.js:246-256), so the same chat always gets the same budget
 * (docs/decisions.md D-0033).
 */
describe('how much room the block gets', () => {
    it('takes a token limit as it is', () => {
        const settings = { qvink_memory: makeQvinkSettings({ short_term_context_limit: 7500, short_term_context_type: 'tokens' }) };

        expect(resolveCap(settings, 22_016)).toEqual({ cap: 7500, type: 'tokens' });
    });

    it('takes a percent limit as a share of the prompt budget', () => {
        const settings = { qvink_memory: makeQvinkSettings({ short_term_context_limit: 30, short_term_context_type: 'percent' }) };

        expect(resolveCap(settings, 22_016)).toEqual({ cap: 6604, type: 'percent' });
    });

    it('falls back to qvink own default when it is not configured', () => {
        expect(resolveCap({}, 20_000)).toEqual({ cap: 20_000 * QVINK_DEFAULTS.limit / 100, type: 'percent' });
    });

    it('never goes negative, whatever the settings say', () => {
        const settings = { qvink_memory: makeQvinkSettings({ short_term_context_limit: -5 }) };

        expect(resolveCap(settings, 22_016).cap).toBe(0);
        expect(resolveCap({}, undefined).cap).toBe(0);
    });
});

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
