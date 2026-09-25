/**
 * World Info observation (DESIGN.md §7).
 *
 * WI keeps doing retrieval; Cairn takes over placement and budgeting. Before it
 * can do either it has to be able to see what WI did — and the first thing worth
 * seeing is whether the block WI produced is even deterministic.
 *
 * Pure. Feed it the entries from WORLD_INFO_ACTIVATED.
 */

/**
 * Activated entries that share an `order` value.
 *
 * ST sorts activated entries with one key and no tiebreak —
 * `sortFn = (a, b) => b.order - a.order` (world-info.js:88, applied at :4610 for
 * scan order and :5203 for prompt order). `Array.prototype.sort` is stable, so
 * tied entries keep the order of the Map they arrived in, which is *activation*
 * order: whichever keyword happened to match first. That is chat-dependent, so a
 * tied block reshuffles itself every turn even when the identical set of entries
 * activates — and everything below it in the prompt is invalidated with it.
 *
 * Measured on Esin: 29 of 31 entries tied at `order: 10`, same set every turn,
 * different order every turn, prefix stability 14-16% (docs/decisions.md D-0022).
 *
 * @param {Array<{order?: number}>} entries From WORLD_INFO_ACTIVATED.
 * @returns {Array<{order: number, count: number, uids: Array<*>}>} Ties, largest first.
 */
export function findOrderTies(entries) {
    const byOrder = new Map();

    for (const entry of entries ?? []) {
        const order = entry?.order;
        if (!Number.isFinite(order)) continue;
        if (!byOrder.has(order)) byOrder.set(order, []);
        byOrder.get(order).push(entry.uid);
    }

    return [...byOrder.entries()]
        .filter(([, uids]) => uids.length > 1)
        .map(([order, uids]) => ({ order, count: uids.length, uids }))
        .sort((a, b) => b.count - a.count);
}

/**
 * How much of the lorebook block is at risk of reshuffling, as a verdict the
 * inspector can show without the reader having to know any of the above.
 *
 * `tiedEntries` is the count that can move, not the number of ties: one tie of
 * 29 is a rewritten block, twenty-nine ties of one are nothing.
 *
 * @param {Array<object>} entries From WORLD_INFO_ACTIVATED.
 */
export function assessOrdering(entries) {
    const activated = (entries ?? []).length;
    const ties = findOrderTies(entries);
    const tiedEntries = ties.reduce((total, tie) => total + tie.count, 0);

    return {
        activated,
        ties,
        tiedEntries,
        // A tie only matters if something sits below it — but from here we cannot
        // see what does, so this is "unstable ordering", not "broken prompt".
        stable: tiedEntries === 0,
    };
}

/**
 * ST keys an external activation by `${world}.${uid}` (world-info.js:412, set at
 * :1025) and ignores outright any entry missing either field (:1022). Using the
 * same key means a held entry round-trips through force-activate unchanged.
 *
 * @param {object} entry
 * @returns {string|null} null when the entry could never be forced.
 */
export function entryKey(entry) {
    if (!entry || typeof entry !== 'object') return null;
    if (!Object.hasOwn(entry, 'world') || !Object.hasOwn(entry, 'uid')) return null;
    if (entry.world == null || entry.uid == null) return null;
    return `${entry.world}.${entry.uid}`;
}

/**
 * Trim a held set to ST's World Info budget, lowest `order` first
 * (docs/decisions.md D-0069).
 *
 * The holder is add-only, so it only grows. ST caps the block at
 * `world_info_budget` percent of the max prompt, optionally capped absolutely by
 * `world_info_budget_cap` (world-info.js:4736-4741). Once the held set passes
 * that budget ST drops the tail itself — but it decides where the tail starts
 * from a running token count taken *during* the scan (:5061), so the boundary
 * entry moves turn to turn and the block below it is rewritten each time. That
 * is D-0023's failure one level up: a set that never really changed, rebuilding
 * the prompt anyway.
 *
 * Trimming here puts the held set under the budget before it is forced, so none
 * of ours sits on ST's boundary. It is only called at a rebuild, which is the
 * turn the prompt's head is moving regardless (D-0067).
 *
 * Mirrors ST's own arithmetic rather than inventing one:
 *
 *   - `ignoreBudget` entries are kept whatever happens and cost nothing against
 *     the budget — ST adds them on top (:5061, :5669).
 *   - The rest are walked highest `order` first (`sortFn`, :88), and the first
 *     one whose running total *reaches* the budget takes everything after it
 *     with it, because ST adds an entry's content to the running count before
 *     testing it (:5059-5061) so a pass cannot recover once it overflows.
 *
 * The tiebreak is first-activation order, which is ours and not ST's: ST scores
 * every forced entry -1 and falls back to its walk over `sortedEntries`
 * (:5002), which we cannot see from here. It does not need to match. ST still
 * governs what reaches the prompt; this only decides what we stop forcing, and
 * an order that never changes between turns is the property we want.
 *
 * Pure: `sizeOf` is injected.
 *
 * @param {{entries: Array<object>, budget: number,
 *          sizeOf: (text: string) => Promise<number>}} input
 * @returns {Promise<{kept: Array<object>, dropped: Array<object>, tokens: number}>}
 *          `kept` stays in the order it arrived in, which is the order it is forced in.
 */
export async function trimToBudget({ entries, budget, sizeOf }) {
    const held = [...(entries ?? [])];
    // No usable budget is no trim, not a trim to nothing (CLAUDE.md §4.17).
    if (!Number.isFinite(budget) || budget <= 0) return { kept: held, dropped: [], tokens: 0 };

    const ranked = held
        .map((entry, arrival) => ({ entry, arrival }))
        .filter(({ entry }) => !entry?.ignoreBudget)
        .sort((a, b) => (b.entry?.order ?? 0) - (a.entry?.order ?? 0) || a.arrival - b.arrival);

    const dropped = new Set();
    /** What the kept set weighs — the running total *before* the one that overflowed. */
    let tokens = 0;
    let running = 0;
    let overflowed = false;

    for (const { entry } of ranked) {
        if (overflowed) {
            dropped.add(entry);
            continue;
        }
        // ST counts the entry plus the newline it joins on (:5059).
        running += await sizeOf(`${entry?.content ?? ''}\n`);
        if (running >= budget) {
            overflowed = true;
            dropped.add(entry);
        } else {
            tokens = running;
        }
    }

    return {
        kept: held.filter((entry) => !dropped.has(entry)),
        dropped: held.filter((entry) => dropped.has(entry)),
        tokens,
    };
}

/**
 * The remembered set — add-only membership for the World Info block
 * (docs/decisions.md D-0023).
 *
 * An entry that has activated stays in; a turn that activates nothing changes
 * nothing. That is the whole rule, and it exists because a *dropout* — a turn
 * whose two-message scan window happens to seed no recursion — costs two full
 * prompt rebuilds. Over 84 measured turns every set change was a dropout
 * artifact, not a real change in what was relevant.
 *
 * It holds the entry **objects**, not just their keys, for two reasons that are
 * easy to get wrong:
 *
 *   - ST substitutes the forced object for the book's own
 *     (`activatedNow.add(buffer.getExternallyActivated(entry))`, world-info.js:4888),
 *     so a `{world, uid}` stub would evict the very content it was meant to keep.
 *   - Entries from WORLD_INFO_ACTIVATED (:901) have already been through the
 *     scan: decorators parsed back out of `content` and `world` attached
 *     (:4629, :4535). Raw entries read from the book file have neither.
 *
 * Pure: no ST, no DOM, no network.
 */
export function createRememberedSet() {
    const held = new Map();

    return {
        /**
         * Learn from one turn's activations. Add-only, and a key already held
         * keeps the object it was first seen with, so the rendered block stays
         * byte-identical across turns.
         *
         * @param {Array<object>} entries From WORLD_INFO_ACTIVATED.
         * @returns {{added: string[], size: number}}
         */
        observe(entries) {
            const added = [];
            for (const entry of entries ?? []) {
                const key = entryKey(entry);
                if (key === null || held.has(key)) continue;
                held.set(key, entry);
                added.push(key);
            }
            return { added, size: held.size };
        },

        /**
         * Drop one book's entries so the next turn re-scans them from source.
         *
         * A held object is a snapshot and nothing refreshes it while we keep
         * forcing it — the book's own entry never reaches the scan again. So an
         * edit to a book (WORLDINFO_UPDATED, world-info.js:4160) invalidates
         * that book. One rebuild on an edit is the right price for not serving
         * the author stale text.
         *
         * @param {string} world Book name, as ST emits it.
         * @returns {number} How many entries were dropped.
         */
        forget(world) {
            let dropped = 0;
            for (const [key, entry] of held) {
                if (entry?.world === world) {
                    held.delete(key);
                    dropped++;
                }
            }
            return dropped;
        },

        /**
         * Re-evaluate the held set against ST's budget (docs/decisions.md D-0069).
         *
         * The union of "currently held" and "currently activated" is the held set
         * itself — `observe` has already folded every activation in — so the union
         * is implicit and only the trim is work. That is the point: a *recompute*
         * from this turn's activations would let a keyword-scan miss landing on a
         * rebuild turn evict an entry, which is D-0023's failure again, rarer and
         * harder to catch.
         *
         * Only ever called on a rebuild turn (prompt/injector.js, D-0067).
         *
         * @param {{budget: number, sizeOf: (text: string) => Promise<number>}} input
         * @returns {Promise<{dropped: number, kept: number, tokens: number}>}
         */
        async trim({ budget, sizeOf }) {
            const result = await trimToBudget({ entries: [...held.values()], budget, sizeOf });
            for (const entry of result.dropped) held.delete(entryKey(entry));
            return { dropped: result.dropped.length, kept: result.kept.length, tokens: result.tokens };
        },

        /** A new chat is a new set. */
        clear() {
            held.clear();
        },

        /** What to force next turn, in first-activation order. */
        entries() {
            return [...held.values()];
        },

        has(key) {
            return held.has(key);
        },

        get size() {
            return held.size;
        },
    };
}
