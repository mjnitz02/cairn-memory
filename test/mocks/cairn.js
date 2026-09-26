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

/**
 * A v3 store carrying a canon batch, written out by hand (docs/p4-plan.md decision 1).
 * A plain string is a fact with no entities; the tags are stored and unread in P4.
 *
 * @param {Array<string|{text: string, entities?: string[]}>} facts
 * @param {number[]} covers The summaries the pass read, `[oldest, newest]`.
 */
export function cairnCanonStore(facts, covers, { prompt = 'h:00000000000003', at = '2026-09-17T09:00:00.000Z' } = {}) {
    return {
        v: 3,
        canon: {
            facts: facts.map((fact) => (typeof fact === 'string'
                ? { text: fact, entities: [] }
                : { text: fact.text, entities: [...(fact.entities ?? [])] })),
            covers: [...covers],
            prompt,
            at,
        },
    };
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

/**
 * A v4 store carrying a summary and the index record read from it, written out by hand
 * (docs/decisions.md D-0074, D-0076). The record's hash is over the *summary*, not the
 * message, which is what makes a resummarise invalidate it.
 *
 * @param {object} message The message the store belongs to, for the scene's hash.
 * @param {string} text The summary.
 * @param {object} [record] Slot overrides; `line` is the block's compact text.
 */
export function cairnIndexStore(message, text, record = {}, { prompt = 'h:00000000000004', at = '2026-09-25T09:00:00.000Z' } = {}) {
    return {
        ...cairnStore(message, text),
        v: 4,
        index: {
            record: {
                kind: 'filler',
                who: ['Wren'],
                what: 'Wren settled the matter before the tide turned',
                changed: '',
                because: '',
                background: '',
                line: `Wren settled it before the tide turned.`,
                ...record,
            },
            hash: hashString(text),
            prompt,
            at,
        },
    };
}
