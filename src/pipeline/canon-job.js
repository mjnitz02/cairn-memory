/**
 * One kind of memory work: picking the story's spine out of the index
 * (DESIGN.md §8, docs/decisions.md D-0071).
 *
 * The queue, the transport and the failure policy are the summarizer's and come in as
 * `machinery`. What this file owns is the shape of one pick: it takes the pending pick
 * the assembler worked out from this turn's index, asks for exactly N facts, and writes
 * the batch on the newest record it read.
 *
 * **A pick replaces the last one.** The fold reads the newest batch alone
 * (memory/canon.js), so a re-derivation is not an amendment — it is the whole answer,
 * asked again over a longer index. That is what makes a wrong fact fixable, and it is
 * why nothing here merges with what canon already holds.
 *
 * **A failed pick changes nothing.** No batch is written, the block keeps the canon it
 * has, and eviction proceeds exactly as it does today (CLAUDE.md §4.17). It is the
 * lowest-priority kind for that reason: canon changes only at a rebuild anyway, which is
 * ~23 messages away, against a summary that holds the see-saw step.
 */
import { canonPick } from '../memory/canon-strategy.js';
import { writeCanon } from '../store/chat-store.js';
import { debug, warn } from '../util/log.js';
import { applyPick } from './compactor.js';
import { MAX_ATTEMPTS, createTally } from './tally.js';

/**
 * @param {{getContext: () => object, send: Function, save: Function, discard: Function,
 *          report: Function, clock: () => number, pending: () => object|null,
 *          strategy?: object}} machinery
 *        `pending` returns the assembler's pending pick for the turn just planned, or
 *        null. It carries the chat's own records, so it never reaches the log.
 */
export function createCanonJob({ getContext, send, save, discard, report, clock, pending, strategy = canonPick }) {
    const picks = createTally({ picked: 0, duplicates: 0, refused: 0 });

    /** A pick is tried again once the index it would read moves on, or the question changes. */
    const key = (chatId, job) => `${chatId}\n${job.covers[0]}\n${job.covers[1]}\n${job.slots}`;

    function fail(chatId, job, reason, err) {
        const outcome = picks.fail(key(chatId, job), reason);
        report(outcome, `The canon pick over records #${job.covers[0]}–#${job.covers[1]} failed (${reason}).`, err);
        if (outcome.givenUp) {
            warn(`Gave up on picking canon over records #${job.covers[0]}–#${job.covers[1]} after ${outcome.count} failures. The block keeps the canon it has.`);
        }
    }

    return {
        tally: picks,

        /** The pick the assembler says is due, or null. */
        pending: () => {
            const due = pending?.();
            return due?.due ? due : null;
        },

        givenUp: (chatId, job) => picks.givenUp(key(chatId, job)),

        /**
         * One pick. The batch lands on the newest record it read — behind the raw
         * window by construction, so it is written where swipes never reach.
         */
        async run(context, { memoryProfileId }, job) {
            const { chatId } = context;
            let request;
            try {
                request = strategy.build({
                    records: job.records.map((entry) => entry.record),
                    slots: job.slots,
                    expand: (text) => context.substituteParams(text),
                });
            } catch (err) {
                return fail(chatId, job, 'error', err);
            }

            const sent = await send(context, memoryProfileId, request, picks, job.covers[1]);
            if (sent.signal.aborted) return discard('canon pick', job.covers[1], 'aborted');
            if (sent.error) return fail(chatId, job, 'error', sent.error);

            // The message the batch goes on, and the messages the rows point at, are all
            // found by identity: a branch, a deletion or a chat change while the request
            // was out means this pick is about a chat that no longer exists.
            const now = getContext();
            const index = now.chat?.indexOf(job.message) ?? -1;
            if (index < 0) return discard('canon pick', job.covers[1], 'its message is no longer in the chat');

            const parsed = strategy.parse(sent.reply?.content, {
                slots: job.slots, records: job.records.length,
            });
            if (!parsed.ok) return fail(chatId, job, parsed.reason);

            const applied = applyPick({
                picked: parsed.picked,
                dropped: parsed.dropped,
                records: job.records.map((entry) => ({
                    index: now.chat?.indexOf(entry.message) ?? -1,
                })),
                covers: [job.covers[0], index],
                slots: job.slots,
                prompt: request.prompt,
                at: new Date(clock()).toISOString(),
            });
            if (!applied.picked) return fail(chatId, job, 'uncited');
            if (!writeCanon(now.chat, index, applied.batch)) return fail(chatId, job, 'write');

            // What the panel reports is the applied change, never the model's claim
            // (CLAUDE.md §4.18).
            picks.stats.picked += applied.picked;
            picks.stats.duplicates += applied.duplicates;
            picks.stats.refused += applied.dropped + applied.uncited;
            picks.succeed(key(chatId, job));
            debug(`Picked canon over records #${job.covers[0]}–#${index}: ${applied.picked} of `
                + `${job.slots} slot(s) filled, ${applied.duplicates} repeated, `
                + `${applied.dropped + applied.uncited} refused.`);
            await save(now, 'a canon pick');
        },

        /** As the state tier's: one pick at a time, so no lists. */
        status(gate) {
            const status = {
                ...picks.stats, gate: gate.reason, streak: picks.streak, inFlight: picks.inFlight,
                pending: null, failed: null, givenUp: false, full: false,
            };
            try {
                const { chatId } = getContext();
                const due = pending?.();
                status.reason = due?.reason ?? null;
                status.pending = due?.due
                    ? { covers: due.covers, records: due.records.length, slots: due.slots }
                    : null;
                const record = due?.due ? picks.record(key(chatId, due)) : undefined;
                if (record) {
                    status.failed = { covers: due.covers, attempts: record.count, reason: record.reason };
                    status.givenUp = record.count >= MAX_ATTEMPTS;
                }
            } catch (err) {
                warn('Could not read the canon queue.', err);
            }
            return status;
        },
    };
}
