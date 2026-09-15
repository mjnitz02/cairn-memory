/**
 * The write side: everything Cairn puts into someone else's prompt goes through
 * here (DESIGN.md §11). P1 step 1 is the World Info holder.
 *
 * ST re-derives the activated set from a two-message keyword scan every turn.
 * When that scan happens to seed nothing the whole lore block vanishes and comes
 * back a turn later — two full prompt rebuilds for a set that never actually
 * changed. The holder pushes the remembered set back in *before* the scan, so a
 * dropout cannot evict it (docs/decisions.md D-0023).
 *
 * How the push works, since none of it is obvious:
 *
 *   - `WORLDINFO_FORCE_ACTIVATE` (world-info.js:1020) seeds
 *     `WorldInfoBuffer.externalActivations`, which the scan consults at :4886 —
 *     ahead of the keyword match, so a forced entry needs no keyword.
 *   - `resetExternalEffects()` runs at the end of *every* `checkWorldInfo`
 *     (:5275), so the push is good for exactly one generation and has to be
 *     repeated each turn.
 *   - The generate interceptor is the only hook that runs late enough to know the
 *     turn is real and early enough to beat the scan: script.js:4564 against
 *     :4635. Dry runs skip interceptors entirely (:4562), and WORLD_INFO_ACTIVATED
 *     is not emitted on them (:900), so neither path can pollute the set.
 *
 * Ordering comes out deterministic, but not for the reason it first appears.
 * Forced entries enter `activatedNow` as *our* objects, which are not identity
 * members of `sortedEntries`, so the tiebreak `sortedEntriesIndex.get(a) ?? -1`
 * (:4996-5002) scores every one of them -1. They therefore tie, and a stable sort
 * leaves them in insertion order — which is the scan's walk over `sortedEntries`,
 * itself deterministic. Final prompt order is `sortFn` on `order` (:5203) with
 * that as the tiebreak.
 *
 * Cairn never breaks the chat (CLAUDE.md §4.17): every path here degrades to
 * "let ST do what it would have done anyway".
 */
import { createRememberedSet } from './lorebook.js';
import { debug, toastOnce, warn } from '../util/log.js';

/**
 * Takes a *getter*, not a context — `SillyTavern.getContext()` is a snapshot
 * (docs/st-api-surface.md, Hazards).
 *
 * @param {() => object} getContext Returns a fresh SillyTavern.getContext()
 * @param {{remembered?: object}} [options]
 */
export function createInjector(getContext, { remembered = createRememberedSet() } = {}) {
    let running = false;
    let enabled = true;

    /** Add-only: learn every entry ST activated, including ones we forced. */
    function onWorldInfoActivated(entries) {
        try {
            const { added } = remembered.observe(entries);
            if (added.length) debug(`World Info: holding ${added.length} new (${remembered.size} total).`);
        } catch (err) {
            warn('Failed to record World Info activations for holding.', err);
        }
    }

    /** A saved book invalidates our snapshot of it (world-info.js:4160). */
    function onWorldInfoUpdated(name) {
        try {
            const dropped = remembered.forget(name);
            if (dropped) debug(`World Info: released ${dropped} entries after "${name}" was edited.`);
        } catch (err) {
            warn('Failed to release World Info entries after a book edit.', err);
        }
    }

    /**
     * ST's generate interceptor — `(chat, contextSize, abort, type)`,
     * extensions.js:2037. We read nothing from `chat` and write nothing to it:
     * the no-clone rule (DESIGN.md §9) is satisfied by not touching it at all.
     */
    async function intercept(_chat, _contextSize, _abort, type) {
        // `running` is checked here and not only at registration: ST resolves the
        // interceptor off globalThis for the life of the page (extensions.js:2035),
        // so switching Cairn off has to be honoured at call time or it keeps
        // writing to the prompt after being told to stop.
        //
        // A quiet prompt is someone else's utility call, not the roleplay turn
        // whose prefix we are protecting (vectors does the same, its index.js:778).
        if (!running || !enabled || type === 'quiet' || remembered.size === 0) return;

        try {
            const { eventSource, eventTypes } = getContext();
            await eventSource.emit(eventTypes.WORLDINFO_FORCE_ACTIVATE, remembered.entries());
            debug(`World Info: forced ${remembered.size} held entries.`);
        } catch (err) {
            // Degrading here means ST scans as usual — a possible rebuild, never
            // a broken generation.
            warn('Failed to hold the World Info block; falling back to ST\'s own scan.', err);
            toastOnce('Cairn could not hold the World Info block this turn. Lore is unaffected.');
        }
    }

    return {
        start() {
            if (running) return;
            const { eventSource, eventTypes } = getContext();
            eventSource.on(eventTypes.WORLD_INFO_ACTIVATED, onWorldInfoActivated);
            eventSource.on(eventTypes.WORLDINFO_UPDATED, onWorldInfoUpdated);
            running = true;
            debug('Injector started.');
        },

        stop() {
            if (!running) return;
            const { eventSource, eventTypes } = getContext();
            eventSource.removeListener(eventTypes.WORLD_INFO_ACTIVATED, onWorldInfoActivated);
            eventSource.removeListener(eventTypes.WORLDINFO_UPDATED, onWorldInfoUpdated);
            running = false;
            // Whatever we were holding is stale by the time we are switched back
            // on, and a stale hold is worse than a rebuild.
            remembered.clear();
            debug('Injector stopped.');
        },

        /**
         * The holder alone, separate from `enabled`, so a run can be measured
         * with and without it while the observer keeps recording either way.
         */
        setHoldEnabled(value) {
            enabled = Boolean(value);
            debug(`World Info holding ${enabled ? 'on' : 'off'}.`);
        },

        /** A new chat is a new set — another character's lore is not ours to hold. */
        reset() {
            remembered.clear();
        },

        intercept,
        remembered,

        get running() {
            return running;
        },
    };
}
