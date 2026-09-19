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
 * Three numbers, all worked out from the chat and the settings rather than
 * measured turn to turn (docs/decisions.md D-0033):
 *
 *   `cap`      — the smaller of `CAP_FRACTION` of the max prompt and the room the
 *                rest of the prompt leaves, never below `MIN_CAP_FRACTION`
 *                (docs/decisions.md D-0038, D-0052). No setting, and nothing
 *                measured feeds it.
 *   `sceneCap` — what is left of it once canon has taken its share
 *                (`canonCap`, docs/p4-plan.md decision 5). This is what the summaries
 *                are fitted to; the cap above is the whole block's.
 *   `floor`    — where a rebuild lands. Half the scene cap, so the next rebuild is
 *                half a cap of growth away instead of one summary away (D-0026).
 *
 * The mark only ever moves forward within a session, which is what makes the
 * deferral hold. A reload starts it over: the first turn of a session rebuilds
 * the block anyway, so it lands at the floor too and buys the full slack.
 *
 * **The deferral is conditional and the condition is checkable.** Rebuilds are
 * spaced `(sceneCap - floor) / growth-per-step` steps apart, so a cap only a step
 * or two wide puts eviction back on every step — qvink's behaviour, reached by a
 * longer road. `recoupled()` says when that has happened (CLAUDE.md §9.35).
 *
 * Pure but for one index of state. No ST, no DOM, no network.
 */

/** A rebuild drops the block to this share of the cap. */
export const FLOOR_FRACTION = 0.5;

/**
 * The block's **ceiling** share of the max prompt. 35% rather than 30% keeps Esin
 * at least the 7,500 tokens qvink's limit gave it (docs/decisions.md D-0038).
 */
export const CAP_FRACTION = 0.35;

/**
 * Left unreserved for what no reserve can see: the instruct wrappers, the story
 * string's own wording, ST's token padding, other extensions' injections and the
 * gap between ST's tokenizer and the model's. Deliberately the same 5% as
 * `NEAR_LIMIT_FRACTION`'s complement (util/context-size.js), so with every other
 * reserve at its upper bound a full prompt lands under that line — and
 * `prompt_near_limit` firing means a reserve missed something (D-0052).
 */
export const MARGIN_FRACTION = 0.05;

/**
 * Canon's **ceiling** share of the block (docs/p4-plan.md decision 5). On Esin's derived
 * cap that is ~720 tokens, about 45 one-liners, against a block that holds 34
 * summaries. Conservative on purpose: the first run's numbers are the evidence for
 * moving it, not an argument made in advance.
 */
export const CANON_FRACTION = 0.20;

/**
 * The floor under the cap. A card, lorebook and raw window that already fill the
 * prompt would otherwise leave the block nothing; keeping a tenth means the chat
 * keeps some memory while ST trims history as it does today. Reported as
 * `starved`, because it is a judgement call and not a budget that adds up
 * (docs/decisions.md D-0052).
 */
export const MIN_CAP_FRACTION = 0.10;

/**
 * How much room the memory block gets, from what the rest of the prompt needs.
 *
 * Pure arithmetic over reserves someone else worked out (prompt/reserves.js).
 * Nothing measured from a prompt reaches it, which is what keeps the cap a
 * function of the chat: the same chat and settings always give the same number,
 * and a reload costs nothing (docs/decisions.md D-0033).
 *
 * @param {{maxPromptTokens: number,
 *          reserves?: {card: number, lore: number, window: number, state: number}|null}} input
 *        `reserves` null means a reserve could not be read at all; the cap falls
 *        back to the plain share rather than guessing (CLAUDE.md §4.17).
 * @returns {{cap: number, share: number, room: number|null, margin: number|null,
 *            minimum: number, parts: object|null,
 *            limitedBy: 'share'|'room'|'starved'|'unknown'}}
 */
export function deriveCap({ maxPromptTokens, reserves } = {}) {
    const max = Number.isFinite(maxPromptTokens) ? Math.max(0, maxPromptTokens) : 0;
    const share = Math.floor(max * CAP_FRACTION);
    const minimum = Math.floor(max * MIN_CAP_FRACTION);

    if (!reserves) {
        return { cap: share, share, room: null, margin: null, minimum, parts: null, limitedBy: 'unknown' };
    }

    const parts = {
        card: nonNegative(reserves.card),
        lore: nonNegative(reserves.lore),
        window: nonNegative(reserves.window),
        state: nonNegative(reserves.state),
    };
    const margin = Math.floor(max * MARGIN_FRACTION);
    const room = max - parts.card - parts.lore - parts.window - parts.state - margin;

    const limitedBy = share <= room ? 'share' : (room >= minimum ? 'room' : 'starved');
    const cap = { share, room, starved: minimum }[limitedBy];

    return { cap, share, room, margin, minimum, parts, limitedBy };
}

function nonNegative(value) {
    return Number.isFinite(value) ? Math.max(0, Math.floor(value)) : 0;
}

/**
 * How much of the block canon may take, and why that number (docs/p4-plan.md decision 5).
 *
 * Canon takes its room from the scene budget, so it can cause exactly the collapse
 * `recoupled()` reports. The second term makes that arithmetically impossible: the
 * scene budget keeps at least two steps whatever canon holds, so canon is squeezed to
 * nothing before the see-saw recouples. A starved chat (docs/decisions.md D-0052) gets no
 * canon at all, which is the right order of sacrifice — the summaries are the memory,
 * and canon is what is left of the ones already dropped.
 *
 * @param {{cap: number, stepTokens: number}} input The block's cap and what one
 *        see-saw step adds, both as the assembler works them out.
 * @returns {{cap: number, share: number, guard: number, limitedBy: 'share'|'guard'}}
 */
export function canonCap({ cap, stepTokens } = {}) {
    const block = nonNegative(cap);
    const step = nonNegative(stepTokens);
    const share = Math.floor(block * CANON_FRACTION);
    const guard = block - 2 * step;

    return {
        cap: Math.max(0, Math.min(share, guard)),
        share,
        guard,
        limitedBy: share <= guard ? 'share' : 'guard',
    };
}

/**
 * Whether growth and eviction have collapsed back into one cadence.
 *
 * True when the slack a rebuild buys cannot absorb even one see-saw step, so the
 * next step overflows the cap immediately and every step is also a rebuild.
 *
 * Measured against the **scene** cap, not the block's: canon takes its room from the
 * summaries, so it is the summaries' slack that says whether the see-saw still holds.
 * `canonCap`'s guard is what keeps this false whatever canon holds.
 *
 * @param {{sceneCap: number, floor: number, stepTokens: number}} input
 *        `stepTokens` is what one step adds, estimated from the block itself.
 */
export function recoupled({ sceneCap, floor, stepTokens }) {
    if (!(sceneCap > 0) || !(stepTokens > 0)) return false;
    return sceneCap - floor < stepTokens;
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
         * @param {{scenes: Array<{index: number}>, sceneCap: number,
         *          tokensOf: (scenes: Array<object>) => number,
         *          rebuild?: boolean}} input
         *        `sceneCap` is the block's cap less canon's share. `tokensOf` sizes a
         *        candidate list; it is called once per dropped summary, so it must be
         *        cheap. `rebuild` means this turn changes the block's head whatever we
         *        do — the first turn of a session — so trimming to the floor now costs
         *        nothing extra.
         * @returns {{kept: Array<object>, evicted: number, oldest: number,
         *            tokens: number, sceneCap: number, floor: number, over: boolean}}
         */
        fit({ scenes, sceneCap, tokensOf, rebuild = false }) {
            const all = scenes ?? [];

            // A branch or swipe can take the chat back past our mark, leaving
            // nothing to keep. Rewinding is correct: those summaries are gone, and
            // the mark was a statement about a chat that no longer exists.
            if (all.length && !all.some((scene) => scene.index >= oldest)) {
                oldest = -Infinity;
            }

            let kept = all.filter((scene) => scene.index >= oldest);
            const floor = Math.max(0, Math.floor(sceneCap * floorFraction));
            let tokens = tokensOf(kept);
            const over = sceneCap > 0 && tokens > sceneCap;
            let evicted = 0;

            if (over || (rebuild && sceneCap > 0 && tokens > floor)) {
                // Drop to the floor in one pass, oldest first. Never to nothing:
                // an empty block is a full rebuild *and* the memory gone with it.
                while (kept.length > 1 && tokens > floor) {
                    kept = kept.slice(1);
                    tokens = tokensOf(kept);
                    evicted++;
                }
                if (kept.length) oldest = kept[0].index;
            }

            return { kept, evicted, oldest, tokens, sceneCap, floor, over };
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
