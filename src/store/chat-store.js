/**
 * `message.extra.cairn` — read, validate, write (DESIGN.md §9, docs/p2-plan.md §1).
 *
 * A scene lives on the message it summarises, so deletions, branches and swipes
 * carry it with no bookkeeping. What it cannot survive is an edit, and that is
 * caught on read: a scene counts only while its hash matches the message's
 * current `mes`.
 *
 * Pure: a message in, a status out. The writer mutates the message it is given
 * and nothing else — never a copy (DESIGN.md §9).
 */
import { SLUG } from '../constants.js';
import { STORE_VERSION } from './schema.js';
import { hashString } from '../util/hash.js';
import { estimateTokens } from '../util/tokens.js';

/** Matt's qvink `message_length_threshold` (docs/p2-plan.md §1). */
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
    const store = message?.extra?.[SLUG];
    if (store === undefined) return { status: 'none', scene: null };
    if (!isObject(store) || !Number.isInteger(store.v) || store.v < 1) {
        return { status: 'invalid', scene: null };
    }
    // A newer Cairn's shape is not ours to interpret, and not ours to overwrite.
    if (store.v > STORE_VERSION) return { status: 'future', scene: null };

    const scene = store.scene;
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

    const existing = message.extra?.[SLUG];
    if (isObject(existing) && Number.isInteger(existing.v) && existing.v > STORE_VERSION) return false;

    message.extra ??= {};
    // Other keys under our slug belong to other tiers; keep them.
    message.extra[SLUG] = {
        ...(isObject(existing) ? existing : {}),
        v: STORE_VERSION,
        scene: { text, hash: hashString(message.mes), prompt, at },
    };
    return true;
}

function isObject(value) {
    return typeof value === 'object' && value !== null && !Array.isArray(value);
}
