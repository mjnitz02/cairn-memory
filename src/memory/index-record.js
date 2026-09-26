/**
 * The index record's shape: the four-way kind, the four slots, and their caps
 * (docs/decisions.md D-0070, D-0064).
 *
 * One record per summary, written beside it on the message it summarises, so it
 * branches, swipes and deletes for free. It carries two things for two readers, which
 * is why there is one record and not two artefacts (D-0076):
 *
 *   the **slots** — structure for the deriver, which needs 159 summaries comparable;
 *   the **`line`** — one sentence of prose for the block's compact tier, which needs
 *   distant history readable rather than comparable.
 *
 * `renderRecord` renders the slots and deliberately not the line: the deriver reads
 * ~6,100 tokens of index and a leaked line would add ~3,600 of prose it has no use for.
 * The block reads the line and never the slots, because `kind` and a column of names
 * are structure it cannot use. Condensing a *recent* summary still breaks its arc
 * (D-0039); the line is for summaries far enough back that the block holds nothing
 * today.
 *
 * **The kind is never a gate** (D-0070), and since 0d the deriver does not see it at
 * all (D-0084): a label a modest model can read, it obeys. It is still written, because
 * the log's kind spread is how a run shows whether the pass is discriminating.
 *
 * **What a record costs, measured.** 38.2 tokens mean over the 85 real summaries, median
 * 33, range 25 to 68 (docs/decisions.md D-0076) — not the ~17 D-0070 estimated. So 159
 * records is ~6,100 tokens, still the one call D-0070 wanted. Of those 38, the slots are
 * 29.4 and 10.5 is machinery: `kind`, the column of names, the separators. That split is
 * why the block's compact tier is a prose line and not this rendering (D-0075, D-0076) —
 * the block can use none of the machinery. The caps are a ceiling, not the cost: every
 * slot at its cap is 463 characters, ~116 tokens, and they exist to stop a pathological
 * record. `background` adds to that where it is filled, which the prompt asks for only
 * when the summary states something that was already true.
 *
 * Pure: plain data in, new plain data out. Inputs are never mutated.
 */

import { clip, hardCap } from '../util/clip.js';

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
 * A slot's **soft** cap: the number the prompt states. 100 characters is about twice
 * what a clause distilled from a real summary needs, measured over the corpus by length
 * alone (CLAUDE.md §3.13).
 */
export const MAX_SLOT_CHARS = 100;

/**
 * Where a slot is cut rather than kept (docs/decisions.md D-0085). Dropping an overshoot
 * instead lost DeepSeek up to half its records at 0d, because a `what` over its cap is
 * the whole record; at 150 the 0d replies lose one `what` in 1,335.
 */
export const HARD_SLOT_CHARS = hardCap(MAX_SLOT_CHARS);

/**
 * The slots, in render order. `what` is required; the other three are usually empty.
 *
 * `background` is the answer to stage 0c's one real loss (D-0076): the yardstick's first
 * fact — where these two grew up and what they promised each other — appears ten times
 * across the 85 real summaries and never once in their records, because it is always a
 * background clause and a 100-character `what` spends itself on the foreground event. The
 * pick can only ever see what the index carries, so a fifth of the spine was unreachable.
 */
export const SLOTS = Object.freeze(['what', 'changed', 'because', 'background']);

/**
 * The column header the rendered index carries once, so each record can be pure content.
 * **No `kind`**: a modest model treats a label it can see as a gate, and at 0d the
 * promise the story's first line rests on was labelled `filler` in 12 runs of 15 and
 * never picked (docs/decisions.md D-0084). The kind is still written, for the log.
 */
export const INDEX_HEADER = 'n | who | what | changed | because | background';

/**
 * The compact line's cap. Measured at 23.0 tokens mean over the 85 real summaries, range
 * 18–28 (D-0076), so 160 characters is about one and a half times what a real line needs
 * and a hard stop on a line that tried to be a paragraph.
 */
export const MAX_LINE_CHARS = 160;

/** The line's hard cap, as `HARD_SLOT_CHARS` is the slots' (D-0085). */
export const HARD_LINE_CHARS = hardCap(MAX_LINE_CHARS);

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
    if (typeof value.what !== 'string' || value.what === '' || value.what.length > HARD_SLOT_CHARS) return false;
    if (typeof value.line !== 'string' || value.line.length > HARD_LINE_CHARS) return false;
    return ['changed', 'because', 'background'].every((slot) =>
        typeof value[slot] === 'string' && value[slot].length <= HARD_SLOT_CHARS);
}

/**
 * Read one record out of a reply, or reject it. A slot past its hard cap is cut, and
 * every cut and every drop is counted, so what the panel reports is the applied change
 * and not the model's claim (CLAUDE.md §4.18).
 *
 * A record with no `what` is nothing at all and is rejected. Everything else degrades
 * to a thinner record rather than to none: an unreadable kind becomes `filler`, a fifth
 * name is left off.
 *
 * @param {unknown} raw
 * @returns {{record: object|null, dropped: Array<{slot: string, reason: string}>,
 *            clipped: string[]}} `clipped` names the slots that were cut.
 */
export function normaliseRecord(raw) {
    const dropped = [];
    const clipped = [];
    if (!isObject(raw)) return { record: null, dropped: [{ slot: 'record', reason: 'not-a-record' }], clipped };

    const cut = (slot, value, hard) => {
        const result = clip(value, hard);
        if (result.clipped) clipped.push(slot);
        return result.text;
    };

    const what = cut('what', text(raw.what), HARD_SLOT_CHARS);
    if (!what) return { record: null, dropped: [{ slot: 'what', reason: 'no-what' }], clipped };

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

    const record = { kind, who, what, changed: '', because: '', background: '', line: '' };
    for (const slot of ['changed', 'because', 'background']) {
        record[slot] = cut(slot, text(raw[slot]), HARD_SLOT_CHARS);
    }

    // A missing line costs the compact tier this one summary — it evicts as it did
    // before the tier existed (docs/decisions.md D-0075) — and costs the deriver nothing.
    record.line = cut('line', text(raw.line), HARD_LINE_CHARS);

    return { record, dropped, clipped };
}

/** Where a kind ranks, for a sort that starts from the prior. Unknown kinds rank last. */
export function kindRank(kind) {
    const rank = KINDS.indexOf(kind);
    return rank < 0 ? KINDS.length : rank;
}

/**
 * One record as the deriver reads it: fixed columns, no labels. The labels would cost
 * more than the slots they name once there are 159 of them, so `INDEX_HEADER` says what
 * the columns are once and each line is content. The kind is left out (`INDEX_HEADER`).
 *
 * @param {object} record A record `validRecord` accepts.
 * @param {number} n The record's 1-based position in the rendered index.
 */
export function renderRecord(record, n) {
    return [
        String(n),
        record.who.join(', '),
        record.what,
        record.changed,
        record.because,
        record.background ?? '',
    ].join(FIELD_SEPARATOR);
}

/**
 * The block's compact text for a summary, or null when there is none.
 *
 * Null is an ordinary answer, not an error: the tier falls back to evicting that summary
 * exactly as the block does today (D-0075), so a record written before the line existed,
 * or one whose line came back too long, costs the horizon one line and nothing else.
 *
 * @param {object|null} record
 */
export function compactLine(record) {
    const line = typeof record?.line === 'string' ? record.line.trim() : '';
    return line === '' ? null : line;
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
