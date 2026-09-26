/**
 * Cleanup every memory strategy's parser does first: reasoning that leaked into
 * the content, a code fence, and a refusal in place of output
 * (docs/decisions.md D-0037, D-0044).
 *
 * Pure: text in, text out.
 */

const REFUSAL = /^(?:I'?m sorry|I am sorry|sorry\b|I apologi[sz]e|I can(?:not|'t)\b|I won't\b|I will not\b|I'?m (?:not able|unable)|I am (?:not able|unable)|as an AI\b|I must decline|I'?m afraid)/i;

/**
 * Remove `<think>` blocks from a reply.
 *
 * @param {unknown} content The reply's `content`; anything but a string is empty.
 * @returns {{truncated: boolean, text: string}} `truncated` when the tokens ran out mid-thought.
 */
export function stripThinking(content) {
    let text = typeof content === 'string' ? content : '';

    if (/^\s*<think>/i.test(text) && !/<\/think>/i.test(text)) return { truncated: true, text: '' };
    text = text.replace(/<think>[\s\S]*?<\/think>/gi, '');
    // The chat template opened the block in the prompt, so only its close arrived.
    const close = text.search(/<\/think>/i);
    if (close >= 0) text = text.slice(close + '</think>'.length);
    return { truncated: false, text };
}

/** The first closed code fence's body, or the text as it is. */
export function unfence(text) {
    const fence = text.match(/```[^\n]*\n([\s\S]*?)\n?```/);
    return fence ? fence[1] : text;
}

/** Whether text opens like a refusal, however its apostrophes are typed. */
export function looksLikeRefusal(text) {
    return REFUSAL.test(straightQuotes(text.trim()));
}

export function straightQuotes(text) {
    return text.replace(/[‘’]/g, '\'');
}

/**
 * The first bracketed span that parses as JSON. Spans that do not parse, like a
 * `[Current scene]` echoed in a preamble, are skipped whole, so an object nested
 * inside a broken one is never taken for the reply. Not "first `{` to last `}`":
 * that read a preamble's punctuation as structure (docs/decisions.md D-0044).
 *
 * `unclosed` is a bracket still open when the reply ends — a cut-off reply, since ST
 * returns no finish reason (public/scripts/custom-request.js:60).
 *
 * @param {string} text
 * @returns {{parsed: true, value: unknown} | {parsed: false, unclosed: boolean}}
 */
export function firstJson(text) {
    for (let start = text.search(/[{[]/); start >= 0;) {
        const end = closingIndex(text, start);
        if (end < 0) return { parsed: false, unclosed: true };
        try {
            return { parsed: true, value: JSON.parse(text.slice(start, end + 1)) };
        } catch {
            const next = text.slice(end + 1).search(/[{[]/);
            start = next < 0 ? -1 : end + 1 + next;
        }
    }
    return { parsed: false, unclosed: false };
}

/** Where the bracket at `start` closes, skipping brackets inside JSON strings; -1 if it never does. */
function closingIndex(text, start) {
    let depth = 0;
    let inString = false;
    for (let i = start; i < text.length; i++) {
        const ch = text[i];
        if (inString) {
            if (ch === '\\') i++;
            else if (ch === '"') inString = false;
        } else if (ch === '"') {
            inString = true;
        } else if (ch === '{' || ch === '[') {
            depth++;
        } else if ((ch === '}' || ch === ']') && --depth === 0) {
            return i;
        }
    }
    return -1;
}
