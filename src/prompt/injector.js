/**
 * The write side: everything Cairn puts into someone else's prompt goes through
 * here (DESIGN.md §11). Three writes, all in the generate interceptor: the World
 * Info holder (P1 step 1), the memory block (P1 step 3) and the world state (P3).
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
import { SLUG } from '../constants.js';
import { createRememberedSet } from './lorebook.js';
import { STATE_INJECTION } from './state-placement.js';
import { debug, toastOnce, warn } from '../util/log.js';

/**
 * Our injection key. `getExtensionPrompt` sorts the keys (public/script.js:3310),
 * so this name decides where the block sits among other injections at the same
 * position — it is not the same slot qvink's `qvink_memory_short` held, and the
 * inspector's locate.js is what shows the difference (docs/decisions.md D-0027).
 */
export const MEMORY_INJECTION = `${SLUG}_memory`;

/**
 * Takes a *getter*, not a context — `SillyTavern.getContext()` is a snapshot
 * (docs/st-api-surface.md, Hazards).
 *
 * @param {() => object} getContext Returns a fresh SillyTavern.getContext()
 * @param {{remembered?: object, memory?: {plan: () => Promise<object>},
 *          state?: {plan: (chat: Array<object>, step: object) => Promise<object>}}} [options]
 *        `memory` is the assembler. It is asked for a plan every turn and the
 *        plan says whether Cairn may write it (prompt/handover.js). `state` is the
 *        world state's placement (prompt/state-placement.js).
 */
export function createInjector(getContext, { remembered = createRememberedSet(), memory = null, state = null } = {}) {
    let running = false;
    let enabled = true;
    /** Whether our block and our state are parked right now, so each is cleared exactly once. */
    let parked = false;
    let stateParked = false;
    /**
     * The `extra` objects we set the ignore flag on last turn. Identity, not
     * index: it survives a branch, and it is what makes clearing our own flags
     * different from clearing everyone's.
     */
    let flagged = new Set();

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
     * extensions.js:2037. `chat` is read to place the state and never written to or
     * copied, which is how the no-clone rule (DESIGN.md §9) is kept.
     */
    async function intercept(chat, _contextSize, _abort, type) {
        // `running` is checked here and not only at registration: ST resolves the
        // interceptor off globalThis for the life of the page (extensions.js:2035),
        // so switching Cairn off has to be honoured at call time or it keeps
        // writing to the prompt after being told to stop.
        //
        // A quiet prompt is someone else's utility call, not the roleplay turn
        // whose prefix we are protecting (vectors does the same, its index.js:778).
        if (!running || type === 'quiet') return;

        await holdWorldInfo();
        const plan = await applyMemory();
        await applyState(chat, plan);
    }

    /** P1 step 1 — push the held lore back in before ST's scan reads it. */
    async function holdWorldInfo() {
        if (!enabled || remembered.size === 0) return;

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

    /**
     * P1 step 3 — the handover. Park the block and hold back the messages it
     * speaks for, or park nothing and hold back nothing.
     *
     * A failure here leaves *last* turn's injection and flags exactly as they
     * were. That is the honest degrade: they were coherent with each other, and
     * a turn's worth of staleness is a stale sentence, where clearing half of it
     * would be a prompt that says the model has not seen messages it is also not
     * being shown (CLAUDE.md §4.17).
     *
     * @returns {Promise<object|null>} The plan, written or not; null when there is none.
     */
    async function applyMemory() {
        if (!memory) return null;

        try {
            const plan = await memory.plan();

            if (!plan?.writing) {
                releaseMemory();
                return plan ?? null;
            }

            park(plan);
            blank(plan.blank);
            return plan;
        } catch (err) {
            warn('Failed to assemble the memory block; leaving the prompt as it was.', err);
            toastOnce('Cairn could not rebuild the memory block this turn. The previous one is still in the prompt.');
            return null;
        }
    }

    /**
     * P3 — the world state, just after the newest message it read. It follows the
     * see-saw even while the handover gate leaves the block to qvink, since the state
     * stands on its own. With no plan to read the step from, no state counts as behind
     * it. A failure leaves last turn's state in place, as `applyMemory` does.
     */
    async function applyState(chat, plan) {
        if (!state) return;

        try {
            const placed = await state.plan(chat, { summarisedThrough: plan?.report?.summarisedThrough ?? -1 });
            if (!placed?.text) {
                releaseState();
                return;
            }
            const { position, scan, role } = placed.placement;
            getContext().setExtensionPrompt(STATE_INJECTION, placed.text, position, placed.depth, scan, role);
            stateParked = true;
            debug(`World state: parked ${placed.text.length} chars at depth ${placed.depth}.`);
        } catch (err) {
            warn('Failed to place the world state; leaving the prompt as it was.', err);
            toastOnce('Cairn could not place the world state this turn. The previous one is still in the prompt.');
        }
    }

    /** public/script.js:8926 — (key, value, position, depth, scan, role). */
    function park({ text, placement }) {
        const { setExtensionPrompt } = getContext();
        setExtensionPrompt(MEMORY_INJECTION, text, placement.position, placement.depth, placement.scan, placement.role);
        parked = true;
        debug(`Memory block: parked ${text.length} chars at position ${placement.position}.`);
    }

    /**
     * Drop the messages the block speaks for out of the sent history.
     *
     * `Symbol.for('ignore')` on `message.extra` (public/scripts/constants.js:25)
     * blanks a message in both prompt paths — text completion at
     * public/script.js:5841 and chat completion at public/scripts/openai.js:584 —
     * without changing the chat's length.
     *
     * Written **in place, through the live chat**, never through the array the
     * interceptor is handed (DESIGN.md §9). Two reasons, and the second is a trap:
     * ST's `coreChat` entries are fresh objects that share `extra` by reference
     * (public/script.js:4525), so writing to the live message reaches them; and
     * `coreChat` is a *filtered* copy whose own `index` field counts the filtered
     * array (:4496, :4525), so a system message anywhere earlier in the chat
     * shifts it away from ours. Indexes here are the live chat's own.
     *
     * Every message we flagged is written every turn, set or cleared. The flag
     * lives on the real `extra` object, so one left behind from a previous turn
     * would blank a message nothing is summarising any more.
     */
    function blank(indexes) {
        const { chat, symbols } = getContext();
        const ignore = symbols?.ignore ?? Symbol.for('ignore');
        const next = new Set();

        for (const index of indexes ?? []) {
            const extra = chat?.[index]?.extra;
            if (!extra) continue;
            extra[ignore] = true;
            next.add(extra);
        }

        // Only ever our own flags: the symbol is `Symbol.for('ignore')`, shared
        // with whoever else is hiding a message, and clearing theirs would put
        // their message back in the prompt on our schedule.
        for (const extra of flagged) {
            if (!next.has(extra)) delete extra[ignore];
        }
        flagged = next;
    }

    /** Un-write everything: no block or state of ours in the prompt, no message held back. */
    function release() {
        releaseMemory();
        releaseState();
    }

    /** Both halves of the block: no block in the prompt, no message held back. */
    function releaseMemory() {
        try {
            if (parked) {
                getContext().setExtensionPrompt(MEMORY_INJECTION, '');
                parked = false;
                debug('Memory block: released the injection.');
            }
            blank([]);
        } catch (err) {
            warn('Failed to release the memory block.', err);
        }
    }

    function releaseState() {
        try {
            if (stateParked) {
                getContext().setExtensionPrompt(STATE_INJECTION, '');
                stateParked = false;
                debug('World state: released the injection.');
            }
        } catch (err) {
            warn('Failed to release the world state.', err);
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
            // Switching Cairn off has to take the block and the blanking with it,
            // or the chat keeps generating against a prompt nobody is maintaining.
            release();
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
            release();
        },

        intercept,
        remembered,

        get parked() {
            return parked;
        },

        get running() {
            return running;
        },
    };
}
