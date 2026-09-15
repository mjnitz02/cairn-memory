/**
 * Memory-model mock.
 *
 * Mirrors ConnectionManagerRequestService (public/scripts/extensions/shared.js:392)
 * and its non-streaming return shape, ExtractedData `{ content, reasoning }`
 * (public/scripts/custom-request.js:60).
 *
 * Cairn's memory calls run on a mid-tier cloud model (DESIGN.md §12), so the
 * catalogue below is not a courtesy — these are the outputs we actually get, and
 * every parser is tested against them (CLAUDE.md §3.12).
 */

/** Realistic malformed responses. Named so a failing test says what shape broke. */
export const badOutputs = {
    /** Wrapped in a fence despite being told to emit bare JSON. */
    fencedJson: (json) => '```json\n' + JSON.stringify(json, null, 2) + '\n```',

    /** Obliging preamble before the payload. */
    preamble: (body) => `Sure! Here's the updated state:\n\n${body}`,

    /** Both at once, which is the common case. */
    preambleAndFence: (json) =>
        'Here is the JSON you asked for:\n\n```json\n' + JSON.stringify(json) + '\n```\n\nLet me know if you need changes!',

    /** Hit max_tokens mid-structure. */
    truncated: (json) => JSON.stringify(json).slice(0, 40),

    /** Content-policy refusal in place of output. */
    refusal: () => "I'm sorry, but I can't help with that request.",

    /** Right shape, wrong types — strings where arrays belong. */
    schemaViolation: () => JSON.stringify({ promote: 'nothing to promote', merge: null, drop: 'none' }),

    /** Reasoning model leaks its thinking into content. */
    leakedReasoning: (body) => `<think>The user wants a summary. I should be concise.</think>\n${body}`,

    /** Empty, which a stalled endpoint returns with a 200. */
    empty: () => '',
};

/**
 * @param {object} [options]
 * @param {Array<string|Error|{content: string, reasoning?: string}>} [options.responses]
 *   Queued replies, consumed in order. A string becomes `{ content }`; an Error
 *   is thrown. Exhausting the queue throws, so an unexpected extra call is loud.
 */
export function createRequestService({ responses = [] } = {}) {
    const queue = [...responses];

    return {
        /** Every call, in order — assert on prompt content and token budgets. */
        calls: [],

        async sendRequest(profileId, prompt, maxTokens, custom = {}, overridePayload = {}) {
            this.calls.push({ profileId, prompt, maxTokens, custom, overridePayload });

            if (queue.length === 0) {
                throw new Error(`Unexpected memory-model call #${this.calls.length} (no queued response)`);
            }

            const next = queue.shift();
            if (next instanceof Error) throw next;
            if (typeof next === 'string') return { content: next, reasoning: '' };
            return { reasoning: '', ...next };
        },

        /** Test helper: queue is drained exactly as expected. */
        get pending() {
            return queue.length;
        },
    };
}
