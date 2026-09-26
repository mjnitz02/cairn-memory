import { describe, expect, it } from 'vitest';
import { assessOrdering, createRememberedSet, entryKey, findOrderTies, trimToBudget } from '../src/prompt/lorebook.js';

/**
 * The shape measured on Esin (docs/decisions.md D-0022): 31 entries, 29 of them
 * tied at `order: 10`, one at 9 and one at 8. Synthetic content, real shape
 * (CLAUDE.md §3.13) — only the fields the sort depends on matter here.
 */
function esinShape() {
    const entries = [];
    for (let uid = 1; uid <= 29; uid++) entries.push({ uid, order: 10 });
    entries.push({ uid: 30, order: 9 });
    entries.push({ uid: 31, order: 8 });
    return entries;
}

describe('findOrderTies', () => {
    it('finds the tie that reshuffles a block every turn', () => {
        const ties = findOrderTies(esinShape());

        expect(ties).toHaveLength(1);
        expect(ties[0]).toMatchObject({ order: 10, count: 29 });
    });

    it('reports nothing when every entry has a distinct order', () => {
        // What the fix produces: order*100 - displayIndex.
        const fixed = esinShape().map((e, i) => ({ ...e, order: e.order * 100 - i }));
        expect(findOrderTies(fixed)).toEqual([]);
    });

    it('ranks ties by how many entries can move, not how many ties there are', () => {
        const ties = findOrderTies([
            { uid: 1, order: 5 }, { uid: 2, order: 5 },
            { uid: 3, order: 7 }, { uid: 4, order: 7 }, { uid: 5, order: 7 },
        ]);
        expect(ties.map((t) => t.order)).toEqual([7, 5]);
    });

    it('names the entries, so the fix can be applied to them', () => {
        const ties = findOrderTies([{ uid: 'a', order: 1 }, { uid: 'b', order: 1 }]);
        expect(ties[0].uids).toEqual(['a', 'b']);
    });

    it('ignores entries with no usable order rather than tying them together', () => {
        // A missing order is not evidence of a collision.
        const ties = findOrderTies([{ uid: 1 }, { uid: 2 }, { uid: 3, order: null }]);
        expect(ties).toEqual([]);
    });

    it('is empty-safe', () => {
        expect(findOrderTies([])).toEqual([]);
        expect(findOrderTies(undefined)).toEqual([]);
    });
});

describe('assessOrdering', () => {
    it('counts entries that can move, not ties', () => {
        // One tie of 29 rewrites the block; twenty-nine ties of one do nothing.
        expect(assessOrdering(esinShape())).toMatchObject({
            activated: 31,
            tiedEntries: 29,
            stable: false,
        });
    });

    it('calls a fully distinct book stable', () => {
        const fixed = esinShape().map((e, i) => ({ ...e, order: e.order * 100 - i }));
        expect(assessOrdering(fixed)).toMatchObject({ tiedEntries: 0, stable: true });
    });

    it('treats a chat with no lorebook as stable, not as unknown', () => {
        // Elizabeth's run: world_info empty on every turn.
        expect(assessOrdering([])).toMatchObject({ activated: 0, tiedEntries: 0, stable: true });
    });

    it('is empty-safe', () => {
        expect(assessOrdering(undefined)).toMatchObject({ activated: 0, stable: true });
    });
});

describe('entryKey', () => {
    it('keys the way ST does, so a held entry round-trips', () => {
        // world-info.js:1025 — `${entry.world}.${entry.uid}`.
        expect(entryKey({ world: "Wren's Lorebook", uid: 7 })).toBe("Wren's Lorebook.7");
    });

    it('rejects what ST would refuse to force', () => {
        // :1022 requires both fields present or the entry is ignored outright.
        expect(entryKey({ uid: 7 })).toBeNull();
        expect(entryKey({ world: 'A' })).toBeNull();
        expect(entryKey({ world: 'A', uid: null })).toBeNull();
        expect(entryKey(null)).toBeNull();
        expect(entryKey('nope')).toBeNull();
    });

    it('accepts uid 0, which is a real uid', () => {
        expect(entryKey({ world: 'A', uid: 0 })).toBe('A.0');
    });
});

describe('createRememberedSet', () => {
    const entry = (uid, content = `entry ${uid}`, world = 'A') => ({ world, uid, content });

    it('is add-only: a turn that activates nothing changes nothing', () => {
        const set = createRememberedSet();
        set.observe([entry(1), entry(2)]);

        // The dropout turn. WORLD_INFO_ACTIVATED does not even fire when the set
        // is empty (world-info.js:900), so this is the defensive case.
        set.observe([]);
        set.observe(undefined);

        expect(set.size).toBe(2);
    });

    it('is add-only: a smaller set never shrinks it', () => {
        const set = createRememberedSet();
        set.observe([entry(1), entry(2), entry(3)]);
        set.observe([entry(1)]);

        expect(set.size).toBe(3);
    });

    it('keeps the object first seen, so the block stays byte-identical', () => {
        const set = createRememberedSet();
        const original = entry(1, 'original text');
        set.observe([original]);
        set.observe([entry(1, 'a different object with different text')]);

        expect(set.entries()[0]).toBe(original);
        expect(set.entries()[0].content).toBe('original text');
    });

    it('reports what it newly learned, and only that', () => {
        const set = createRememberedSet();

        expect(set.observe([entry(1), entry(2)]).added).toEqual(['A.1', 'A.2']);
        expect(set.observe([entry(2), entry(3)]).added).toEqual(['A.3']);
    });

    it('skips entries ST could never force back in', () => {
        const set = createRememberedSet();
        set.observe([entry(1), { uid: 2 }, { world: 'A' }]);

        expect(set.size).toBe(1);
    });

    it('forgets one book without touching the others', () => {
        const set = createRememberedSet();
        set.observe([entry(1, 'a', 'A'), entry(2, 'b', 'B'), entry(3, 'c', 'A')]);

        expect(set.forget('A')).toBe(2);
        expect(set.size).toBe(1);
        expect(set.has('B.2')).toBe(true);
    });

    it('forgetting an unknown book is a no-op', () => {
        const set = createRememberedSet();
        set.observe([entry(1)]);

        expect(set.forget('nonexistent')).toBe(0);
        expect(set.size).toBe(1);
    });

    it('holds entries in first-activation order', () => {
        const set = createRememberedSet();
        set.observe([entry(3), entry(1)]);
        set.observe([entry(2)]);

        expect(set.entries().map((e) => e.uid)).toEqual([3, 1, 2]);
    });

    it('clears completely for a new chat', () => {
        const set = createRememberedSet();
        set.observe([entry(1), entry(2)]);
        set.clear();

        expect(set.size).toBe(0);
        expect(set.entries()).toEqual([]);
    });
});

/**
 * The trim (docs/decisions.md D-0069). Sizes are exact so the budget boundary is
 * a fact rather than an approximation: `sizeOf` returns the entry's declared
 * weight, and ST's own check is `running >= budget` counting the entry being
 * tested (world-info.js:5059-5061).
 */
describe('trimToBudget', () => {
    const weighed = (uid, order, weight, extra = {}) => ({
        world: 'A', uid, order, content: 'x'.repeat(weight), ...extra,
    });
    // ST joins each entry on a newline before counting it (:5059).
    const sizeOf = async (text) => String(text).length - 1;

    it('drops the lowest order first', async () => {
        const entries = [weighed(1, 10, 100), weighed(2, 30, 100), weighed(3, 20, 100)];

        const { kept, dropped } = await trimToBudget({ entries, budget: 250, sizeOf });

        expect(dropped.map((e) => e.uid)).toEqual([1]);
        expect(kept.map((e) => e.uid)).toEqual([2, 3]);
    });

    it('keeps what survives in first-activation order, not in order order', async () => {
        // The kept list is what gets forced, and forcing order is the tiebreak ST
        // falls back to (:5002). It must not be reshuffled by the trim.
        const entries = [weighed(1, 10, 10), weighed(2, 30, 10), weighed(3, 20, 10)];

        const { kept } = await trimToBudget({ entries, budget: 1000, sizeOf });

        expect(kept.map((e) => e.uid)).toEqual([1, 2, 3]);
    });

    it('takes everything after the entry that overflowed, as ST does', async () => {
        // :5059-5061 — the content is added to the running count *before* the
        // test, so a pass that overflows can never fit anything smaller later.
        const entries = [weighed(1, 30, 100), weighed(2, 20, 500), weighed(3, 10, 1)];

        const { kept } = await trimToBudget({ entries, budget: 300, sizeOf });

        expect(kept.map((e) => e.uid)).toEqual([1]);
    });

    it('keeps an ignoreBudget entry however heavy it is, and does not charge for it', async () => {
        // :5061 and :5669 — it is added on top of the budget, not out of it.
        const entries = [
            weighed(1, 5, 10_000, { ignoreBudget: true }),
            weighed(2, 30, 100),
            weighed(3, 20, 100),
        ];

        const { kept, dropped } = await trimToBudget({ entries, budget: 250, sizeOf });

        expect(dropped).toEqual([]);
        expect(kept.map((e) => e.uid)).toEqual([1, 2, 3]);
    });

    it('is a no-op when the set is already under the budget', async () => {
        const entries = [weighed(1, 10, 100), weighed(2, 20, 100)];

        const { kept, dropped, tokens } = await trimToBudget({ entries, budget: 10_000, sizeOf });

        expect(dropped).toEqual([]);
        expect(kept).toHaveLength(2);
        expect(tokens).toBe(200);
    });

    it('trims nothing rather than everything when the budget is unusable', async () => {
        // CLAUDE.md §4.17: a missing number degrades to "leave the lore alone".
        const entries = [weighed(1, 10, 100)];

        for (const budget of [0, -1, NaN, undefined, null]) {
            const { kept } = await trimToBudget({ entries, budget, sizeOf });
            expect(kept).toHaveLength(1);
        }
    });

    it('reports what the kept set weighs, not what the overflowing one did', async () => {
        const entries = [weighed(1, 30, 100), weighed(2, 20, 100), weighed(3, 10, 900)];

        const { tokens } = await trimToBudget({ entries, budget: 500, sizeOf });

        expect(tokens).toBe(200);
    });

    it('is empty-safe', async () => {
        await expect(trimToBudget({ entries: [], budget: 100, sizeOf }))
            .resolves.toMatchObject({ kept: [], dropped: [] });
        await expect(trimToBudget({ entries: undefined, budget: 100, sizeOf }))
            .resolves.toMatchObject({ kept: [], dropped: [] });
    });
});

describe('the held set, trimmed', () => {
    const weighed = (uid, order, weight) => ({ world: 'A', uid, order, content: 'x'.repeat(weight) });
    const sizeOf = async (text) => String(text).length - 1;

    it('stops holding what it dropped', async () => {
        const set = createRememberedSet();
        set.observe([weighed(1, 10, 100), weighed(2, 30, 100), weighed(3, 20, 100)]);

        const result = await set.trim({ budget: 250, sizeOf });

        expect(result).toMatchObject({ dropped: 1, kept: 2 });
        expect(set.has('A.1')).toBe(false);
        expect(set.entries().map((e) => e.uid)).toEqual([2, 3]);
    });

    it('re-holds an entry it dropped if the scan activates it again', async () => {
        // The trim is not a blocklist. D-0023's add-only rule still governs: what
        // the book says is relevant comes back in, and waits for the next rebuild.
        const set = createRememberedSet();
        set.observe([weighed(1, 10, 100), weighed(2, 30, 100), weighed(3, 20, 100)]);
        await set.trim({ budget: 250, sizeOf });

        set.observe([weighed(1, 10, 100)]);

        expect(set.has('A.1')).toBe(true);
    });
});
