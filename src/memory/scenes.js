/**
 * Tier 2 — scene summaries (DESIGN.md §5).
 *
 * P1 does not generate summaries. It reads the ones qvink has already written
 * into `message.extra` and takes over where they go (DESIGN.md §13;
 * docs/decisions.md D-0020). So this is tier 2's *source*, and at P2 its innards
 * change while its shape does not.
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
});

/**
 * Every message carrying a summary, oldest first.
 *
 * `text` is built the way qvink builds it for injection — prefill prepended only
 * when `show_prefill` is on (its index.js:3521) — because a block that differs
 * from qvink's by a prefix is not a block we can hand over byte-identically.
 *
 * @param {Array<object>} chat ST's live message array. Read only, never mutated.
 * @param {{key?: string, showPrefill?: boolean}} [options]
 * @returns {Array<object>} `{index, text, chars, eligible, remembered, excluded, include, lagging}`
 */
export function readScenes(chat, { key = QVINK_KEY, showPrefill = false } = {}) {
    const scenes = [];

    (chat ?? []).forEach((message, index) => {
        const data = message?.extra?.[key];
        const memory = data?.memory;
        if (typeof memory !== 'string' || memory === '') return;

        const text = showPrefill ? `${data.prefill ?? ''}${memory}` : memory;
        const remembered = Boolean(data.remember);
        const excluded = Boolean(data.exclude);

        scenes.push({
            index,
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
 * Where qvink parks the block, so Cairn parks it in the same place.
 *
 * The handover has to change *one* thing — who writes — or the measurement
 * afterwards cannot separate "the block moved" from "the block's contents
 * changed" (docs/decisions.md D-0027). Moving it to where DESIGN.md §6 wants it
 * is a later change, made on its own and measured on its own.
 *
 * @param {object} extensionSettings `context.extensionSettings`
 * @returns {{position: number, depth: number, role: number, scan: boolean}}
 *          `setExtensionPrompt`'s arguments (public/script.js:8926).
 */
export function resolvePlacement(extensionSettings, { key = QVINK_KEY } = {}) {
    const settings = extensionSettings?.[key];

    return {
        position: numberOr(settings?.short_term_position, QVINK_DEFAULTS.position),
        depth: numberOr(settings?.short_term_depth, QVINK_DEFAULTS.depth),
        role: numberOr(settings?.short_term_role, QVINK_DEFAULTS.role),
        scan: Boolean(settings?.short_term_scan ?? QVINK_DEFAULTS.scan),
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
