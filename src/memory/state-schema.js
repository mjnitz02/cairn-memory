/**
 * Tier 1's shape: the fields and their caps, merging a patch into a state, and
 * rendering a state into the prompt (docs/p3-plan.md decisions 4-5, §2).
 *
 * The fields are the hard facts a card's description fixes and the story later
 * changes: where the scene is, who is in it, their hair and outfit. Mood, time and
 * plot stay with the roleplay model, so the memory model never steers the story.
 *
 * The caps bound the rendered state by construction. `applyPatch` only produces
 * values `validState` accepts, `renderState` renders nothing else, and the widest
 * valid state renders to MAX_STATE_CHARS. Nothing is clamped: a value over its cap
 * is dropped, so what is stored is what the model wrote or nothing.
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
 * Merge a JSON Merge Patch (RFC 7386) into a state. A changed field takes the new
 * value, `null` or a blank string clears it, and `null` for a character removes
 * them. Key names match case-insensitively, and so do
 * character names, keeping the stored spelling.
 *
 * A field that breaks the schema is dropped and the rest applies. `changed` is
 * worked out from the state before and after, so a patch repeating current values
 * records nothing (CLAUDE.md §4.18).
 *
 * @param {object} current A state `validState` accepts; `{}` on a cold start.
 * @param {object} patch The parsed reply.
 * @returns {{value: object, changed: string[], dropped: Array<{field: string, reason: string}>}}
 */
export function applyPatch(current, patch) {
    if (!validState(current)) throw new TypeError('applyPatch needs a valid current state');
    if (!isObject(patch)) throw new TypeError('A state patch must be an object');

    const dropped = [];
    const keys = foldKeys(patch, STATE_KEYS, '', dropped);
    const value = mergeTexts(current, keys, TEXT_FIELDS, '', dropped);

    const characters = keys.has('characters')
        ? mergeCharacters(current.characters, keys.get('characters'), dropped)
        : copyCharacters(current.characters);
    if (characters) value.characters = characters;

    return { value, changed: changedKinds(current, value), dropped };
}

/**
 * Exactly the values `applyPatch` produces: known keys only, every text non-blank
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

/** Departures first, so one character can leave and another arrive in the same patch at the cap. */
function mergeCharacters(before, patch, dropped) {
    if (patch === null) return undefined;
    if (!isObject(patch)) {
        dropped.push({ field: 'characters', reason: 'wrong-type' });
        return copyCharacters(before);
    }

    const next = new Map(Object.entries(copyCharacters(before) ?? {}));
    const seen = new Set();
    const updates = [];
    for (const [written, entry] of Object.entries(patch)) {
        const name = [...next.keys()].find((stored) => fold(stored) === fold(written)) ?? written;
        if (seen.has(fold(name))) {
            dropped.push({ field: 'characters', reason: 'duplicate-key' });
        } else if (!next.has(name) && !validName(name)) {
            dropped.push({ field: 'characters', reason: 'bad-name' });
        } else if (entry === null) {
            next.delete(name);
        } else if (!isObject(entry)) {
            dropped.push({ field: 'characters', reason: 'wrong-type' });
        } else {
            updates.push([name, entry]);
        }
        seen.add(fold(name));
    }

    for (const [name, entry] of updates) {
        if (!next.has(name) && next.size >= MAX_CHARACTERS) {
            dropped.push({ field: 'characters', reason: 'too-many' });
            continue;
        }
        const keys = foldKeys(entry, Object.keys(CHARACTER_FIELDS), 'characters.', dropped);
        next.set(name, mergeTexts(next.get(name) ?? {}, keys, CHARACTER_FIELDS, 'characters.', dropped));
    }
    return next.size ? Object.fromEntries(next) : undefined;
}

function copyCharacters(characters) {
    const entries = Object.entries(characters ?? {});
    return entries.length ? Object.fromEntries(entries.map(([name, fields]) => [name, { ...fields }])) : undefined;
}

function readText(entry, cap) {
    if (entry === null || (typeof entry === 'string' && entry.trim() === '')) return { ok: true, text: undefined };
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
