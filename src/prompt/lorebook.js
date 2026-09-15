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
