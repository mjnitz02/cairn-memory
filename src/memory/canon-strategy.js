/**
 * The canon strategy: the forced-budget pick over the index, and how its reply is read
 * (docs/decisions.md D-0071, D-0070).
 *
 * The same interface boundary as `perMessage`, `stateRecord` and `indexBatch`
 * (DESIGN.md §11): the prompt and the parser live here, and the queue, the transport
 * and the store never see either.
 *
 * **It reads the index, not the summaries.** P4 asked an open-ended question — "what
 * became permanently true" — over the handful of summaries an eviction was about to
 * drop, which is a local window ranking global importance and cannot work (D-0062).
 * This reads one record per summary for the *whole* chat, ~40 tokens each, so the pass
 * sees the story end to end at a fifth of the tokens with its structure made explicit.
 *
 * **The budget is forced and the question is comparative.** "Fill exactly N slots" is
 * calibration by construction; an absolute question ("is this permanent?") makes a small
 * model say yes to everything, which is what produced P4's bubbly-adventure canon
 * (D-0064). Fewer slots than asked is still an answer — a short story has a short spine
 * — and the shortfall is counted rather than retried.
 *
 * **Every fact cites its rows.** That is what lets canon be re-derived and corrected
 * rather than remembered (memory/canon.js): the citation is how a fact dies when the
 * record it rests on does. It is also cheap grounding — a model that must name the row
 * invents less than one that need not.
 *
 * Editable in the settings since D-0085; an edit without `{{index}}` falls back to this
 * one. Follows DESIGN.md §12 — an `IMPORTANT:` line, concrete include and exclude
 * examples, a tiebreaker at the end.
 *
 * Pure: no ST, no network. ST's macro expansion comes in as `expand`.
 */
import { firstJson, looksLikeRefusal, stripThinking, unfence } from './model-reply.js';
import {
    MAX_ENTITIES, MAX_ENTITY_CHARS, MAX_FACT_CHARS, MAX_SLOTS, MAX_SOURCES, MIN_SLOTS,
} from './canon.js';
import { INDEX_HEADER, renderIndex } from './index-record.js';
import { clip, hardCap } from '../util/clip.js';
import { hashString } from '../util/hash.js';
import { renderTemplate, resolvePrompt } from '../util/template.js';

/**
 * Room for a reasoning model's thinking over a long index before a short list. The
 * reply is at most sixteen one-sentence facts; the thinking is the part that needs
 * the room, because this is the one pass that reasons over the whole story.
 */
export const CANON_MAX_TOKENS = 4096;

/** Where a fact is cut rather than kept; the prompt states `MAX_FACT_CHARS` (D-0085). */
export const HARD_FACT_CHARS = hardCap(MAX_FACT_CHARS);

export const CANON_PROMPT = `You are choosing the permanent spine of a long roleplay. Below is an index of the whole story so far: one numbered row per scene, in order, with the columns \`${INDEX_HEADER}\`. The storyteller will soon have room for only these few lines and the most recent scenes — everything else is already gone.

IMPORTANT: Choose exactly {{slots}} facts. Not more, and fewer only if the story genuinely holds fewer. This is a choice between rows, not a judgement of each row on its own: a fact earns a slot by being one the rest of the story does not make sense without, not by being true.

What earns a slot:
- Who these people are to each other, and where they came from.
- What was permanently won, lost, destroyed, paid or promised.
- Someone entering the story or leaving it for good.
- The standing conditions the \`background\` column reports: an origin, an old promise, a debt, who owns what.

Leave out:
- Anything a scene record already carries: where the characters are, the weather, who is present, and each character's hair and outfit.
- How anyone felt, and how anyone seemed. Moods pass, and the storyteller decides them.
- What might happen next, what someone intends, or what a scene is building towards.
- A journey, a meal, a purchase or a conversation that nothing later rests on.

**Read every row.** A quiet row can hold the fact the whole story turns on — a purchase is small until it turns out to be where they settled, and a confession can be the only place an old promise is written down — while a loud row can be a battle nothing later refers to. Read \`changed\`, \`because\` and \`background\` as closely as \`what\`.

**Chain the causes.** A fact stripped of why it happened reads as trivia once the scene around it is gone, and a row's \`because\` is there to be used. Prefer "he destroyed the army to buy her freedom" over "he destroyed an army".

Example, over a five-row index and three slots.
1 | Wren, Aster | Wren asked Aster about the ferry timetable | | | Wren's brother drowned in the spring flood
2 | Aster | Aster admitted she crewed the winter run with Wren's brother | Aster knew Wren's brother | Wren asked her outright |
3 | Aster, Wren | Aster and Wren waited out the fog in the ferry terminal | | the crossing was posted delayed |
4 | Aster | Aster rowed Wren across the water before the feast day | Wren is across the water | the ferry never sailed | Aster promised her a crossing
5 | Wren | Wren walked up from the harbour into the town | | |
Reply: {"canon":[{"fact":"Wren's brother drowned in the spring flood.","entities":["Wren"],"from":[1]},{"fact":"Aster crewed the winter run with Wren's brother the year before he drowned.","entities":["Aster","Wren"],"from":[2]},{"fact":"Aster rowed Wren across the water before the feast day, as she had promised, because the ferry never sailed.","entities":["Aster","Wren"],"from":[4]}]}

Row 1 is a question about a timetable and is still picked, because its \`background\` carries the death the rest of the story rests on. Rows 3 and 5 are a wait and a walk: nothing later needs them. Nothing says Aster seemed shaken or that Wren doubted her — those are feelings, and they passed with the scene.

Rules:
- Exactly {{slots}} facts, ordered oldest first as the rows are.
- One plain sentence a fact, at most ${MAX_FACT_CHARS} characters. A much longer one is cut short.
- Write each fact so it stands alone, with names rather than pronouns.
- from lists the row numbers the fact comes from: at least one, at most ${MAX_SOURCES}.
- entities names who or what the fact is about: at most ${MAX_ENTITIES}, each at most ${MAX_ENTITY_CHARS} characters.

Where two rows say the same thing, pick the one that says it most completely and cite both. Where you cannot tell whether a fact matters, prefer the one a reader would have to be told to follow the rest of the story.

The index:
{{index}}

Reply with JSON of the form {"canon":[{"fact":"…","entities":["…"],"from":[1]}]}, and nothing else.`;

/** The template to send for a `canonPrompt` setting (`resolvePrompt`). */
export function resolveCanonPrompt(setting) {
    return resolvePrompt(setting, CANON_PROMPT, ['index']);
}

export const canonPick = {
    id: 'canon-pick-v2',

    /**
     * @param {object} request
     * @param {Array<object>} request.records Every valid index record in the chat,
     *        oldest first. Numbered from 1 in the prompt; mapping those positions back
     *        to chat indexes is the caller's, as it is for a batch (index-strategy.js).
     * @param {number} request.slots How many facts to ask for, MIN_SLOTS to MAX_SLOTS.
     * @param {string} [request.template] The `canonPrompt` setting, raw.
     * @param {(text: string) => string} [request.expand] ST's `substituteParams`
     *        (public/scripts/st-context.js:163), applied to the template only.
     * @returns {{messages: Array<{role: string, content: string}>, maxTokens: number,
     *            prompt: string, slots: number, records: number, fallback: boolean}}
     *          `prompt` is stored as `canon.prompt`.
     */
    build({ records, slots, template, expand }) {
        if (!Array.isArray(records) || records.length < 1) {
            throw new RangeError('A canon pick reads at least one index record');
        }
        if (!Number.isInteger(slots) || slots < MIN_SLOTS || slots > MAX_SLOTS) {
            throw new RangeError(`A canon pick fills ${MIN_SLOTS} to ${MAX_SLOTS} slots`);
        }

        const resolved = resolveCanonPrompt(template);
        const content = renderTemplate(resolved.template, {
            slots: String(slots),
            index: renderIndex(records),
        }, { expand });

        return {
            messages: [{ role: 'user', content }],
            maxTokens: CANON_MAX_TOKENS,
            prompt: hashString(resolved.template),
            slots,
            records: records.length,
            fallback: resolved.fallback,
        };
    },

    parse: parseCanonReply,
};

/**
 * Find the picked facts in a reply, or reject it. Caps are enforced here, not in the
 * store: a fact past its hard cap is cut and marked `clipped` (D-0085), and every drop is
 * counted, so what the panel reports is the applied change (CLAUDE.md §4.18).
 *
 * **An empty pick is a rejection, unlike P4's promotion pass.** `{"promote": null}` was
 * a real answer to "is anything here permanent"; there is no real answer to "choose the
 * ten rows this story cannot be told without" that chooses none, when there are rows to
 * choose from. A *short* pick is different and is accepted: the shortfall is reported,
 * and whether a five-line spine is right for a five-scene story is not the parser's call.
 *
 * `from` is read as written — row numbers in the rendered index. Mapping them back to
 * chat indexes is the caller's, because only it knows which records it sent.
 *
 * @param {string} content
 * @param {{slots?: number, records?: number}} [limits] What `build` was given.
 * @returns {{ok: true, picked: Array<{text: string, entities: string[], from: number[],
 *            clipped?: true}>,
 *            dropped: Array<{reason: string}>, short: number}
 *          | {ok: false, reason: 'empty'|'refusal'|'format'|'truncated'|'no-facts'}}
 */
export function parseCanonReply(content, { slots = MAX_SLOTS, records = Infinity } = {}) {
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
    const value = Array.isArray(found.value) ? { canon: found.value } : found.value;
    if (!isObject(value) || !Array.isArray(value.canon)) return reject('format');

    const allowed = Math.max(0, Math.min(slots, MAX_SLOTS));
    const picked = [];
    const dropped = [];

    for (const entry of value.canon) {
        if (picked.length >= allowed) {
            dropped.push({ reason: 'over-slots' });
            continue;
        }
        const fact = readFact(entry, dropped, records);
        if (fact) picked.push(fact);
    }

    if (!picked.length) return reject('no-facts');
    return { ok: true, picked, dropped, short: Math.max(0, allowed - picked.length) };
}

/** One entry of `canon`, or null with the reason recorded. */
function readFact(entry, dropped, records) {
    if (!isObject(entry)) return drop(dropped, 'not-a-fact');
    const raw = typeof entry.fact === 'string' ? entry.fact.trim() : '';
    if (!raw) return drop(dropped, 'no-text');
    const { text, clipped } = clip(raw, HARD_FACT_CHARS);

    const from = [];
    for (const row of Array.isArray(entry.from) ? entry.from : []) {
        const n = Number(row);
        if (!Number.isInteger(n) || n < 1 || n > records) dropped.push({ reason: 'bad-row' });
        else if (from.length >= MAX_SOURCES) dropped.push({ reason: 'too-many-rows' });
        else if (!from.includes(n)) from.push(n);
    }
    // A fact with no readable citation cannot be re-derived or invalidated, which is the
    // property the pick exists to have (memory/canon.js). Keeping it would put a
    // permanent fact back in the store, which is what D-0071 undid.
    if (!from.length) return drop(dropped, 'no-source');

    const entities = [];
    for (const entity of Array.isArray(entry.entities) ? entry.entities : []) {
        if (typeof entity !== 'string' || entity.trim() === '') {
            dropped.push({ reason: 'bad-entity' });
        } else if (entity.trim().length > MAX_ENTITY_CHARS) {
            dropped.push({ reason: 'entity-too-long' });
        } else if (entities.length >= MAX_ENTITIES) {
            dropped.push({ reason: 'too-many-entities' });
        } else {
            entities.push(entity.trim());
        }
    }

    // Marked only when cut, so an ordinary fact keeps exactly the shape the store writes.
    return clipped ? { text, entities, from, clipped } : { text, entities, from };
}

function drop(dropped, reason) {
    dropped.push({ reason });
    return null;
}

function reject(reason) {
    return { ok: false, reason };
}

function isObject(value) {
    return typeof value === 'object' && value !== null && !Array.isArray(value);
}
