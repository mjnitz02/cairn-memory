/**
 * The see-saw — the *growth* cadence, and only that (DESIGN.md §11).
 *
 * qvink fuses two decisions into one trigger: when the injection threshold moves,
 * summaries enter the block *and* the budget evicts from the far end. Both edges
 * of the block change on the same turn, so every step rewrites the block from its
 * first byte and the whole prompt below it with it — 13% prefix stability, once
 * every ten messages, forever (docs/decisions.md D-0018, D-0019).
 *
 * Splitting them is the whole of D-0019. This module owns growth: the threshold
 * advances in steps, and between steps the included set does not change at all,
 * so the block is byte-identical. When it does advance, the new summaries land at
 * the *tail*, which leaves the head — and therefore the prefix — intact. Eviction
 * is the other cadence and lives in budgeter.js, deliberately in another file, so
 * the code says what the design says.
 *
 * Pure but for one index of state. No ST, no DOM, no network.
 */

/**
 * Messages kept raw behind the threshold. They are already summarised, but their
 * summaries are held back so the model sees the prose rather than both.
 * qvink's `summary_injection_threshold` default (its index.js:134).
 */
export const RAW_WINDOW = 10;

/**
 * Messages the threshold advances by. `0` means "advance every turn", which is
 * qvink's own default and the pathological case D-0018 measured at 13% — the
 * block's ends both move on every single message. A real step is the point, and
 * `0` stays reachable because it is the control this is measured against.
 */
export const STEP = 10;

/**
 * @param {{rawWindow?: number, step?: number}} [options]
 */
export function createSeeSaw({ rawWindow = RAW_WINDOW, step = STEP } = {}) {
    /** Highest message index whose summary may be in the block. null = no turn yet. */
    let summarisedThrough = null;

    return {
        /**
         * Advance the threshold if this turn has earned it.
         *
         * @param {number} chatLength `context.chat.length`
         * @returns {{summarisedThrough: number, stepped: boolean, reason: string}}
         */
        advance(chatLength) {
            const length = Number.isFinite(chatLength) ? Math.max(0, chatLength) : 0;
            const base = Math.max(-1, length - 1 - rawWindow);

            if (summarisedThrough === null) {
                summarisedThrough = base;
                return { summarisedThrough, stepped: true, reason: 'first-turn' };
            }

            // The chat got shorter: a branch or a swipe (DESIGN.md §9). Holding the
            // old threshold would inject summaries for messages that no longer
            // exist, which is quiet wrongness rather than an error. Follow it down
            // immediately — a rebuild on a branch is expected and unavoidable.
            if (base < summarisedThrough) {
                summarisedThrough = base;
                return { summarisedThrough, stepped: true, reason: 'rollback' };
            }

            if (base > summarisedThrough && base - summarisedThrough >= step) {
                summarisedThrough = base;
                return { summarisedThrough, stepped: true, reason: 'step' };
            }

            return { summarisedThrough, stepped: false, reason: 'held' };
        },

        /** A new chat is a new see-saw. */
        reset() {
            summarisedThrough = null;
        },

        get summarisedThrough() {
            return summarisedThrough;
        },

        get rawWindow() {
            return rawWindow;
        },

        get step() {
            return step;
        },
    };
}
