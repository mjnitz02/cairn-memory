/**
 * The state strategy: the whole record back from the model, after each reply
 * (docs/decisions.md D-0053, superseding D-0044's merge patch).
 *
 * The same boundary as `perMessage` (DESIGN.md §11): what the prompt says and how
 * a reply is read live here. Merging the record belongs to the schema
 * (state-schema.js), so this parser only finds the record or rejects the reply.
 *
 * Pure: no ST, no network. ST's macro expansion comes in as `expand`.
 */
import { firstJson, looksLikeRefusal, stripThinking, unfence } from './model-reply.js';
import {
    CHARACTER_FIELDS,
    MAX_CHARACTERS,
    MAX_NAME_CHARS,
    TEXT_FIELDS,
    validState,
} from './state-schema.js';
import { hashString } from '../util/hash.js';
import { renderTemplate, resolvePrompt } from '../util/template.js';

/** As for summaries: room for a reasoning model's thinking before a short record. */
export const STATE_MAX_TOKENS = 2048;

/** The most messages one update reads. The caller picks the newest ones. */
export const STATE_MAX_MESSAGES = 6;

/** The most scene summaries sent as background when there were more messages than that. */
export const STATE_MAX_EARLIER = 5;

/**
 * Editable in the settings since D-0085 (it was built in under D-0044 and D-0053); an
 * edit without `{{messages}}` and `{{state}}` falls back to this one. The field list and
 * caps are still the schema's, so an edit that changes them only changes what the model
 * is told. A value over its cap is dropped, not cut, which is why the model is told the
 * caps. It records stated facts only, so the memory model never takes over telling the
 * story (D-0043).
 */
export const STATE_PROMPT = `You keep a short record of the hard facts of a roleplay scene: where it is, who is in it, and what each character's hair and outfit are right now. Character descriptions often fix these, so the record carries forward whatever the story has since changed. Below are the record as it stands and the messages that came after it. Reply with the complete record as it stands at the end of those messages.

Fields, with the most characters each value may use:
- location: where the scene is, most specific place first (${TEXT_FIELDS.location})
- weather: weather and temperature, or the conditions indoors (${TEXT_FIELDS.weather})
- characters: the characters actually present in the scene, at most ${MAX_CHARACTERS}, keyed by name (${MAX_NAME_CHARS}), each with:
  - hair: hairstyle and its condition (${CHARACTER_FIELDS.hair})
  - outfit: the complete outfit, underwear included (${CHARACTER_FIELDS.outfit})

Rules:
- Write every field every time. Where the messages changed nothing, copy the value across exactly as it stands rather than rewording it.
- Fill in any field the record is missing whenever the messages or the characters' own descriptions establish it, even in passing. A blank field is worse than an old one.
- List exactly the characters present at the end of the messages. Anyone you leave out has left the scene.
- Values are short, plain phrases stating what the messages say. Keep each value within its limit; a longer one is thrown away and the stored value kept.

Example.
Record: {"location":"The ferry terminal, waiting room","weather":"Drizzle outside; damp and cold indoors","characters":{"Wren":{"hair":"Loose, damp from the rain","outfit":"Wool coat over a grey jumper, jeans, boots"}}}
Messages: Wren shrugs off her soaked coat, ties her hair back and walks out to the pier.
Reply: {"location":"The ferry terminal, outer pier","weather":"Drizzle outside; damp and cold indoors","characters":{"Wren":{"hair":"Tied back","outfit":"Grey jumper, jeans, boots"}}}

Where the messages leave a detail unsettled, carry the record's own value across unchanged.

Current record:
{{state}}

{{#if earlier}}
Earlier events:
{{earlier}}

{{/if}}
New messages:
{{messages}}

Reply with the complete record as JSON, and nothing else.`;

/** The template to send for a `statePrompt` setting (`resolvePrompt`). */
export function resolveStatePrompt(setting) {
    return resolvePrompt(setting, STATE_PROMPT, ['state', 'messages']);
}

export const stateRecord = {
    id: 'state-record-v1',

    /**
     * @param {object} request
     * @param {object} [request.state] The current state's value; `{}` on a cold start.
     * @param {Array<object>} request.messages The visible messages to read, oldest first,
     *        at most STATE_MAX_MESSAGES.
     * @param {Array<string|{text: string}>} [request.earlier] Scenes before those messages,
     *        oldest first, at most STATE_MAX_EARLIER.
     * @param {string} [request.template] The `statePrompt` setting, raw.
     * @param {(text: string) => string} [request.expand] ST's `substituteParams`
     *        (public/scripts/st-context.js:163), applied to the template only.
     * @returns {{messages: Array<{role: string, content: string}>, maxTokens: number, prompt: string,
     *            fallback: boolean}} `prompt` is stored as `state.prompt`.
     */
    build({ state = {}, messages, earlier = [], template, expand }) {
        if (!validState(state)) throw new TypeError('A state request needs a valid current state');
        if (!Array.isArray(messages) || messages.length < 1 || messages.length > STATE_MAX_MESSAGES) {
            throw new RangeError(`A state request reads 1 to ${STATE_MAX_MESSAGES} messages`);
        }
        if (!Array.isArray(earlier) || earlier.length > STATE_MAX_EARLIER) {
            throw new RangeError(`A state request takes at most ${STATE_MAX_EARLIER} earlier scenes`);
        }

        const resolved = resolveStatePrompt(template);
        const content = renderTemplate(resolved.template, {
            state: JSON.stringify(state),
            earlier: earlier.map((scene) => (typeof scene === 'string' ? scene : scene?.text ?? '')).join('\n'),
            messages: messages.map((message) => `${message?.name ?? ''}: ${message?.mes ?? ''}`).join('\n\n'),
        }, { expand });

        return {
            messages: [{ role: 'user', content }],
            maxTokens: STATE_MAX_TOKENS,
            prompt: hashString(resolved.template),
            fallback: resolved.fallback,
        };
    },

    parse: parseStateReply,
};

/**
 * Find the record in a reply, or reject it. The first JSON object in the reply is
 * the record, wherever the model put it; field-level problems are left to
 * `mergeReply`, which drops them one at a time. A bracket still open when the
 * reply ends is a cut-off reply: ST returns no finish reason
 * (public/scripts/custom-request.js:60).
 *
 * @param {string} content
 * @returns {{ok: true, record: object} | {ok: false, reason: 'empty'|'refusal'|'format'|'truncated'}}
 */
export function parseStateReply(content) {
    const thought = stripThinking(content);
    if (thought.truncated) return reject('truncated');
    const text = unfence(thought.text).trim();
    if (!text) return reject('empty');

    const found = firstJson(text);
    if (found.parsed) return isObject(found.value) ? { ok: true, record: found.value } : reject('format');
    if (looksLikeRefusal(text)) return reject('refusal');
    if (found.unclosed) return reject('truncated');
    return reject('format');
}

function reject(reason) {
    return { ok: false, reason };
}

function isObject(value) {
    return typeof value === 'object' && value !== null && !Array.isArray(value);
}
