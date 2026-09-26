/**
 * Tier 1's shape: the fields and their caps, merging the model's record into ours,
 * and rendering it into the prompt (docs/decisions.md D-0043, D-0053).
 *
 * The fields are the hard facts a card's description fixes and the story later
 * changes: where the scene is, who is in it, their hair and outfit. Mood, time and
 * plot stay with the roleplay model, so the memory model never steers the story.
 *
 * The model sends the whole record every turn, so **a field is never cleared** — a
 * filled field is the nudge, and an empty one hands the card's stale value the
 * argument (D-0053). Fields merge, so anything the reply leaves out keeps its
 * bytes; the cast replaces, so who is present is whoever the reply lists.
 *
 * The caps bound the rendered state by construction. `mergeReply` only produces
 * values `validState` accepts, `renderState` renders nothing else, and the widest
 * valid state renders to MAX_STATE_CHARS. Nothing is clamped: a value over its cap
 * is dropped and the stored one kept.
 *
 * Pure: plain data in, new plain data out. Inputs are never mutated.
 */

/** Top-level text fields, in render order, with their caps in characters. */
export const TEXT_FIELDS = Object.freeze({ location: 120, weather: 80 });

/** Per-character fields, in render order, with their caps. */
export const CHARACTER_FIELDS = Object.freeze({ hair: 80, outfit: 120 });

export const MAX_CHARACTERS = 5;
export const MAX_NAME_CHARS = 40;

/** What `changed` can hold, in the order it is reported. Kinds, never content. */
export const CHANGE_KINDS = Object.freeze([
    ...Object.keys(TEXT_FIELDS),
    'characters.arrived',
    'characters.left',
    ...Object.keys(CHARACTER_FIELDS).map((field) => `characters.${field}`),
]);

export const STATE_HEADER = '[Current scene]';

const LABELS = Object.freeze({ location: 'Location', weather: 'Weather' });
const STATE_KEYS = [...Object.keys(TEXT_FIELDS), 'characters'];

/**
 * Merge the model's record into the stored one. A field the reply names takes the
 * new value; one it leaves out keeps the stored bytes, so a reply that forgets a
 * field costs nothing. Nothing clears a field: a blank, a `null` or a value past
 * its cap is dropped and the stored one kept (D-0053). The cast is whoever the
 * reply lists, so leaving a character out is how they leave. Key names match
 * case-insensitively, and so do character names, keeping the stored spelling.
 *
 * A field that breaks the schema is dropped and the rest applies. `changed` is
 * worked out from the state before and after, so a reply repeating current values
 * records nothing (CLAUDE.md §4.18).
 *
 * @param {object} current A state `validState` accepts; `{}` on a cold start.
 * @param {object} reply The parsed reply: the whole record, as the prompt asks.
 * @returns {{value: object, changed: string[], dropped: Array<{field: string, reason: string}>}}
 */
export function mergeReply(current, reply) {
    if (!validState(current)) throw new TypeError('mergeReply needs a valid current state');
    if (!isObject(reply)) throw new TypeError('A state reply must be an object');

    const dropped = [];
    const keys = foldKeys(reply, STATE_KEYS, '', dropped);
    const value = mergeTexts(current, keys, TEXT_FIELDS, '', dropped);

    const characters = keys.has('characters')
        ? mergeCharacters(current.characters, keys.get('characters'), dropped)
        : copyCharacters(current.characters);
    if (characters) value.characters = characters;

    return { value, changed: changedKinds(current, value), dropped };
}

/**
 * Exactly the values `mergeReply` produces: known keys only, every text non-blank
 * and within its cap, no empty `characters`.
 *
 * @param {unknown} value
 */
export function validState(value) {
    if (!isObject(value)) return false;
    return Object.entries(value).every(([field, entry]) => {
        if (Object.hasOwn(TEXT_FIELDS, field)) return validText(entry, TEXT_FIELDS[field]);
        if (field === 'characters') return validCharacters(entry);
        return false;
    });
}

/**
 * The state as it goes into the prompt. Fixed field order, characters in the
 * order they arrived, empty fields left out, and whitespace collapsed so a value
 * cannot start a line of its own. Anything `validState` rejects renders as `''`,
 * so the bound holds for any input.
 *
 * @param {object} value
 * @returns {string} `''` when there is nothing to say.
 */
export function renderState(value) {
    if (!validState(value)) return '';

    const lines = Object.keys(TEXT_FIELDS)
        .filter((field) => value[field] !== undefined)
        .map((field) => `${LABELS[field]}: ${oneLine(value[field])}`);
    const characters = Object.entries(value.characters ?? {});
    // Who is present is a fact of its own, as WTrackerLite rendered it, so a
    // character with nothing recorded yet still counts as there.
    if (characters.length) lines.push(`Present: ${characters.map(([name]) => oneLine(name)).join(', ')}`);
    for (const [name, fields] of characters) {
        const parts = Object.keys(CHARACTER_FIELDS)
            .filter((field) => fields[field] !== undefined)
            .map((field) => `${field}: ${oneLine(fields[field])}`);
        if (parts.length) lines.push(`${oneLine(name)} — ${parts.join('; ')}`);
    }

    return lines.length ? [STATE_HEADER, ...lines].join('\n') : '';
}

/** The rendered length of a state with every field full, so the ceiling is derived, not typed in. */
export const MAX_STATE_CHARS = renderState(widestState()).length;

function widestState() {
    const fill = (caps) => Object.fromEntries(Object.entries(caps).map(([field, cap]) => [field, 'x'.repeat(cap)]));
    const characters = {};
    for (let i = 0; i < MAX_CHARACTERS; i++) {
        characters[String.fromCharCode(65 + i).repeat(MAX_NAME_CHARS)] = fill(CHARACTER_FIELDS);
    }
    return { ...fill(TEXT_FIELDS), characters };
}

/**
 * The keys of `object` that name a known field, lowercased. An unknown key or a
 * second spelling of one already seen is dropped; the first spelling wins.
 */
function foldKeys(object, known, prefix, dropped) {
    const found = new Map();
    for (const [key, entry] of Object.entries(object)) {
        const field = known.find((name) => name === key.toLowerCase());
        if (!field) dropped.push({ field: `${prefix}unknown`, reason: 'unknown-key' });
        else if (found.has(field)) dropped.push({ field: `${prefix}${field}`, reason: 'duplicate-key' });
        else found.set(field, entry);
    }
    return found;
}

function mergeTexts(before, keys, caps, prefix, dropped) {
    const merged = {};
    for (const [field, cap] of Object.entries(caps)) {
        let text = before[field];
        if (keys.has(field)) {
            const read = readText(keys.get(field), cap);
            if (read.ok) text = read.text;
            else dropped.push({ field: `${prefix}${field}`, reason: read.reason });
        }
        if (text !== undefined) merged[field] = text;
    }
    return merged;
}

/**
 * The cast the reply lists, with each character's fields merged onto the stored
 * ones. Leaving a character out is how they leave, which is what keeps the five
 * slots from filling with people who have gone.
 *
 * A reply that empties the cast is a lazy reply, not a scene with nobody in it, so
 * the stored cast stands. That is the one guard replacement needs: an empty
 * `Present:` line nudges nothing, and the next reply puts the cast back.
 */
function mergeCharacters(before, reply, dropped) {
    const stored = new Map(Object.entries(copyCharacters(before) ?? {}));
    if (!isObject(reply)) {
        dropped.push({ field: 'characters', reason: 'wrong-type' });
        return copyCharacters(before);
    }

    const cast = new Map();
    const seen = new Set();
    for (const [written, entry] of Object.entries(reply)) {
        const name = [...stored.keys()].find((known) => fold(known) === fold(written)) ?? written;
        if (seen.has(fold(name))) {
            dropped.push({ field: 'characters', reason: 'duplicate-key' });
            continue;
        }
        seen.add(fold(name));

        // `null` used to mean "remove"; leaving them out now says the same thing.
        if (entry === null) continue;
        if (!stored.has(name) && !validName(name)) {
            dropped.push({ field: 'characters', reason: 'bad-name' });
            continue;
        }
        // Every path below adds to the cast, so the cap is checked once, before them all.
        if (cast.size >= MAX_CHARACTERS) {
            dropped.push({ field: 'characters', reason: 'too-many' });
            continue;
        }
        if (!isObject(entry)) {
            dropped.push({ field: 'characters', reason: 'wrong-type' });
            if (stored.has(name)) cast.set(name, { ...stored.get(name) });
            continue;
        }
        const keys = foldKeys(entry, Object.keys(CHARACTER_FIELDS), 'characters.', dropped);
        cast.set(name, mergeTexts(stored.get(name) ?? {}, keys, CHARACTER_FIELDS, 'characters.', dropped));
    }

    if (!cast.size) {
        if (stored.size) dropped.push({ field: 'characters', reason: 'empty' });
        return copyCharacters(before);
    }

    // Everyone still here keeps their place, so an unchanged cast renders the same bytes.
    const order = [...stored.keys()].filter((name) => cast.has(name))
        .concat([...cast.keys()].filter((name) => !stored.has(name)));
    return Object.fromEntries(order.map((name) => [name, cast.get(name)]));
}

function copyCharacters(characters) {
    const entries = Object.entries(characters ?? {});
    return entries.length ? Object.fromEntries(entries.map(([name, fields]) => [name, { ...fields }])) : undefined;
}

/** Nothing here can stop applying, so a blank is a reply that lost a field, not a field that ended. */
function readText(entry, cap) {
    if (entry === null || (typeof entry === 'string' && entry.trim() === '')) return { ok: false, reason: 'blank' };
    if (typeof entry !== 'string') return { ok: false, reason: 'wrong-type' };
    if (entry.length > cap) return { ok: false, reason: 'too-long' };
    return { ok: true, text: entry };
}

function changedKinds(before, after) {
    const kinds = new Set(Object.keys(TEXT_FIELDS).filter((field) => before[field] !== after[field]));

    const was = before.characters ?? {};
    const now = after.characters ?? {};
    for (const [name, fields] of Object.entries(now)) {
        if (!Object.hasOwn(was, name)) {
            kinds.add('characters.arrived');
            continue;
        }
        for (const field of Object.keys(CHARACTER_FIELDS)) {
            if (was[name][field] !== fields[field]) kinds.add(`characters.${field}`);
        }
    }
    if (Object.keys(was).some((name) => !Object.hasOwn(now, name))) kinds.add('characters.left');
    return CHANGE_KINDS.filter((kind) => kinds.has(kind));
}

function validCharacters(characters) {
    if (!isObject(characters)) return false;
    const entries = Object.entries(characters);
    return entries.length > 0 && entries.length <= MAX_CHARACTERS
        && entries.every(([name, fields]) => validName(name) && isObject(fields)
            && Object.entries(fields).every(([field, text]) => Object.hasOwn(CHARACTER_FIELDS, field)
                && validText(text, CHARACTER_FIELDS[field])));
}

/**
 * An integer-like name would enumerate ahead of older characters and break append
 * order, and `__proto__` is not a key to hand to later code as a property name.
 */
function validName(name) {
    return typeof name === 'string' && name.trim() !== '' && name.length <= MAX_NAME_CHARS
        && !/^\d+$/.test(name.trim()) && name !== '__proto__';
}

function validText(text, cap) {
    return typeof text === 'string' && text.trim() !== '' && text.length <= cap;
}

function fold(name) {
    return name.trim().toLowerCase();
}

function oneLine(text) {
    return text.replace(/\s+/g, ' ').trim();
}

function isObject(value) {
    return typeof value === 'object' && value !== null && !Array.isArray(value);
}
