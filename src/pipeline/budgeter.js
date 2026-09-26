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
 * What a full summary costs against its own compact line, measured over the 85 real
 * summaries: 123.1 tokens against 23.0 (docs/decisions.md D-0076). It is a measurement
 * and not a preference, so it is the one number to change when it is measured again —
 * `scripts/calibrate-tier.mjs measure` prints it.
 */
export const COMPACT_RATIO = 5.36;

/**
 * The compact tier's share of the scene budget, **derived rather than chosen**
 * (CLAUDE.md §4.15, docs/decisions.md D-0075). At `s = 1/(1 + r)` the compact tail holds
 * about as many messages as the full tier does, which roughly doubles the held horizon
 * and stops there: past that point the tail buys lines about scenes a hundred messages
 * back by spending the full tier's rebuild spacing.
 */
export const COMPACT_SHARE = 1 / (1 + COMPACT_RATIO);

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
 * Measured against the **full tier's** cap, not the block's and not the whole scene
 * budget's: canon takes its room from the summaries, and the compact tier takes its room
 * after that, but the see-saw only ever grows in *full* summaries. A guard still reading
 * the whole scene budget would go on reporting slack the growing tier does not have, and
 * it would stop guarding the moment the compact tier existed — silently, because nothing
 * in play looks different until every step rebuilds (docs/decisions.md D-0075).
 *
 * With no compact tier `fullCap` *is* the scene cap, so this is unchanged.
 *
 * @param {{fullCap: number, floor: number, stepTokens: number}} input
 *        `stepTokens` is what one step adds, estimated from the block itself.
 */
export function recoupled({ fullCap, floor, stepTokens }) {
    if (!(fullCap > 0) || !(stepTokens > 0)) return false;
    return fullCap - floor < stepTokens;
}

/**
 * How the scene budget divides between the two fidelities (docs/decisions.md D-0075).
 *
 * **The share is a ceiling, not a reservation.** `available` is what the compact texts
 * on hand would actually cost, so a chat with no index records yet — every chat, on the
 * turn Cairn is installed — gets the whole budget for full summaries instead of losing a
 * sixth of it to a tail it cannot fill. That is the failure this argument exists to
 * prevent: a reserve for something not in the prompt is the card-and-examples mistake of
 * D-0068 in a second place.
 *
 * Deterministic, like every other number here: the same chat and settings give the same
 * split, and nothing measured from a prompt that went out reaches it (D-0033). The
 * assembler holds the result across a see-saw cycle so that a split which moves as lines
 * are written cannot demote a summary on an ordinary turn (D-0059's pattern).
 *
 * @param {{sceneCap: number, available?: number}} input `available` is the token cost of
 *        the compact texts that could be held, or 0 when there are none.
 * @returns {{fullCap: number, compactCap: number, share: number}}
 */
export function tierSplit({ sceneCap, available = 0 } = {}) {
    const budget = nonNegative(sceneCap);
    const ceiling = Math.floor(budget * COMPACT_SHARE);
    const compactCap = Math.min(ceiling, nonNegative(available));

    return { fullCap: budget - compactCap, compactCap, share: COMPACT_SHARE };
}

/**
 * @param {{floorFraction?: number}} [options]
 */
export function createBudget({ floorFraction = FLOOR_FRACTION } = {}) {
    /** Oldest message index still in the block, either fidelity. Monotonic. */
    let oldest = -Infinity;
    /**
     * Oldest message still held as a *full* summary; everything between `oldest` and
     * this is compact. Monotonic for the same reason `oldest` is — a summary that went
     * back to full would grow the block above the cap it was just trimmed to.
     */
    let boundary = -Infinity;

    return {
        /**
         * Choose what stays in the block, and at which fidelity.
         *
         * **Demote before evict** (docs/decisions.md D-0075). A summary pushed out of the
         * full tier becomes a compact line if it has one, and is evicted only if it does
         * not — so the order of sacrifice is full prose, then one sentence, then nothing.
         * The compact tail is trimmed after, oldest first, to whatever room the split left
         * it. Both drops move the block's head, which is why everything here is expected
         * to land on a rebuild turn: the caps come from the assembler, which holds them
         * still between rebuilds (D-0059's pattern), so an ordinary turn has nothing to do.
         *
         * With no `compactOf` this is exactly the single-fidelity fit it was before: the
         * compact tier is empty, `fullCap` is the scene cap, and `demoted` is 0.
         *
         * @param {{scenes: Array<{index: number}>, sceneCap: number,
         *          tokensOf: (scenes: Array<object>) => number,
         *          compactCap?: number, compactOf?: ((scene: object) => string|null)|null,
         *          rebuild?: boolean}} input
         *        `sceneCap` is the block's cap less canon's share, and `compactCap` the
         *        part of it the compact tier may use (`tierSplit`). `tokensOf` sizes a
         *        candidate list and is called once per dropped summary, so it must be
         *        cheap; it sees the list this function will return, compact texts and all.
         *        `compactOf` returns a summary's compact line, or null when it has none.
         *        `rebuild` means this turn changes the block's head whatever we do — the
         *        first turn of a session — so trimming to the floor now costs nothing.
         * @returns {{kept: Array<object>, evicted: number, demoted: number, unlined: number,
         *            oldest: number, boundary: number|null, tokens: number,
         *            sceneCap: number, fullCap: number, compactCap: number,
         *            full: number, compact: number, floor: number, over: boolean}}
         *          `kept` is chronological, each entry carrying `tier` and the `text` its
         *          fidelity renders with.
         */
        fit({ scenes, sceneCap, tokensOf, compactCap = 0, compactOf = null, rebuild = false }) {
            const all = scenes ?? [];
            const room = Math.min(nonNegative(compactCap), nonNegative(sceneCap));
            const fullCap = nonNegative(sceneCap) - room;
            // The compact form of a summary, or null. `chars` moves with `text` because
            // that is the field the block's own sizing reads (prompt/assembler.js
            // `blockChars`) — a swapped text left on the full summary's length would be
            // priced as the summary it replaced, and the tier would buy nothing.
            const compactItem = (scene) => {
                const line = compactOf ? compactOf(scene) : null;
                return line ? { ...scene, tier: 'compact', text: line, chars: line.length } : null;
            };

            // A branch or swipe can take the chat back past our marks, leaving
            // nothing to keep. Rewinding is correct: those summaries are gone, and
            // the marks were statements about a chat that no longer exists.
            if (all.length && !all.some((scene) => scene.index >= oldest)) {
                oldest = -Infinity;
                boundary = -Infinity;
            }
            if (all.length && !all.some((scene) => scene.index >= boundary)) boundary = -Infinity;

            const kept = all.filter((scene) => scene.index >= oldest);
            // Anything already behind the boundary is compact; a summary that lost its
            // line since (a resummarise, a failed pass) is evicted rather than restored,
            // because restoring it would grow the block above the cap it was trimmed to.
            const compact = [];
            let full = [];
            let evicted = 0;
            /** Evictions that happened only because a summary had no compact line. */
            let unlined = 0;
            for (const scene of kept) {
                if (scene.index >= boundary) {
                    full.push({ ...scene, tier: 'full' });
                    continue;
                }
                const line = compactItem(scene);
                if (line) compact.push(line);
                else {
                    evicted++;
                    unlined++;
                }
            }

            const floor = Math.max(0, Math.floor(fullCap * floorFraction));
            let fullTokens = tokensOf(full);
            const over = fullCap > 0 && fullTokens > fullCap;
            let demoted = 0;

            if (over || (rebuild && fullCap > 0 && fullTokens > floor)) {
                // Down to the floor in one pass, oldest first. Never to nothing: an
                // empty full tier is a rebuild *and* the readable memory gone with it.
                while (full.length > 1 && fullTokens > floor) {
                    const [leaving] = full;
                    full = full.slice(1);
                    fullTokens = tokensOf(full);
                    const line = compactItem(leaving);
                    if (line) {
                        compact.push(line);
                        demoted++;
                    } else {
                        evicted++;
                        unlined++;
                    }
                }
                if (full.length) boundary = full[0].index;
            }

            // The tail, to whatever room the split left it. Ordered, so the oldest
            // line goes first — the same sacrifice order one fidelity up.
            let compactTokens = tokensOf(compact);
            while (compact.length && compactTokens > room) {
                compact.shift();
                compactTokens = tokensOf(compact);
                evicted++;
            }

            const list = [...compact, ...full];
            if (list.length) oldest = list[0].index;

            return {
                kept: list,
                evicted,
                demoted,
                unlined,
                oldest,
                boundary: Number.isFinite(boundary) ? boundary : null,
                // Sized as one list rather than as the sum of two: the rendering puts a
                // separator between them, and the reported number is the block's own.
                tokens: tokensOf(list),
                sceneCap: nonNegative(sceneCap),
                fullCap,
                compactCap: room,
                full: full.length,
                compact: compact.length,
                floor,
                over,
            };
        },

        /** A new chat is a new block. */
        reset() {
            oldest = -Infinity;
            boundary = -Infinity;
        },

        get oldest() {
            return oldest;
        },

        /** Oldest summary still held in full, or null before anything is demoted. */
        get boundary() {
            return Number.isFinite(boundary) ? boundary : null;
        },
    };
}
