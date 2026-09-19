/**
 * Tier 2 — canon: the facts promoted out of summaries before a rebuild drops them
 * (DESIGN.md §8, docs/p4-plan.md decision 1).
 *
 * Nothing is stored about which batch is current. The canon set is a scan and a
 * fold over the chat, oldest first, read fresh every turn, so branches, swipes and
 * deletions roll back with no code — the same shape the state tier uses
 * (docs/decisions.md D-0045), and the reason DESIGN.md §9's `chatMetadata` checkpoint
 * is not built.
 *
 * A fact is not hashed against anything (plan decision 2). A scene and a state cache
 * text and go stale when it is edited; a fact says something *happened*, and editing
 * the message afterwards does not unmake it. The cost, stated plainly: a wrong fact is
 * permanent for that branch, and P4 gives no lever to remove one.
 *
 * Pure: plain data in, plain data out. No ST, no DOM, no network.
 */
import { readCanon } from '../store/chat-store.js';

/** The most facts one pass may promote. Small on purpose: passes are frequent. */
export const MAX_FACTS_PER_PASS = 8;

/** A fact over this is dropped, not cut, as a state value is (docs/decisions.md D-0053). */
export const MAX_FACT_CHARS = 160;

/** Tags on a fact, stored and unread in P4 (store/chat-store.js). */
export const MAX_ENTITIES = 4;
export const MAX_ENTITY_CHARS = 32;

/**
 * What a fact costs before any has been written, used only to say how many a cold
 * first pass may ask for. The plan's own arithmetic — a 720-token canon holding
 * about 45 one-liners (docs/p4-plan.md §1). Once a chat has facts their real cost is
 * measured instead, so this binds on the first pass and never again.
 */
export const COLD_FACT_TOKENS = 16;

/**
 * Every canon fact in the chat, oldest first, with repeats folded out.
 *
 * The dedup here is a safety net, not the count that gets reported: a pass refuses a
 * repeat before writing it (`newFacts`). Doing it again on read makes the fold
 * idempotent, so a duplicate an older build wrote still renders once.
 *
 * @param {Array<object>} chat The live chat. Read only.
 * @returns {{facts: Array<{text: string, entities: string[], index: number}>,
 *            batches: number, coveredThrough: number|null}}
 *          `coveredThrough` is the newest summary any batch has read — what says
 *          whether a pass has already answered for a range (plan decision 6).
 */
export function canonFor(chat) {
    const list = chat ?? [];
    const facts = [];
    const seen = new Set();
    let batches = 0;
    let coveredThrough = null;

    for (let index = 0; index < list.length; index++) {
        const { status, canon } = readCanon(list[index]);
        if (status !== 'valid') continue;

        batches++;
        coveredThrough = coveredThrough === null
            ? canon.covers[1]
            : Math.max(coveredThrough, canon.covers[1]);
        for (const fact of canon.facts) {
            const key = normaliseFact(fact.text);
            if (seen.has(key)) continue;
            seen.add(key);
            facts.push({ text: fact.text, entities: [...fact.entities], index });
        }
    }

    return { facts, batches, coveredThrough };
}

/**
 * How much room canon has left, and how many more facts that is.
 *
 * The fact count is an estimate from what the facts in hand actually cost, the way
 * the assembler sizes candidate summaries from this turn's own block: a ratio from
 * the text in hand, never one carried over.
 *
 * @param {{facts: Array<object>, cap: number, tokensOf: (facts: Array<object>) => number}} input
 *        `tokensOf` sizes a fact list; called once.
 * @returns {{tokens: number, cap: number, spare: number, facts: number, full: boolean}}
 *          `full` means no further fact fits, so no pass is made at all (plan decision 6).
 */
export function canonRoom({ facts = [], cap = 0, tokensOf }) {
    const limit = Math.max(0, Math.floor(cap));
    const tokens = facts.length ? Math.max(0, Math.ceil(tokensOf(facts))) : 0;
    const spare = Math.max(0, limit - tokens);
    const perFact = facts.length ? Math.max(1, Math.ceil(tokens / facts.length)) : COLD_FACT_TOKENS;
    const room = Math.floor(spare / perFact);

    return { tokens, cap: limit, spare, facts: Math.min(room, MAX_FACTS_PER_PASS), full: room < 1 };
}

/**
 * The facts that fit the cap: the longest run from the oldest, and nothing after it.
 *
 * Canon renders at the block's head, so the cheap end to drop from is the newest —
 * the bytes above a dropped fact keep their offsets. It is also the honest order:
 * the oldest facts are the ones whose summaries are longest gone, and so the ones
 * nothing else in the prompt still speaks for.
 *
 * This only binds when the cap *falls* — a heavier run of messages narrowing the
 * block (docs/decisions.md D-0052) — because a pass never promotes past the cap in the
 * first place. The caller admits on a rebuild turn only, so the dropped tail costs
 * the head-change that turn was already paying (plan decision 3).
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
 * The facts in `promoted` that canon does not already hold, in order, with repeats
 * inside the batch itself folded out too.
 *
 * @param {Array<{text: string, entities?: string[]}>} promoted
 * @param {Array<{text: string}>} existing The fold, from `canonFor`.
 * @returns {{facts: Array<{text: string, entities: string[]}>, duplicates: number}}
 */
export function newFacts(promoted, existing = []) {
    const seen = new Set(existing.map((fact) => normaliseFact(fact.text)));
    const facts = [];
    let duplicates = 0;

    for (const fact of promoted ?? []) {
        const key = normaliseFact(fact?.text);
        if (!key || seen.has(key)) {
            duplicates++;
            continue;
        }
        seen.add(key);
        facts.push({ text: fact.text, entities: [...(fact.entities ?? [])] });
    }

    return { facts, duplicates };
}

/**
 * What counts as the same fact: case, surrounding punctuation and runs of
 * whitespace are noise, because the model rephrases the same promotion across
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
