import { describe, expect, it } from 'vitest';
import { assessOrdering, findOrderTies } from '../src/prompt/lorebook.js';

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
