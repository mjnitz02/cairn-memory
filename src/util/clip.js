/**
 * Soft and hard caps on a model-written string (docs/decisions.md D-0085).
 *
 * The **soft** cap is the number the prompt tells the model. The **hard** cap is
 * where we cut. Between them the text is kept as written: a lower-tier model
 * overshoots a stated limit by a few words far more often than it ignores it, and
 * at 0d dropping those overshoots cost DeepSeek up to half its index.
 *
 * Pure.
 */

/** How far past the soft cap a string may run before it is cut. */
export const HARD_CAP_RATIO = 1.5;

/** The hard cap for a soft one. */
export function hardCap(soft) {
    return Math.floor(soft * HARD_CAP_RATIO);
}

const ELLIPSIS = '…';

/**
 * The text within `hard` characters, cut at the last word boundary with an ellipsis
 * when it was longer. A cut that would leave less than half the cap cuts mid-word
 * instead, because a single enormous word is not worth losing the rest for.
 *
 * @param {string} text Already trimmed.
 * @param {number} hard
 * @returns {{text: string, clipped: boolean}}
 */
export function clip(text, hard) {
    if (text.length <= hard) return { text, clipped: false };
    const room = hard - ELLIPSIS.length;
    const head = text.slice(0, room + 1);
    const space = head.lastIndexOf(' ');
    const cut = space >= room / 2 ? head.slice(0, space) : text.slice(0, room);
    return { text: cut.replace(/[\s,;:.—-]+$/, '') + ELLIPSIS, clipped: true };
}
