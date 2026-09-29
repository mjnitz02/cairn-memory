/**
 * WTracker and WTrackerLite: the state writers Cairn stands aside for (docs/decisions.md
 * D-0046), and whether one is loaded on this page.
 *
 * Pure: plain data in, plain data out. No ST, no DOM, no network.
 */

/**
 * The two state writers Cairn stands aside for (D-0046). Folders are the ones
 * their repositories clone into, under ST's `third-party/` prefix
 * (src/endpoints/extensions.js:518). Interceptor names are from their manifests:
 * WTrackerLite's manifest.json, and WTracker's at github.com/bmen25124/SillyTavern-WTracker.
 */
export const WTRACKERS = Object.freeze([
    Object.freeze({
        name: 'WTrackerLite',
        extension: 'third-party/SillyTavern-WTrackerLite',
        interceptor: 'wtrackerliteGenerateInterceptor',
    }),
    Object.freeze({
        name: 'WTracker',
        extension: 'third-party/SillyTavern-WTracker',
        interceptor: 'wtrackerGenerateInterceptor',
    }),
]);

/**
 * Which state writer is loaded, if any: a second one in the prompt is what this
 * project exists to end. Loaded means its interceptor is defined, which only its
 * running code does (ST calls it by that name, public/scripts/extensions.js:2035),
 * or its manifest is installed and not disabled (:524, :626). Its settings are
 * never read: they outlive it (docs/decisions.md D-0040).
 *
 * @param {object} context SillyTavern.getContext()
 * @param {{scope?: object}} [options] Where interceptors are defined; `globalThis` in ST.
 * @returns {string|null} Its display name.
 */
export function wtrackerLoaded(context, { scope = globalThis } = {}) {
    const { extensionSettings, getExtensionManifest } = context ?? {};
    const disabled = extensionSettings?.disabledExtensions ?? [];
    const loaded = WTRACKERS.find((tracker) => typeof scope?.[tracker.interceptor] === 'function'
        || (Boolean(getExtensionManifest?.(tracker.extension)) && !disabled.includes(tracker.extension)));
    return loaded?.name ?? null;
}
