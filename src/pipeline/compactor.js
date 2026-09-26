/**
 * The *compaction* cadence — when a pass is due, what it reads, and what its reply
 * becomes (DESIGN.md §8, docs/p4-plan.md decision 6).
 *
 * A pass fires one step **before** the rebuild that drops its summaries, so it has a
 * whole see-saw step of wall-clock to finish and the block gets canon and the rebuild
 * in the same head-change (assembler, decision 3). Its input is exactly what that
 * rebuild will drop, simulated with the budgeter's own loop rather than guessed at.
 *
 * Nothing is stored about what has run. Pressure is read from the block and the
 * once-per-cycle test from the batches already in the chat, so branches, swipes and
 * reloads need no bookkeeping — the same reason the canon set is a fold
 * (memory/canon.js, docs/decisions.md D-0045).
 *
 * Pure: plain data in, plain data out. No ST, no DOM, no network.
 */
import { newFacts } from '../memory/canon.js';

/** Fewer than this and the call is not worth making (docs/p4-plan.md decision 6). */
export const MIN_EVICT_SET = 3;

/**
 * Whether a compaction pass is due, and what it would read.
 *
 * **Pressure** is one step ahead of the overflow: `sceneTokens + stepTokens > sceneCap`
 * means the step after this one cannot fit, so the rebuild is the next step.
 *
 * **The evict-set** is the budgeter's own drop-to-floor, run one step early. At the
 * rebuild the block will be a step heavier, so the loop here targets
 * `floor - stepTokens`: dropping to that now is dropping to the floor then, which is
 * what makes the two sets the same summaries rather than merely similar ones.
 *
 * **Once per cycle, without a flag:** a pass is due only when the evict-set's newest
 * summary is past the newest one any batch in the chat has already read. Pressure
 * holding for ten turns therefore yields one pass, not ten.
 *
 * @param {{scenes: Array<{index: number}>, coveredThrough: number|null,
 *          sceneCap: number, floor: number, stepTokens: number, room: number,
 *          tokensOf: (scenes: Array<object>) => number}} input
 *        `scenes` is the block as it stands, oldest first. `room` is how many facts
 *        canon has space for (memory/canon.js `canonRoom`).
 * @returns {{due: boolean, reason: string, evicting: Array<object>,
 *            covers: number[]|null, room: number}}
 *          `reason` is a stable string the log and the inspector record.
 */
export function pendingCompaction({
    scenes = [], coveredThrough = null, sceneCap = 0, floor = 0, stepTokens = 0, room = 0, tokensOf,
} = {}) {
    const refuse = (reason) => ({ due: false, reason, evicting: [], covers: null, room });

    // No room, no call: the block keeps the facts it has, and making room is P5's.
    if (!(room >= 1)) return refuse('canon-full');
    if (scenes.length < MIN_EVICT_SET) return refuse('too-few');
    if (!(sceneCap > 0)) return refuse('no-pressure');

    const tokens = tokensOf(scenes);
    if (tokens + stepTokens <= sceneCap) return refuse('no-pressure');

    // pipeline/budgeter.js `fit`, one step early. Never to nothing, for its reason.
    const target = floor - stepTokens;
    let kept = scenes;
    let size = tokens;
    while (kept.length > 1 && size > target) {
        kept = kept.slice(1);
        size = tokensOf(kept);
    }

    const evicting = scenes.slice(0, scenes.length - kept.length);
    if (evicting.length < MIN_EVICT_SET) return refuse('too-few');

    const covers = [evicting[0].index, evicting[evicting.length - 1].index];
    if (coveredThrough !== null && covers[1] <= coveredThrough) return refuse('already-covered');

    return { due: true, reason: 'ready', evicting, covers, room };
}

/**
 * What a reply becomes: the batch to store, and the counts to report.
 *
 * The counts are of the *applied* change, not the model's claimed output
 * (CLAUDE.md §4.18) — a repeat is refused here and counted as refused, and the caps
 * the parser enforced are already counted in `dropped`.
 *
 * @param {{promoted: Array<object>, dropped?: Array<object>, canon?: Array<{text: string}>,
 *          covers: number[], prompt: string, at: string}} input
 * @returns {{batch: {facts: Array<object>, covers: number[], prompt: string, at: string},
 *            promoted: number, duplicates: number, dropped: number}}
 */
export function applyPass({ promoted, dropped = [], canon = [], covers, prompt, at }) {
    const { facts, duplicates } = newFacts(promoted, canon);

    return {
        batch: { facts, covers: [...covers], prompt, at },
        promoted: facts.length,
        duplicates,
        dropped: dropped.length,
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
