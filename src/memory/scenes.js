/**
 * Tier 2 — scene summaries (DESIGN.md §5).
 *
 * Tier 2 has two sources, one scene per message: the summaries qvink already
 * wrote, read and never rewritten, and Cairn's own in `extra.cairn`, which win
 * where both exist and count only while their message is unedited
 * (docs/p2-plan.md §1). The scene shape is the same for both, so the assembler
 * does not care which wrote it.
 *
 * Two selections come out of here and they are not the same thing:
 *
 *   - `readScenes` + `eligible` — every summary that could be injected. Which of
 *     them actually are is Cairn's policy (pipeline/scheduler.js for the growth
 *     cadence, pipeline/budgeter.js for the eviction one).
 *   - `qvinkInjected` — the set qvink itself is injecting right now, taken from
 *     the flags it wrote. That is the mirror the fidelity check renders against,
 *     and it must follow qvink's rule rather than ours or it proves nothing.
 *
 * Pure: a chat array in, a scene list out. No ST, no DOM, no network.
 */

import { readScene, summarisable } from '../store/chat-store.js';

/** qvink's `message.extra` key and settings key (its index.js:45). */
export const QVINK_KEY = 'qvink_memory';

/** The injection it parks its short-term block under (its index.js:4023). */
export const QVINK_SHORT_INJECTION = 'qvink_memory_short';

/** And its long-term one, from the same call (its index.js:4022). */
export const QVINK_LONG_INJECTION = 'qvink_memory_long';

/**
 * qvink's own defaults, for when it is not installed or has not been configured.
 * Cited so the fallback is a known shape rather than a guess.
 */
export const QVINK_DEFAULTS = Object.freeze({
    /** its index.js:93 */
    template: '[Following is a list of recent events]:\n{{memories}}\n',
    /** its index.js:133 */
    separator: '\n* ',
    /** its index.js:69 */
    macro: 'memories',
    /** its index.js:113 */
    showPrefill: false,
    /** its index.js:153 — IN_PROMPT, i.e. after the story string. */
    position: 0,
    /** its index.js:154 */
    depth: 2,
    /** its index.js:155 — extension_prompt_roles.SYSTEM */
    role: 0,
    /** its index.js:156 */
    scan: false,
    /** its index.js:136 */
    excludeAfterThreshold: true,
    /** its index.js:151 */
    limit: 10,
    /** its index.js:152 — `percent` of the prompt budget, or `tokens`. */
    limitType: 'percent',
});

/**
 * Every message carrying a scene, oldest first.
 *
 * A qvink `text` is built the way qvink builds it for injection — prefill
 * prepended only when `show_prefill` is on (its index.js:3521) — because the
 * qvink part of the block must stay byte-identical to what it was in P1.
 *
 * @param {Array<object>} chat ST's live message array. Read only, never mutated.
 * @param {{key?: string, showPrefill?: boolean}} [options]
 * @returns {Array<object>} `{index, source, text, chars, eligible, remembered,
 *          excluded, include, lagging}`
 */
export function readScenes(chat, { key = QVINK_KEY, showPrefill = false } = {}) {
    const scenes = [];

    (chat ?? []).forEach((message, index) => {
        const cairn = readScene(message);
        if (cairn.status === 'valid') {
            scenes.push({
                index,
                source: 'cairn',
                text: cairn.scene.text,
                chars: cairn.scene.text.length,
                eligible: true,
                remembered: false,
                excluded: false,
                include: null,
                lagging: false,
            });
            return;
        }
        // An edit invalidated Cairn's scene, and any qvink one on the same
        // message is older still: the message goes back to being raw.
        if (cairn.status === 'stale') return;

        const data = message?.extra?.[key];
        const memory = data?.memory;
        if (typeof memory !== 'string' || memory === '') return;

        const text = showPrefill ? `${data.prefill ?? ''}${memory}` : memory;
        const remembered = Boolean(data.remember);
        const excluded = Boolean(data.exclude);

        scenes.push({
            index,
            source: 'qvink',
            text,
            chars: text.length,
            // qvink's exclusion rule, minus the parts we cannot see from `extra`:
            // a `remember` flag bypasses everything, an `exclude` flag removes it
            // (its index.js:3745-3760). The message-length test is not reproduced
            // — a message too short to summarise has no summary to read.
            eligible: remembered || !excluded,
            remembered,
            excluded,
            include: data.include ?? null,
            lagging: Boolean(data.lagging),
        });
    });

    return scenes;
}

/**
 * Where Cairn's summarising starts: just after qvink's newest summary. Messages
 * qvink skipped before it stay as qvink left them, because summarising them now
 * would insert scenes into the middle of the block (docs/p2-plan.md §1).
 */
export function cairnStart(chat, { key = QVINK_KEY } = {}) {
    const list = chat ?? [];
    for (let index = list.length - 1; index >= 0; index--) {
        const memory = list[index]?.extra?.[key]?.memory;
        if (typeof memory === 'string' && memory !== '') return index + 1;
    }
    return 0;
}

/**
 * Messages waiting for a summary, oldest first: summarisable, at or after the
 * start, with no valid scene — and never the last message, which can still be
 * swiped, regenerated or edited (docs/p2-plan.md §3).
 *
 * @returns {number[]} Chat indexes.
 */
export function pendingScenes(chat, { key = QVINK_KEY } = {}) {
    const list = chat ?? [];
    const pending = [];
    for (let index = cairnStart(list, { key }); index < list.length - 1; index++) {
        const message = list[index];
        if (summarisable(message) && readScene(message).status !== 'valid') pending.push(index);
    }
    return pending;
}

/**
 * The scenes qvink is injecting this turn, by its own flags.
 *
 * `collect_chat_messages('short')` (its index.js:3939): has a summary, is not
 * lagging, and is flagged `include === 'short'`. Lagging messages are summarised
 * but still in the raw window, so injecting them would duplicate them.
 */
export function qvinkInjected(scenes) {
    return (scenes ?? []).filter((scene) => scene.include === 'short' && !scene.lagging);
}

/**
 * How the block is rendered, taken from qvink's live settings so a handover is
 * byte-identical for *this* user rather than for the defaults.
 *
 * Only rendering is read from qvink. The cadences are Cairn's own
 * (docs/decisions.md D-0026) — reading those would import the behaviour P1 exists
 * to replace.
 *
 * @param {object} extensionSettings `context.extensionSettings`
 */
export function resolveRendering(extensionSettings, { key = QVINK_KEY } = {}) {
    const settings = extensionSettings?.[key];

    return {
        template: stringOr(settings?.short_template, QVINK_DEFAULTS.template),
        separator: stringOr(settings?.summary_injection_separator, QVINK_DEFAULTS.separator),
        macro: QVINK_DEFAULTS.macro,
        showPrefill: settings?.show_prefill ?? QVINK_DEFAULTS.showPrefill,
        configured: Boolean(settings),
    };
}

/**
 * The block's cap: qvink's short-term limit, resolved the way qvink resolves it
 * (its index.js:246-256). A setting the user already chose, fixed for the chat,
 * so the same chat always gets the same block (docs/decisions.md D-0033).
 *
 * @param {object} extensionSettings `context.extensionSettings`
 * @param {number} maxPromptTokens What `percent` is a percent of. qvink's
 *        `getMaxContextSize` is ST's `getMaxPromptTokens` under another name
 *        (public/script.js:333).
 * @returns {{cap: number, type: string}}
 */
export function resolveCap(extensionSettings, maxPromptTokens, { key = QVINK_KEY } = {}) {
    const settings = extensionSettings?.[key];
    const limit = Math.max(0, numberOr(settings?.short_term_context_limit, QVINK_DEFAULTS.limit));
    const type = settings?.short_term_context_type === 'tokens' ? 'tokens' : QVINK_DEFAULTS.limitType;

    if (type === 'tokens') return { cap: Math.floor(limit), type };
    const max = Number.isFinite(maxPromptTokens) ? Math.max(0, maxPromptTokens) : 0;
    return { cap: Math.floor(max * limit / 100), type };
}

/**
 * Where qvink parks the block, so Cairn parks it in the same place.
 *
 * The handover has to change *one* thing — who writes — or the measurement
 * afterwards cannot separate "the block moved" from "the block's contents
 * changed" (docs/decisions.md D-0027). Moving it to where DESIGN.md §6 wants it
 * is a later change, made on its own and measured on its own.
 *
 * **`NONE` is not a placement.** It is how the user silences qvink — the very act
 * the handover asks of them — so mirroring it would park our block where nothing
 * places it, on the one turn we also start holding messages back
 * (docs/decisions.md D-0029). A silent qvink has no placement to copy, so we take
 * its own default instead and say the placement was defaulted.
 *
 * @param {object} extensionSettings `context.extensionSettings`
 * @returns {{position: number, depth: number, role: number, scan: boolean,
 *            defaulted: boolean}}
 *          `setExtensionPrompt`'s arguments (public/script.js:8926).
 */
export function resolvePlacement(extensionSettings, { key = QVINK_KEY } = {}) {
    const settings = extensionSettings?.[key];
    const wanted = Number(settings?.short_term_position);
    // Mirrored only when qvink names a position ST actually collects; `defaulted`
    // says we chose rather than copied, which is what the inspector reports.
    const mirrored = Number.isFinite(wanted) && wanted >= 0;

    return {
        position: mirrored ? wanted : QVINK_DEFAULTS.position,
        depth: numberOr(settings?.short_term_depth, QVINK_DEFAULTS.depth),
        role: numberOr(settings?.short_term_role, QVINK_DEFAULTS.role),
        scan: Boolean(settings?.short_term_scan ?? QVINK_DEFAULTS.scan),
        defaulted: !mirrored,
    };
}

/**
 * Which of qvink's injections ST would still place this turn.
 *
 * Read from what it actually parked rather than from its settings: the parked
 * object is the thing ST collects, and `getExtensionPrompt` takes anything with a
 * matching position and a non-empty value (public/script.js:3310-3313). Its
 * "Macro Only" position is `extension_prompt_types.NONE` (-1, public/script.js:484),
 * which matches no collected position — so the value stays available for the
 * fidelity check while nothing places it. That is the switch the handover asks
 * for (its settings.html:244).
 *
 * @param {object} extensionPrompts `context.extensionPrompts`
 * @returns {string[]} Injection keys, empty when qvink is silent.
 */
export function qvinkInjecting(extensionPrompts) {
    return [QVINK_LONG_INJECTION, QVINK_SHORT_INJECTION].filter((key) => {
        const parked = extensionPrompts?.[key];
        return Boolean(parked?.value) && Number(parked.position) >= 0;
    });
}

/**
 * Whether qvink is still blanking summarised messages — its
 * `exclude_messages_after_threshold` (its index.js:136, :3980). Two extensions
 * writing the same ignore flag from different thresholds is D-0020's whole point.
 */
export function qvinkExcluding(extensionSettings, { key = QVINK_KEY } = {}) {
    const settings = extensionSettings?.[key];
    if (!settings) return false;
    return Boolean(settings.exclude_messages_after_threshold ?? QVINK_DEFAULTS.excludeAfterThreshold);
}

function numberOr(value, fallback) {
    const number = Number(value);
    return Number.isFinite(number) ? number : fallback;
}

function stringOr(value, fallback) {
    return typeof value === 'string' && value !== '' ? value : fallback;
}
