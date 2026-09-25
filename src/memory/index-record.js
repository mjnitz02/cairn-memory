/**
 * The index record's shape: the four-way kind, the four slots, and their caps
 * (docs/decisions.md D-0070, D-0064).
 *
 * One record per summary, written beside it on the message it summarises, so it
 * branches, swipes and deletes for free. It is not a second summary: the summary is
 * prose for the roleplay model, and this is structure for the deriver. A summary can
 * only carry structure implicitly, and a short one has nowhere to put it — which is
 * why condensing them broke arcs (D-0039) and why the structure moved here instead.
 *
 * **The kind is a sort key, never a gate** (D-0070). A local label is not stable
 * under hindsight: a purchase is filler until it turns out to be where they settled.
 * So the deriver reads every record and may overrule the label. Nothing in this file
 * filters on it, and `KINDS` is ordered by rank only so a ranker has a prior to start
 * from.
 *
 * **What the caps buy, stated honestly.** The slots are clauses, not sentences, so a
 * filled record renders to ~68 characters — ~17 tokens, and 159 of them ~2,700, one
 * call (D-0070). That is the *expected* cost and not the ceiling: every slot at its cap
 * is 463 characters, ~116 tokens. The caps stop a pathological record; they do not make
 * the ~20-token claim true on their own. `renderRecord` is what lets the real number be
 * measured rather than assumed, and measuring it is stage 0's check — the last
 * unmeasured number in docs/p5-plan.md.
 *
 * Pure: plain data in, new plain data out. Inputs are never mutated.
 */

/**
 * The four kinds of thing roleplay prose is made of (D-0064), in rank order.
 * Kinds 1 and 2 keep the story on the rails; 3 and 4 are most of the volume.
 */
export const KINDS = Object.freeze(['cast', 'major', 'description', 'filler']);

/** What each kind means, one line each. The prompt renders these, so they are the shape. */
export const KIND_MEANINGS = Object.freeze({
    cast: 'someone entered the story or permanently left it',
    major: 'something large happened: an escape, a rescue, something accomplished, lost or destroyed',
    description: 'surroundings, a journey, what was seen — the tone rather than a durable fact',
    filler: 'a small conversation, an errand, the glue between arcs',
});

/**
 * The kind an unreadable one becomes. The least privileged of the four on purpose: a
 * record whose label we could not read keeps its slots and loses only its prior, which
 * the deriver may overrule anyway. Dropping the record instead would lose the content,
 * and the content is the part that cannot be recovered.
 */
export const DEFAULT_KIND = 'filler';

/** Names the record is about. Canon's entity caps, deliberately — the same people. */
export const MAX_WHO = 4;
export const MAX_WHO_CHARS = 32;

/**
 * A slot over its cap is dropped, not cut, as a state value and a canon fact are
 * (docs/decisions.md D-0053). 100 characters is about twice what a clause distilled
 * from a real summary needs, measured over the corpus by length alone (CLAUDE.md §3.13).
 */
export const MAX_SLOT_CHARS = 100;

/** The slots, in render order. `what` is required; the other two are usually empty. */
export const SLOTS = Object.freeze(['what', 'changed', 'because']);

/** The column header the rendered index carries once, so each record can be pure content. */
export const INDEX_HEADER = 'n | kind | who | what | changed | because';

const FIELD_SEPARATOR = ' | ';

/**
 * Exactly what `normaliseRecord` produces: a known kind, `who` within its caps, a
 * non-empty `what`, and `changed` / `because` present as strings even when empty.
 *
 * @param {unknown} value
 */
export function validRecord(value) {
    if (!isObject(value)) return false;
    if (!KINDS.includes(value.kind)) return false;
    if (!Array.isArray(value.who) || value.who.length > MAX_WHO) return false;
    if (!value.who.every((name) => typeof name === 'string' && name !== '' && name.length <= MAX_WHO_CHARS)) {
        return false;
    }
    if (typeof value.what !== 'string' || value.what === '' || value.what.length > MAX_SLOT_CHARS) return false;
    return ['changed', 'because'].every((slot) =>
        typeof value[slot] === 'string' && value[slot].length <= MAX_SLOT_CHARS);
}

/**
 * Read one record out of a reply, or reject it. Nothing is clamped: a slot past its
 * cap is dropped and every drop is counted, so what the panel reports is the applied
 * change and not the model's claim (CLAUDE.md §4.18).
 *
 * A record with no `what` is nothing at all and is rejected. Everything else degrades
 * to a thinner record rather than to none: an unreadable kind becomes `filler`, an
 * over-long `changed` becomes empty, a fifth name is left off.
 *
 * @param {unknown} raw
 * @returns {{record: object|null, dropped: Array<{slot: string, reason: string}>}}
 */
export function normaliseRecord(raw) {
    const dropped = [];
    if (!isObject(raw)) return { record: null, dropped: [{ slot: 'record', reason: 'not-a-record' }] };

    const what = text(raw.what);
    if (!what) return { record: null, dropped: [{ slot: 'what', reason: 'no-what' }] };
    if (what.length > MAX_SLOT_CHARS) return { record: null, dropped: [{ slot: 'what', reason: 'too-long' }] };

    let kind = typeof raw.kind === 'string' ? raw.kind.trim().toLowerCase() : '';
    if (!KINDS.includes(kind)) {
        dropped.push({ slot: 'kind', reason: kind ? 'unknown-kind' : 'no-kind' });
        kind = DEFAULT_KIND;
    }

    const who = [];
    for (const name of Array.isArray(raw.who) ? raw.who : []) {
        const trimmed = text(name);
        if (!trimmed) dropped.push({ slot: 'who', reason: 'blank-name' });
        else if (trimmed.length > MAX_WHO_CHARS) dropped.push({ slot: 'who', reason: 'name-too-long' });
        else if (who.length >= MAX_WHO) dropped.push({ slot: 'who', reason: 'too-many-names' });
        else if (!who.includes(trimmed)) who.push(trimmed);
    }
    if (raw.who !== undefined && raw.who !== null && !Array.isArray(raw.who)) {
        dropped.push({ slot: 'who', reason: 'not-a-list' });
    }

    const record = { kind, who, what, changed: '', because: '' };
    for (const slot of ['changed', 'because']) {
        const value = text(raw[slot]);
        if (value.length > MAX_SLOT_CHARS) dropped.push({ slot, reason: 'too-long' });
        else record[slot] = value;
    }

    return { record, dropped };
}

/** Where a kind ranks, for a sort that starts from the prior. Unknown kinds rank last. */
export function kindRank(kind) {
    const rank = KINDS.indexOf(kind);
    return rank < 0 ? KINDS.length : rank;
}

/**
 * One record as the deriver reads it: fixed columns, no labels. The labels would cost
 * more than the slots they name once there are 159 of them, so `INDEX_HEADER` says what
 * the columns are once and each line is content.
 *
 * @param {object} record A record `validRecord` accepts.
 * @param {number} n The record's 1-based position in the rendered index.
 */
export function renderRecord(record, n) {
    return [
        String(n),
        record.kind,
        record.who.join(', '),
        record.what,
        record.changed,
        record.because,
    ].join(FIELD_SEPARATOR);
}

/**
 * The whole index, header first, numbered from 1. This is the deriver's entire input
 * — the story at a fifth of the tokens with the structure made explicit (D-0070).
 *
 * @param {Array<object>} records Records `validRecord` accepts, oldest first.
 */
export function renderIndex(records) {
    if (!records?.length) return '';
    return [INDEX_HEADER, ...records.map((record, i) => renderRecord(record, i + 1))].join('\n');
}

function text(value) {
    return typeof value === 'string' ? value.trim() : '';
}

function isObject(value) {
    return typeof value === 'object' && value !== null && !Array.isArray(value);
}
