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

/**
 * Where a reply stopped being JSON, for the log of a failed call (docs/decisions.md
 * D-0094): the engine's own parse error and a short window of the reply around it,
 * because the reason alone cannot tell a cut-off from a stray quote.
 *
 * @param {unknown} content The reply's `content`.
 * @param {number} [span] Characters kept either side of the spot.
 * @returns {{error: string|null, at: number|null, near: string, tail: string}}
 *          `error` is null when a JSON span parsed and only its shape was wrong.
 */
export function describeReply(content, span = 80) {
    const raw = typeof content === 'string' ? content : '';
    const thought = stripThinking(raw);
    const text = thought.truncated ? raw : unfence(thought.text);
    const tail = text.slice(-span);
    const start = text.search(/[{[]/);
    if (start < 0) return { error: 'no JSON', at: null, near: text.slice(0, 2 * span), tail };
    if (firstJson(text).parsed) return { error: null, at: null, near: text.slice(start, start + 2 * span), tail };

    const body = text.slice(start);
    let error = null;
    try {
        JSON.parse(body);
    } catch (err) {
        error = String(err?.message ?? err).slice(0, 200);
    }
    const offset = errorOffset(error, body);
    const at = offset === null ? null : start + offset;
    const near = at === null ? body.slice(0, 2 * span) : text.slice(Math.max(0, at - span), at + span);
    return { error, at, near, tail };
}

/** The offset a JSON.parse message names, as V8 ("position N") or Firefox ("line L column C") word it. */
function errorOffset(message, body) {
    const position = /position (\d+)/.exec(message ?? '');
    if (position) return Number(position[1]);
    const lineColumn = /line (\d+) column (\d+)/.exec(message ?? '');
    if (!lineColumn) return null;
    const lines = body.split('\n').slice(0, Number(lineColumn[1]) - 1);
    return lines.reduce((sum, line) => sum + line.length + 1, 0) + Number(lineColumn[2]) - 1;
}
