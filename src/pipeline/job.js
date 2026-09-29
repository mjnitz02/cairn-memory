/**
 * What every kind of memory work shares: a tally, a key that says when a failed job is
 * worth trying again, the failure and discard policy, and the first half of every run —
 * build the request, send it, and stop on an abort or an error (docs/decisions.md D-0045).
 *
 * A kind's own file (summary-, state-, index- and canon-job.js) owns the rest: what one
 * job reads, what invalidates it while the request is out, and what it writes.
 */
import { debug, toast, warn } from '../util/log.js';
import { createTally } from './tally.js';

/** An empty or cut-off reply is nearly always a budget spent reasoning (docs/decisions.md D-0086). */
const REASONING_HINT = 'The memory model most likely spent its reply budget reasoning: turn reasoning off in the memory profile\'s preset.';
const BUDGET_REASONS = new Set(['empty', 'truncated']);

/** A failure's toast text, with the likely cause when the reason points at one. */
export function failureDetail(detail, reason) {
    return BUDGET_REASONS.has(reason) ? `${detail} ${REASONING_HINT}` : detail;
}

/** Toast the first failure of a streak and log the rest, so a flaky model is not a wall of toasts. */
export function reportFailure({ first, reason }, detail, err) {
    if (first) toast(failureDetail(`${detail} Cairn will try again after the next reply.`, reason));
    else warn(detail);
    if (err) warn(err);
}

/**
 * @param {{log: string, name: string, article: string, counters?: object,
 *          key: (chatId: string, work: object) => string,
 *          failed: (work: object, at: number) => string,
 *          gaveUp: (work: object, at: number, count: number) => string}} kind
 *        `log` is the kind as the chat's log records it (D-0093), `name` and `article` as
 *        the debug log says it. `failed` names what failed; `gaveUp` is the whole warning.
 * @param {{send: Function}} machinery The summarizer's transport.
 */
export function createJob(kind, { send }) {
    const tally = createTally(kind.counters);
    const keyOf = kind.key;

    const job = {
        kind,
        tally,

        /** Whether this job has failed too often to try again this session. */
        givenUp: (chatId, work) => tally.givenUp(keyOf(chatId, work)),

        /** Forget a job's failures, so one the user asked for is tried at all. */
        forget: (chatId, work) => tally.forget(keyOf(chatId, work)),

        record: (chatId, work) => tally.record(keyOf(chatId, work)),

        succeed: (chatId, work) => tally.succeed(keyOf(chatId, work)),

        /** @returns {false} So a run can `return job.fail(…)`. */
        fail(chatId, work, reason, err, at) {
            const outcome = tally.fail(keyOf(chatId, work), reason);
            reportFailure(outcome, `${kind.failed(work, at)} failed (${reason}).`, err);
            if (outcome.givenUp) warn(kind.gaveUp(work, at, outcome.count));
            return false;
        },

        /** A reply the chat moved on from: counted, never a failure. @returns {false} */
        discard(at, why) {
            tally.discard(why);
            debug(`Discarded the ${kind.name} for message #${at}: ${why}.`);
            return false;
        },

        /**
         * Build a request and send it. A build that throws, an abort and a transport error
         * are already recorded when this returns null.
         *
         * @param {{fail?: (reason: string, err: unknown) => false}} [options] In place of
         *        `job.fail`, for a kind whose failures depend on who asked.
         * @returns {Promise<{request: object, reply: object}|null>}
         */
        async request(context, memoryProfileId, work, at, build, {
            fail = (reason, err) => job.fail(context.chatId, work, reason, err, at),
        } = {}) {
            let request;
            try {
                request = build();
            } catch (err) {
                return fail('error', err) || null;
            }
            const sent = await send(context, memoryProfileId, request, job, at);
            if (sent.signal.aborted) return job.discard(at, 'aborted') || null;
            if (sent.error) return fail('error', sent.error) || null;
            return { request, reply: sent.reply };
        },

        /**
         * The panel's view of this kind: the tally, the gate's verdict, and what `fill` adds.
         * A reader that throws costs the panel its detail, never the status itself.
         */
        status(gate, fill, base = {}) {
            const status = {
                ...tally.stats, gate: gate.reason, streak: tally.streak, inFlight: tally.inFlight,
                pending: null, failed: null, givenUp: false, ...base,
            };
            try {
                fill(status);
            } catch (err) {
                warn(`Could not read the ${kind.log} queue.`, err);
            }
            return status;
        },
    };
    return job;
}
