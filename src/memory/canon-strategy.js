/**
 * The canon strategy: what a compaction pass asks for, and how its reply is read
 * (docs/p4-plan.md decision 7).
 *
 * The same interface boundary as `perMessage` and `stateRecord` (DESIGN.md §11): the
 * prompt and the parser live here, and the queue, the transport and the store never
 * see either.
 *
 * Built in, not a setting (as the state prompt is, docs/decisions.md D-0044): the caps
 * are the store's, so an edit could only break the parser. It follows DESIGN.md §12 —
 * an `IMPORTANT:` line, concrete include and exclude examples, a tiebreaker at the end.
 *
 * Pure: no ST, no network. ST's macro expansion comes in as `expand`.
 */
import { firstJson, looksLikeRefusal, stripThinking, unfence } from './model-reply.js';
import {
    MAX_ENTITIES, MAX_ENTITY_CHARS, MAX_FACTS_PER_PASS, MAX_FACT_CHARS,
} from './canon.js';
import { hashString } from '../util/hash.js';
import { renderTemplate } from '../util/template.js';

/** As for the other two kinds: room for a reasoning model's thinking before a short list. */
export const CANON_MAX_TOKENS = 2048;

export const CANON_PROMPT = `You pull the permanent facts out of a roleplay's oldest scene summaries, just before those summaries are dropped from the storyteller's memory. Below are the summaries about to be dropped and the facts already kept. Reply with the facts in those summaries that will still be true long after the scene they came from is over.

IMPORTANT: Promote a fact only if it stays true once that scene ends. A death, a birth, a kinship, a promise made, a place or a name learned, something permanently broken, taken, given or destroyed.

Leave out:
- Anything a scene record already carries: where the characters are, the weather, who is present, and each character's hair and outfit.
- How anyone felt. Moods pass, and the storyteller decides them.
- What might happen next, what someone intends, or what a scene seems to be building towards.
- Anything already among the facts kept below, however differently it is worded.

Example.
Summaries: Wren asked Aster whether she had known her brother, who drowned in the spring flood. Aster admitted she had crewed the winter run with him the year before. She promised to get Wren across the water before the feast day, whatever the harbourmaster decided about the ferry. Aster seemed shaken by the question, and Wren was left wondering whether to trust her.
Reply: {"promote":[{"fact":"Wren's brother drowned in the spring flood.","entities":["Wren"]},{"fact":"Aster crewed the winter run with Wren's brother.","entities":["Aster","Wren"]},{"fact":"Aster promised to get Wren across the water before the feast day.","entities":["Aster","Wren"]}]}

Nothing there promotes Aster being shaken or Wren's doubt: those are feelings, and they passed with the scene.

Rules:
- At most {{room}} facts this time. Fewer is right whenever fewer are permanent, and an empty list is a correct answer.
- One plain sentence a fact, at most ${MAX_FACT_CHARS} characters. A longer one is thrown away rather than shortened.
- Write each fact so it stands alone, with names rather than pronouns.
- entities names who or what the fact is about: at most ${MAX_ENTITIES}, each at most ${MAX_ENTITY_CHARS} characters.

Where you cannot tell whether something is permanent, leave it out. A fact promoted here can never be taken back.

{{#if canon}}
Facts already kept:
{{canon}}

{{/if}}
Summaries about to be dropped:
{{summaries}}

Reply with JSON of the form {"promote":[{"fact":"…","entities":["…"]}]}, and nothing else.`;

export const canonPromote = {
    id: 'canon-promote-v1',

    /**
     * @param {object} request
     * @param {Array<string|{text: string}>} request.summaries The summaries the next
     *        rebuild will drop, oldest first.
     * @param {Array<string|{text: string}>} [request.canon] Canon as it stands, oldest first,
     *        so the pass does not repeat itself.
     * @param {number} request.room How many facts there is room for, 1 to MAX_FACTS_PER_PASS.
     * @param {(text: string) => string} [request.expand] ST's `substituteParams`
     *        (public/scripts/st-context.js:163), applied to the template only.
     * @returns {{messages: Array<{role: string, content: string}>, maxTokens: number,
     *            prompt: string, room: number}} `prompt` is stored as `canon.prompt`.
     */
    build({ summaries, canon = [], room, expand }) {
        if (!Array.isArray(summaries) || summaries.length < 1) {
            throw new RangeError('A compaction pass reads at least one summary');
        }
        if (!Array.isArray(canon)) throw new TypeError('A compaction pass takes canon as a list');
        if (!Number.isInteger(room) || room < 1 || room > MAX_FACTS_PER_PASS) {
            throw new RangeError(`A compaction pass promotes 1 to ${MAX_FACTS_PER_PASS} facts`);
        }

        const content = renderTemplate(CANON_PROMPT, {
            room: String(room),
            canon: canon.map((fact) => `- ${textOf(fact)}`).join('\n'),
            summaries: summaries.map((scene) => `- ${textOf(scene)}`).join('\n'),
        }, { expand });

        return {
            messages: [{ role: 'user', content }],
            maxTokens: CANON_MAX_TOKENS,
            prompt: hashString(CANON_PROMPT),
            room,
        };
    },

    parse: parseCanonReply,
};

/**
 * Find the promotions in a reply, or reject it. Caps are enforced here, not in the
 * store: a fact over its cap is dropped rather than cut, as a state value is
 * (docs/decisions.md D-0053), and every drop is counted so what the panel reports is
 * the applied change (CLAUDE.md §4.18).
 *
 * A well-formed reply promoting nothing is a *success* with no facts. That is a real
 * answer — the summaries held nothing permanent — and the pass still records the range
 * it read, so the same question is not asked again every turn.
 *
 * @param {string} content
 * @param {{room?: number}} [limits] `room` is what `build` was given.
 * @returns {{ok: true, promote: Array<{text: string, entities: string[]}>,
 *            dropped: Array<{reason: string}>}
 *          | {ok: false, reason: 'empty'|'refusal'|'format'|'truncated'}}
 */
export function parseCanonReply(content, { room = MAX_FACTS_PER_PASS } = {}) {
    const thought = stripThinking(content);
    if (thought.truncated) return reject('truncated');
    const text = unfence(thought.text).trim();
    if (!text) return reject('empty');

    const found = firstJson(text);
    if (!found.parsed) {
        if (looksLikeRefusal(text)) return reject('refusal');
        return reject(found.unclosed ? 'truncated' : 'format');
    }
    if (!isObject(found.value)) return reject('format');

    // `{"promote": null}` is a model saying nothing was durable in the clumsiest way
    // available to it. An absent key is the same statement; neither is a broken reply.
    const promoted = found.value.promote;
    if (promoted !== undefined && promoted !== null && !Array.isArray(promoted)) return reject('format');

    const allowed = Math.max(0, Math.min(room, MAX_FACTS_PER_PASS));
    const promote = [];
    const dropped = [];

    for (const entry of promoted ?? []) {
        if (promote.length >= allowed) {
            dropped.push({ reason: 'over-room' });
            continue;
        }
        const fact = readFact(entry, dropped);
        if (fact) promote.push(fact);
    }

    return { ok: true, promote, dropped };
}

/** One entry of `promote`, or null with the reason recorded. */
function readFact(entry, dropped) {
    if (!isObject(entry)) return drop(dropped, 'not-a-fact');
    const text = typeof entry.fact === 'string' ? entry.fact.trim() : '';
    if (!text) return drop(dropped, 'no-text');
    if (text.length > MAX_FACT_CHARS) return drop(dropped, 'fact-too-long');

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

    return { text, entities };
}

function drop(dropped, reason) {
    dropped.push({ reason });
    return null;
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
