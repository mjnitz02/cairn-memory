/**
 * One kind of memory work: picking the story's spine out of the index
 * (DESIGN.md §8, docs/decisions.md D-0071).
 *
 * The queue and the transport are the summarizer's, and the failure policy is the
 * shared job's (pipeline/job.js). What this file owns is the shape of one pick: it takes the pending pick
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
import { debug } from '../util/log.js';
import { applyPick } from './canon-pick.js';
import { createJob } from './job.js';
import { MAX_ATTEMPTS } from './tally.js';

const over = (work) => `records #${work.covers[0]}–#${work.covers[1]}`;

/**
 * @param {{getContext: () => object, send: Function, save: Function, clock: () => number,
 *          pending: () => object|null, strategy?: object}} machinery
 *        `pending` returns the assembler's pending pick for the turn just planned, or
 *        null. It carries the chat's own records, so it never reaches the log.
 */
export function createCanonJob({ getContext, send, save, clock, pending, strategy = canonPick }) {
    const job = createJob({
        log: 'canon',
        name: 'canon pick',
        article: 'a canon pick',
        counters: { picked: 0, duplicates: 0, refused: 0, clipped: 0 },
        /** A pick is tried again once the index it would read moves on, or the question changes. */
        key: (chatId, work) => `${chatId}\n${work.covers[0]}\n${work.covers[1]}\n${work.slots}`,
        failed: (work) => `The canon pick over ${over(work)}`,
        gaveUp: (work, _at, count) => `Gave up on picking canon over ${over(work)} after ${count} failures. The block keeps the canon it has.`,
    }, { send });
    const picks = job.tally;

    return {
        job,
        tally: picks,

        /** The pick the assembler says is due, or null. */
        pending: () => {
            const due = pending?.();
            return due?.due ? due : null;
        },

        givenUp: job.givenUp,

        /**
         * One pick. The batch lands on the newest record it read — behind the raw
         * window by construction, so it is written where swipes never reach.
         */
        async run(context, { memoryProfileId, canonPrompt }, work) {
            const { chatId } = context;
            const sent = await job.request(context, memoryProfileId, work, work.covers[1], () => strategy.build({
                records: work.records.map((entry) => entry.record),
                slots: work.slots,
                template: canonPrompt,
                expand: (text) => context.substituteParams(text),
                // Only an adoption carries the canon forward; the queue asks afresh (D-0090).
                ...(work.previous?.length ? { previous: work.previous } : {}),
            }));
            if (!sent) return false;

            // The message the batch goes on, and the messages the rows point at, are all
            // found by identity: a branch, a deletion or a chat change while the request
            // was out means this pick is about a chat that no longer exists.
            const now = getContext();
            const index = now.chat?.indexOf(work.message) ?? -1;
            if (index < 0) return job.discard(work.covers[1], 'its message is no longer in the chat');

            const parsed = strategy.parse(sent.reply?.content, {
                slots: work.slots, records: work.records.length,
            });
            if (!parsed.ok) return job.fail(chatId, work, parsed.reason);

            const applied = applyPick({
                picked: parsed.picked,
                dropped: parsed.dropped,
                records: work.records.map((entry) => ({
                    index: now.chat?.indexOf(entry.message) ?? -1,
                })),
                covers: [work.covers[0], index],
                slots: work.slots,
                prompt: sent.request.prompt,
                at: new Date(clock()).toISOString(),
            });
            if (!applied.picked) return job.fail(chatId, work, 'uncited');
            if (!writeCanon(now.chat, index, applied.batch)) return job.fail(chatId, work, 'write');

            // What the panel reports is the applied change, never the model's claim
            // (CLAUDE.md §4.18).
            picks.stats.picked += applied.picked;
            picks.stats.duplicates += applied.duplicates;
            picks.stats.refused += applied.dropped + applied.uncited;
            picks.stats.clipped += parsed.picked.filter((fact) => fact.clipped).length;
            job.succeed(chatId, work);
            debug(`Picked canon over records #${work.covers[0]}–#${index}: ${applied.picked} of `
                + `${work.slots} slot(s) filled, ${applied.duplicates} repeated, `
                + `${applied.dropped + applied.uncited} refused.`);
            await save(now, 'a canon pick');
            return true;
        },

        /** One pick at a time, so no lists. */
        status: (gate) => job.status(gate, (status) => {
            const { chatId } = getContext();
            const due = pending?.();
            status.reason = due?.reason ?? null;
            status.pending = due?.due
                ? { covers: due.covers, records: due.records.length, slots: due.slots }
                : null;
            const record = due?.due ? job.record(chatId, due) : undefined;
            if (record) {
                status.failed = { covers: due.covers, attempts: record.count, reason: record.reason };
                status.givenUp = record.count >= MAX_ATTEMPTS;
            }
        }, { full: false }),
    };
}
