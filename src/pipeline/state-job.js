/**
 * One kind of memory work: bringing the world state up to the newest message
 * (docs/decisions.md D-0044, D-0053).
 *
 * The queue, the transport and the failure policy are the summarizer's and come in as
 * `machinery`; what this file owns is the shape of one state update — what it reads,
 * what invalidates it while the request is out, and what is written when it lands.
 *
 * Its counterpart for summaries is inline in the summarizer, because the summary job
 * *is* the queue's unit of work; canon's is pipeline/canon-job.js.
 */
import { jobStillCurrent, pendingStateJob } from '../memory/state.js';
import { mergeReply } from '../memory/state-schema.js';
import { stateRecord } from '../memory/state-strategy.js';
import { writeState } from '../store/chat-store.js';
import { debug, warn } from '../util/log.js';
import { MAX_ATTEMPTS, createTally } from './tally.js';

/**
 * @param {{getContext: () => object, send: Function, save: Function, discard: Function,
 *          report: Function, clock: () => number, strategy?: object}} machinery
 *        `send` runs one request through the memory profile and counts it against the
 *        tally it is given; the rest are the summarizer's shared helpers.
 */
export function createStateJob({ getContext, send, save, discard, report, clock, strategy = stateRecord }) {
    const states = createTally({ dropped: 0 });

    /** A state update is tried again once what it reads changes: an edit, or a new message. */
    const key = (chatId, job) => `${chatId}\n${job.read}\n${job.hash}`;

    function fail(chatId, job, index, reason, err) {
        const outcome = states.fail(key(chatId, job), reason);
        report(outcome, `The world state update through message #${index} failed (${reason}).`, err);
        if (outcome.givenUp) {
            warn(`Gave up on the world state through message #${index} after ${outcome.count} failures. The previous state stays in the prompt until a new message arrives.`);
        }
    }

    return {
        tally: states,

        /** The next update, or null when the newest visible message already carries one. */
        pending: (chat) => pendingStateJob(chat),

        /** Whether this job has failed too often to try again this session. */
        givenUp: (chatId, job) => states.givenUp(key(chatId, job)),

        /** One update. Its outcome is only recorded: a failing state must not starve summaries. */
        async run(context, { memoryProfileId, statePrompt }, job) {
            const { chatId } = context;
            let request;
            try {
                request = strategy.build({
                    template: statePrompt,
                    state: job.state,
                    messages: job.messages,
                    earlier: job.earlier,
                    expand: (text) => context.substituteParams(text),
                });
            } catch (err) {
                return fail(chatId, job, job.index, 'error', err);
            }

            const sent = await send(context, memoryProfileId, request, states, job.index);
            if (sent.signal.aborted) return discard('state', job.index, 'aborted');
            if (sent.error) return fail(chatId, job, job.index, 'error', sent.error);

            // Found by identity and checked against the hash of what was read, so an edit,
            // hide, deletion, swipe, continue or chat change meanwhile discards the reply.
            const now = getContext();
            const index = jobStillCurrent(now.chat, job);
            if (index < 0) return discard('state', job.index, 'the messages it read changed');

            const parsed = strategy.parse(sent.reply?.content);
            if (!parsed.ok) return fail(chatId, job, index, parsed.reason);
            const { value, changed, dropped } = mergeReply(job.state, parsed.record);
            if (dropped.length) {
                states.stats.dropped += dropped.length;
                debug(`Dropped from the state reply: ${dropped.map((drop) => `${drop.field} (${drop.reason})`).join(', ')}.`);
            }
            if (!writeState(now.chat, index, {
                value, read: job.read, changed, prompt: request.prompt, at: new Date(clock()).toISOString(),
            })) {
                return fail(chatId, job, index, 'write');
            }

            states.succeed(key(chatId, job));
            debug(`Brought the state up to message #${index}: ${changed.length ? changed.join(', ') : 'no change'}.`);
            await save(now, 'the state');
        },

        /** The summary tier's `status`, for a kind that runs one job at a time, so no lists. */
        status(gate) {
            const status = {
                ...states.stats, gate: gate.reason, tracker: gate.tracker, streak: states.streak,
                inFlight: states.inFlight, pending: null, failed: null, givenUp: false,
            };
            try {
                const { chat, chatId } = getContext();
                const job = pendingStateJob(chat);
                status.pending = Boolean(job);
                const record = job ? states.record(key(chatId, job)) : undefined;
                if (record) {
                    status.failed = { index: job.index, attempts: record.count, reason: record.reason };
                    status.givenUp = record.count >= MAX_ATTEMPTS;
                }
            } catch (err) {
                warn('Could not read the state queue.', err);
            }
            return status;
        },
    };
}
