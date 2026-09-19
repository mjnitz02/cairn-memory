/**
 * The Established facts shown under the message that carries a canon batch, beside
 * the summary and the world state (src/ui/chat-marks.js draws them).
 *
 * The chat shows what the prompt carries, so a promotion is visible where it happened
 * rather than only in a log. It matters more here than for the other two tiers: a fact
 * is permanent for its branch and P4 gives no lever to remove one, so the only way to
 * see a wrong one is to be shown it (docs/p4-plan.md decision 2, §5).
 *
 * Pure: a chat in, text out. The DOM glue is the caller's.
 */
import { readCanon } from '../store/chat-store.js';

/**
 * The facts each batch promoted, as a plain list, keyed by the message the batch is
 * stored on. A batch that promoted nothing has nothing to show — it is a record that
 * the range was read, not something the reader needs.
 *
 * Unlike the fold (memory/canon.js) this does not dedup: it shows what that pass
 * wrote, which is what the reader is checking.
 *
 * @param {Array<object>} chat
 * @returns {Map<number, string>}
 */
export function canonTexts(chat) {
    const texts = new Map();
    (chat ?? []).forEach((message, index) => {
        const { status, canon } = readCanon(message);
        if (status !== 'valid' || !canon.facts.length) return;
        texts.set(index, canon.facts.map((fact) => `• ${fact.text}`).join('\n'));
    });
    return texts;
}
