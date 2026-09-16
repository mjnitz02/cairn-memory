/**
 * Memory-model mock.
 *
 * Mirrors ConnectionManagerRequestService (public/scripts/extensions/shared.js:392)
 * and its non-streaming return shape, ExtractedData `{ content, reasoning }`
 * (public/scripts/custom-request.js:60).
 *
 * Cairn's memory calls run on a strong cloud model (DESIGN.md §12), and even
 * those misbehave, so the catalogue below is not a courtesy — these are the outputs we actually get, and
 * every parser is tested against them (CLAUDE.md §3.12).
 */

/**
 * Realistic malformed replies to the summary prompt, which asks for one plain
 * paragraph (docs/p2-plan.md §4). Each takes the summary the model *meant* to
 * give. Named so a failing test says what shape broke, and every one of them has
 * a case in test/scene-strategy.test.js (CLAUDE.md §3.12).
 */
export const badOutputs = {
    /** Fenced despite being plain prose. */
    fenced: (summary) => '```\n' + summary + '\n```',

    /** Obliging preamble before the summary. */
    preamble: (summary) => `Sure! Here's a summary of the message:\n\n${summary}`,

    /** Preamble, fence and sign-off at once, which is the common case. */
    preambleAndFence: (summary) =>
        `Here is the summary you asked for:\n\n\`\`\`text\n${summary}\n\`\`\`\n\nLet me know if you need changes!`,

    /** A sign-off after the summary, no fence. */
    signOff: (summary) => `${summary}\n\nI hope this helps! Let me know if you'd like it shorter.`,

    /** Echoes the `Summary: ` prefill qvink sent, which Cairn does not send. */
    labelled: (summary) => `**Summary:** ${summary}`,

    /** Hit max_tokens mid-sentence. ST reports no finish reason (custom-request.js:60). */
    truncated: (summary) => summary.slice(0, Math.floor(summary.length * 0.6)).replace(/[\s.!?"'”’)\]]+$/, ''),

    /** Content-policy refusal in place of output. */
    refusal: () => "I'm sorry, but I can't help with that request.",

    /** Ignores "a single paragraph" and answers as a list. */
    bulleted: (summary) => summary.split(/(?<=\.) /).map((sentence) => `- ${sentence}`).join('\n'),

    /** Splits one paragraph into two. */
    paragraphs: (summary) => summary.replace(/(?<=\.) /, '\n\n'),

    /** The wrong format entirely: JSON, as if a structured prompt had been sent. */
    json: (summary) => JSON.stringify({ summary }),

    /** Far longer than a 2-3 sentence paragraph. */
    overlong: (summary) => Array(8).fill(summary).join(' '),

    /** Reasoning model leaks its thinking into content. */
    leakedReasoning: (summary) => `<think>The user wants a summary. I should be concise.</think>\n${summary}`,

    /** The template opened the think block in the prompt, so only its close arrives. */
    orphanThinkClose: (summary) => `The user wants a summary. Names, not pronouns.\n</think>\n\n${summary}`,

    /** Ran out of tokens while still thinking. */
    unterminatedReasoning: () => '<think>The user wants a summary. First I should work out who',

    /** Empty, which a stalled endpoint returns with a 200. */
    empty: () => '',
};

/**
 * A reply the test settles by hand, for anything that happens while a request is
 * still out: a chat change, an edit, a second trigger.
 */
export function deferred() {
    let resolve;
    let reject;
    const promise = new Promise((res, rej) => {
        resolve = res;
        reject = rej;
    });
    return { promise, resolve, reject };
}

/**
 * @param {object} [options]
 * @param {Array<string|Error|Promise|{content: string, reasoning?: string}>} [options.responses]
 *   Queued replies, consumed in order. A string becomes `{ content }`; an Error
 *   is thrown; a Promise (see `deferred`) settles to either. Exhausting the queue
 *   throws, so an unexpected extra call is loud.
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

            try {
                const next = await settle(queue.shift(), custom.signal);
                if (next instanceof Error) throw next;
                if (typeof next === 'string') return { content: next, reasoning: '' };
                return { reasoning: '', ...next };
            } catch (cause) {
                // Everything past profile validation is wrapped (extensions/shared.js:489-490).
                throw new Error('API request failed', { cause });
            }
        },

        /** Test helper: queue is drained exactly as expected. */
        get pending() {
            return queue.length;
        },
    };
}

/** A fetch given an aborted signal rejects with an AbortError, whatever the server does. */
function settle(next, signal) {
    if (!signal) return next;
    const aborted = () => new DOMException('The operation was aborted.', 'AbortError');
    if (signal.aborted) return Promise.reject(aborted());
    return new Promise((resolve, reject) => {
        signal.addEventListener('abort', () => reject(aborted()), { once: true });
        Promise.resolve(next).then(resolve, reject);
    });
}
