/**
 * The summarisation strategy: one plain-text summary per message
 * (docs/decisions.md D-0037, D-0039).
 *
 * This is the interface boundary DESIGN.md §11 names. What the prompt says and
 * how a reply is read live here; the queue, the transport and the store never
 * see either, so a new strategy is a new object with the same two methods.
 *
 * Pure: no ST, no network. ST's macro expansion comes in as `expand`.
 */
import { hashString } from '../util/hash.js';
import { hasMacro, renderTemplate } from '../util/template.js';

/**
 * Matt's qvink prompt, verbatim, proven in play on the D-0036 model floor. It
 * deliberately does not follow DESIGN.md §12's structure: a prompt measured in
 * play beats one written to rules.
 */
export const DEFAULT_SUMMARY_PROMPT = `Summarize the following fictional message as a single paragraph of 2-3 sentences in past tense. Do not use bullet points or numbered lists.

Include: character names (not pronouns), actions taken, dialogue points, emotional shifts, decisions made, and new information revealed.

{{#if history}}
Recent summary context (for reference only, do not re-summarize):
{{history}}
{{/if}}

Message to summarize:
{{message}}`;

/**
 * Enough for a reasoning model's thinking plus a paragraph. The longest of 105
 * measured replies was 199 tokens (docs/decisions.md D-0037).
 */
export const SUMMARY_MAX_TOKENS = 2048;

/** Longer than this is not a 2-3 sentence paragraph (the corpus max is 641). */
export const MAX_SUMMARY_CHARS = 1500;

/**
 * The template to use for a `summaryPrompt` setting. Empty means the built-in
 * default, so users who never edit it get its improvements. A prompt with no
 * `{{message}}` cannot summarise anything, so it falls back and says so.
 *
 * @param {string} [setting]
 * @returns {{template: string, edited: boolean, fallback: boolean}}
 */
export function resolveSummaryPrompt(setting) {
    const edited = typeof setting === 'string' && setting.trim() !== '';
    if (!edited) return { template: DEFAULT_SUMMARY_PROMPT, edited: false, fallback: false };
    if (!hasMacro(setting, 'message')) return { template: DEFAULT_SUMMARY_PROMPT, edited: true, fallback: true };
    return { template: setting, edited: true, fallback: false };
}

export const perMessage = {
    id: 'per-message-v1',

    /**
     * @param {object} request
     * @param {object} request.message The chat message to summarise.
     * @param {Array<string|{text: string}>} request.history The scenes just before it, oldest first.
     * @param {string} [request.template] The `summaryPrompt` setting, raw.
     * @param {(text: string) => string} [request.expand] ST's `substituteParams`
     *        (public/scripts/st-context.js:163), applied to the template only.
     * @returns {{messages: Array<{role: string, content: string}>, maxTokens: number,
     *            prompt: string, fallback: boolean}} `prompt` is stored as `scene.prompt`.
     */
    build({ message, history = [], template, expand }) {
        const resolved = resolveSummaryPrompt(template);
        const content = renderTemplate(resolved.template, {
            message: `${message?.name ?? ''}: ${message?.mes ?? ''}`,
            history: history.map((scene) => (typeof scene === 'string' ? scene : scene?.text ?? '')).join('\n'),
        }, { expand });

        return {
            messages: [{ role: 'user', content }],
            maxTokens: SUMMARY_MAX_TOKENS,
            prompt: hashString(resolved.template),
            fallback: resolved.fallback,
        };
    },

    parse: parseSummary,
};

const REFUSAL = /^(?:I'?m sorry|I am sorry|sorry\b|I apologi[sz]e|I can(?:not|'t)\b|I won't\b|I will not\b|I'?m (?:not able|unable)|I am (?:not able|unable)|as an AI\b|I must decline|I'?m afraid)/i;
const SIGN_OFF = /^(?:I hope|Let me know|Feel free|Is there anything|If you(?:'d| would) like|Would you like)/i;
const LABEL = /^(?:\*\*|__)?summary(?:\*\*|__)?\s*:\s*(?:\*\*|__)?\s*/i;
const LIST_MARKER = /^(?:[-*•]|\d+[.)])\s+/;
/** Sentence-ending punctuation, then any closing quotes or brackets. */
const FINISHED = /[.!?…。！？]["'”’»)\]*]*$/;

/**
 * Clean a reply into one paragraph, or reject it. ST returns no finish reason
 * (public/scripts/custom-request.js:60), so an unfinished last sentence is the
 * truncation check. A refusal worded in a way REFUSAL misses is stored — the
 * known weakness in docs/decisions.md D-0037.
 *
 * @param {string} content
 * @returns {{ok: true, text: string} | {ok: false, reason: 'empty'|'refusal'|'format'|'too-long'|'truncated'}}
 */
export function parseSummary(content) {
    let text = typeof content === 'string' ? content : '';

    // Still thinking when the tokens ran out.
    if (/^\s*<think>/i.test(text) && !/<\/think>/i.test(text)) return reject('truncated');
    text = text.replace(/<think>[\s\S]*?<\/think>/gi, '');
    // The chat template opened the block in the prompt, so only its close arrived.
    const close = text.search(/<\/think>/i);
    if (close >= 0) text = text.slice(close + '</think>'.length);

    const fence = text.match(/```[^\n]*\n([\s\S]*?)\n?```/);
    if (fence) text = fence[1];

    const paragraphs = text.split(/\n\s*\n/).map((part) => part.trim()).filter(Boolean);
    if (paragraphs.length > 1 && paragraphs[0].endsWith(':')) paragraphs.shift();
    if (paragraphs.length > 1 && SIGN_OFF.test(straightQuotes(paragraphs.at(-1)))) paragraphs.pop();

    text = paragraphs.join('\n')
        .split('\n')
        .map((line) => line.trim().replace(LIST_MARKER, ''))
        .filter(Boolean)
        .join(' ')
        .replace(LABEL, '')
        .replace(/\s+/g, ' ')
        .trim();

    if (!text) return reject('empty');
    if (REFUSAL.test(straightQuotes(text))) return reject('refusal');
    if (/^[{[]/.test(text)) return reject('format');
    if (text.length > MAX_SUMMARY_CHARS) return reject('too-long');
    if (!FINISHED.test(text)) return reject('truncated');
    return { ok: true, text };
}

function reject(reason) {
    return { ok: false, reason };
}

function straightQuotes(text) {
    return text.replace(/[‘’]/g, '\'');
}
