/**
 * The rebuild turn — one definition, read by everything that batches to it
 * (docs/decisions.md D-0067).
 *
 * A rebuild already breaks the prefix at the block's head and is already the
 * expensive turn, so everything discontinuous happens there and nowhere else:
 * block eviction, canon admission, canon re-derivation, World Info
 * reprioritisation, and the examples latch. This file exists so that "is this a
 * rebuild turn" has exactly one answer. Re-deriving the condition at a call site
 * is how the answers drift apart, and the drift is invisible in play — the block
 * simply starts changing on turns it should not.
 *
 * `prompt/assembler.js` computes it once and puts it in the report as `rebuilt`;
 * everything downstream reads that flag rather than the inputs
 * (`prompt/injector.js` is the first such reader). test/rebuild.test.js asserts
 * both halves: that this is the definition, and that nothing else writes one.
 *
 * Pure: two numbers in, a boolean out.
 */

/** The see-saw's reason for a cold first turn (pipeline/scheduler.js). */
export const FIRST_TURN = 'first-turn';

/**
 * Whether this turn rewrites the block's head.
 *
 * Eviction is one half: dropping a summary moves every byte after it. **A demotion
 * is the same half** — replacing a summary's prose with its compact line rewrites
 * exactly those bytes, so it is a head-change by the same argument, and batching
 * discontinuous work to a turn that has one is the whole of D-0067 (D-0075). A cold
 * first turn is the other half: there is no previous block to be continuous with.
 *
 * **`rollback` is deliberately not a rebuild.** A branch or a swipe pulls the
 * threshold back (scheduler.js's `rollback`), which does rewrite the head, but it
 * also rolls the *store* back: the records a re-derivation would read are the ones
 * that just went away, and re-deriving there would spend a call to reproduce what
 * the fold already gives for free (D-0045). The head-change is paid either way;
 * the discontinuous work is not.
 *
 * @param {{evicted?: number, demoted?: number, stepReason?: string}} turn
 * @returns {boolean}
 */
export function isRebuild({ evicted = 0, demoted = 0, stepReason = '' } = {}) {
    const moved = (Number.isFinite(evicted) ? evicted : 0) + (Number.isFinite(demoted) ? demoted : 0);
    return moved > 0 || stepReason === FIRST_TURN;
}
