/**
 * Prompt prefix stability.
 *
 * A local model with a resident KV cache only re-reads the prompt from the first
 * character that changed. If something volatile sits above something stable, the
 * common prefix collapses and every turn pays full price — the failure that hid
 * for weeks behind a working-looking chat (docs/decisions.md, Lessons).
 *
 * Pure string math. No tokenizer: characters are close enough to rank turns
 * against each other, and this runs on every generation.
 */

/** @returns {number} Characters shared from the start of both strings. */
export function commonPrefixLength(a, b) {
    if (!a || !b) return 0;

    const limit = Math.min(a.length, b.length);
    let i = 0;
    while (i < limit && a.charCodeAt(i) === b.charCodeAt(i)) i++;
    return i;
}

/**
 * Compare this turn's prompt against the previous one.
 *
 * Stability is the share of the *current* prompt that was already cached, so it
 * answers "how much of this request is free?" — which is the question the local
 * model's cost actually turns on.
 *
 * @param {string|null} previous
 * @param {string} current
 * @param {{excerpt?: number}} [options]
 */
export function comparePrompts(previous, current, { excerpt = 100 } = {}) {
    const currentLength = current?.length ?? 0;

    if (previous == null) {
        return {
            previousLength: 0,
            currentLength,
            commonPrefix: 0,
            stabilityPercent: null, // No previous turn — not 0%, not 100%.
            divergence: null,
        };
    }

    const common = commonPrefixLength(previous, current);
    const identical = common === previous.length && common === currentLength;

    return {
        previousLength: previous.length,
        currentLength,
        commonPrefix: common,
        stabilityPercent: currentLength === 0 ? 0 : round1((common / currentLength) * 100),
        // Where the prompts parted company, with enough either side to recognise
        // what moved. This is the whole diagnostic.
        divergence: identical ? null : {
            index: common,
            previous: previous.slice(common, common + excerpt),
            current: current.slice(common, common + excerpt),
        },
    };
}

/**
 * Flatten whatever the generation hook handed us into one comparable string.
 * Chat-completion prompts arrive as a message array; text completion as a string.
 * Never mutates the input (CLAUDE.md §2.8).
 */
export function flattenPrompt(prompt) {
    if (typeof prompt === 'string') return prompt;
    if (!Array.isArray(prompt)) return '';

    return prompt
        .map((message) => `${message?.role ?? ''}: ${stringifyContent(message?.content)}`)
        .join('\n');
}

function stringifyContent(content) {
    if (typeof content === 'string') return content;
    // Multimodal content is an array of parts; only the text parts are comparable.
    if (Array.isArray(content)) {
        return content.map((part) => (typeof part?.text === 'string' ? part.text : '')).join('');
    }
    return '';
}

function round1(value) {
    return Math.round(value * 10) / 10;
}
