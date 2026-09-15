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
