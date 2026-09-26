/**
 * The derive cadence — when a canon pick is due, what it reads, and what its reply
 * becomes; and which summaries are still waiting for an index record
 * (docs/decisions.md D-0071, D-0070).
 *
 * **The eviction trigger is gone.** Until P5 a pass fired one step before the rebuild
 * that would drop its summaries, read exactly that evict-set, and promoted out of it.
 * Every part of that was wrong for the job: eviction from the *prompt* says nothing
 * about availability on *disk* (`readScenes` always returned the whole chat), and a
 * window sampled by recency is almost entirely description and filler, so it cannot
 * rank what matters (D-0062, D-0064). The pressure test, the evict-set simulation and
 * the once-per-cycle `covers` test all went with it.
 *
 * What replaces them is the shape `pendingScenes` already uses for summaries: **work is
 * due when something is missing.** A summary with no record is indexing work; an index
 * with records the current pick never read is derivation work. Nothing is stored about
 * what has run, so a branch, a swipe, an edit or a resummarise needs no bookkeeping.
 *
 * Pure: plain data in, plain data out. No ST, no DOM, no network.
 */
import { newFacts } from '../memory/canon.js';

/**
 * Fewer records than this and there is no story to rank. Three is the same floor the
 * old evict-set used, for the same reason: the call is not worth making, and a spine
 * picked out of two scenes is those two scenes.
 */
export const MIN_INDEX_RECORDS = 3;

/**
 * Whether a canon pick is due, and what it would read.
 *
 * Four things make one due, and each is a statement about the *stored* pick rather
 * than about pressure:
 *
 *   `no-canon`     nothing has ever been picked in this chat.
 *   `new-records`  the index has grown past what the last pick read.
 *   `lost-facts`   a fact's records are gone — edited, resummarised or branched away
 *                  (memory/canon.js) — so the pick in force is missing a slot.
 *   `slots-changed` the user moved the slot count, so the question itself changed.
 *
 * All four terminate. A pick that comes back short is *answered*, not under-filled:
 * the batch records how many slots were asked for, so a story with four durable facts
 * and ten slots is not re-derived every turn forever.
 *
 * @param {{records: Array<{index: number}>, canon?: {coveredThrough: number|null,
 *          slots: number|null, dropped: number}, slots: number}} input
 *        `records` is every valid index record in the chat, oldest first;
 *        `canon` is the fold in force (`canonFor`).
 * @returns {{due: boolean, reason: string, records: Array<object>, covers: number[]|null,
 *            slots: number}} `reason` is a stable string the log and the inspector record.
 */
export function pendingPick({ records = [], canon = null, slots = 0 } = {}) {
    const refuse = (reason) => ({ due: false, reason, records: [], covers: null, slots });

    if (!(slots >= 1)) return refuse('no-slots');
    if (records.length < MIN_INDEX_RECORDS) return refuse('too-few');

    const covers = [records[0].index, records[records.length - 1].index];
    const reason = pickReason(canon, covers[1], slots);
    if (!reason) return refuse('covered');

    return { due: true, reason, records, covers, slots };
}

/** Why a pick is due, or null when the one in force still answers. */
function pickReason(canon, newest, slots) {
    if (!canon || canon.coveredThrough === null) return 'no-canon';
    if (newest > canon.coveredThrough) return 'new-records';
    if (canon.dropped > 0) return 'lost-facts';
    if (canon.slots !== null && canon.slots !== slots) return 'slots-changed';
    return null;
}

/**
 * What a reply becomes: the batch to store, and the counts to report.
 *
 * The counts are of the *applied* change, not the model's claimed output
 * (CLAUDE.md §4.18) — a repeat inside the pick is refused here and counted as refused,
 * and the caps the parser enforced are already counted in `dropped`.
 *
 * **The rows are mapped to chat indexes here**, because the caller is the only thing
 * that knows which records it sent and in what order. A fact whose every row falls
 * outside that list loses its grounding, so it is dropped rather than stored uncited:
 * an uncitable fact is a permanent one, which is what a pick exists not to be.
 *
 * @param {{picked: Array<object>, dropped?: Array<object>, records: Array<{index: number}>,
 *          covers: number[], slots: number, prompt: string, at: string}} input
 * @returns {{batch: {facts: Array<object>, covers: number[], slots: number,
 *            prompt: string, at: string}, picked: number, duplicates: number,
 *            dropped: number, uncited: number}}
 */
export function applyPick({ picked, dropped = [], records = [], covers, slots, prompt, at }) {
    const { facts, duplicates } = newFacts(picked);
    const kept = [];
    let uncited = 0;

    for (const fact of facts) {
        const from = fact.from
            .map((row) => records[row - 1]?.index)
            .filter((index) => Number.isInteger(index));
        if (!from.length) {
            uncited++;
            continue;
        }
        kept.push({ ...fact, from });
    }

    return {
        batch: { facts: kept, covers: [...covers], slots, prompt, at },
        picked: kept.length,
        duplicates,
        dropped: dropped.length,
        uncited,
    };
}

/**
 * The summaries still waiting for an index record, oldest first (docs/decisions.md
 * D-0071, D-0075).
 *
 * Work is due when a summary has no record — the same shape `pendingScenes` uses for
 * summaries, and for the same reason: nothing is stored about what has run, so a branch,
 * a swipe, an edit or a resummarise needs no bookkeeping. A record is hashed against its
 * summary (D-0074), so an invalidated summary invalidates its record and the work simply
 * reappears here.
 *
 * **No overlap between batches**, unlike the qvink-era selection pass that this batching
 * comes from. That pass judged which summaries mattered and needed its neighbours to do
 * it; this one extracts what each summary says and explicitly does not judge
 * (memory/index-strategy.js), and the compact line is a compression of one summary in
 * isolation. Context would cost tokens and buy nothing.
 *
 * @param {Array<object>} chat ST's live message array. Read only.
 * @param {{readScene: (message: object) => {status: string, scene: object|null},
 *          readIndex: (message: object) => {status: string}}} readers
 *        The store's readers, passed in so this file stays pure (store/chat-store.js).
 * @param {{limit?: number}} [options]
 * @returns {Array<{index: number, text: string}>} Oldest first, at most `limit`.
 */
export function pendingIndex(chat, { readScene, readIndex }, { limit = Infinity } = {}) {
    const waiting = [];

    (chat ?? []).forEach((message, index) => {
        if (waiting.length >= limit) return;
        const scene = readScene(message);
        if (scene.status !== 'valid') return;
        if (readIndex(message).status === 'valid') return;
        waiting.push({ index, text: scene.scene.text });
    });

    return waiting;
}

/**
 * Every valid index record in the chat, oldest first, with the message it sits on.
 *
 * This is the pick's whole input, and it is read from the *chat* rather than from the
 * block — which is the single sentence D-0062's three gaps reduce to. A chat whose
 * defining scenes were evicted from the prompt long ago still offers their records here.
 *
 * @param {Array<object>} chat ST's live message array. Read only.
 * @param {{readIndex: (message: object) => {status: string, index: object|null}}} readers
 * @returns {Array<{index: number, record: object}>} Oldest first.
 */
export function indexRecords(chat, { readIndex }) {
    const records = [];

    (chat ?? []).forEach((message, index) => {
        const found = readIndex(message);
        if (found.status === 'valid') records.push({ index, record: found.index.record });
    });

    return records;
}
