import { describe, expect, it } from 'vitest';
import { indexRecords, pendingIndex } from '../src/pipeline/index-reads.js';
import { readIndex, readScene } from '../src/store/chat-store.js';
import { cairnIndexStore, makeMixedChat } from './mocks/cairn.js';
import { makeQvinkChat } from './mocks/qvink.js';

/** The queue's own waiting list is tested with the job, in test/index-queue.test.js. */
describe('what an adoption step indexes', () => {
    it('stops at `through`, so a step indexes only the summaries it has reached', () => {
        const chat = makeMixedChat({ length: 24, qvinkThrough: -1, cairnThrough: 22 });
        const all = pendingIndex(chat, { readScene, readIndex }).map((entry) => entry.index);
        const through = all[4];

        expect(pendingIndex(chat, { readScene, readIndex }, { through }).map((entry) => entry.index))
            .toEqual(all.slice(0, 5));
        expect(pendingIndex(chat, { readScene, readIndex }, { through: -1 })).toEqual([]);
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
