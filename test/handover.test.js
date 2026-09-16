import { describe, expect, it } from 'vitest';
import { HANDOVER, assessHandover } from '../src/prompt/handover.js';

/**
 * The gate is the whole safety of P1 step 3 (docs/decisions.md D-0020, D-0027).
 * Every closed state below is a prompt that would otherwise carry the memory
 * block twice, or a raw window two extensions disagree about — both of which
 * look completely normal on screen.
 */
const HANDED_OVER = { own: true, injecting: [], excluding: false };

describe('the handover gate', () => {
    it('opens only when every precondition holds at once', () => {
        expect(assessHandover(HANDED_OVER)).toMatchObject({
            writing: true,
            reason: HANDOVER.WRITING,
        });
    });

    it('stays shut by default, so a bare call never writes', () => {
        expect(assessHandover().writing).toBe(false);
        expect(assessHandover({}).reason).toBe(HANDOVER.OFF);
    });

    it('will not write while the setting is off, however ready everything else is', () => {
        expect(assessHandover({ ...HANDED_OVER, own: false })).toMatchObject({
            writing: false,
            reason: HANDOVER.OFF,
        });
    });

    it('will not be the second writer of the same block', () => {
        const verdict = assessHandover({ ...HANDED_OVER, injecting: ['qvink_memory_short'] });

        expect(verdict.writing).toBe(false);
        expect(verdict.reason).toBe(HANDOVER.QVINK_INJECTING);
        // The detail names the switch, because the alternative is a user staring
        // at a panel that says "no" and nothing else.
        expect(verdict.detail).toContain('Macro Only');
    });

    it('counts the long-term injection too — it is the same prompt', () => {
        expect(assessHandover({ ...HANDED_OVER, injecting: ['qvink_memory_long'] }).reason)
            .toBe(HANDOVER.QVINK_INJECTING);
    });

    it('will not be the second writer of the raw window either', () => {
        const verdict = assessHandover({ ...HANDED_OVER, excluding: true });

        expect(verdict.writing).toBe(false);
        expect(verdict.reason).toBe(HANDOVER.QVINK_EXCLUDING);
        expect(verdict.detail).toContain('Exclude messages after threshold');
    });

    it('reports the switch the user must flip first, not the last one', () => {
        // Both wrong at once: qvink silent is step one, so that is what it says.
        const verdict = assessHandover({
            own: true, injecting: ['qvink_memory_short'], excluding: true,
        });

        expect(verdict.reason).toBe(HANDOVER.QVINK_INJECTING);
    });
});
