/**
 * Tier 2 — scene summaries (DESIGN.md §5).
 *
 * Tier 2 has two sources, one scene per message: the summaries qvink already
 * wrote, read and never rewritten, and Cairn's own in `extra.cairn`, which win
 * where both exist and count only while their message is unedited
 * (docs/decisions.md D-0037). The scene shape is the same for both, so the assembler
 * does not care which wrote it.
 *
 * Nothing else is read from qvink except whether it is still in the path: loaded,
 * and injecting, excluding or summarising (docs/decisions.md D-0040).
 *
 * Pure: plain data in, plain data out. No ST, no DOM, no network.
 */

import { readScene, summarisable } from '../store/chat-store.js';

/** qvink's `message.extra` key and settings key (its index.js:45). */
export const QVINK_KEY = 'qvink_memory';

/** The injection it parks its short-term block under (its index.js:4023). */
export const QVINK_SHORT_INJECTION = 'qvink_memory_short';

/** And its long-term one, from the same call (its index.js:4022). */
export const QVINK_LONG_INJECTION = 'qvink_memory_long';

/**
 * qvink's install folder, as its repository clones (github.com/qvink/SillyTavern-MessageSummarize),
 * under the prefix ST gives every user extension (src/endpoints/extensions.js:518).
 */
export const QVINK_EXTENSION = 'third-party/SillyTavern-MessageSummarize';

/** qvink's own defaults for the two switches Cairn reads, cited so the fallback is not a guess. */
export const QVINK_DEFAULTS = Object.freeze({
    /** its index.js:136 */
    excludeAfterThreshold: true,
    /** its index.js:116 */
    autoSummarize: true,
});

/**
 * Every message carrying a scene, oldest first.
 *
 * A qvink `text` is its `memory` alone. Its prefill reaches its own block only
 * with `show_prefill` on (its index.js:3521), which is off by default (:113).
 *
 * @param {Array<object>} chat ST's live message array. Read only, never mutated.
 * @param {{key?: string}} [options]
 * @returns {Array<object>} `{index, source, text, chars, eligible, remembered,
 *          excluded, include, lagging}`
 */
export function readScenes(chat, { key = QVINK_KEY } = {}) {
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

        const remembered = Boolean(data.remember);
        const excluded = Boolean(data.exclude);

        scenes.push({
            index,
            source: 'qvink',
            text: memory,
            chars: memory.length,
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
 * would insert scenes into the middle of the block (docs/decisions.md D-0037).
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
 * swiped, regenerated or edited (docs/decisions.md D-0037).
 *
 * @returns {number[]} Chat indexes.
 */
export function pendingScenes(chat, { key = QVINK_KEY } = {}) {
    const list = chat ?? [];
    const pending = [];
    for (let index = cairnStart(list, { key }); index < list.length - 1; index++) {
        const message = list[index];
        if (!summarisable(message)) continue;
        // A newer Cairn's store is not ours to overwrite (store/chat-store.js).
        const { status } = readScene(message);
        if (status !== 'valid' && status !== 'future') pending.push(index);
    }
    return pending;
}

/** Scenes sent back with each summary request (docs/decisions.md D-0037). */
export const SCENE_HISTORY = 5;

/**
 * The scenes just before a message, oldest first: what Matt's qvink profile sends
 * back as context, from either source, and never one the user excluded.
 *
 * @returns {Array<object>} Scenes as `readScenes` returns them.
 */
export function sceneHistory(chat, index, { count = SCENE_HISTORY, key = QVINK_KEY } = {}) {
    return readScenes(chat, { key })
        .filter((scene) => scene.index < index && scene.eligible)
        .slice(-count);
}

/**
 * Which of qvink's injections ST would still place this turn.
 *
 * Read from what it actually parked rather than from its settings: the parked
 * object is the thing ST collects, and `getExtensionPrompt` takes anything with a
 * matching position and a non-empty value (public/script.js:3310-3313). Its
 * "Macro Only" position is `extension_prompt_types.NONE` (-1, public/script.js:484),
 * which matches no collected position, so the value is parked and nothing places
 * it. That is the switch the handover asks for (its settings.html:244).
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
 * Whether qvink is loaded on this page. ST never loads a disabled extension
 * (public/scripts/extensions.js:626) and disabling one reloads the page (:490);
 * an uninstalled one has no manifest (:524). Its parked injections (its
 * index.js:4004-4005, :4022-4023) count too, so an install under another folder
 * name is still seen once it has refreshed a chat.
 *
 * Its settings outlive it, so they say nothing on their own about whether it runs.
 *
 * @param {object} context SillyTavern.getContext()
 */
export function qvinkRunning(context) {
    const { extensionSettings, extensionPrompts, getExtensionManifest } = context ?? {};
    if ([QVINK_LONG_INJECTION, QVINK_SHORT_INJECTION].some((key) => Object.hasOwn(extensionPrompts ?? {}, key))) {
        return true;
    }
    return Boolean(getExtensionManifest?.(QVINK_EXTENSION))
        && !(extensionSettings?.disabledExtensions ?? []).includes(QVINK_EXTENSION);
}

/**
 * Whether qvink is still blanking summarised messages — its
 * `exclude_messages_after_threshold` (its index.js:136, :3980). Two extensions
 * writing the same ignore flag from different thresholds is D-0020's whole point.
 *
 * @param {object} context SillyTavern.getContext()
 */
export function qvinkExcluding(context, { key = QVINK_KEY } = {}) {
    if (!qvinkRunning(context)) return false;
    const settings = context.extensionSettings?.[key];
    return Boolean(settings?.exclude_messages_after_threshold ?? QVINK_DEFAULTS.excludeAfterThreshold);
}

/**
 * Whether qvink is still writing summaries — its Auto Summarize, read the way it
 * reads it (its index.js:655). Cairn summarising the same messages would pay for
 * each twice and race qvink to the store (docs/how-it-works.md, "Writing summaries").
 *
 * @param {object} context SillyTavern.getContext()
 */
export function qvinkSummarising(context, { key = QVINK_KEY } = {}) {
    if (!qvinkRunning(context)) return false;
    const settings = context.extensionSettings?.[key];
    return Boolean(settings?.auto_summarize ?? QVINK_DEFAULTS.autoSummarize);
}
