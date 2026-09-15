import { describe, expect, it } from 'vitest';
import { createBudget, deriveCap, FLOOR_FRACTION } from '../src/pipeline/budgeter.js';

/** Each scene costs 10 tokens; nothing here depends on the real tokenizer. */
const scenes = (from, to) => Array.from({ length: to - from + 1 }, (_, i) => ({ index: from + i }));
const tokensOf = (list) => list.length * 10;

describe('deriving the cap', () => {
    it('is what the prompt may hold, less what everything else in it cost', () => {
        expect(deriveCap({ maxPromptTokens: 21_000, otherTokens: 6_000 })).toBe(15_000);
    });

    it('never goes negative when the rest of the prompt already overflows', () => {
        expect(deriveCap({ maxPromptTokens: 4_000, otherTokens: 9_000 })).toBe(0);
    });

    it('treats missing measurements as zero rather than as NaN', () => {
        expect(deriveCap({ maxPromptTokens: undefined, otherTokens: 100 })).toBe(0);
        expect(deriveCap({ maxPromptTokens: 500, otherTokens: undefined })).toBe(500);
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
        // No measurement yet is not "no room" — it is "we do not know".
        const fit = createBudget().fit({ scenes: scenes(0, 9), cap: 0, tokensOf });

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
