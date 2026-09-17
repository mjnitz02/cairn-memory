/**
 * One kind of memory work's bookkeeping: what the open chat has cost, the failure
 * streak that decides when to toast, and the jobs that failed too often to try
 * again this session. Summaries and state updates each keep their own, so one
 * kind failing never gives up on the other (docs/decisions.md D-0045).
 *
 * Pure: no ST, no network.
 */

/** Failures before a job is left alone for the rest of the session. */
export const MAX_ATTEMPTS = 3;

/**
 * @param {object} [counters] Running totals this kind reports beyond the shared ones, at zero.
 */
export function createTally(counters = {}) {
    const fresh = () => ({
        calls: 0, written: 0, failures: 0, lastReason: null, lastMs: null, ms: 0, tokensIn: 0, tokensOut: 0, ...counters,
    });
    /** Job key → `{count, reason}`. Keys carry the chat id, so they outlive a chat change. */
    const attempts = new Map();
    let stats = fresh();
    let streak = 0;

    return {
        /** Counters for the open chat. The log keeps running totals, so a reader diffs two lines. */
        get stats() {
            return stats;
        },

        get streak() {
            return streak;
        },

        /** The message a request is out for, or null. */
        inFlight: null,

        /** Counts start again in another chat; attempts and the streak do not. */
        resetStats() {
            stats = fresh();
        },

        /**
         * @returns {{count: number, first: boolean, givenUp: boolean}} `first` is the
         *          streak's first failure, the one that toasts.
         */
        fail(key, reason) {
            const count = (attempts.get(key)?.count ?? 0) + 1;
            attempts.set(key, { count, reason });
            stats.failures++;
            stats.lastReason = reason;
            streak++;
            return { count, first: streak === 1, givenUp: count >= MAX_ATTEMPTS };
        },

        succeed(key) {
            attempts.delete(key);
            stats.written++;
            streak = 0;
        },

        /** Forget a job's failures, so a user's retry of a given-up job is tried at all. */
        forget(key) {
            attempts.delete(key);
        },

        /** @returns {{count: number, reason: string}|undefined} */
        record(key) {
            return attempts.get(key);
        },

        givenUp(key) {
            return (attempts.get(key)?.count ?? 0) >= MAX_ATTEMPTS;
        },
    };
}
