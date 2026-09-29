/**
 * Reading the index out of the chat: which summaries still wait for a record, and
 * every record there is (docs/decisions.md D-0070, D-0071).
 *
 * Pure: plain data in, plain data out. The store's readers come in as arguments.
 */

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
 * @param {{limit?: number, through?: number}} [options] `through` is the newest index
 *        to consider; an adoption indexes the chat a step at a time.
 * @returns {Array<{index: number, text: string}>} Oldest first, at most `limit`.
 */
export function pendingIndex(chat, { readScene, readIndex }, { limit = Infinity, through = Infinity } = {}) {
    const waiting = [];

    (chat ?? []).forEach((message, index) => {
        if (waiting.length >= limit || index > through) return;
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
