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
 * Realistic replies to the state prompt, which asks for the whole record back
 * (docs/decisions.md D-0053). Each takes the record the model *meant* to send and
 * the state it was sent. No Cairn state reply has been seen in play yet, so the
 * shapes are the summary catalogue's, carried over to JSON, plus the ways a model
 * asked for a whole record sends less than one. Every one has a case in
 * test/state-strategy.test.js (CLAUDE.md §3.12).
 */
export const badStateOutputs = {
    /** A json fence, pretty-printed. */
    fenced: (record) => '```json\n' + JSON.stringify(record, null, 2) + '\n```',

    /** Preamble and sign-off around bare JSON. */
    preambleAndSignOff: (record) =>
        `Here is the updated record for the new messages:\n\n${JSON.stringify(record, null, 2)}\n\nLet me know if anything should change!`,

    /** Reasoning model leaks its thinking into content. */
    leakedReasoning: (record) => `<think>Wren moved outside. Location and outfit change.</think>\n${JSON.stringify(record)}`,

    /** The template opened the think block in the prompt, so only its close arrives. */
    orphanThinkClose: (record) => `Wren moved outside, so the location changes.\n</think>\n\n${JSON.stringify(record)}`,

    /** Ran out of tokens while still thinking. */
    unterminatedReasoning: () => '<think>Wren moved outside. First I should check whether the weather',

    /** Hit max_tokens partway through the object. ST reports no finish reason (custom-request.js:60). */
    truncated: (record) => {
        const json = JSON.stringify(record, null, 2);
        return json.slice(0, Math.floor(json.length * 0.6));
    },

    /** Content-policy refusal in place of output. */
    refusal: () => 'I’m sorry, but I can’t continue with this scene.',

    /** Describes the change in prose instead of writing the record. */
    prose: () => 'Wren has taken off her coat and moved out to the outer pier of the ferry terminal.',

    /** Falls back into sending a delta: one field, no cast at all. Everything else must stand. */
    sparse: (record) => JSON.stringify({ location: record.location }),

    /** The reported failure: a full cast with hair left out of every character (D-0053). */
    missingFields: (record) => JSON.stringify({
        ...record,
        characters: Object.fromEntries(Object.entries(record.characters)
            .map(([name, fields]) => [name, { outfit: fields.outfit }])),
    }),

    /** Lists one of the two characters present, which is how a character leaves. */
    castDropped: (record) => JSON.stringify({
        ...record,
        characters: Object.fromEntries(Object.entries(record.characters).slice(1)),
    }),

    /** Sends nobody at all, which is a lazy reply rather than an empty room. */
    emptyCast: (record) => JSON.stringify({ ...record, characters: {} }),

    /** Wraps the record in an array. */
    array: (record) => JSON.stringify([record]),

    /** Tracks the time of day anyway, which the schema leaves to the roleplay model. */
    unknownField: (record) => JSON.stringify({ ...record, time: 'Late evening' }),

    /** weather broken into parts, not one phrase. */
    wrongType: (record) => JSON.stringify({ ...record, weather: { condition: 'Rain', temperature: 'Cold' } }),

    /** Writes a paragraph where a phrase goes. */
    overlong: (record) => JSON.stringify({
        ...record,
        location: 'The outer pier of the ferry terminal, past the ticket office and the shuttered café, where the boards are slick with rain and the harbour lights are just coming on',
    }),

    /** A crowd arrives: four newcomers join two present characters, one past the cap. */
    sixCharacters: (record) => JSON.stringify({
        ...record,
        characters: {
            ...record.characters,
            Bram: { outfit: 'Harbour uniform' },
            Cora: { hair: 'Short and grey' },
            Dell: {},
            Ines: { outfit: 'Rain cape' },
        },
    }),

    /** A mood beside the meant change: the kind of field upstream WTracker tracked and the schema leaves out. */
    unknownSubKey: (record) => JSON.stringify({
        ...record,
        characters: { ...record.characters, Wren: { ...record.characters?.Wren, mood: 'calmer' } },
    }),

    /** Title-cased keys, as a model mirroring the `Location:` labels would write them. */
    capitalisedKeys: (record) => JSON.stringify(capitalise(record)),

    /** Nothing changed. */
    noChange: () => '{}',

    /** Still writing nulls, as the merge-patch prompt asked for: a field ended, a character gone. */
    nullRemovals: (record) => JSON.stringify({
        ...record,
        weather: null,
        characters: { ...record.characters, Aster: null },
    }),

    /** Empty, which a stalled endpoint returns with a 200. */
    empty: () => '',
};

/**
 * Realistic replies to the canon prompt, which asks for `{"canon":[{fact, entities, from}]}`
 * — a forced-budget pick over the whole index (docs/decisions.md D-0071). Each takes the
 * facts the model *meant* to send. No Cairn pick has been seen in play yet, so the shapes
 * are the catalogues above carried over, plus the ways a forced budget goes wrong: a model
 * that fills every slot whether or not it has the facts, one that cites nothing, and one
 * that cites a row that was never in the index. Every one has a case in
 * test/canon-strategy.test.js (CLAUDE.md §3.12).
 */
export const badCanonOutputs = {
    /** A json fence, pretty-printed. */
    fenced: (canon) => '```json\n' + JSON.stringify({ canon }, null, 2) + '\n```',

    /** Preamble and sign-off around bare JSON. */
    preambleAndSignOff: (canon) =>
        `Reading the index end to end, these are the rows the story cannot be told without:\n\n${JSON.stringify({ canon })}\n\nLet me know if you'd like a tighter set.`,

    /** Reasoning model leaks its thinking into content. */
    leakedReasoning: (canon) =>
        `<think>Row 1 is background but it is the whole premise. Row 3 is a wait.</think>\n${JSON.stringify({ canon })}`,

    /** The template opened the think block in the prompt, so only its close arrives. */
    orphanThinkClose: (canon) =>
        `Rows 1, 2 and 4 carry the spine; the rest is weather.\n</think>\n\n${JSON.stringify({ canon })}`,

    /** Ran out of tokens while still thinking. */
    unterminatedReasoning: () => '<think>Twelve candidate rows for ten slots. The origin has to go in, but',

    /** Hit max_tokens mid-array. ST reports no finish reason (custom-request.js:60). */
    truncated: (canon) => {
        const json = JSON.stringify({ canon }, null, 2);
        return json.slice(0, Math.floor(json.length * 0.6));
    },

    /** Content-policy refusal in place of output. */
    refusal: () => 'I’m sorry, but I can’t extract facts from this content.',

    /** Lists the facts in prose instead of writing the object. */
    prose: () => 'The rows that matter are 1, 2 and 4: the drowning, the winter run, and the crossing.',

    /** Answers the question it was not asked: nothing here is permanent. */
    nullCanon: () => '{"canon": null}',

    /** Picks nothing out of an index that plainly holds something. */
    emptyPick: () => '{"canon": []}',

    /** A bare array, the wrapper forgotten — a shape we can still read. */
    bareArray: (canon) => JSON.stringify(canon),

    /** Uses `text` where the prompt said `fact`. */
    wrongKey: (canon) => JSON.stringify({ canon: canon.map(({ fact, from }) => ({ text: fact, entities: [], from })) }),

    /** Facts as plain strings, the object dropped. */
    plainStrings: (canon) => JSON.stringify({ canon: canon.map(({ fact }) => fact) }),

    /** Writes a paragraph where one sentence goes. */
    overlong: (canon) => JSON.stringify({
        canon: [{
            fact: 'Wren\'s brother drowned in the spring flood the year before the story begins, during the crossing he had made every winter since he was a boy, and the harbour has not run a winter ferry since, which is the reason the board still reads DELAYED whenever the fog comes in off the water.',
            entities: ['Wren'],
            from: [1],
        }, ...canon.slice(1)],
    }),

    /** Tags the whole cast and then some: six entities, two past the cap. */
    manyEntities: (canon) => JSON.stringify({
        canon: [{ ...canon[0], entities: ['Wren', 'Aster', 'the flood', 'the harbour', 'the ferry', 'the feast day'] }],
    }),

    /** An entity written as a sentence rather than a name. */
    entitySentence: (canon) => JSON.stringify({
        canon: [{ ...canon[0], entities: ['Wren\'s brother, who drowned in the spring flood last year'] }],
    }),

    /** Fills every slot it is given and then some: twelve facts for ten. */
    overSlots: () => JSON.stringify({
        canon: Array.from({ length: 12 }, (_, i) => ({ fact: `Durable fact number ${i + 1}.`, entities: [], from: [i + 1] })),
    }),

    /** Answers with a spine and no citations at all — the shape that cannot be re-derived. */
    uncited: (canon) => JSON.stringify({ canon: canon.map(({ fact, entities }) => ({ fact, entities })) }),

    /** Cites a row that was never in the index, and one that is not a number. */
    badRows: (canon) => JSON.stringify({
        canon: [{ ...canon[0], from: [999] }, { ...canon[1], from: ['the first one', 2] }],
    }),

    /** Chains half the story into one fact, citing five rows for it. */
    manyRows: (canon) => JSON.stringify({ canon: [{ ...canon[0], from: [1, 2, 3, 4, 5] }] }),

    /** Picks the mood the prompt told it to leave, beside a real fact. */
    mood: (canon) => JSON.stringify({
        canon: [canon[0], { fact: 'Aster was shaken by the question.', entities: ['Aster'], from: [2] }],
    }),

    /** Empty, which a stalled endpoint returns with a 200. */
    empty: () => '',
};

/**
 * Realistic replies to the index prompt, which asks for `{"records":[{n, kind, who, what,
 * changed, because}]}`, one record per numbered summary (docs/decisions.md D-0070). Each
 * takes the records the model *meant* to send. No Cairn index reply has been seen in play
 * yet, so the shapes are the three catalogues above carried over, plus the ways a model
 * asked for one record per number sends a different number of them. Every one has a case
 * in test/index-strategy.test.js (CLAUDE.md §3.12).
 */
export const badIndexOutputs = {
    /** A json fence, pretty-printed. */
    fenced: (records) => '```json\n' + JSON.stringify({ records }, null, 2) + '\n```',

    /** Preamble and sign-off around bare JSON. */
    preambleAndSignOff: (records) =>
        `Here are the records for all ${records.length} summaries:\n\n${JSON.stringify({ records })}\n\nLet me know if you'd like the kinds adjusted.`,

    /** Reasoning model leaks its thinking into content. */
    leakedReasoning: (records) =>
        `<think>The first one is a promise, so major. The second is just the terminal.</think>\n${JSON.stringify({ records })}`,

    /** The template opened the think block in the prompt, so only its close arrives. */
    orphanThinkClose: (records) =>
        `Summary 2 is scene-setting, so description rather than filler.\n</think>\n\n${JSON.stringify({ records })}`,

    /** Ran out of tokens while still thinking. */
    unterminatedReasoning: () => '<think>Fifteen summaries. The first is a departure, so cast, but the second',

    /** Hit max_tokens mid-array, which is the likeliest failure on a full batch. */
    truncated: (records) => {
        const json = JSON.stringify({ records }, null, 2);
        return json.slice(0, Math.floor(json.length * 0.6));
    },

    /** Content-policy refusal in place of output. */
    refusal: () => 'I’m sorry, but I can’t index this content.',

    /** Describes the summaries in prose instead of writing the records. */
    prose: () => 'The first summary is the important one: Aster admits she knew the brother. The others are scene-setting.',

    /** A bare array, the wrapper forgotten. */
    bareArray: (records) => JSON.stringify(records),

    /** The wrapper under a different name. */
    wrongWrapper: (records) => JSON.stringify({ index: records }),

    /** Says "nothing to index" the way the canon pass says "nothing to promote". */
    nullRecords: () => '{"records": null}',

    /** Answers about the first summary twice, differently, and never about the second. */
    duplicateIndex: (records) => JSON.stringify({
        records: [records[0], { ...records[1], n: records[0].n }],
    }),

    /** Numbers past the batch it was given, having counted the example's summaries too. */
    outOfBatch: (records) => JSON.stringify({
        records: records.map((record, i) => ({ ...record, n: records.length + i + 1 })),
    }),

    /** Records in a different order than they were asked about. */
    shuffled: (records) => JSON.stringify({ records: [...records].reverse() }),

    /** Drops `n` entirely and relies on the array's order. */
    noIndex: (records) => JSON.stringify({ records: records.map(({ n: _n, ...rest }) => rest) }),

    /** Answers about fewer summaries than it was given, the rest silently skipped. */
    short: (records) => JSON.stringify({ records: records.slice(0, 1) }),

    /** A kind of its own invention, beside the four it was given. */
    unknownKind: (records) => JSON.stringify({
        records: [{ ...records[0], kind: 'dialogue' }, ...records.slice(1)],
    }),

    /** The kind shouted, which is the same kind with different bytes. */
    shoutedKind: (records) => JSON.stringify({
        records: records.map((record) => ({ ...record, kind: record.kind.toUpperCase() })),
    }),

    /** Writes `null` into the slots it had nothing for, rather than leaving them empty. */
    nullSlots: (records) => JSON.stringify({
        records: records.map((record) => ({ ...record, changed: null, because: null })),
    }),

    /** Leaves the empty slots out altogether, which is the same statement. */
    missingSlots: (records) => JSON.stringify({
        records: records.map(({ changed: _c, because: _b, ...rest }) => rest),
    }),

    /** Writes the summary back into `what` instead of a clause. */
    overlong: (records) => JSON.stringify({
        records: [{
            ...records[0],
            what: 'Aster went quiet for a while and then admitted that she had known Wren\'s brother, that he had crewed the winter run with her the year before the flood took him, and that he had been better at it than she ever was.',
        }, ...records.slice(1)],
    }),

    /** Tags every name in the summary, two past the cap. */
    manyNames: (records) => JSON.stringify({
        records: [{ ...records[0], who: ['Wren', 'Aster', 'the harbourmaster', 'Wren\'s brother', 'the ferry', 'the feast day'] }],
    }),

    /** `who` as a comma-separated string rather than a list. */
    whoAsString: (records) => JSON.stringify({
        records: [{ ...records[0], who: records[0].who.join(', ') }],
    }),

    /** Judges the summaries despite being told not to, and drops the ones it dismissed. */
    judged: (records) => JSON.stringify({
        records: records.filter((record) => record.kind === 'major' || record.kind === 'cast'),
    }),

    /** Puts the mood in `changed`, which is the field D-0043 keeps out of the memory. */
    mood: (records) => JSON.stringify({
        records: [{ ...records[0], changed: 'Wren is no longer sure she can trust Aster' }, ...records.slice(1)],
    }),

    /** Empty, which a stalled endpoint returns with a 200. */
    empty: () => '',
};

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
