/**
 * One kind of memory work: promoting the permanent facts out of the summaries a
 * rebuild is about to drop (DESIGN.md §8, docs/p4-plan.md decisions 6 to 8).
 *
 * The queue, the transport and the failure policy are the summarizer's and come in as
 * `machinery`. What this file owns is the shape of one pass: it takes the pending
 * pass the assembler worked out from this turn's block, asks for the promotions, and
 * writes the batch on the newest summary it read.
 *
 * **A failed pass changes nothing.** No batch is written, eviction proceeds exactly as
 * it does today, and the block keeps the facts it has (CLAUDE.md §4.17). It is the
 * lowest-priority kind for that reason: a whole see-saw step of slack, against a
 * summary that holds the step and a state the next prompt carries.
 */
import { canonPromote } from '../memory/canon-strategy.js';
import { writeCanon } from '../store/chat-store.js';
import { debug, warn } from '../util/log.js';
import { applyPass } from './compactor.js';
import { MAX_ATTEMPTS, createTally } from './tally.js';

/**
 * @param {{getContext: () => object, send: Function, save: Function, discard: Function,
 *          report: Function, clock: () => number, pending: () => object|null,
 *          strategy?: object}} machinery
 *        `pending` returns the assembler's pending pass for the turn just planned, or
 *        null. It carries the chat's own text, so it never reaches the log.
 */
export function createCanonJob({ getContext, send, save, discard, report, clock, pending, strategy = canonPromote }) {
    const passes = createTally({ promoted: 0, duplicates: 0, refused: 0 });

    /** A pass is tried again once the range it would read moves on. */
    const key = (chatId, job) => `${chatId}\n${job.covers[0]}\n${job.covers[1]}`;

    function fail(chatId, job, reason, err) {
        const outcome = passes.fail(key(chatId, job), reason);
        report(outcome, `The compaction pass over summaries #${job.covers[0]}–#${job.covers[1]} failed (${reason}).`, err);
        if (outcome.givenUp) {
            warn(`Gave up on compacting summaries #${job.covers[0]}–#${job.covers[1]} after ${outcome.count} failures. Those summaries are dropped without promotion.`);
        }
    }

    return {
        tally: passes,

        /** The pass the assembler says is due, or null. */
        pending: () => {
            const due = pending?.();
            return due?.due ? due : null;
        },

        givenUp: (chatId, job) => passes.givenUp(key(chatId, job)),

        /**
         * One pass. The batch lands on the newest summary it read — behind the raw
         * window by construction, so it is written where swipes never reach.
         */
        async run(context, { memoryProfileId }, job) {
            const { chatId } = context;
            let request;
            try {
                request = strategy.build({
                    summaries: job.evicting,
                    canon: job.canon,
                    room: job.room,
                    expand: (text) => context.substituteParams(text),
                });
            } catch (err) {
                return fail(chatId, job, 'error', err);
            }

            const sent = await send(context, memoryProfileId, request, passes, job.covers[1]);
            if (sent.signal.aborted) return discard('compaction pass', job.covers[1], 'aborted');
            if (sent.error) return fail(chatId, job, 'error', sent.error);

            // The message the batch goes on, found by identity: a branch, a deletion or a
            // chat change while the request was out means this pass is about a chat that
            // no longer exists. Unlike a scene or a state there is no text to re-hash —
            // a fact survives an edit by design (plan decision 2).
            const now = getContext();
            const index = now.chat?.indexOf(job.message) ?? -1;
            if (index < 0) return discard('compaction pass', job.covers[1], 'its message is no longer in the chat');

            const parsed = strategy.parse(sent.reply?.content, { room: job.room });
            if (!parsed.ok) return fail(chatId, job, parsed.reason);

            const applied = applyPass({
                promoted: parsed.promote,
                dropped: parsed.dropped,
                canon: job.canon,
                covers: [job.covers[0], index],
                prompt: request.prompt,
                at: new Date(clock()).toISOString(),
            });
            if (!writeCanon(now.chat, index, applied.batch)) return fail(chatId, job, 'write');

            // What the panel reports is the applied change, never the model's claim
            // (CLAUDE.md §4.18).
            passes.stats.promoted += applied.promoted;
            passes.stats.duplicates += applied.duplicates;
            passes.stats.refused += applied.dropped;
            passes.succeed(key(chatId, job));
            debug(`Compacted summaries #${job.covers[0]}–#${index}: promoted ${applied.promoted}, `
                + `${applied.duplicates} already known, ${applied.dropped} refused.`);
            await save(now, 'a canon batch');
        },

        /** As the state tier's: one pass at a time, so no lists. */
        status(gate) {
            const status = {
                ...passes.stats, gate: gate.reason, streak: passes.streak, inFlight: passes.inFlight,
                pending: null, failed: null, givenUp: false, full: gate.reason === 'ready' && pending?.()?.reason === 'canon-full',
            };
            try {
                const { chatId } = getContext();
                const due = pending?.();
                status.pending = due?.due ? { covers: due.covers, summaries: due.evicting.length } : null;
                const record = due?.due ? passes.record(key(chatId, due)) : undefined;
                if (record) {
                    status.failed = { covers: due.covers, attempts: record.count, reason: record.reason };
                    status.givenUp = record.count >= MAX_ATTEMPTS;
                }
            } catch (err) {
                warn('Could not read the compaction queue.', err);
            }
            return status;
        },
    };
}
