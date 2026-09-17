/**
 * The state strategy: a JSON merge patch against the current state, after each
 * reply (docs/p3-plan.md decisions 5-6, §2).
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
    MAX_THREADS,
    MAX_THREAD_CHARS,
    TEXT_FIELDS,
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
 * Built in, not a setting (decision 6): the field list and caps are the schema's,
 * so an edit could only break the parser. A value over its cap is dropped, not
 * cut, which is why the model is told the caps.
 */
export const STATE_PROMPT = `You keep the current state of a roleplay scene. Below are the state as it stood and the messages that came after it. Reply with a JSON merge patch that brings the state up to the end of the messages.

IMPORTANT: Include only what the messages change. Leave every other field out of the patch, so its wording stays exactly as it is.

Fields, with the most characters each value may use:
- time: the in-story time of day, and the date if the story gives one (${TEXT_FIELDS.time})
- location: where the characters are, most specific place first (${TEXT_FIELDS.location})
- weather: weather and temperature, or the conditions indoors (${TEXT_FIELDS.weather})
- characters: one entry per character present, at most ${MAX_CHARACTERS}, keyed by name (${MAX_NAME_CHARS}), each with:
  - appearance: clothing and how they look now (${CHARACTER_FIELDS.appearance})
  - condition: injuries, fatigue, state of dress (${CHARACTER_FIELDS.condition})
  - mood: a few words (${CHARACTER_FIELDS.mood})
  - intent: what they are trying to do next (${CHARACTER_FIELDS.intent})
- threads: up to ${MAX_THREADS} unresolved matters the scene is carrying, one sentence each (${MAX_THREAD_CHARS})

Patch rules:
- A changed field gets its new value. A field that no longer applies gets null.
- A character who leaves the scene gets null. A character who arrives gets every field the messages describe.
- threads is always the complete new list.
- Values are short phrases, except threads. Keep each value within its limit; a longer one is thrown away.
- When nothing changed, reply {}.

Example.
State: {"location":"The ferry terminal, waiting room","characters":{"Wren":{"mood":"impatient","intent":"find out when the ferry runs"}}}
Messages: Wren walks out to the pier and starts to calm down.
Patch: {"location":"The ferry terminal, outer pier","characters":{"Wren":{"mood":"calmer"}}}

When unsure whether something changed, leave it out.

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

        const content = renderTemplate(STATE_PROMPT, {
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
