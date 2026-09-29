/**
 * One kind of memory work: reading a batch of summaries into index records
 * (docs/decisions.md D-0070, D-0075).
 *
 * The queue and the transport are the summarizer's, and the failure policy is the
 * shared job's (pipeline/job.js). What this file owns is the shape of one batch: take the oldest summaries
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
import { debug } from '../util/log.js';
import { pendingIndex } from './index-reads.js';
import { createJob } from './job.js';
import { MAX_ATTEMPTS } from './tally.js';

const span = (work) => `#${work[0].index}–#${work[work.length - 1].index}`;

/**
 * @param {{getContext: () => object, send: Function, save: Function, clock: () => number,
 *          strategy?: object}} machinery The summarizer's transport and shared helpers.
 */
export function createIndexJob({ getContext, send, save, clock, strategy = indexBatch }) {
    const job = createJob({
        log: 'index',
        name: 'index batch',
        article: 'an index batch',
        counters: { records: 0, dropped: 0, clipped: 0, missed: 0 },
        /**
         * Keyed on where the batch starts, not its whole range: the range grows with every
         * reply, and a key that grows with it never gives up (docs/decisions.md D-0086).
         */
        key: (chatId, work) => `${chatId}\n${work[0].index}`,
        failed: (work) => `Indexing summaries ${span(work)}`,
        gaveUp: (work, _at, count) => `Gave up on indexing summaries ${span(work)} after ${count} failures. Those summaries keep no compact line, so they evict rather than demote.`,
    }, { send });
    const batches = job.tally;

    return {
        job,
        tally: batches,

        /** The oldest summaries with no record, or null when there are none. */
        pending() {
            const { chat } = getContext();
            const waiting = pendingIndex(chat, { readScene, readIndex }, { limit: MAX_BATCH });
            return waiting.length ? waiting : null;
        },

        givenUp: job.givenUp,

        /**
         * One batch. Each record is written on its own message, found by identity: a
         * branch, a deletion or a chat change while the request was out means those
         * indexes belong to a chat that no longer exists.
         */
        async run(context, { memoryProfileId, indexPrompt }, work) {
            const { chatId } = context;
            const messages = work.map((entry) => context.chat[entry.index]);
            const sent = await job.request(context, memoryProfileId, work, work[work.length - 1].index, () => strategy.build({
                summaries: work.map((entry) => ({ text: entry.text })),
                template: indexPrompt,
                expand: (text) => context.substituteParams(text),
            }));
            if (!sent) return false;

            const parsed = strategy.parse(sent.reply?.content, { count: work.length });
            if (!parsed.ok) return job.fail(chatId, work, parsed.reason);

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
                if (writeIndex(now.chat, index, { record: fields, prompt: sent.request.prompt, at })) written++;
            }
            if (!written) return job.fail(chatId, work, 'write');

            // What the panel reports is the applied change, never the model's claim
            // (CLAUDE.md §4.18): records actually stored, slots the parser dropped or cut
            // to their hard cap, and numbers the reply never answered.
            batches.stats.records += written;
            batches.stats.dropped += parsed.dropped.length;
            batches.stats.clipped += parsed.clipped?.length ?? 0;
            batches.stats.missed += work.length - parsed.records.length;
            job.succeed(chatId, work);
            debug(`Indexed summaries ${span(work)}: ${written} record(s) written, `
                + `${parsed.dropped.length} slot(s) dropped, ${work.length - parsed.records.length} unanswered.`);
            await save(now, 'index records');
            return true;
        },

        /** One batch at a time, so no lists. */
        status: (gate) => job.status(gate, (status) => {
            const { chat, chatId } = getContext();
            const waiting = pendingIndex(chat, { readScene, readIndex });
            status.waiting = waiting.length;
            const work = waiting.slice(0, MAX_BATCH);
            status.pending = work.length ? { from: work[0].index, to: work[work.length - 1].index, summaries: work.length } : null;
            const record = work.length ? job.record(chatId, work) : undefined;
            if (record) {
                status.failed = { from: work[0].index, to: work[work.length - 1].index, attempts: record.count, reason: record.reason };
                status.givenUp = record.count >= MAX_ATTEMPTS;
            }
        }),
    };
}
