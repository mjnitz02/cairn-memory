/**
 * The index strategy: what a batch of summaries is asked for, and how the reply is
 * read (docs/decisions.md D-0070).
 *
 * The same interface boundary as `perMessage`, `stateRecord` and `canonPromote`
 * (DESIGN.md §11): the prompt and the parser live here, and the queue, the transport
 * and the store never see either.
 *
 * **Batched, because that is the half that already worked.** In the qvink era, passing
 * 10–15 summaries with a little overlap and asking about them by index identified the
 * critical points reliably; it was the compression half that never did (D-0064). This
 * prompt keeps the batching and asks only for extraction.
 *
 * **It extracts and it does not judge.** Whether a record matters is decided later,
 * over the whole index, at a lag — because only judgment needs context, so only
 * judgment pays for it (D-0072). An extract prompt that decided what was worth
 * recording would throw away the raw material the later pass needs, and no amount of
 * downstream context recovers it.
 *
 * Editable in the settings since D-0085, like the summary prompt; an edit without
 * `{{summaries}}` falls back to this one. The caps it states are the soft ones
 * (util/clip.js), so an edit that changes them only changes what the model aims at.
 * Follows DESIGN.md §12 — an `IMPORTANT:` line, concrete examples, a tiebreaker at the end.
 *
 * Pure: no ST, no network. ST's macro expansion comes in as `expand`.
 */
import { firstJson, looksLikeRefusal, stripThinking, unfence } from './model-reply.js';
import {
    KINDS, KIND_MEANINGS, MAX_LINE_CHARS, MAX_SLOT_CHARS, MAX_WHO, MAX_WHO_CHARS, normaliseRecord,
} from './index-record.js';
import { hashString } from '../util/hash.js';
import { renderTemplate, resolvePrompt } from '../util/template.js';

/**
 * The most summaries one batch may carry. D-0064's 10–15, at the top of that range:
 * the overlap and the batch size themselves belong to the caller, which knows how many
 * summaries are waiting and where the last batch ended.
 */
export const MAX_BATCH = 15;

/**
 * Room for a reasoning model's thinking plus fifteen records. Larger than the other
 * three strategies because the reply scales with the batch: fifteen records at their
 * caps is ~2,700 tokens of JSON before any thinking, `background` and `line` included
 * (docs/decisions.md D-0076).
 */
export const INDEX_MAX_TOKENS = 6144;

const KIND_LINES = KINDS.map((kind) => `- ${kind} — ${KIND_MEANINGS[kind]}.`).join('\n');

export const INDEX_PROMPT = `You are indexing a roleplay's scene summaries. Each summary gets one record, so that later a single pass over the whole index can pick out the few summaries that carry the story's spine. Below are the summaries, numbered. Reply with one record for every number.

IMPORTANT: Fill the slots from what the summary says, and do not judge whether the summary matters. The ranking happens later, over the whole story at once. A record that reads as trivial is still a record, and a summary you skip is a summary that can never be picked.

kind is exactly one of:
${KIND_LINES}

The slots:
- who — the people the summary is about, at most ${MAX_WHO} names, each at most ${MAX_WHO_CHARS} characters. Names, never pronouns. An empty list is right when the summary is about a place or an event rather than a person.
- what — what happened, one clause of at most ${MAX_SLOT_CHARS} characters. Names rather than pronouns, so the clause stands alone.
- changed — what is lastingly different now, in at most ${MAX_SLOT_CHARS} characters. Empty for most summaries: fill it only when something is still true long after this scene ends.
- because — what brought it about, in at most ${MAX_SLOT_CHARS} characters. Empty unless the summary says. This is the slot that keeps a fact from reading as trivia once the scene around it is gone.
- background — something the summary mentions as *already* true before this scene: where someone is from, what was promised years ago, who owns what, how long ago something happened. At most ${MAX_SLOT_CHARS} characters, and empty unless the summary actually says it. Most summaries have none.

And one thing that is not a slot:
- line — the whole summary in one sentence of at most ${MAX_LINE_CHARS} characters, past tense, names rather than pronouns. It stands in for the summary itself once the scene is far behind, so write a sentence of story that reads on its own, not a list of the slots.

Example.
Summaries:
1. Wren asked Aster whether she had known her brother, who drowned in the spring flood. Aster went quiet and admitted she had crewed the winter run with him the year before. Wren was not sure whether to believe her.
2. Aster led Wren along the sea wall to the ferry terminal, where the board over the ticket window read DELAYED in chalk. They sat in a waiting room that smelled of wet wool and diesel while the fog came in off the water.
3. Aster promised to get Wren across the water before the feast day, whatever the harbourmaster decided about the ferry, and showed her a small green boat tied below the stones.
Reply: {"records":[{"n":1,"kind":"major","who":["Wren","Aster"],"what":"Aster admitted she had crewed the winter run with Wren's drowned brother","changed":"Aster knew Wren's brother","because":"Wren asked her outright","background":"Wren's brother drowned in the spring flood","line":"Aster admitted she had crewed the winter run with Wren's brother, who drowned in the spring flood, and Wren was unsure whether to believe her."},{"n":2,"kind":"description","who":["Aster","Wren"],"what":"Aster and Wren waited in the ferry terminal","changed":"","because":"the last crossing was posted delayed","background":"","line":"Aster and Wren waited out the fog in the ferry terminal with the crossing posted delayed."},{"n":3,"kind":"major","who":["Aster","Wren"],"what":"Aster promised to get Wren across the water before the feast day","changed":"Wren has a crossing promised, by boat if not by ferry","because":"the ferry was delayed and the harbourmaster had not decided","background":"","line":"Aster promised to get Wren across before the feast day and showed her a small green boat tied below the sea wall."}]}

Record 1 gets a changed and record 2 does not: that Aster knew him is still true once the conversation ends, while a delayed board and a smell of diesel belong to the evening they happened in. Record 1 gets a background because the drowning happened long before this scene; records 2 and 3 have none, which is the usual case. Neither record says anything about how Wren felt, or whether she was right to doubt.

Where you cannot tell, make the smaller claim: {{smaller}}. A thin record is useful and a guessed one is not.

Summaries:
{{summaries}}

Reply with JSON of the form {"records":[{"n":1,"kind":"…","who":["…"],"what":"…","changed":"…","because":"…","background":"…","line":"…"}]}, one record per number and nothing else.`;

/** The template to send for an `indexPrompt` setting (`resolvePrompt`). */
export function resolveIndexPrompt(setting) {
    return resolvePrompt(setting, INDEX_PROMPT, ['summaries']);
}

/** The tiebreaker, spelled out from the ranking so it cannot drift from `KINDS`. */
const SMALLER_CLAIM = `${KINDS[KINDS.length - 1]} over ${KINDS[1]}, and an empty changed over a guessed one`;

export const indexBatch = {
    id: 'index-batch-v1',

    /**
     * @param {object} request
     * @param {Array<string|{text: string}>} request.summaries The summaries to index,
     *        oldest first, 1 to MAX_BATCH. Numbered from 1 in the prompt; mapping those
     *        positions back to chat indexes is the caller's, since only it knows the
     *        batch's overlap with the last one.
     * @param {string} [request.template] The `indexPrompt` setting, raw.
     * @param {(text: string) => string} [request.expand] ST's `substituteParams`
     *        (public/scripts/st-context.js:163), applied to the template only.
     * @returns {{messages: Array<{role: string, content: string}>, maxTokens: number,
     *            prompt: string, count: number, fallback: boolean}}
     *          `prompt` is stored as `index.prompt`.
     */
    build({ summaries, template, expand }) {
        if (!Array.isArray(summaries) || summaries.length < 1) {
            throw new RangeError('An index pass reads at least one summary');
        }
        if (summaries.length > MAX_BATCH) {
            throw new RangeError(`An index pass reads at most ${MAX_BATCH} summaries`);
        }

        const resolved = resolveIndexPrompt(template);
        const content = renderTemplate(resolved.template, {
            smaller: SMALLER_CLAIM,
            summaries: summaries.map((scene, i) => `${i + 1}. ${textOf(scene)}`).join('\n'),
        }, { expand });

        return {
            messages: [{ role: 'user', content }],
            maxTokens: INDEX_MAX_TOKENS,
            prompt: hashString(resolved.template),
            count: summaries.length,
            fallback: resolved.fallback,
        };
    },

    parse: parseIndexReply,
};

/**
 * Find the records in a reply, or reject it. Every drop is counted, so the caller can
 * report the applied change rather than the model's claim (CLAUDE.md §4.18).
 *
 * **A reply with no records is a rejection here, unlike the canon pass.** An empty
 * `promote` is a real answer to "what here is permanent"; there is no real answer to
 * "describe each of these fifteen summaries" that describes none of them. The caller
 * decides whether a partial batch is enough to write — the parser only says what came
 * back and how much of it was usable.
 *
 * @param {string} content
 * @param {{count?: number}} [limits] `count` is the batch size `build` was given.
 * @returns {{ok: true, records: Array<{n: number, kind: string, who: string[],
 *            what: string, changed: string, because: string, background: string,
 *            line: string}>,
 *            dropped: Array<{slot: string, reason: string, n?: number}>,
 *            clipped: Array<{slot: string, n: number}>}
 *          | {ok: false, reason: 'empty'|'refusal'|'format'|'truncated'}}
 */
export function parseIndexReply(content, { count = MAX_BATCH } = {}) {
    const thought = stripThinking(content);
    if (thought.truncated) return reject('truncated');
    const text = unfence(thought.text).trim();
    if (!text) return reject('empty');

    const found = firstJson(text);
    if (!found.parsed) {
        if (looksLikeRefusal(text)) return reject('refusal');
        return reject(found.unclosed ? 'truncated' : 'format');
    }
    // A bare array is a model dropping the envelope, which is a shape we can still read.
    const value = Array.isArray(found.value) ? { records: found.value } : found.value;
    if (!isObject(value) || !Array.isArray(value.records)) return reject('format');

    const records = [];
    const dropped = [];
    const clipped = [];
    const seen = new Set();

    for (const entry of value.records) {
        const n = isObject(entry) ? Number(entry.n) : NaN;
        if (!Number.isInteger(n) || n < 1 || n > count) {
            dropped.push({ slot: 'n', reason: Number.isInteger(n) ? 'out-of-batch' : 'no-index' });
            continue;
        }
        // First answer wins. A model that answers twice has changed its mind without
        // saying so, and taking the later one would make the batch order matter.
        if (seen.has(n)) {
            dropped.push({ slot: 'n', reason: 'duplicate-index', n });
            continue;
        }

        const { record, dropped: slots, clipped: cut } = normaliseRecord(entry);
        for (const drop of slots) dropped.push({ ...drop, n });
        for (const slot of cut) clipped.push({ slot, n });
        if (!record) continue;

        seen.add(n);
        records.push({ n, ...record });
    }

    records.sort((a, b) => a.n - b.n);
    return { ok: true, records, dropped, clipped };
}

function textOf(item) {
    return typeof item === 'string' ? item : item?.text ?? '';
}

function reject(reason) {
    return { ok: false, reason };
}

function isObject(value) {
    return typeof value === 'object' && value !== null && !Array.isArray(value);
}
