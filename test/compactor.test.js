import { describe, expect, it } from 'vitest';
import { MIN_EVICT_SET, applyPass, pendingCompaction } from '../src/pipeline/compactor.js';
import { createBudget } from '../src/pipeline/budgeter.js';

/** Each summary costs 10 tokens; nothing here depends on the real tokenizer. */
const scenes = (from, to) => Array.from({ length: to - from + 1 }, (_, i) => ({ index: from + i }));
const tokensOf = (list) => list.length * 10;

/** A block under pressure: 30 summaries at 300 tokens against a 320-token cap. */
const pressured = {
    scenes: scenes(0, 29), sceneCap: 320, floor: 160, stepTokens: 100, room: 8, tokensOf,
};

describe('when a compaction pass is due', () => {
    it('is due one step before the block overflows, not when it already has', () => {
        // 300 + 100 > 320: the step after this one cannot fit.
        expect(pendingCompaction(pressured)).toMatchObject({ due: true, reason: 'ready' });

        // A cap the next step still fits under leaves nothing to do.
        expect(pendingCompaction({ ...pressured, sceneCap: 500 }))
            .toMatchObject({ due: false, reason: 'no-pressure' });
    });

    it('is not due when canon has no room left, so no call is made at all', () => {
        expect(pendingCompaction({ ...pressured, room: 0 }))
            .toMatchObject({ due: false, reason: 'canon-full', evicting: [], covers: null });
    });

    it('is not due when too few summaries would be dropped to be worth a call', () => {
        // A floor close under the block: two summaries go, which is below the minimum.
        expect(pendingCompaction({ ...pressured, sceneCap: 310, floor: 305, stepTokens: 20 }))
            .toMatchObject({ due: false, reason: 'too-few' });
        expect(pendingCompaction({ ...pressured, scenes: scenes(0, 1) }))
            .toMatchObject({ due: false, reason: 'too-few' });
        expect(MIN_EVICT_SET).toBe(3);
    });

    it('is not due for a range a pass has already answered for', () => {
        const due = pendingCompaction(pressured);

        expect(pendingCompaction({ ...pressured, coveredThrough: due.covers[1] }))
            .toMatchObject({ due: false, reason: 'already-covered' });
        // One summary short of it, and the newer ground makes it due again.
        expect(pendingCompaction({ ...pressured, coveredThrough: due.covers[1] - 1 }))
            .toMatchObject({ due: true });
    });

    it('is not due on a chat with no block at all', () => {
        expect(pendingCompaction({ ...pressured, scenes: [] })).toMatchObject({ due: false, reason: 'too-few' });
        expect(pendingCompaction()).toMatchObject({ due: false, reason: 'canon-full' });
    });

    /**
     * Pressure holds for the whole step before the rebuild. Without the
     * once-per-cycle test that would be a call every turn (docs/p4-plan.md decision 6).
     */
    it('yields one pass however long the pressure holds', () => {
        let coveredThrough = null;
        let passes = 0;

        for (let turn = 0; turn < 10; turn++) {
            const due = pendingCompaction({ ...pressured, coveredThrough });
            if (due.due) {
                passes++;
                coveredThrough = due.covers[1];
            }
        }

        expect(passes).toBe(1);
    });
});

describe('what a pass reads', () => {
    it('reads the oldest summaries, in order, and says which they are', () => {
        const due = pendingCompaction(pressured);

        expect(due.evicting.map((scene) => scene.index)).toEqual(
            Array.from({ length: due.evicting.length }, (_, i) => i),
        );
        expect(due.covers).toEqual([0, due.evicting.length - 1]);
    });

    /**
     * The invariant §4 names: the simulation must be the set the budgeter really
     * drops. Run the real budgeter forward a step and compare, rather than
     * re-deriving the answer from the same arithmetic.
     */
    it('reads exactly what the next rebuild drops', () => {
        const budget = createBudget();
        const sceneCap = 320;
        const floor = Math.floor(sceneCap * 0.5);
        const block = scenes(0, 29);
        const stepTokens = 100;

        const due = pendingCompaction({ scenes: block, sceneCap, floor, stepTokens, room: 8, tokensOf });
        expect(due.due).toBe(true);

        // The next step arrives: ten more summaries, and now the block is over.
        const stepped = scenes(0, 39);
        const fit = budget.fit({ scenes: stepped, sceneCap, tokensOf });
        const dropped = stepped.slice(0, fit.evicted).map((scene) => scene.index);

        expect(due.evicting.map((scene) => scene.index)).toEqual(dropped);
    });

    it('never reads the whole block, so the rebuild always has something to keep', () => {
        const due = pendingCompaction({ ...pressured, floor: 0, stepTokens: 1_000 });

        expect(due.evicting.length).toBe(pressured.scenes.length - 1);
    });
});

describe('what a reply becomes', () => {
    const covers = [4, 17];

    it('counts the facts it actually wrote, not the ones the model claimed', () => {
        const applied = applyPass({
            promoted: [
                { text: 'Her brother is dead.', entities: ['Wren'] },
                { text: 'her brother is dead!', entities: [] },
                { text: 'They kissed at the lighthouse.', entities: [] },
            ],
            dropped: [{ reason: 'fact-too-long' }, { reason: 'over-room' }],
            canon: [{ text: 'Wren grew up on the harbour.' }],
            covers,
            prompt: 'h:1',
            at: 'T',
        });

        expect(applied).toEqual({
            batch: {
                facts: [
                    { text: 'Her brother is dead.', entities: ['Wren'] },
                    { text: 'They kissed at the lighthouse.', entities: [] },
                ],
                covers: [4, 17],
                prompt: 'h:1',
                at: 'T',
            },
            promoted: 2,
            duplicates: 1,
            dropped: 2,
        });
    });

    it('makes an empty batch when nothing survived, which still records the range read', () => {
        const applied = applyPass({
            promoted: [{ text: 'Wren grew up on the harbour.' }],
            canon: [{ text: 'Wren grew up on the harbour.' }],
            covers,
            prompt: 'h:1',
            at: 'T',
        });

        expect(applied).toEqual({
            batch: { facts: [], covers: [4, 17], prompt: 'h:1', at: 'T' },
            promoted: 0,
            duplicates: 1,
            dropped: 0,
        });
    });

    it('copies the range, so the caller\'s array cannot reach the store', () => {
        const mutable = [4, 17];
        const applied = applyPass({ promoted: [], canon: [], covers: mutable, prompt: 'h:1', at: 'T' });
        mutable[1] = 99;

        expect(applied.batch.covers).toEqual([4, 17]);
    });
});
