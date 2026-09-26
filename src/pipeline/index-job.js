/**
 * One kind of memory work: reading a batch of summaries into index records
 * (docs/decisions.md D-0070, D-0075).
 *
 * The queue, the transport and the failure policy are the summarizer's and come in as
 * `machinery`. What this file owns is the shape of one batch: take the oldest summaries
 * with no record, ask for one record each, and write each record on the message its
 * summary is on — so records branch, swipe and roll back with the summaries themselves
 * and nothing has to be kept in step (D-0045).
 *
 * **A failed batch changes nothing.** No record is written, the compact tier holds
 * whatever lines it already has, and the block evicts exactly as it does today
 * (CLAUDE.md §4.17). It sits below summaries in the queue because a missing summary holds
 * the see-saw step while a missing record costs the horizon one line, at the next rebuild
 * at the earliest.
 *
 * **Partial is normal and partial is written.** A reply that answers twelve of fifteen
 * numbers leaves three summaries pending, and they come back in the next batch — the
 * queue is derived from what is on disk, so there is no state to reconcile.
 */
import { indexBatch, MAX_BATCH } from '../memory/index-strategy.js';
import { readIndex, readScene, writeIndex } from '../store/chat-store.js';
import { debug, warn } from '../util/log.js';
import { pendingIndex } from './compactor.js';
import { MAX_ATTEMPTS, createTally } from './tally.js';

/**
 * @param {{getContext: () => object, send: Function, save: Function, discard: Function,
 *          report: Function, clock: () => number, strategy?: object}} machinery
 */
export function createIndexJob({ getContext, send, save, discard, report, clock, strategy = indexBatch }) {
    const batches = createTally({ records: 0, dropped: 0, missed: 0 });

    /** A batch is tried again once the range it would read moves on. */
    const key = (chatId, job) => `${chatId}\n${job[0].index}\n${job[job.length - 1].index}`;
    const span = (job) => `#${job[0].index}–#${job[job.length - 1].index}`;

    function fail(chatId, job, reason, err) {
        const outcome = batches.fail(key(chatId, job), reason);
        report(outcome, `Indexing summaries ${span(job)} failed (${reason}).`, err);
        if (outcome.givenUp) {
            warn(`Gave up on indexing summaries ${span(job)} after ${outcome.count} failures. Those summaries keep no compact line, so they evict rather than demote.`);
        }
    }

    return {
        tally: batches,

        /** The oldest summaries with no record, or null when there are none. */
        pending() {
            const { chat } = getContext();
            const waiting = pendingIndex(chat, { readScene, readIndex }, { limit: MAX_BATCH });
            return waiting.length ? waiting : null;
        },

        givenUp: (chatId, job) => batches.givenUp(key(chatId, job)),

        /**
         * One batch. Each record is written on its own message, found by identity: a
         * branch, a deletion or a chat change while the request was out means those
         * indexes belong to a chat that no longer exists.
         */
        async run(context, { memoryProfileId }, job) {
            const { chatId } = context;
            const messages = job.map((entry) => context.chat[entry.index]);
            let request;
            try {
                request = strategy.build({
                    summaries: job.map((entry) => ({ text: entry.text })),
                    expand: (text) => context.substituteParams(text),
                });
            } catch (err) {
                return fail(chatId, job, 'error', err);
            }

            const sent = await send(context, memoryProfileId, request, batches, job[job.length - 1].index);
            if (sent.signal.aborted) return discard('index batch', job[job.length - 1].index, 'aborted');
            if (sent.error) return fail(chatId, job, 'error', sent.error);

            const parsed = strategy.parse(sent.reply?.content, { count: job.length });
            if (!parsed.ok) return fail(chatId, job, parsed.reason);

            const now = getContext();
            const at = new Date(clock()).toISOString();
            let written = 0;
            for (const record of parsed.records) {
                const message = messages[record.n - 1];
                const index = now.chat?.indexOf(message) ?? -1;
                if (index < 0) continue;
                const { n: _n, ...fields } = record;
                // writeIndex refuses a message whose summary is gone or was edited while
                // the request was out, so a stale record cannot be stored (D-0074).
                if (writeIndex(now.chat, index, { record: fields, prompt: request.prompt, at })) written++;
            }
            if (!written) return fail(chatId, job, 'write');

            // What the panel reports is the applied change, never the model's claim
            // (CLAUDE.md §4.18): records actually stored, slots the parser dropped, and
            // numbers the reply never answered.
            batches.stats.records += written;
            batches.stats.dropped += parsed.dropped.length;
            batches.stats.missed += job.length - parsed.records.length;
            batches.succeed(key(chatId, job));
            debug(`Indexed summaries ${span(job)}: ${written} record(s) written, `
                + `${parsed.dropped.length} slot(s) dropped, ${job.length - parsed.records.length} unanswered.`);
            await save(now, 'index records');
        },

        /** As the other tiers': one batch at a time, so no lists. */
        status(gate) {
            const status = {
                ...batches.stats, gate: gate.reason, streak: batches.streak, inFlight: batches.inFlight,
                pending: null, failed: null, givenUp: false,
            };
            try {
                const { chat, chatId } = getContext();
                const waiting = pendingIndex(chat, { readScene, readIndex });
                status.waiting = waiting.length;
                const job = waiting.slice(0, MAX_BATCH);
                status.pending = job.length ? { from: job[0].index, to: job[job.length - 1].index, summaries: job.length } : null;
                const record = job.length ? batches.record(key(chatId, job)) : undefined;
                if (record) {
                    status.failed = { from: job[0].index, to: job[job.length - 1].index, attempts: record.count, reason: record.reason };
                    status.givenUp = record.count >= MAX_ATTEMPTS;
                }
            } catch (err) {
                warn('Could not read the index queue.', err);
            }
            return status;
        },
    };
}
