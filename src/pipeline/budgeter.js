/**
 * The *eviction* cadence — the other half of D-0019, kept apart from the growth
 * cadence in scheduler.js on purpose.
 *
 * Eviction is the expensive event: it changes the block's first byte, so the
 * model re-reads the block and everything under it. qvink pays that price on
 * every see-saw step because its budget binds on every step. Cairn pays it only
 * when the block outgrows its cap, and then pays it *once* for many steps by
 * dropping down to a floor rather than shaving the single summary that happened
 * to overflow.
 *
 * Two numbers, both fixed for the chat rather than measured turn to turn
 * (docs/decisions.md D-0033):
 *
 *   `cap`   — a fixed share of the max prompt, `CAP_FRACTION` (docs/p2-plan.md
 *             decision 2). No setting, and nothing measured feeds it.
 *   `floor` — where a rebuild lands. Half the cap, so the next rebuild is half a
 *             cap of growth away instead of one summary away (D-0026).
 *
 * The mark only ever moves forward within a session, which is what makes the
 * deferral hold. A reload starts it over: the first turn of a session rebuilds
 * the block anyway, so it lands at the floor too and buys the full slack.
 *
 * **The deferral is conditional and the condition is checkable.** Rebuilds are
 * spaced `(cap - floor) / growth-per-step` steps apart, so a cap only a step or
 * two wide puts eviction back on every step — qvink's behaviour, reached by a
 * longer road. `recoupled()` says when that has happened (CLAUDE.md §9.35).
 *
 * Pure but for one index of state. No ST, no DOM, no network.
 */

/** A rebuild drops the block to this share of the cap. */
export const FLOOR_FRACTION = 0.5;

/**
 * The block's share of the max prompt. 35% rather than 30% keeps Esin at least the
 * 7,500 tokens qvink's limit gave it (docs/p2-plan.md decision 2).
 */
export const CAP_FRACTION = 0.35;

/**
 * @param {number} maxPromptTokens ST's `getMaxPromptTokens` (util/context-size.js).
 * @returns {number} The cap, in tokens. Fixed for the chat (docs/decisions.md D-0033).
 */
export function memoryCap(maxPromptTokens) {
    const max = Number.isFinite(maxPromptTokens) ? Math.max(0, maxPromptTokens) : 0;
    return Math.floor(max * CAP_FRACTION);
}

/**
 * Whether growth and eviction have collapsed back into one cadence.
 *
 * True when the slack a rebuild buys cannot absorb even one see-saw step, so the
 * next step overflows the cap immediately and every step is also a rebuild.
 *
 * @param {{cap: number, floor: number, stepTokens: number}} input
 *        `stepTokens` is what one step adds, estimated from the block itself.
 */
export function recoupled({ cap, floor, stepTokens }) {
    if (!(cap > 0) || !(stepTokens > 0)) return false;
    return cap - floor < stepTokens;
}

/**
 * @param {{floorFraction?: number}} [options]
 */
export function createBudget({ floorFraction = FLOOR_FRACTION } = {}) {
    /** Oldest message index still in the block. Monotonic within a session. */
    let oldest = -Infinity;

    return {
        /**
         * Choose what stays in the block.
         *
         * @param {{scenes: Array<{index: number}>, cap: number,
         *          tokensOf: (scenes: Array<object>) => number,
         *          rebuild?: boolean}} input
         *        `tokensOf` sizes a candidate list; it is called once per dropped
         *        summary, so it must be cheap. `rebuild` means this turn changes
         *        the block's head whatever we do — the first turn of a session —
         *        so trimming to the floor now costs nothing extra.
         * @returns {{kept: Array<object>, evicted: number, oldest: number,
         *            tokens: number, cap: number, floor: number, over: boolean}}
         */
        fit({ scenes, cap, tokensOf, rebuild = false }) {
            const all = scenes ?? [];

            // A branch or swipe can take the chat back past our mark, leaving
            // nothing to keep. Rewinding is correct: those summaries are gone, and
            // the mark was a statement about a chat that no longer exists.
            if (all.length && !all.some((scene) => scene.index >= oldest)) {
                oldest = -Infinity;
            }

            let kept = all.filter((scene) => scene.index >= oldest);
            const floor = Math.max(0, Math.floor(cap * floorFraction));
            let tokens = tokensOf(kept);
            const over = cap > 0 && tokens > cap;
            let evicted = 0;

            if (over || (rebuild && cap > 0 && tokens > floor)) {
                // Drop to the floor in one pass, oldest first. Never to nothing:
                // an empty block is a full rebuild *and* the memory gone with it.
                while (kept.length > 1 && tokens > floor) {
                    kept = kept.slice(1);
                    tokens = tokensOf(kept);
                    evicted++;
                }
                if (kept.length) oldest = kept[0].index;
            }

            return { kept, evicted, oldest, tokens, cap, floor, over };
        },

        /** A new chat is a new block. */
        reset() {
            oldest = -Infinity;
        },

        get oldest() {
            return oldest;
        },
    };
}
