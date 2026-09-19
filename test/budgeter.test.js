import { describe, expect, it } from 'vitest';
import {
    CAP_FRACTION, MARGIN_FRACTION, MIN_CAP_FRACTION,
    canonCap, createBudget, deriveCap, FLOOR_FRACTION, recoupled,
} from '../src/pipeline/budgeter.js';
import { NEAR_LIMIT_FRACTION } from '../src/util/context-size.js';
import { mulberry32 } from './helpers/random.js';

/** Each scene costs 10 tokens; nothing here depends on the real tokenizer. */
const scenes = (from, to) => Array.from({ length: to - from + 1 }, (_, i) => ({ index: from + i }));
const tokensOf = (list) => list.length * 10;

/** A chat with room to spare: the ceiling binds and nothing else does. */
const roomy = { card: 500, lore: 0, window: 800, state: 0 };

/**
 * The smaller of a fixed share and what the chat leaves, with no setting either
 * way (docs/decisions.md D-0038, D-0052).
 */
describe('how much room the block gets', () => {
    it('is 35% of the max prompt while the chat leaves that much', () => {
        expect(CAP_FRACTION).toBe(0.35);
        const derived = deriveCap({ maxPromptTokens: 22_016, reserves: roomy });

        expect(derived.cap).toBe(7_705);
        expect(derived.limitedBy).toBe('share');
        // Esin: at least the 7,500 tokens qvink's limit gave it.
        expect(derived.cap).toBeGreaterThanOrEqual(7_500);
    });

    /**
     * Esin's own numbers (docs/decisions.md D-0052): a 4,500-token card, a ~5,000
     * lorebook and a heaviest 19-message run of 7,968 leave about half the share.
     */
    it('is what the chat leaves when the rest of the prompt wants more', () => {
        const derived = deriveCap({
            maxPromptTokens: 23_040,
            reserves: { card: 4_500, lore: 5_000, window: 7_968, state: 330 },
        });

        expect(derived.margin).toBe(1_152);
        expect(derived.room).toBe(4_090);
        expect(derived.cap).toBe(4_090);
        expect(derived.limitedBy).toBe('room');
        expect(derived.share).toBe(8_063);
    });

    it('keeps a tenth for a chat that cannot fit at all, and says so', () => {
        const derived = deriveCap({
            maxPromptTokens: 23_040,
            reserves: { card: 9_000, lore: 5_760, window: 9_000, state: 330 },
        });

        expect(derived.room).toBeLessThan(derived.minimum);
        expect(derived.cap).toBe(2_304);
        expect(derived.limitedBy).toBe('starved');
    });

    /**
     * A reserve that could not be read is not a reserve of zero: guessing low
     * would hand the block room the prompt does not have. Fall back to the share
     * that has been shipping, and say the cap is unexplained (CLAUDE.md §4.17).
     */
    it('falls back to the plain share when the reserves are unreadable', () => {
        const derived = deriveCap({ maxPromptTokens: 23_040, reserves: null });

        expect(derived.cap).toBe(8_063);
        expect(derived.limitedBy).toBe('unknown');
        expect(derived.parts).toBeNull();
        expect(derived.room).toBeNull();
    });

    it('is nothing when the max prompt is unknown, never negative', () => {
        for (const max of [undefined, Number.NaN, -100]) {
            expect(deriveCap({ maxPromptTokens: max, reserves: roomy }).cap).toBe(0);
            expect(deriveCap({ maxPromptTokens: max, reserves: null }).cap).toBe(0);
        }
    });

    it('treats a missing or nonsense reserve as zero rather than throwing', () => {
        const derived = deriveCap({
            maxPromptTokens: 10_000,
            reserves: { card: undefined, lore: Number.NaN, window: -5, state: '7' },
        });

        expect(derived.parts).toEqual({ card: 0, lore: 0, window: 0, state: 0 });
        expect(derived.cap).toBe(3_500);
    });

    /** The ceiling and the minimum, against parts that add to anything at all. */
    it('always lands between a tenth and 35% of the max prompt', () => {
        const random = mulberry32(0x0652);

        for (let i = 0; i < 500; i++) {
            const max = 2_048 + Math.floor(random() * 120_000);
            const part = () => Math.floor(random() * max * 0.7);
            const derived = deriveCap({
                maxPromptTokens: max,
                reserves: { card: part(), lore: part(), window: part(), state: part() },
            });

            expect(derived.cap).toBeGreaterThanOrEqual(Math.floor(max * MIN_CAP_FRACTION));
            expect(derived.cap).toBeLessThanOrEqual(Math.floor(max * CAP_FRACTION));
        }
    });

    /**
     * The margin is the same 5% `prompt_near_limit` watches, which is what turns
     * that warning into a check: every other reserve is an upper bound, so a full
     * prompt should land under the line, and a prompt that does not means a
     * reserve missed something (docs/decisions.md D-0052).
     */
    it('leaves the margin prompt_near_limit is measured against', () => {
        expect(MARGIN_FRACTION).toBeCloseTo(1 - NEAR_LIMIT_FRACTION, 10);
    });
});

/** docs/p4-plan.md decision 5: canon's share, and the guard that keeps the see-saw apart. */
describe('canon\'s share of the block', () => {
    it('takes its fifth when the block has room for it', () => {
        // Esin's derived cap (docs/decisions.md D-0054) against a ~1,060-token step.
        expect(canonCap({ cap: 3_463, stepTokens: 1_060 })).toEqual({
            cap: 692, share: 692, guard: 1_343, limitedBy: 'share',
        });
    });

    it('gives way to the scene budget when two steps need the room', () => {
        const narrow = canonCap({ cap: 2_000, stepTokens: 900 });

        expect(narrow).toEqual({ cap: 200, share: 400, guard: 200, limitedBy: 'guard' });
    });

    it('gets nothing at all on a chat whose block cannot hold two steps', () => {
        // The right order of sacrifice: the summaries are the memory.
        expect(canonCap({ cap: 1_000, stepTokens: 600 })).toMatchObject({ cap: 0, limitedBy: 'guard' });
        expect(canonCap({ cap: 0, stepTokens: 100 })).toMatchObject({ cap: 0 });
        expect(canonCap()).toMatchObject({ cap: 0 });
    });

    it('takes its share before the block has a step to measure', () => {
        // The first turn of a chat: no block, so no step size yet.
        expect(canonCap({ cap: 3_463, stepTokens: 0 })).toMatchObject({ cap: 692, limitedBy: 'share' });
    });

    /**
     * The invariant the guard exists for (CLAUDE.md §3.10). Canon takes room from the
     * summaries, so it is the one thing in P4 that could recouple the two cadences.
     * Whatever the cap and the step, the scene budget keeps two steps or canon is zero.
     */
    it('can never recouple the see-saw, whatever the cap and the step', () => {
        const random = mulberry32(0x04a1);

        for (let i = 0; i < 1_000; i++) {
            const cap = Math.floor(random() * 12_000);
            const stepTokens = Math.floor(random() * 3_000);
            const canon = canonCap({ cap, stepTokens });
            // A pass never promotes past the cap, and the block admits no more than it.
            const sceneCap = cap - canon.cap;
            const floor = Math.max(0, Math.floor(sceneCap * FLOOR_FRACTION));

            const seed = JSON.stringify({ cap, stepTokens });
            expect(canon.cap, seed).toBeGreaterThanOrEqual(0);
            expect(canon.cap, seed).toBeLessThanOrEqual(cap);
            if (canon.cap > 0) expect(sceneCap, seed).toBeGreaterThanOrEqual(2 * stepTokens);
            // And the report that follows from it: canon never turns `recoupled` on.
            if (canon.cap > 0 && !recoupled({ sceneCap: cap, floor: Math.floor(cap * FLOOR_FRACTION), stepTokens })) {
                expect(recoupled({ sceneCap, floor, stepTokens }), seed).toBe(false);
            }
        }
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
        const fit = budget.fit({ scenes: scenes(0, 7), sceneCap: 100, tokensOf, rebuild: true });

        expect(fit.over).toBe(false);
        expect(fit.kept.map((scene) => scene.index)).toEqual([3, 4, 5, 6, 7]);
        expect(budget.oldest).toBe(3);
    });

    it('leaves a block already under the floor alone', () => {
        const budget = createBudget();
        const fit = budget.fit({ scenes: scenes(0, 3), sceneCap: 100, tokensOf, rebuild: true });

        expect(fit.kept).toHaveLength(4);
        expect(fit.evicted).toBe(0);
    });

    it('is the same answer for the same chat, however often it is asked', () => {
        // A reload is a new budget on the same chat: nothing carried, same block.
        const first = createBudget().fit({ scenes: scenes(0, 30), sceneCap: 100, tokensOf, rebuild: true });
        const again = createBudget().fit({ scenes: scenes(0, 30), sceneCap: 100, tokensOf, rebuild: true });

        expect(again.kept).toEqual(first.kept);
    });

    it('does not trim on a turn that is not a rebuild', () => {
        const fit = createBudget().fit({ scenes: scenes(0, 7), sceneCap: 100, tokensOf });

        expect(fit.kept).toHaveLength(8);
    });
});

describe('fitting the block to the cap', () => {
    it('keeps everything while it fits', () => {
        const budget = createBudget();
        const fit = budget.fit({ scenes: scenes(0, 9), sceneCap: 200, tokensOf });

        expect(fit.kept).toHaveLength(10);
        expect(fit.evicted).toBe(0);
        expect(fit.over).toBe(false);
    });

    it('drops to the floor in one pass, oldest first', () => {
        const budget = createBudget();
        const fit = budget.fit({ scenes: scenes(0, 19), sceneCap: 100, tokensOf });

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
            const fit = budget.fit({ scenes: scenes(0, newest), sceneCap: 100, tokensOf });
            if (fit.evicted) evictions.push(newest);
        }

        // Once at the crossing, then only after another five scenes of growth.
        expect(evictions).toEqual([19, 25, 31, 37]);
    });

    it('holds the mark forward so an unchanged chat is an unchanged block', () => {
        const budget = createBudget();
        budget.fit({ scenes: scenes(0, 19), sceneCap: 100, tokensOf });
        const oldest = budget.oldest;
        const again = budget.fit({ scenes: scenes(0, 19), sceneCap: 100, tokensOf });

        expect(budget.oldest).toBe(oldest);
        expect(again.evicted).toBe(0);
        expect(again.kept.map((s) => s.index)).toEqual([15, 16, 17, 18, 19]);
    });

    it('never empties the block, even against a cap it cannot meet', () => {
        const budget = createBudget();
        const fit = budget.fit({ scenes: scenes(0, 9), sceneCap: 1, tokensOf });

        expect(fit.kept).toHaveLength(1);
        expect(fit.kept[0].index).toBe(9);
    });

    it('rewinds when a branch takes the chat back past the mark', () => {
        const budget = createBudget();
        budget.fit({ scenes: scenes(0, 19), sceneCap: 100, tokensOf });
        expect(budget.oldest).toBe(15);

        // The branch point is before everything we were keeping: those summaries
        // are gone, and the mark described a chat that no longer exists.
        const fit = budget.fit({ scenes: scenes(0, 8), sceneCap: 100, tokensOf });

        expect(fit.kept.map((s) => s.index)).toEqual([...Array(9).keys()]);
    });

    it('ignores a cap of zero rather than evicting everything', () => {
        // An unconfigured limit is not "no room" — it is "no limit given".
        const fit = createBudget().fit({ scenes: scenes(0, 9), sceneCap: 0, tokensOf, rebuild: true });

        expect(fit.kept).toHaveLength(10);
        expect(fit.over).toBe(false);
    });

    it('starts over on a new chat', () => {
        const budget = createBudget();
        budget.fit({ scenes: scenes(0, 19), sceneCap: 100, tokensOf });
        budget.reset();

        expect(budget.fit({ scenes: scenes(0, 5), sceneCap: 200, tokensOf }).kept).toHaveLength(6);
    });
});
