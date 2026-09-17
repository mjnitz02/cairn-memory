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
