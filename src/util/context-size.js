/**
 * How many tokens the prompt may actually occupy.
 *
 * ST already answers this: `getMaxPromptTokens` (public/script.js:5981) is the
 * context window minus the reserved response length, which is the number the
 * memory cap is a share of (pipeline/budgeter.js), and not one
 * we should be re-deriving (CLAUDE.md §2.5).
 * `getContext()` does not expose it (st-context.js:115), so it comes from
 * `script.js` the way every bundled extension imports it.
 *
 * The import is dynamic and specified absolutely. `/script.js` is the URL ST
 * itself loaded (public/index.html:8218) and the one every relative
 * `../../../script.js` resolves to, so it is the same module instance without
 * depending on how deeply we are installed. Dynamic because a failed import at
 * module scope would stop the extension loading, and a missing diagnostic number
 * must never do that (CLAUDE.md §4.17).
 */
import { debug, warn } from './log.js';

/**
 * Reserve when ST's own answer is unavailable. Deliberately generous:
 * overestimating the reserve costs a little memory, underestimating it overflows
 * the request, and Cairn never breaks the chat (CLAUDE.md §4.17).
 */
export const FALLBACK_RESERVE_FRACTION = 0.125;

const ST_SCRIPT = '/script.js';

/**
 * @param {{load?: () => Promise<object>}} [options] Injected in tests; there is
 *        no `/script.js` outside the browser.
 * @returns {(context: object) => Promise<number>}
 */
export function createMaxPromptTokens({ load = () => import(/* @vite-ignore */ ST_SCRIPT) } = {}) {
    /** undefined = not tried yet, null = tried and unavailable. */
    let resolved;

    return async function maxPromptTokens(context) {
        if (resolved === undefined) {
            try {
                const fn = (await load())?.getMaxPromptTokens;
                resolved = typeof fn === 'function' ? fn : null;
                debug(resolved ? 'Using ST\'s own prompt budget.' : 'ST exposes no getMaxPromptTokens; estimating.');
            } catch (err) {
                resolved = null;
                warn('Could not read ST\'s prompt budget; estimating from the context window.', err);
            }
        }

        if (resolved) {
            try {
                const tokens = Number(resolved());
                if (Number.isFinite(tokens) && tokens > 0) return Math.floor(tokens);
            } catch (err) {
                warn('ST\'s prompt budget threw; estimating from the context window.', err);
                resolved = null;
            }
        }

        return estimateMaxPromptTokens(context);
    };
}

/**
 * The fallback. Reserves a generous share of the window for the response,
 * because overestimating the reserve costs memory and underestimating it
 * overflows the request.
 */
export function estimateMaxPromptTokens(context) {
    const maxContext = Number(context?.maxContext) || 0;
    return Math.max(0, Math.floor(maxContext * (1 - FALLBACK_RESERVE_FRACTION)));
}

/**
 * Text completion stops adding history once the count reaches the limit
 * (public/script.js:4920), so a prompt that lost its oldest messages ends just
 * *under* the limit, not at it. Within this share of it is the flag.
 */
export const NEAR_LIMIT_FRACTION = 0.95;

/**
 * Whether a prompt was full enough that ST may have dropped raw history the block's
 * cap cannot see (docs/decisions.md D-0038). Null when the limit is unknown.
 *
 * @param {number} promptTokens What the observer counted.
 * @param {number} maxPromptTokens What the assembler planned against.
 */
export function nearPromptLimit(promptTokens, maxPromptTokens) {
    if (!(maxPromptTokens > 0) || !Number.isFinite(promptTokens)) return null;
    return promptTokens >= maxPromptTokens * NEAR_LIMIT_FRACTION;
}
