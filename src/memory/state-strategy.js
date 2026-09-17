/**
 * The state strategy: a JSON merge patch against the current state, after each
 * reply (docs/decisions.md D-0044).
 *
 * The same boundary as `perMessage` (DESIGN.md §11): what the prompt says and how
 * a reply is read live here. Merging the patch belongs to the schema
 * (state-schema.js), so this parser only finds the patch or rejects the reply.
 *
 * Pure: no ST, no network. ST's macro expansion comes in as `expand`.
 */
import { looksLikeRefusal, stripThinking, unfence } from './model-reply.js';
import {
    CHARACTER_FIELDS,
    MAX_CHARACTERS,
    MAX_NAME_CHARS,
    TEXT_FIELDS,
    renderState,
    validState,
} from './state-schema.js';
import { hashString } from '../util/hash.js';
import { renderTemplate } from '../util/template.js';

/** As for summaries: room for a reasoning model's thinking before a short patch. */
export const STATE_MAX_TOKENS = 2048;

/** The most messages one update reads. The caller picks the newest ones. */
export const STATE_MAX_MESSAGES = 6;

/** The most scene summaries sent as background when there were more messages than that. */
export const STATE_MAX_EARLIER = 5;

/**
 * Built in, not a setting (D-0044): the field list and caps are the schema's,
 * so an edit could only break the parser. A value over its cap is dropped, not
 * cut, which is why the model is told the caps. It records stated facts only, so
 * the memory model never takes over telling the story (D-0043).
 */
export const STATE_PROMPT = `You keep a short record of the hard facts of a roleplay scene: where it is, who is in it, and what each character's hair and outfit are right now. Character descriptions often fix these, so the record carries forward whatever the story has since changed. Below are the record as it stood and the messages that came after it. Reply with a JSON merge patch that brings the record up to the end of the messages.

{{#if first}}
IMPORTANT: The record is empty, so this patch is its first entry. Fill in every field the messages and earlier events establish, including hair and outfit for each character present, even where they are only mentioned in passing. Leave out only what they don't say.
{{/if}}
{{#if update}}
IMPORTANT: Include only what the messages change. Leave every other field out of the patch, so its wording stays exactly as it is.
{{/if}}

Fields, with the most characters each value may use:
- location: where the scene is, most specific place first (${TEXT_FIELDS.location})
- weather: weather and temperature, or the conditions indoors (${TEXT_FIELDS.weather})
- characters: the characters actually present in the scene, at most ${MAX_CHARACTERS}, keyed by name (${MAX_NAME_CHARS}), each with:
  - hair: hairstyle and its condition (${CHARACTER_FIELDS.hair})
  - outfit: the complete outfit, underwear included (${CHARACTER_FIELDS.outfit})

Patch rules:
- A changed field gets its new value. A field that no longer applies gets null.
- A character who leaves the scene gets null. A character who arrives gets an entry, with hair and outfit if the messages describe them.
- Values are short, plain phrases stating what the messages say. Keep each value within its limit; a longer one is thrown away.
- When nothing changed, reply {}.

Example.
State: {"location":"The ferry terminal, waiting room","characters":{"Wren":{"hair":"Loose, damp from the rain","outfit":"Wool coat over a grey jumper, jeans, boots"}}}
Messages: Wren shrugs off her soaked coat, ties her hair back and walks out to the pier.
Patch: {"location":"The ferry terminal, outer pier","characters":{"Wren":{"hair":"Tied back","outfit":"Grey jumper, jeans, boots"}}}

{{#if first}}
When unsure whether a detail still holds at the end of the messages, leave it out.
{{/if}}
{{#if update}}
When unsure whether something changed, leave it out.
{{/if}}

Current state:
{{state}}

{{#if earlier}}
Earlier events:
{{earlier}}

{{/if}}
New messages:
{{messages}}

Reply with the JSON patch only.`;

export const statePatch = {
    id: 'state-patch-v1',

    /**
     * @param {object} request
     * @param {object} [request.state] The current state's value; `{}` on a cold start.
     * @param {Array<object>} request.messages The visible messages to read, oldest first,
     *        at most STATE_MAX_MESSAGES.
     * @param {Array<string|{text: string}>} [request.earlier] Scenes before those messages,
     *        oldest first, at most STATE_MAX_EARLIER.
     * @param {(text: string) => string} [request.expand] ST's `substituteParams`
     *        (public/scripts/st-context.js:163), applied to the template only.
     * @returns {{messages: Array<{role: string, content: string}>, maxTokens: number, prompt: string}}
     *          `prompt` is stored as `state.prompt`.
     */
    build({ state = {}, messages, earlier = [], expand }) {
        if (!validState(state)) throw new TypeError('A state request needs a valid current state');
        if (!Array.isArray(messages) || messages.length < 1 || messages.length > STATE_MAX_MESSAGES) {
            throw new RangeError(`A state request reads 1 to ${STATE_MAX_MESSAGES} messages`);
        }
        if (!Array.isArray(earlier) || earlier.length > STATE_MAX_EARLIER) {
            throw new RangeError(`A state request takes at most ${STATE_MAX_EARLIER} earlier scenes`);
        }

        // A changes-only instruction on an empty record leaves out whatever was set before
        // these messages, hair most of all (docs/decisions.md D-0048).
        const first = renderState(state) === '';
        const content = renderTemplate(STATE_PROMPT, {
            first: first ? 'yes' : '',
            update: first ? '' : 'yes',
            state: JSON.stringify(state),
            earlier: earlier.map((scene) => (typeof scene === 'string' ? scene : scene?.text ?? '')).join('\n'),
            messages: messages.map((message) => `${message?.name ?? ''}: ${message?.mes ?? ''}`).join('\n\n'),
        }, { expand });

        return {
            messages: [{ role: 'user', content }],
            maxTokens: STATE_MAX_TOKENS,
            prompt: hashString(STATE_PROMPT),
        };
    },

    parse: parseStatePatch,
};

/**
 * Find the patch in a reply, or reject it. The first JSON object in the reply is
 * the patch, wherever the model put it; field-level problems are left to
 * `applyPatch`, which drops them one at a time. A bracket still open when the
 * reply ends is a cut-off reply: ST returns no finish reason
 * (public/scripts/custom-request.js:60).
 *
 * @param {string} content
 * @returns {{ok: true, patch: object} | {ok: false, reason: 'empty'|'refusal'|'format'|'truncated'}}
 */
export function parseStatePatch(content) {
    const thought = stripThinking(content);
    if (thought.truncated) return reject('truncated');
    const text = unfence(thought.text).trim();
    if (!text) return reject('empty');

    const found = firstJson(text);
    if (found.parsed) return isObject(found.value) ? { ok: true, patch: found.value } : reject('format');
    if (looksLikeRefusal(text)) return reject('refusal');
    if (found.unclosed) return reject('truncated');
    return reject('format');
}

/**
 * The first bracketed span that parses as JSON. Spans that do not parse, like a
 * `[Current scene]` echoed in a preamble, are skipped whole, so an object nested
 * inside a broken one is never taken for the patch.
 */
function firstJson(text) {
    for (let start = text.search(/[{[]/); start >= 0;) {
        const end = closingIndex(text, start);
        if (end < 0) return { parsed: false, unclosed: true };
        try {
            return { parsed: true, value: JSON.parse(text.slice(start, end + 1)) };
        } catch {
            const next = text.slice(end + 1).search(/[{[]/);
            start = next < 0 ? -1 : end + 1 + next;
        }
    }
    return { parsed: false, unclosed: false };
}

/** Where the bracket at `start` closes, skipping brackets inside JSON strings; -1 if it never does. */
function closingIndex(text, start) {
    let depth = 0;
    let inString = false;
    for (let i = start; i < text.length; i++) {
        const ch = text[i];
        if (inString) {
            if (ch === '\\') i++;
            else if (ch === '"') inString = false;
        } else if (ch === '"') {
            inString = true;
        } else if (ch === '{' || ch === '[') {
            depth++;
        } else if ((ch === '}' || ch === ']') && --depth === 0) {
            return i;
        }
    }
    return -1;
}

function reject(reason) {
    return { ok: false, reason };
}

function isObject(value) {
    return typeof value === 'object' && value !== null && !Array.isArray(value);
}
