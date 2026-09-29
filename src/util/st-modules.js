/**
 * ST's own modules, for what `getContext()` does not expose (public/scripts/st-context.js:115-309).
 *
 * **Absolute specifiers**, because they are the URLs ST itself loaded: `/script.js` from
 * public/index.html:8218, and `./scripts/world-info.js` from it (public/script.js:52). A
 * relative `../../../script.js` resolves to the same URL only at one install depth, and a
 * different URL would be a second module instance.
 *
 * **Dynamic imports**, because a failed import at module scope would stop the extension
 * loading, and a missing diagnostic or reserve must never do that (CLAUDE.md §4.17). Each
 * caller takes its loader as an option, since neither URL exists outside the browser.
 */

/** Where `getMaxPromptTokens` lives (util/context-size.js). */
export const loadScript = () => import(/* @vite-ignore */ '/script.js');

/** Where the World Info budget, its cap and `getSortedEntries` live (prompt/reserves.js, prompt/lore-cap.js). */
export const loadWorldInfo = () => import(/* @vite-ignore */ '/scripts/world-info.js');
