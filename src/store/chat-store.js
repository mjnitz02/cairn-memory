/**
 * `message.extra.cairn` — read, validate, write (DESIGN.md §9, docs/decisions.md D-0037).
 *
 * Two tiers share the store. A scene lives on the message it summarises and a
 * state on the newest message it read (docs/p3-plan.md §1), so deletions, branches
 * and swipes carry both with no bookkeeping. What neither survives is an edit, and
 * that is caught on read: each counts only while the text it was written from
 * still hashes the same.
 *
 * Pure: messages in, a status out. The writers mutate the message they are given
 * and nothing else — never a copy (DESIGN.md §9).
 */
import { SLUG } from '../constants.js';
import { STORE_VERSION, migrateStore } from './schema.js';
import { hashString } from '../util/hash.js';
import { estimateTokens } from '../util/tokens.js';

/** Matt's qvink `message_length_threshold` (docs/decisions.md D-0037). */
export const MIN_SUMMARY_TOKENS = 50;

/**
 * Whether a message gets a summary at all. A constant rule applied on read, so
 * nothing is ever stored for a skipped message.
 *
 * Hidden messages are skipped because ST hides one by setting `is_system`
 * (public/scripts/chats.js:157). Length is *estimated*, not tokenised as qvink
 * does (its index.js:3792): the rule has to be pure and synchronous, and the
 * estimate depends on nothing but `mes`.
 *
 * @param {object} message
 */
export function summarisable(message) {
    if (!message || typeof message.mes !== 'string') return false;
    if (message.is_system) return false;
    return estimateTokens(message.mes) >= MIN_SUMMARY_TOKENS;
}

/**
 * @param {object} message
 * @returns {{status: 'none'|'invalid'|'future'|'stale'|'valid', scene: object|null}}
 *          `scene` is set only when `valid`.
 */
export function readScene(message) {
    const { status, store } = migrateStore(message?.extra?.[SLUG]);
    if (status !== 'ok') return { status, scene: null };

    const scene = store.scene;
    // The state tier writes to the newest message before any scene does.
    if (scene === undefined) return { status: 'none', scene: null };
    const wellFormed = isObject(scene)
        && typeof scene.text === 'string' && scene.text !== ''
        && typeof scene.hash === 'string'
        && typeof scene.prompt === 'string'
        && typeof scene.at === 'string';
    if (!wellFormed) return { status: 'invalid', scene: null };

    if (scene.hash !== hashString(message.mes)) return { status: 'stale', scene: null };
    return { status: 'valid', scene };
}

/**
 * Store a summary on the message it summarises, hashed against `mes` as it is
 * now. The caller checks the message is still the one it summarised before
 * calling; this only refuses what would corrupt the store.
 *
 * @param {object} message The live chat message.
 * @param {{text: string, prompt: string, at?: string}} scene
 * @returns {boolean} Whether anything was written.
 */
export function writeScene(message, { text, prompt, at = new Date().toISOString() }) {
    if (!message || typeof message.mes !== 'string') return false;
    if (typeof text !== 'string' || text === '' || typeof prompt !== 'string') return false;

    return writeKey(message, 'scene', { text, hash: hashString(message.mes), prompt, at });
}

/**
 * The visible messages a state read: `read` of them, ending at `index`, oldest
 * first. Hidden ones are skipped the way ST leaves them out of the prompt
 * (`coreChat`, public/script.js:4496), so hiding, unhiding or deleting one inside
 * the range pulls a different message in and changes the hash.
 *
 * @param {Array<object>} chat
 * @param {number} index
 * @param {number} read
 * @returns {Array<object>|null} Null when the message at `index` is hidden or
 *          there are fewer than `read` visible messages up to it.
 */
export function readRange(chat, index, read) {
    const message = chat?.[index];
    if (!visible(message) || !Number.isInteger(read) || read < 1) return null;

    const range = [];
    for (let i = index; i >= 0 && range.length < read; i--) {
        if (visible(chat[i])) range.unshift(chat[i]);
    }
    return range.length === read ? range : null;
}

/**
 * What a state is checked against. Part of the stored shape: changing it is a
 * schema change (CLAUDE.md §8.32).
 *
 * @param {Array<object>} messages
 */
export function hashRange(messages) {
    return hashString(messages.map((message) => `${message.name}: ${message.mes}`).join('\n'));
}

/**
 * The state stored on `chat[index]`.
 *
 * @param {Array<object>} chat
 * @param {number} index
 * @returns {{status: 'none'|'invalid'|'future'|'stale'|'valid', state: object|null}}
 *          `state` is set only when `valid`.
 */
export function readState(chat, index) {
    const message = chat?.[index];
    const { status, store } = migrateStore(message?.extra?.[SLUG]);
    if (status !== 'ok') return { status, state: null };

    const state = store.state;
    if (state === undefined) return { status: 'none', state: null };
    const wellFormed = isObject(state)
        && isObject(state.value)
        && Number.isInteger(state.read) && state.read >= 1
        && typeof state.hash === 'string'
        && Array.isArray(state.changed) && state.changed.every((kind) => typeof kind === 'string')
        && typeof state.prompt === 'string'
        && typeof state.at === 'string';
    if (!wellFormed) return { status: 'invalid', state: null };

    const range = readRange(chat, index, state.read);
    if (!range || hashRange(range) !== state.hash) return { status: 'stale', state: null };
    return { status: 'valid', state };
}

/**
 * Store a state on the newest message it read, hashed against the range as it is
 * now. The caller checks the range still matches what the request read before
 * calling; this only refuses what would corrupt the store.
 *
 * @param {Array<object>} chat The live chat.
 * @param {number} index The newest message the update read.
 * @param {{value: object, read: number, changed: string[], prompt: string, at?: string}} state
 * @returns {boolean} Whether anything was written.
 */
export function writeState(chat, index, { value, read, changed, prompt, at = new Date().toISOString() }) {
    if (!isObject(value) || typeof prompt !== 'string') return false;
    if (!Array.isArray(changed) || !changed.every((kind) => typeof kind === 'string')) return false;
    const range = readRange(chat, index, read);
    if (!range || typeof chat[index].mes !== 'string') return false;

    return writeKey(chat[index], 'state', { value, read, hash: hashRange(range), changed, prompt, at });
}

/** Set one tier's key, keeping the other's and upgrading the envelope to the current version. */
function writeKey(message, key, entry) {
    const { status, store } = migrateStore(message.extra?.[SLUG]);
    if (status === 'future') return false;

    message.extra ??= {};
    message.extra[SLUG] = { ...(status === 'ok' ? store : {}), v: STORE_VERSION, [key]: entry };
    return true;
}

function visible(message) {
    return Boolean(message) && !message.is_system;
}

function isObject(value) {
    return typeof value === 'object' && value !== null && !Array.isArray(value);
}
