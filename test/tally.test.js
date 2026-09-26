import { describe, expect, it } from 'vitest';
import { MAX_ATTEMPTS, createTally } from '../src/pipeline/tally.js';

describe('one kind\'s tally', () => {
    it('counts failures per job, and gives up at the limit', () => {
        const tally = createTally();
        for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
            expect(tally.fail('a', 'refusal')).toMatchObject({ count: attempt, givenUp: attempt === MAX_ATTEMPTS });
        }

        expect(tally.givenUp('a')).toBe(true);
        expect(tally.givenUp('b')).toBe(false);
        expect(tally.record('a')).toEqual({ count: MAX_ATTEMPTS, reason: 'refusal' });
        expect(tally.stats).toMatchObject({ failures: MAX_ATTEMPTS, lastReason: 'refusal' });
    });

    it('marks only a streak\'s first failure, and a success ends the streak and clears its job', () => {
        const tally = createTally();

        expect(tally.fail('a', 'error').first).toBe(true);
        expect(tally.fail('b', 'error').first).toBe(false);
        tally.succeed('a');

        expect(tally.streak).toBe(0);
        expect(tally.record('a')).toBeUndefined();
        expect(tally.record('b')).toMatchObject({ count: 1 });
        expect(tally.fail('b', 'error').first).toBe(true);
        expect(tally.stats.written).toBe(1);
    });

    it('starts the counts again for another chat, keeping attempts, the streak and its own counters', () => {
        const tally = createTally({ dropped: 0 });
        tally.stats.dropped = 2;
        tally.fail('a', 'error');
        const before = tally.stats;

        tally.resetStats();

        expect(tally.stats).not.toBe(before);
        expect(tally.stats).toEqual({
            calls: 0, written: 0, failures: 0, lastReason: null, lastMs: null, ms: 0, tokensIn: 0, tokensOut: 0, dropped: 0,
        });
        expect(tally.streak).toBe(1);
        expect(tally.record('a')).toMatchObject({ count: 1 });
    });

    it('keeps each tally to itself', () => {
        const summaries = createTally();
        const states = createTally();
        summaries.fail('a', 'error');

        expect(states.givenUp('a')).toBe(false);
        expect(states.streak).toBe(0);
        expect(states.stats.failures).toBe(0);
    });
});
