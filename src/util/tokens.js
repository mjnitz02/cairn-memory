/**
 * Token counting. ST's tokenizer is authoritative but async and not free, so
 * callers that just need a ranking can use the estimate.
 */

/** ~4 characters per token. Wrong in the details, right in the ordering. */
export function estimateTokens(text) {
    return Math.ceil(String(text ?? '').length / 4);
}

/**
 * Count with ST's tokenizer, falling back to the estimate if it is unavailable
 * or throws. A token count is diagnostic; it must never break a generation.
 * @param {object} context SillyTavern.getContext()
 */
export async function countTokens(context, text) {
    try {
        const count = await context.getTokenCountAsync(String(text ?? ''));
        return Number.isFinite(count) ? count : estimateTokens(text);
    } catch {
        return estimateTokens(text);
    }
}
