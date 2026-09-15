/**
 * Where each injection landed in the finished prompt, and which block owns the
 * byte where the prefix broke.
 *
 * The stability meter reports that two prompts diverged at character N. On its
 * own that is a number. What tuning needs is the *name* of the block N fell
 * inside — "the break was 0 chars into qvink_memory_short" is the finding;
 * "the break was at 7,687" is a lead (DESIGN.md §10).
 *
 * Pure string search, no tokenizer, no ST. Matching is best-effort by
 * construction: ST trims each value and runs substituteParams over the joined
 * result (public/script.js:3326), so a value carrying macros — `{{outlet::x}}`
 * above all — is not in the prompt verbatim. Every result records how it was
 * matched. A probe match is a lead, not a fact, and callers must not round it
 * up to one.
 */

/** Below this, a macro-free head is too generic to identify a block. */
const MIN_PROBE = 24;

const UNLOCATED = Object.freeze({
    offset: null,
    endOffset: null,
    offsetPercent: null,
    match: 'none',
    ambiguous: false,
});

/**
 * Locate every inventory entry in the flattened prompt.
 *
 * Takes the texts separately rather than carrying them on the inventory, so the
 * prompt body never ends up retained in a snapshot or written to the log.
 *
 * @param {string} flat The flattened prompt, as the stability meter sees it.
 * @param {Array<{key: string}>} inventory From buildInventory().
 * @param {Record<string, string>} [texts] Raw injection values, keyed as in ST's bag.
 * @param {{minProbe?: number}} [options]
 * @returns {Array<object>} Copies of the entries, each with placement fields added.
 */
export function locateInjections(flat, inventory, texts = {}, { minProbe = MIN_PROBE } = {}) {
    const prompt = String(flat ?? '');

    return (inventory ?? []).map((entry) => ({
        ...entry,
        ...locateOne(prompt, texts?.[entry.key], minProbe),
    }));
}

/**
 * Name the block containing a character offset — the divergence index, usually.
 *
 * `precision` is the honest part of the answer:
 *   `inside` — the offset falls within a block matched exactly. Trust it.
 *   `after`  — it falls past the end of one block and before the next starts,
 *              so it is in whatever ST placed between them.
 *   `probe`  — the block was only matched on its macro-free head, so its extent
 *              is unknown and this is the nearest block that starts before the
 *              offset.
 *   `none`   — nothing we can see starts at or before it: the offset is above
 *              every injection, in the card, persona or story string body.
 *
 * @param {number} offset
 * @param {Array<object>} located From locateInjections().
 * @returns {object|null} null when there is no offset to attribute.
 */
export function attributeOffset(offset, located) {
    if (!Number.isFinite(offset)) return null;

    const candidates = (located ?? [])
        .filter((entry) => Number.isFinite(entry.offset) && entry.offset <= offset)
        .sort((a, b) => a.offset - b.offset);

    const entry = candidates[candidates.length - 1];
    if (!entry) {
        return {
            key: null,
            owner: null,
            label: 'above every injection',
            offsetInEntry: null,
            precision: 'none',
        };
    }

    const precision = entry.match === 'probe'
        ? 'probe'
        : (Number.isFinite(entry.endOffset) && offset < entry.endOffset ? 'inside' : 'after');

    return {
        key: entry.key,
        owner: entry.owner ?? null,
        label: entry.label ?? entry.key,
        offsetInEntry: offset - entry.offset,
        precision,
    };
}

function locateOne(prompt, raw, minProbe) {
    // ST trims each value before joining (public/script.js:3320), so the trimmed
    // form is what actually reaches the prompt.
    const text = String(raw ?? '').trim();
    if (!text || !prompt) return { ...UNLOCATED };

    const exact = prompt.indexOf(text);
    if (exact !== -1) {
        return placement(prompt, exact, exact + text.length, 'exact', prompt.indexOf(text, exact + 1) !== -1);
    }

    // Macros are substituted after the value is parked, so everything from the
    // first `{{` on may not survive. Search on the literal head instead, and
    // leave the extent unknown rather than guessing it from the pre-macro length.
    const macroAt = text.indexOf('{{');
    const probe = (macroAt === -1 ? text : text.slice(0, macroAt)).trim();
    if (probe.length < minProbe) return { ...UNLOCATED };

    const at = prompt.indexOf(probe);
    if (at === -1) return { ...UNLOCATED };

    return placement(prompt, at, null, 'probe', prompt.indexOf(probe, at + 1) !== -1);
}

function placement(prompt, offset, endOffset, match, ambiguous) {
    return {
        offset,
        endOffset,
        offsetPercent: prompt.length ? round1((offset / prompt.length) * 100) : null,
        match,
        ambiguous,
    };
}

function round1(value) {
    return Math.round(value * 10) / 10;
}
