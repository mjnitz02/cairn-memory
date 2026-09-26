/**
 * `message.extra.cairn` — read, validate, write (DESIGN.md §9, docs/decisions.md D-0037).
 *
 * Four tiers share the store. A scene lives on the message it summarises, an index
 * record beside it (docs/decisions.md D-0070), a state on the newest message it read
 * (D-0045) and a canon batch on the newest summary its pass read (docs/p4-plan.md
 * decision 1), so deletions, branches and swipes carry all four with no bookkeeping.
 * What a scene, an index record and a state do not survive is an edit, and that is
 * caught on read: each counts only while the text it was written from still hashes the
 * same. A canon fact is not hashed — it says something *happened*, and editing the
 * message afterwards does not unmake it.
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

/**
 * The canon batch stored on `chat[index]`.
 *
 * No `stale`: a batch is checked for shape and nothing else (docs/p4-plan.md decision 2).
 * An empty `facts` is well-formed and deliberate — a pass that found nothing durable
 * still records the range it read, so it is not asked the same question every turn.
 *
 * @param {object} message
 * @returns {{status: 'none'|'invalid'|'future'|'valid', canon: object|null}}
 *          `canon` is set only when `valid`.
 */
export function readCanon(message) {
    const { status, store } = migrateStore(message?.extra?.[SLUG]);
    if (status !== 'ok') return { status, canon: null };

    const canon = store.canon;
    if (canon === undefined) return { status: 'none', canon: null };
    const wellFormed = isObject(canon)
        && Array.isArray(canon.facts) && canon.facts.every(wellFormedFact)
        && Array.isArray(canon.covers) && canon.covers.length === 2
        && canon.covers.every(Number.isInteger) && canon.covers[0] <= canon.covers[1]
        && typeof canon.prompt === 'string'
        && typeof canon.at === 'string';
    return wellFormed ? { status: 'valid', canon } : { status: 'invalid', canon: null };
}

/**
 * Store a canon batch on the newest indexed summary the pick read. That message is
 * behind the raw window by construction, so a batch lands where swipes never reach.
 *
 * The caller enforces the per-fact caps before calling (memory/canon-strategy.js);
 * this only refuses what would corrupt the store.
 *
 * `slots` is what the pick was *asked* for, and it is stored rather than derived
 * because a short answer has to be distinguishable from an unanswered question — a
 * four-fact reply to a ten-slot pick is a spine, not work still to do
 * (pipeline/compactor.js `pendingPick`).
 *
 * @param {Array<object>} chat The live chat.
 * @param {number} index The newest message the pick read.
 * @param {{facts: Array<{text: string, entities: string[], from: number[]}>,
 *          covers: number[], slots?: number, prompt: string, at?: string}} canon
 * @returns {boolean} Whether anything was written.
 */
export function writeCanon(chat, index, { facts, covers, slots, prompt, at = new Date().toISOString() }) {
    if (!Array.isArray(facts) || !facts.every(wellFormedFact) || typeof prompt !== 'string') return false;
    if (!Array.isArray(covers) || covers.length !== 2 || !covers.every(Number.isInteger) || covers[0] > covers[1]) return false;
    if (typeof chat?.[index]?.mes !== 'string') return false;

    return writeKey(chat[index], 'canon', {
        facts: facts.map((fact) => ({
            text: fact.text,
            entities: [...fact.entities],
            from: [...(fact.from ?? [])],
        })),
        covers: [...covers],
        ...(Number.isInteger(slots) ? { slots } : {}),
        prompt,
        at,
    });
}

/**
 * `from` is the messages whose index records the fact was picked from, and it is the
 * one field here that is read back: a fact outlives a source only while one of them is
 * still valid (memory/canon.js). It is **optional**, because a batch written before the
 * pick existed has no citations and is still a readable batch — it simply cannot be
 * invalidated by a record going away.
 *
 * `entities` is stored and never read: `store/entity-index.js` is a named interface
 * boundary (DESIGN.md §11), the model gives the tags in the same reply, and adding the
 * field later would cost a store version and a migration.
 */
function wellFormedFact(fact) {
    return isObject(fact)
        && typeof fact.text === 'string' && fact.text !== ''
        && Array.isArray(fact.entities)
        && fact.entities.every((entity) => typeof entity === 'string' && entity !== '')
        && (fact.from === undefined
            || (Array.isArray(fact.from) && fact.from.every(Number.isInteger)));
}

/**
 * The index record stored on `chat[index]`.
 *
 * **Hashed against the summary, not against `mes`.** The record is a reading of the
 * summary, so the summary is what it depends on: an edited message invalidates the
 * scene, which invalidates this, and a resummarise invalidates it too — which a hash of
 * `mes` would have missed. A record therefore never outlives the summary it describes,
 * and `status` is `stale` whenever that summary is gone, stale or was never written.
 *
 * @param {object} message
 * @returns {{status: 'none'|'invalid'|'future'|'stale'|'valid', index: object|null}}
 *          `index` is set only when `valid`.
 */
export function readIndex(message) {
    const { status, store } = migrateStore(message?.extra?.[SLUG]);
    if (status !== 'ok') return { status, index: null };

    const record = store.index;
    if (record === undefined) return { status: 'none', index: null };
    const wellFormed = isObject(record)
        && wellFormedRecord(record.record)
        && typeof record.hash === 'string'
        && typeof record.prompt === 'string'
        && typeof record.at === 'string';
    if (!wellFormed) return { status: 'invalid', index: null };

    const scene = readScene(message);
    if (scene.status !== 'valid') return { status: 'stale', index: null };
    if (record.hash !== hashString(scene.scene.text)) return { status: 'stale', index: null };
    return { status: 'valid', index: record };
}

/**
 * Store an index record beside the summary it was derived from.
 *
 * Refuses a message with no valid summary: there is nothing to have indexed, and a
 * record hashed against a summary that is not there could never read back as valid.
 * The caller enforces the record's caps before calling (memory/index-record.js); this
 * only refuses what would corrupt the store.
 *
 * @param {Array<object>} chat The live chat.
 * @param {number} index The message the record belongs to.
 * @param {{record: object, prompt: string, at?: string}} entry A record `validRecord` accepts.
 * @returns {boolean} Whether anything was written.
 */
export function writeIndex(chat, index, { record, prompt, at = new Date().toISOString() }) {
    if (!wellFormedRecord(record) || typeof prompt !== 'string') return false;
    const message = chat?.[index];
    const scene = readScene(message);
    if (scene.status !== 'valid') return false;

    return writeKey(message, 'index', {
        record: { ...record, who: [...record.who] },
        hash: hashString(scene.scene.text),
        prompt,
        at,
    });
}

/**
 * Structure only, as `wellFormedFact` is: the caps and the four legal kinds are the
 * strategy's (memory/index-record.js `validRecord`), because enforcing them here would
 * make store/ depend on memory/, and memory/canon.js already depends on store/.
 */
function wellFormedRecord(record) {
    return isObject(record)
        && typeof record.kind === 'string' && record.kind !== ''
        && Array.isArray(record.who)
        && record.who.every((name) => typeof name === 'string' && name !== '')
        && typeof record.what === 'string' && record.what !== ''
        && typeof record.changed === 'string'
        && typeof record.because === 'string';
}

/** Set one tier's key, keeping the others' and upgrading the envelope to the current version. */
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
