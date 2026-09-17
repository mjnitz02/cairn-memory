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
 * paragraph (docs/decisions.md D-0037). Each takes the summary the model *meant* to
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
 * Realistic replies to the state prompt, which asks for a JSON merge patch
 * (docs/p3-plan.md decision 5, §7). Each takes the patch the model *meant* and the
 * state it was sent. No Cairn state reply has been seen in play yet, so the
 * shapes are the summary catalogue's, carried over to JSON, plus WTrackerLite's
 * habit of regenerating the whole state. Every one has a case in
 * test/state-strategy.test.js (CLAUDE.md §3.12).
 */
export const badStateOutputs = {
    /** A json fence, pretty-printed. */
    fenced: (patch) => '```json\n' + JSON.stringify(patch, null, 2) + '\n```',

    /** Preamble and sign-off around bare JSON. */
    preambleAndSignOff: (patch) =>
        `Here is the patch for the new messages:\n\n${JSON.stringify(patch, null, 2)}\n\nLet me know if anything should change!`,

    /** Reasoning model leaks its thinking into content. */
    leakedReasoning: (patch) => `<think>Wren moved outside. Location and outfit change.</think>\n${JSON.stringify(patch)}`,

    /** The template opened the think block in the prompt, so only its close arrives. */
    orphanThinkClose: (patch) => `Wren moved outside, so the location changes.\n</think>\n\n${JSON.stringify(patch)}`,

    /** Ran out of tokens while still thinking. */
    unterminatedReasoning: () => '<think>Wren moved outside. First I should check whether the weather',

    /** Hit max_tokens partway through the object. ST reports no finish reason (custom-request.js:60). */
    truncated: (patch) => {
        const json = JSON.stringify(patch, null, 2);
        return json.slice(0, Math.floor(json.length * 0.6));
    },

    /** Content-policy refusal in place of output. */
    refusal: () => 'I’m sorry, but I can’t continue with this scene.',

    /** Describes the change in prose instead of writing the patch. */
    prose: () => 'Wren has taken off her coat and moved out to the outer pier of the ferry terminal.',

    /** Ignores "patch" and sends the whole state back, as a regenerating tracker would. */
    fullState: (patch, state) => JSON.stringify(mergePatch(state, patch), null, 2),

    /** Wraps the patch in an array. */
    array: (patch) => JSON.stringify([patch]),

    /** Tracks the time of day anyway, which the schema leaves to the roleplay model. */
    unknownField: (patch) => JSON.stringify({ ...patch, time: 'Late evening' }),

    /** weather broken into parts, not one phrase. */
    wrongType: (patch) => JSON.stringify({ ...patch, weather: { condition: 'Rain', temperature: 'Cold' } }),

    /** Writes a paragraph where a phrase goes. */
    overlong: (patch) => JSON.stringify({
        ...patch,
        location: 'The outer pier of the ferry terminal, past the ticket office and the shuttered café, where the boards are slick with rain and the harbour lights are just coming on',
    }),

    /** A crowd arrives: four newcomers join two present characters, one past the cap. */
    sixCharacters: (patch) => JSON.stringify({
        ...patch,
        characters: {
            ...patch.characters,
            Bram: { outfit: 'Harbour uniform' },
            Cora: { hair: 'Short and grey' },
            Dell: {},
            Ines: { outfit: 'Rain cape' },
        },
    }),

    /** A mood beside the meant change: the kind of field upstream WTracker tracked and the schema leaves out. */
    unknownSubKey: (patch) => JSON.stringify({
        ...patch,
        characters: { ...patch.characters, Wren: { ...patch.characters?.Wren, mood: 'calmer' } },
    }),

    /** Title-cased keys, as a model mirroring the `Location:` labels would write them. */
    capitalisedKeys: (patch) => JSON.stringify(capitalise(patch)),

    /** Nothing changed. */
    noChange: () => '{}',

    /** A character leaves and a field stops applying, beside the meant change. */
    nullRemovals: (patch) => JSON.stringify({
        ...patch,
        weather: null,
        characters: { ...patch.characters, Aster: null },
    }),

    /** Empty, which a stalled endpoint returns with a 200. */
    empty: () => '',
};

/** RFC 7386 §2's MergePatch, as written there: what a model sending the full state meant. */
function mergePatch(target, patch) {
    if (typeof patch !== 'object' || patch === null || Array.isArray(patch)) return patch;
    const result = typeof target === 'object' && target !== null && !Array.isArray(target) ? { ...target } : {};
    for (const [name, value] of Object.entries(patch)) {
        if (value === null) delete result[name];
        else result[name] = mergePatch(result[name], value);
    }
    return result;
}

/** Title-case the schema's keys, leaving character names and values alone. */
function capitalise(patch) {
    const title = (key) => key[0].toUpperCase() + key.slice(1);
    return Object.fromEntries(Object.entries(patch).map(([key, value]) => [
        title(key),
        key === 'characters'
            ? Object.fromEntries(Object.entries(value).map(([name, fields]) => [
                name,
                Object.fromEntries(Object.entries(fields).map(([field, text]) => [title(field), text])),
            ]))
            : value,
    ]));
}

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
