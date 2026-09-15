/**
 * The *eviction* cadence — the other half of D-0019, kept apart from the growth
 * cadence in scheduler.js on purpose.
 *
 * Eviction is the expensive event: it changes the block's first byte, so the
 * model re-reads the block and everything under it. qvink pays that price on
 * every see-saw step because its budget binds on every step. Cairn pays it only
 * when the prompt genuinely cannot hold the block, and then pays it *once* for
 * many steps by dropping down to a floor rather than shaving the single summary
 * that happened to overflow.
 *
 * Two numbers:
 *
 *   `cap`   — what the block may occupy, derived: everything the prompt may use,
 *             minus what everything else in it actually cost last turn. Not a
 *             setting (CLAUDE.md §4.15) and not a guess — the observer measures
 *             both terms every turn.
 *   `floor` — where a rebuild lands. Half the cap, so the next rebuild is half a
 *             cap of growth away instead of one summary away. That fraction is
 *             the one judgement call in this file; the trace will settle it
 *             (docs/decisions.md D-0026).
 *
 * The mark only ever moves forward, which is what makes the deferral hold: after
 * a rebuild the block is under the floor, so growth has to cross the cap again
 * before anything else is dropped. Same shape as the World Info holder's add-only
 * rule (D-0023), for the same reason.
 *
 * **The deferral is conditional and the condition is checkable.** Rebuilds are
 * spaced `(cap - floor) / growth-per-step` steps apart, so a cap only a step or
 * two wide puts eviction back on every step — qvink's behaviour, reached by a
 * longer road. `recoupled()` says when that has happened, because the failure is
 * otherwise invisible: the block looks right, the numbers look plausible, and the
 * prefix collapses exactly as often as before (CLAUDE.md §9.35).
 *
 * Pure but for one index of state. No ST, no DOM, no network.
 */

/** A rebuild drops the block to this share of the cap. */
export const FLOOR_FRACTION = 0.5;

/**
 * Reserve when ST's own answer is unavailable (util/context-size.js). Deliberately
 * generous: overestimating the reserve costs a little memory, underestimating it
 * overflows the request, and Cairn never breaks the chat (CLAUDE.md §4.17).
 */
export const FALLBACK_RESERVE_FRACTION = 0.125;

/**
 * How many tokens the memory block may occupy.
 *
 * @param {{maxPromptTokens: number, otherTokens: number}} input
 *        `maxPromptTokens` is ST's usable prompt size — context window minus the
 *        reserved response. `otherTokens` is the rest of the prompt as measured
 *        last turn: card, persona, lore, raw window, everyone else's injections.
 * @returns {number} Never negative.
 */
export function deriveCap({ maxPromptTokens, otherTokens }) {
    const max = Number.isFinite(maxPromptTokens) ? maxPromptTokens : 0;
    const other = Number.isFinite(otherTokens) ? Math.max(0, otherTokens) : 0;
    return Math.max(0, Math.floor(max - other));
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
    /** Oldest message index still in the block. Monotonic within a chat. */
    let oldest = -Infinity;

    return {
        /**
         * Choose what stays in the block.
         *
         * @param {{scenes: Array<{index: number}>, cap: number,
         *          tokensOf: (scenes: Array<object>) => number}} input
         *        `tokensOf` sizes a candidate list. It is called a few times per
         *        eviction and never otherwise, so it must be cheap — the assembler
         *        passes an arithmetic estimate calibrated against ST's tokenizer.
         * @returns {{kept: Array<object>, evicted: number, oldest: number,
         *            tokens: number, cap: number, floor: number, over: boolean}}
         */
        fit({ scenes, cap, tokensOf }) {
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

            if (over) {
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
