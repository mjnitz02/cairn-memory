/**
 * qvink (github.com/qvink/SillyTavern-MessageSummarize): whether it is still in the path —
 * loaded, and injecting, excluding, summarising or displaying (docs/decisions.md D-0040).
 * Its summaries are read as scenes by memory/scenes.js; nothing else of it is read.
 *
 * Pure: plain data in, plain data out. No ST, no DOM, no network.
 */

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
    /** its index.js:160 */
    displayMemories: true,
});

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

/**
 * Whether qvink draws its own summaries under messages — its `display_memories`
 * (its index.js:160, :1460), read the way `qvinkSummarising` reads its switch.
 * Cairn shows qvink's summaries only when qvink doesn't, so none shows twice.
 *
 * @param {object} context SillyTavern.getContext()
 */
export function qvinkDisplaying(context, { key = QVINK_KEY } = {}) {
    if (!qvinkRunning(context)) return false;
    const settings = context.extensionSettings?.[key];
    return Boolean(settings?.display_memories ?? QVINK_DEFAULTS.displayMemories);
}
