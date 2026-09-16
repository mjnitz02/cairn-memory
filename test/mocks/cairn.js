/**
 * Chats as P2 leaves them: qvink's summaries up to some message, Cairn's after it.
 *
 * The message envelopes come from `makeQvinkChat`, whose shape is checked against
 * the corpus. The `extra.cairn` stores are written out here by hand, never by
 * src/store/chat-store.js, so the reader is tested against the shape in
 * docs/decisions.md D-0037 rather than against whatever the writer happens to emit.
 * The v1 literal lives in test/fixtures/store-v1.js.
 */
import { hashString } from '../../src/util/hash.js';
import { makeQvinkChat, makeSummary, QVINK_KEY } from './qvink.js';

/** A v1 store for a message, valid against its `mes` as it is now. */
export function cairnStore(message, text, { prompt = 'h:00000000000001', at = '2026-09-16T12:00:00.000Z' } = {}) {
    return { v: 1, scene: { text, hash: hashString(message.mes), prompt, at } };
}

/** A Cairn summary, distinguishable from a qvink one by eye and by prefix. */
export function cairnSummary(index, chars = 353) {
    return `Cairn ${makeSummary(index, chars)}`.slice(0, chars);
}

/**
 * @param {object} options
 * @param {number} options.length
 * @param {number} options.qvinkThrough Newest message qvink summarised; -1 for none.
 * @param {number} options.cairnThrough Newest message Cairn summarised.
 * @param {number[]} [options.gaps] Messages in Cairn's range left unsummarised.
 * @param {number[]} [options.short] Messages cut under the summary threshold (and so unsummarised).
 * @param {number[]} [options.hidden] Messages hidden by the user (and so unsummarised).
 */
export function makeMixedChat({ length, qvinkThrough, cairnThrough, gaps = [], short = [], hidden = [] }) {
    const chat = makeQvinkChat({ length, summarisedThrough: length - 11 });

    chat.forEach((message, index) => {
        if (short.includes(index)) message.mes = message.mes.slice(0, 120);
        if (hidden.includes(index)) message.is_system = true;
        if (index <= qvinkThrough) return;

        // Past its newest summary qvink still keeps its flags current, with no
        // `memory` key — the two-key shape the corpus shows on the last message.
        message.extra[QVINK_KEY] = { include: null, lagging: index > length - 11 };

        const skipped = gaps.includes(index) || short.includes(index) || hidden.includes(index);
        if (index <= cairnThrough && !skipped) {
            message.extra.cairn = cairnStore(message, cairnSummary(index));
        }
    });

    return chat;
}
