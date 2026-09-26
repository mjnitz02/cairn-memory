import { describe, expect, it } from 'vitest';
import { MIN_INDEX_RECORDS, applyPick, indexRecords, pendingPick } from '../src/pipeline/compactor.js';
import { readIndex } from '../src/store/chat-store.js';
import { cairnIndexStore } from './mocks/cairn.js';
import { makeQvinkChat } from './mocks/qvink.js';

/** An index of `count` records over messages 0, 1, 2 … — the pick's whole input. */
const records = (count, from = 0) =>
    Array.from({ length: count }, (_, i) => ({ index: from + i, record: { kind: 'filler' } }));

/** The fold in force: what `canonFor` returns. */
const canon = (fields = {}) => ({ coveredThrough: 9, slots: 10, dropped: 0, ...fields });

describe('when a canon pick is due', () => {
    it('is due when nothing has ever been picked in this chat', () => {
        expect(pendingPick({ records: records(20), canon: null, slots: 10 }))
            .toMatchObject({ due: true, reason: 'no-canon', covers: [0, 19] });
        expect(pendingPick({ records: records(20), canon: canon({ coveredThrough: null }), slots: 10 }))
            .toMatchObject({ due: true, reason: 'no-canon' });
    });

    it('is due when the index has grown past what the last pick read', () => {
        expect(pendingPick({ records: records(20), canon: canon({ coveredThrough: 19 }), slots: 10 }))
            .toMatchObject({ due: false, reason: 'covered' });
        expect(pendingPick({ records: records(21), canon: canon({ coveredThrough: 19 }), slots: 10 }))
            .toMatchObject({ due: true, reason: 'new-records', covers: [0, 20] });
    });

    it('is due when a fact lost the records it rested on', () => {
        // An edit, a resummarise or a branch took a record away, so the pick in force
        // is missing a slot and the answer is out of date (memory/canon.js).
        expect(pendingPick({ records: records(20), canon: canon({ coveredThrough: 19, dropped: 1 }), slots: 10 }))
            .toMatchObject({ due: true, reason: 'lost-facts' });
    });

    it('is due when the slot count moved, because the question itself changed', () => {
        expect(pendingPick({ records: records(20), canon: canon({ coveredThrough: 19, slots: 6 }), slots: 10 }))
            .toMatchObject({ due: true, reason: 'slots-changed' });
    });

    it('treats a short answer as answered, so it is not asked again every turn', () => {
        // Four facts against ten slots is a spine, not work still to do. Without the
        // stored `slots` this would be indistinguishable from an unanswered question.
        const answered = canon({ coveredThrough: 19, slots: 10 });

        for (let turn = 0; turn < 20; turn++) {
            expect(pendingPick({ records: records(20), canon: answered, slots: 10 }))
                .toMatchObject({ due: false, reason: 'covered' });
        }
    });

    it('is not due with too few records to rank, or with no slots to fill', () => {
        expect(pendingPick({ records: records(MIN_INDEX_RECORDS - 1), canon: null, slots: 10 }))
            .toMatchObject({ due: false, reason: 'too-few', records: [], covers: null });
        expect(pendingPick({ records: records(20), canon: null, slots: 0 }))
            .toMatchObject({ due: false, reason: 'no-slots' });
        expect(pendingPick()).toMatchObject({ due: false, reason: 'no-slots' });
        expect(MIN_INDEX_RECORDS).toBe(3);
    });

    it('carries the whole index, because the pick ranks all of it', () => {
        // Not the newest ones, and not the ones the block still holds: the pick reads
        // the chat, which is the single sentence D-0062's three gaps reduce to.
        const due = pendingPick({ records: records(200), canon: null, slots: 10 });

        expect(due.records).toHaveLength(200);
        expect(due.covers).toEqual([0, 199]);
    });
});

describe('the index the pick reads', () => {
    it('is every valid record in the chat, oldest first, with its message', () => {
        const chat = makeQvinkChat({ length: 12 });
        for (const index of [2, 5, 9]) {
            chat[index].extra.cairn = cairnIndexStore(chat[index], `Summary ${index}.`, { what: `Thing ${index}` });
        }

        expect(indexRecords(chat, { readIndex }).map((entry) => entry.index)).toEqual([2, 5, 9]);
        expect(indexRecords(chat, { readIndex })[1].record.what).toBe('Thing 5');
    });

    it('leaves out a record whose summary was resummarised away', () => {
        const chat = makeQvinkChat({ length: 12 });
        chat[2].extra.cairn = cairnIndexStore(chat[2], 'Summary 2.');
        chat[5].extra.cairn = cairnIndexStore(chat[5], 'Summary 5.');
        chat[5].extra.cairn.scene.text = 'A different summary entirely.';

        expect(indexRecords(chat, { readIndex }).map((entry) => entry.index)).toEqual([2]);
    });

    it('is empty for a chat with no records at all', () => {
        expect(indexRecords(makeQvinkChat({ length: 8 }), { readIndex })).toEqual([]);
        expect(indexRecords(null, { readIndex })).toEqual([]);
    });
});

describe('what a pick becomes', () => {
    const sent = [{ index: 4 }, { index: 7 }, { index: 11 }];

    it('maps the rows the model cited back to the messages they came from', () => {
        const applied = applyPick({
            picked: [
                { text: 'Her brother is dead.', entities: ['Wren'], from: [1] },
                { text: 'He burned the army to buy her freedom.', entities: [], from: [2, 3] },
            ],
            records: sent,
            covers: [4, 11],
            slots: 10,
            prompt: 'h:1',
            at: 'T',
        });

        expect(applied.batch.facts).toEqual([
            { text: 'Her brother is dead.', entities: ['Wren'], from: [4] },
            { text: 'He burned the army to buy her freedom.', entities: [], from: [7, 11] },
        ]);
        expect(applied).toMatchObject({ picked: 2, duplicates: 0, dropped: 0, uncited: 0 });
        expect(applied.batch).toMatchObject({ covers: [4, 11], slots: 10, prompt: 'h:1', at: 'T' });
    });

    it('refuses a fact whose every row fell outside the index it was sent', () => {
        // An uncitable fact is a permanent one, which is what a pick exists not to be.
        const applied = applyPick({
            picked: [{ text: 'Invented.', entities: [], from: [99] }],
            records: sent, covers: [4, 11], slots: 10, prompt: 'h:1', at: 'T',
        });

        expect(applied).toMatchObject({ picked: 0, uncited: 1 });
        expect(applied.batch.facts).toEqual([]);
    });

    it('counts the facts it actually wrote, not the ones the model claimed', () => {
        const applied = applyPick({
            picked: [
                { text: 'Her brother is dead.', entities: [], from: [1] },
                { text: 'her brother is dead!', entities: [], from: [2] },
            ],
            dropped: [{ reason: 'fact-too-long' }, { reason: 'over-slots' }],
            records: sent, covers: [4, 11], slots: 10, prompt: 'h:1', at: 'T',
        });

        expect(applied).toMatchObject({ picked: 1, duplicates: 1, dropped: 2 });
    });

    it('writes the same batch twice from the same reply, so a re-derivation is stable', () => {
        // Canon is derivable rather than remembered (memory/canon.js): nothing about
        // when or how often it ran may show up in what is stored.
        const reply = {
            picked: [{ text: 'Her brother is dead.', entities: ['Wren'], from: [1, 3] }],
            records: sent, covers: [4, 11], slots: 10, prompt: 'h:1', at: 'T',
        };

        expect(applyPick(reply)).toEqual(applyPick(reply));
    });

    it('copies the range, so the caller\'s array cannot reach the store', () => {
        const mutable = [4, 11];
        const applied = applyPick({
            picked: [], records: sent, covers: mutable, slots: 10, prompt: 'h:1', at: 'T',
        });
        mutable[1] = 99;

        expect(applied.batch.covers).toEqual([4, 11]);
    });
});
