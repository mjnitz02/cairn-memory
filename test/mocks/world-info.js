/**
 * A working model of SillyTavern's World Info scan.
 *
 * The holder's claim is "a dropout can no longer evict the lore block". Asserting
 * that we emitted WORLDINFO_FORCE_ACTIVATE would only prove we called a function;
 * proving the claim needs something that actually drops entries when the scan
 * misses and puts them back when they are forced. So this mirrors the parts of
 * `checkWorldInfo` the holder depends on, each cited (CLAUDE.md §3.11):
 *
 *   :4639  `getSortedEntries` hands the scan a `structuredClone` of the book,
 *          so a held entry is always a *copy* and never the book's own object
 *   :4610  scan order is `sortFn` — `(a, b) => b.order - a.order`, one key
 *   :4732  `allActivatedEntries` is a Map keyed `${world}.${uid}`
 *   :4797  an entry already activated this generation is skipped
 *   :4886  external activations are consulted *before* the keyword match
 *   :4888  ...and the entry added is **ours**, substituted for the book's own
 *   :4996  the pass sort tiebreaks on `sortedEntries` index, `?? -1` when absent
 *   :5075  survivors go into `allActivatedEntries`
 *   :5203  prompt order is `sortFn` again, ties keeping activation order
 *   :5275  `resetExternalEffects()` — forcing lasts exactly one generation
 *   :900   WORLD_INFO_ACTIVATED fires only when non-empty and not a dry run
 *   :1022  a forced entry missing `world` or `uid` is ignored
 *   :1025  external activations are keyed `${world}.${uid}`
 *
 * Recursion is modelled the way D-0022 measured it: activated content re-enters
 * the scan buffer, so a small seed cascades to a fixed point. That is what makes
 * a dropout possible at all — miss the seed and the whole closure is lost.
 *
 * Deliberately *not* modelled: budget, probability, inclusion groups, sticky and
 * cooldown, timed effects. Every one is either inert on the books we have
 * (`sticky`/`cooldown` are null on all 31 of Esin's entries) or orthogonal to
 * membership, and a mock that guesses at them would be worse than one that says
 * it does not.
 */

/** public/scripts/world-info.js:88 */
const sortFn = (a, b) => b.order - a.order;

/**
 * @param {{book: Array<object>, eventSource: object, eventTypes: object,
 *          recursive?: boolean, interceptors?: Array<Function>}} options
 */
export function createWorldInfoEngine({ book, eventSource, eventTypes, recursive = true, interceptors = [] }) {
    /** WorldInfoBuffer.externalActivations — world-info.js:203 */
    const externalActivations = new Map();

    eventSource.on(eventTypes.WORLDINFO_FORCE_ACTIVATE, (entries) => {
        for (const entry of entries ?? []) {
            // :1022 — both fields or the entry is dropped with a console error.
            if (!Object.hasOwn(entry, 'world') || !Object.hasOwn(entry, 'uid')) continue;
            externalActivations.set(`${entry.world}.${entry.uid}`, entry); // :1025
        }
    });

    /**
     * One generation, in ST's order: interceptors (script.js:4564, skipped on a
     * dry run at :4562) and then the scan (:4635).
     *
     * @param {{window: string, dryRun?: boolean, type?: string}} options
     *        `window` is the scan buffer — the last `world_info_depth` messages.
     * @returns {Promise<{entries: Array<object>, block: string}>}
     */
    async function generate({ window = '', dryRun = false, type = undefined } = {}) {
        if (!dryRun) {
            for (const intercept of interceptors) {
                await intercept([], 4096, () => {}, type);
            }
        }

        // :4639 — the scan works on a deep clone, which is why a held entry
        // goes stale when the book is edited: nothing links the two objects.
        const sorted = structuredClone(book).sort(sortFn); // :4610
        const sortedIndex = new Map(sorted.map((entry, index) => [entry, index]));
        const activated = new Map(); // :4732
        let buffer = window;

        for (;;) {
            const activatedNow = new Set();

            for (const entry of sorted) {
                const key = `${entry.world}.${entry.uid}`;
                if (activated.has(key)) continue; // :4797

                const external = externalActivations.get(key); // :4886
                if (external) {
                    activatedNow.add(external); // :4888 — ours, not the book's
                    continue;
                }

                if (entry.key.some((k) => buffer.toLowerCase().includes(k.toLowerCase()))) {
                    activatedNow.add(entry);
                }
            }

            if (activatedNow.size === 0) break;

            // :4996 — stable sort; a forced entry is not in `sortedEntries`, so
            // it scores -1 and keeps the insertion order the walk above gave it.
            const newEntries = [...activatedNow].sort(
                (a, b) => (sortedIndex.get(a) ?? -1) - (sortedIndex.get(b) ?? -1),
            );

            for (const entry of newEntries) {
                activated.set(`${entry.world}.${entry.uid}`, entry); // :5075
            }

            if (!recursive) break;
            buffer += `\n${newEntries.map((entry) => entry.content).join('\n')}`;
        }

        externalActivations.clear(); // :5275

        const entries = [...activated.values()].sort(sortFn); // :5203
        const block = entries.map((entry) => entry.content).join('\n');

        if (!dryRun && entries.length > 0) {
            await eventSource.emit(eventTypes.WORLD_INFO_ACTIVATED, entries); // :900
        }

        return { entries, block };
    }

    return { generate };
}

/**
 * A synthetic lorebook, real in shape (CLAUDE.md §3.13).
 *
 * Mirrors Esin Nasser's book as it stands after the D-0022 `order` fix: entries
 * all at `position: 1`, distinct descending `order`, `probability: 100`,
 * `sticky`/`cooldown` null, `outletName` empty. Content and keys are invented.
 *
 * The reference graph is the point. Only `hearth` is reachable from ordinary
 * chat text; everything else is reached by recursion from it, so a scan window
 * that fails to mention it activates *nothing at all* — which is the turn-4
 * dropout D-0023 measured, reproduced here rather than asserted.
 */
export function makeBook(world = "Wren's Lorebook") {
    const spec = [
        ['hearth', ['hearth'], 'The hearth at Calder Row never goes out. Ferris keeps it.', 999],
        ['ferris', ['Ferris'], 'Ferris tends the hearth and owes a debt to the Weft.', 998],
        ['weft', ['Weft'], 'The Weft is the cartel that owns Calder Row and the salt road.', 997],
        ['saltroad', ['salt road'], 'The salt road runs from Calder Row to the Ashen Gate.', 996],
        ['ashengate', ['Ashen Gate'], 'The Ashen Gate is sealed each dusk by the Orrery.', 995],
        ['orrery', ['Orrery'], 'The Orrery is a brass machine that counts the tides.', 994],
    ];

    return spec.map(([name, key, content, order], index) => ({
        uid: index + 1,
        world,
        key,
        keysecondary: [],
        comment: name,
        content,
        constant: false,
        selective: false,
        order,
        position: 1,
        displayIndex: index,
        disable: false,
        probability: 100,
        useProbability: true,
        depth: 4,
        role: 0,
        sticky: null,
        cooldown: null,
        delay: null,
        excludeRecursion: false,
        preventRecursion: false,
        delayUntilRecursion: false,
        outletName: '',
        group: '',
        decorators: [],
    }));
}
