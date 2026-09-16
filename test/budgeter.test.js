import { describe, expect, it } from 'vitest';
import { CAP_FRACTION, createBudget, FLOOR_FRACTION, memoryCap } from '../src/pipeline/budgeter.js';

/** Each scene costs 10 tokens; nothing here depends on the real tokenizer. */
const scenes = (from, to) => Array.from({ length: to - from + 1 }, (_, i) => ({ index: from + i }));
const tokensOf = (list) => list.length * 10;

/** A fixed share of the max prompt, with no setting (docs/p2-plan.md decision 2). */
describe('how much room the block gets', () => {
    it('is 35% of the max prompt, rounded down', () => {
        expect(CAP_FRACTION).toBe(0.35);
        // Esin: at least the 7,500 tokens qvink's limit gave it.
        expect(memoryCap(22_016)).toBe(7_705);
        expect(memoryCap(22_016)).toBeGreaterThanOrEqual(7_500);
    });

    it('is nothing when the max prompt is unknown, never negative', () => {
        expect(memoryCap(undefined)).toBe(0);
        expect(memoryCap(Number.NaN)).toBe(0);
        expect(memoryCap(-100)).toBe(0);
    });
});

/**
 * The first turn of a session changes the block's head whatever the budget does,
 * so it may as well land at the floor: the rebuild is already paid for, and the
 * slack it buys defers the next one (docs/decisions.md D-0033).
 */
describe('the first turn of a session', () => {
    it('lands at the floor even when the block is under the cap', () => {
        const budget = createBudget();
        const fit = budget.fit({ scenes: scenes(0, 7), cap: 100, tokensOf, rebuild: true });

        expect(fit.over).toBe(false);
        expect(fit.kept.map((scene) => scene.index)).toEqual([3, 4, 5, 6, 7]);
        expect(budget.oldest).toBe(3);
    });

    it('leaves a block already under the floor alone', () => {
        const budget = createBudget();
        const fit = budget.fit({ scenes: scenes(0, 3), cap: 100, tokensOf, rebuild: true });

        expect(fit.kept).toHaveLength(4);
        expect(fit.evicted).toBe(0);
    });

    it('is the same answer for the same chat, however often it is asked', () => {
        // A reload is a new budget on the same chat: nothing carried, same block.
        const first = createBudget().fit({ scenes: scenes(0, 30), cap: 100, tokensOf, rebuild: true });
        const again = createBudget().fit({ scenes: scenes(0, 30), cap: 100, tokensOf, rebuild: true });

        expect(again.kept).toEqual(first.kept);
    });

    it('does not trim on a turn that is not a rebuild', () => {
        const fit = createBudget().fit({ scenes: scenes(0, 7), cap: 100, tokensOf });

        expect(fit.kept).toHaveLength(8);
    });
});

describe('fitting the block to the cap', () => {
    it('keeps everything while it fits', () => {
        const budget = createBudget();
        const fit = budget.fit({ scenes: scenes(0, 9), cap: 200, tokensOf });

        expect(fit.kept).toHaveLength(10);
        expect(fit.evicted).toBe(0);
        expect(fit.over).toBe(false);
    });

    it('drops to the floor in one pass, oldest first', () => {
        const budget = createBudget();
        const fit = budget.fit({ scenes: scenes(0, 19), cap: 100, tokensOf });

        expect(fit.floor).toBe(100 * FLOOR_FRACTION);
        expect(fit.tokens).toBeLessThanOrEqual(fit.floor);
        expect(fit.kept.map((s) => s.index)).toEqual([15, 16, 17, 18, 19]);
        expect(fit.evicted).toBe(15);
    });

    /**
     * The point of the floor. A budget that evicts exactly enough to fit would
     * evict again on the very next summary — which is qvink's behaviour and the
     * head-eviction D-0019 is aimed at. Dropping to half the cap buys half a cap
     * of growth before the next rebuild.
     */
    it('does not evict again until growth crosses the cap a second time', () => {
        const budget = createBudget();
        const evictions = [];

        for (let newest = 19; newest <= 40; newest++) {
            const fit = budget.fit({ scenes: scenes(0, newest), cap: 100, tokensOf });
            if (fit.evicted) evictions.push(newest);
        }

        // Once at the crossing, then only after another five scenes of growth.
        expect(evictions).toEqual([19, 25, 31, 37]);
    });

    it('holds the mark forward so an unchanged chat is an unchanged block', () => {
        const budget = createBudget();
        budget.fit({ scenes: scenes(0, 19), cap: 100, tokensOf });
        const oldest = budget.oldest;
        const again = budget.fit({ scenes: scenes(0, 19), cap: 100, tokensOf });

        expect(budget.oldest).toBe(oldest);
        expect(again.evicted).toBe(0);
        expect(again.kept.map((s) => s.index)).toEqual([15, 16, 17, 18, 19]);
    });

    it('never empties the block, even against a cap it cannot meet', () => {
        const budget = createBudget();
        const fit = budget.fit({ scenes: scenes(0, 9), cap: 1, tokensOf });

        expect(fit.kept).toHaveLength(1);
        expect(fit.kept[0].index).toBe(9);
    });

    it('rewinds when a branch takes the chat back past the mark', () => {
        const budget = createBudget();
        budget.fit({ scenes: scenes(0, 19), cap: 100, tokensOf });
        expect(budget.oldest).toBe(15);

        // The branch point is before everything we were keeping: those summaries
        // are gone, and the mark described a chat that no longer exists.
        const fit = budget.fit({ scenes: scenes(0, 8), cap: 100, tokensOf });

        expect(fit.kept.map((s) => s.index)).toEqual([...Array(9).keys()]);
    });

    it('ignores a cap of zero rather than evicting everything', () => {
        // An unconfigured limit is not "no room" — it is "no limit given".
        const fit = createBudget().fit({ scenes: scenes(0, 9), cap: 0, tokensOf, rebuild: true });

        expect(fit.kept).toHaveLength(10);
        expect(fit.over).toBe(false);
    });

    it('starts over on a new chat', () => {
        const budget = createBudget();
        budget.fit({ scenes: scenes(0, 19), cap: 100, tokensOf });
        budget.reset();

        expect(budget.fit({ scenes: scenes(0, 5), cap: 200, tokensOf }).kept).toHaveLength(6);
    });
});
