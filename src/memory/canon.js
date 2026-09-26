/**
 * Tier 2 — canon: the spine of the story, picked out of the index that every summary
 * carries (DESIGN.md §8, docs/decisions.md D-0071).
 *
 * **Canon is a pick, not a bag.** Until P5 it was an append-only set of facts promoted
 * out of the summaries an eviction was about to drop, and it could neither be corrected
 * nor re-ranked (D-0055). It is now a fixed number of *slots* filled by one pass over
 * the whole index, so the newest pick replaces the last one and a wrong fact stops being
 * permanent. What survives from P4 is the storage, the dedup and the caps.
 *
 * **A fact cites the records it came from, and lives only while one of them does.**
 * That is what makes canon derivable rather than remembered: delete the record, fix the
 * summary, branch away from the scene, and the fact goes with it, with no rollback code
 * — the same shape as the state tier and the old fold (D-0045). A fact whose every
 * source is gone is dropped on read and counted, and the count is what says a
 * re-derivation is due (pipeline/compactor.js `pendingPick`).
 *
 * The fold reads **one** batch: the newest at or before `through`. The whole point of a
 * pick is that it supersedes, so a union over batches would be the bag again, and an
 * older batch would go on asserting what the newer one deliberately left out.
 *
 * Pure: plain data in, plain data out, and **the store's readers come in as arguments**
 * as they do for `pendingIndex` (pipeline/compactor.js §1.3). Importing them would make
 * this module part of a cycle — `store/schema.js` holds the default slot count's home in
 * `DEFAULT_SETTINGS`, and `store/chat-store.js` reads that schema — and a cycle that only
 * shows up outside the test runner is the worst kind.
 */

/**
 * How many slots a pick fills by default. Kinds 1 and 2 are necessarily rare
 * (D-0064), so the spine does not grow with the chat: the run's 85 real summaries
 * carry five lines, and a 300-message chat wants eight to twelve, not thirty.
 */
export const DEFAULT_SLOTS = 10;

/**
 * The most slots a pick may be asked for. A ceiling on the *question*, not on the
 * block: `canonCap` still decides what fits, and leftover tokens fall to summaries.
 */
export const MAX_SLOTS = 16;

/** The fewest. One slot is a legitimate setting; zero means canon is off, which is `keepCanon`. */
export const MIN_SLOTS = 1;

/** A fact's soft cap, the one the prompt states; past `HARD_FACT_CHARS` it is cut (D-0085). */
export const MAX_FACT_CHARS = 160;

/**
 * The most index records one fact may cite. A line like "he destroyed an army to buy
 * her contract, and she keeps it as proof" is genuinely two records; past three it is a
 * summary of the story rather than a fact in it.
 */
export const MAX_SOURCES = 3;

/** Tags on a fact, stored and unread (store/chat-store.js). */
export const MAX_ENTITIES = 4;
export const MAX_ENTITY_CHARS = 32;

/**
 * The canon in force, resolved against the records it was picked from.
 *
 * @param {Array<object>} chat The live chat. Read only.
 * @param {{readCanon: (message: object) => {status: string, canon: object|null},
 *          readIndex: (message: object) => {status: string}}} readers
 *        The store's readers (store/chat-store.js).
 * @param {{through?: number}} [options] The newest message whose batch may be read.
 *        The assembler passes the mark it last admitted at, so a pick written between
 *        rebuilds does not change the block until one (docs/decisions.md D-0059, D-0067).
 * @returns {{facts: Array<{text: string, entities: string[], from: number[], index: number}>,
 *            index: number|null, slots: number|null, covers: number[]|null,
 *            coveredThrough: number|null, batches: number, dropped: number}}
 *          `index` is the message the batch lives on; `dropped` counts facts whose
 *          every cited record is gone, which is what makes a re-derivation due.
 */
export function canonFor(chat, { readCanon, readIndex }, { through = Infinity } = {}) {
    const list = chat ?? [];
    let batches = 0;
    let newest = null;
    let at = null;

    for (let index = 0; index < list.length; index++) {
        const { status, canon } = readCanon(list[index]);
        if (status !== 'valid') continue;
        batches++;
        if (index <= through) {
            newest = canon;
            at = index;
        }
    }

    if (!newest) {
        return {
            facts: [], index: null, slots: null, covers: null, coveredThrough: null, batches, dropped: 0,
        };
    }

    const facts = [];
    const seen = new Set();
    let dropped = 0;

    for (const fact of newest.facts) {
        const from = (fact.from ?? []).filter((source) => Number.isInteger(source));
        // No citation is an older batch, from before a fact cited anything. There is
        // nothing to check it against, so it is kept: degrading to a guess would be
        // worse than degrading to what is written (D-0074).
        if (from.length && !from.some((source) => readIndex(list[source]).status === 'valid')) {
            dropped++;
            continue;
        }
        const key = normaliseFact(fact.text);
        if (seen.has(key)) continue;
        seen.add(key);
        facts.push({ text: fact.text, entities: [...fact.entities], from, index: at });
    }

    return {
        facts,
        index: at,
        slots: Number.isInteger(newest.slots) ? newest.slots : null,
        covers: [...newest.covers],
        coveredThrough: newest.covers[1],
        batches,
        dropped,
    };
}

/**
 * The facts that fit the cap: the longest run from the oldest, and nothing after it.
 *
 * Canon renders at the block's head, so the cheap end to drop from is the newest —
 * the bytes above a dropped fact keep their offsets. It is also the honest order:
 * the oldest facts are the ones whose summaries are longest gone, and so the ones
 * nothing else in the prompt still speaks for.
 *
 * With a pick this binds more often than it did with a bag: the slot count is the
 * question's size and the cap is the block's, and only the cap knows how heavy the
 * run of messages under it has become (docs/decisions.md D-0052). The caller admits
 * on a rebuild turn only, so a dropped tail costs the head-change that turn was
 * already paying (D-0067).
 *
 * @param {{facts: Array<object>, cap: number, tokensOf: (facts: Array<object>) => number}} input
 * @returns {{facts: Array<object>, tokens: number, dropped: number}}
 */
export function admitCanon({ facts = [], cap = 0, tokensOf }) {
    const limit = Math.max(0, Math.floor(cap));
    let kept = facts;
    let tokens = kept.length ? Math.max(0, Math.ceil(tokensOf(kept))) : 0;

    while (kept.length && tokens > limit) {
        kept = kept.slice(0, -1);
        tokens = kept.length ? Math.max(0, Math.ceil(tokensOf(kept))) : 0;
    }

    return { facts: kept, tokens, dropped: facts.length - kept.length };
}

/**
 * The distinct facts in a pick, in order, with repeats folded out.
 *
 * A pick replaces rather than appends, so `existing` is normally empty and this is
 * guarding one reply against saying the same thing twice in two slots — which a forced
 * budget makes more likely, not less: a model given ten slots and eight facts will pad.
 *
 * @param {Array<{text: string, entities?: string[], from?: number[]}>} picked
 * @param {Array<{text: string}>} [existing]
 * @returns {{facts: Array<{text: string, entities: string[], from: number[]}>, duplicates: number}}
 */
export function newFacts(picked, existing = []) {
    const seen = new Set(existing.map((fact) => normaliseFact(fact.text)));
    const facts = [];
    let duplicates = 0;

    for (const fact of picked ?? []) {
        const key = normaliseFact(fact?.text);
        if (!key || seen.has(key)) {
            duplicates++;
            continue;
        }
        seen.add(key);
        facts.push({
            text: fact.text,
            entities: [...(fact.entities ?? [])],
            from: [...(fact.from ?? [])],
        });
    }

    return { facts, duplicates };
}

/**
 * What counts as the same fact: case, surrounding punctuation and runs of
 * whitespace are noise, because the model rephrases the same fact across
 * passes rather than repeating it verbatim.
 *
 * @param {unknown} text
 * @returns {string} Empty when there is nothing to compare.
 */
export function normaliseFact(text) {
    if (typeof text !== 'string') return '';
    return text
        .toLowerCase()
        .replace(/[‘’]/g, '\'')
        .replace(/[^\p{L}\p{N}'\s]+/gu, ' ')
        .replace(/\s+/g, ' ')
        .trim();
}

/** The slot count a setting asks for, clamped to what a pick may be asked. */
export function slotsFor(setting) {
    const value = Number.isFinite(setting) ? Math.floor(setting) : DEFAULT_SLOTS;
    return Math.min(MAX_SLOTS, Math.max(MIN_SLOTS, value));
}
