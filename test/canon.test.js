import { describe, expect, it } from 'vitest';
import {
    DEFAULT_SLOTS, MAX_SLOTS, MIN_SLOTS, admitCanon, canonFor, newFacts, normaliseFact, slotsFor,
} from '../src/memory/canon.js';
import { STORE_VERSION } from '../src/store/schema.js';
import { readCanon, readIndex } from '../src/store/chat-store.js';
import { cairnCanonStore, cairnIndexStore } from './mocks/cairn.js';
import { makeQvinkChat } from './mocks/qvink.js';
import { storeV3Chat, STORE_V3_CANON } from './fixtures/store-v3.js';

/** The store's readers, which `canonFor` takes rather than imports (memory/canon.js). */
const READERS = { readCanon, readIndex };

const NOTHING = {
    facts: [], index: null, slots: null, covers: null, coveredThrough: null, batches: 0, dropped: 0,
};

/** A chat with canon batches at the given indexes. */
function chatWithCanon(batches, { length = 24, indexed = [] } = {}) {
    const chat = makeQvinkChat({ length });
    for (const index of indexed) {
        chat[index].extra.cairn = cairnIndexStore(chat[index], `Summary of message ${index}.`);
    }
    for (const [index, facts, covers, options] of batches) {
        chat[index].extra.cairn = { ...chat[index].extra.cairn, ...cairnCanonStore(facts, covers, options) };
    }
    return chat;
}

describe('the canon fold', () => {
    it('reads the newest batch alone, because a pick supersedes rather than accumulates', () => {
        // The whole point of a fixed slot count is that the last answer replaces the
        // one before it (docs/decisions.md D-0071). A union would be the bag again, and
        // the older batch would go on asserting what the newer one left out.
        const chat = chatWithCanon([
            [3, ['Her brother is dead.', 'They met at the harbour.'], [0, 3]],
            [9, ['Aster owns a green boat.'], [4, 9], { slots: 4 }],
        ]);

        const { facts, index, slots, batches, coveredThrough } = canonFor(chat, READERS);

        expect(facts.map((fact) => fact.text)).toEqual(['Aster owns a green boat.']);
        expect(facts.map((fact) => fact.index)).toEqual([9]);
        expect(index).toBe(9);
        expect(slots).toBe(4);
        expect(batches).toBe(2);
        expect(coveredThrough).toBe(9);
    });

    it('reads the newest batch at the mark, so a pick written since leaves the block alone', () => {
        // How canon changes on a rebuild turn and only there (D-0067): the assembler
        // folds at the mark it last admitted at, and moves the mark at a rebuild.
        const chat = chatWithCanon([
            [3, ['Her brother is dead.'], [0, 3]],
            [9, ['Aster owns a green boat.'], [4, 9]],
        ]);

        expect(canonFor(chat, READERS, { through: 8 }).facts.map((fact) => fact.text))
            .toEqual(['Her brother is dead.']);
        expect(canonFor(chat, READERS, { through: 9 }).facts.map((fact) => fact.text))
            .toEqual(['Aster owns a green boat.']);
        expect(canonFor(chat, READERS, { through: 2 })).toEqual({ ...NOTHING, batches: 2 });
    });

    it('reports nothing for a chat that has never had a pick', () => {
        expect(canonFor(makeQvinkChat({ length: 12 }), READERS)).toEqual(NOTHING);
        expect(canonFor([], READERS)).toEqual(NOTHING);
        expect(canonFor(null, READERS)).toEqual(NOTHING);
    });

    it('drops a fact whose every cited record is gone, and counts it', () => {
        // Canon is derivable, not remembered: delete the record and the fact goes with
        // it, with no rollback code. `dropped` is what makes the next pick due.
        const chat = chatWithCanon(
            [[9, [
                { text: 'Her brother is dead.', from: [3] },
                { text: 'Aster owns a green boat.', from: [5] },
            ], [0, 9]]],
            { indexed: [3, 5] },
        );

        expect(canonFor(chat, READERS).facts.map((fact) => fact.text)).toEqual([
            'Her brother is dead.', 'Aster owns a green boat.',
        ]);

        delete chat[5].extra.cairn;
        const after = canonFor(chat, READERS);

        expect(after.facts.map((fact) => fact.text)).toEqual(['Her brother is dead.']);
        expect(after.dropped).toBe(1);
    });

    it('keeps a fact while any one of its records survives', () => {
        // A line that chains two rows should not die because one of them was edited:
        // the fact is still grounded, and dropping it would lose something true.
        const chat = chatWithCanon(
            [[9, [{ text: 'He burned the army to buy her freedom.', from: [3, 5] }], [0, 9]]],
            { indexed: [3, 5] },
        );
        delete chat[3].extra.cairn;

        expect(canonFor(chat, READERS)).toMatchObject({ dropped: 0 });
        expect(canonFor(chat, READERS).facts).toHaveLength(1);
    });

    it('keeps a fact a resummarise invalidated the record of, only until the record is stale', () => {
        // The record is hashed against the summary (D-0074), so a resummarise makes it
        // stale rather than absent — and a stale record is not a record.
        const chat = chatWithCanon(
            [[9, [{ text: 'Her brother is dead.', from: [3] }], [0, 9]]],
            { indexed: [3] },
        );
        chat[3].extra.cairn.scene.text = 'A different summary entirely.';

        expect(canonFor(chat, READERS)).toMatchObject({ facts: [], dropped: 1 });
    });

    it('keeps an uncited fact, because there is nothing to check it against', () => {
        // A batch written before the pick existed (test/fixtures/store-v4-uncited.js).
        // Degrading it to a guess would be worse than degrading to what is written.
        const chat = chatWithCanon([[9, ['Her brother is dead.'], [0, 9]]]);

        expect(canonFor(chat, READERS)).toMatchObject({ facts: [{ text: 'Her brother is dead.', from: [] }], dropped: 0 });
    });

    it('folds out a repeat inside one batch, so it renders once', () => {
        const chat = chatWithCanon([[9, ['Her brother is dead.', 'Her brother is dead!'], [4, 9]]]);

        expect(canonFor(chat, READERS).facts.map((fact) => fact.text)).toEqual(['Her brother is dead.']);
    });

    it('keeps the tags it never reads, so a later entity index inherits them', () => {
        const chat = chatWithCanon([[3, [{ text: 'Her brother is dead.', entities: ['Wren'] }], [0, 3]]]);

        expect(canonFor(chat, READERS).facts[0].entities).toEqual(['Wren']);
    });

    it('skips a malformed batch and a batch from a newer Cairn', () => {
        const chat = chatWithCanon([[9, ['Kept.'], [4, 9]]]);
        chat[3].extra.cairn = { v: STORE_VERSION, canon: { facts: 'not a list', covers: [0, 3], prompt: 'h:1', at: 'T' } };
        chat[11].extra.cairn = { ...cairnCanonStore(['Newer.'], [0, 11]), v: STORE_VERSION + 1 };

        const { facts, batches } = canonFor(chat, READERS);

        expect(facts.map((fact) => fact.text)).toEqual(['Kept.']);
        expect(batches).toBe(1);
    });

    it('rolls a branch back with no rollback code, because the batch went with its message', () => {
        // Truncating past a batch's message is what a branch, a swipe or a deletion
        // does to the array. Nothing records which batch is current, so nothing to undo.
        const chat = chatWithCanon([
            [3, ['Her brother is dead.'], [0, 3]],
            [9, ['Aster owns a green boat.'], [4, 9]],
        ]);

        expect(canonFor(chat.slice(0, 9), READERS).facts.map((fact) => fact.text)).toEqual(['Her brother is dead.']);
        expect(canonFor(chat.slice(0, 3), READERS)).toEqual(NOTHING);
    });

    it('keeps a fact after the messages it was picked from are edited', () => {
        // An edit invalidates the *summary*, which invalidates the record through it —
        // but this fixture predates citations, so there is nothing to invalidate.
        const chat = storeV3Chat();
        chat[0].mes = 'Something else entirely.';
        chat[1].mes = `${chat[1].mes} Then the fog closed in.`;

        expect(canonFor(chat, READERS).facts.map((fact) => fact.text))
            .toEqual(STORE_V3_CANON.canon.facts.map((fact) => fact.text));
    });
});

describe('the slot count', () => {
    it('clamps a setting to what a pick may be asked for', () => {
        expect(slotsFor(8)).toBe(8);
        expect(slotsFor(0)).toBe(MIN_SLOTS);
        expect(slotsFor(-4)).toBe(MIN_SLOTS);
        expect(slotsFor(999)).toBe(MAX_SLOTS);
        expect(slotsFor(7.6)).toBe(7);
    });

    it('falls back to the default when there is no setting', () => {
        expect(slotsFor(undefined)).toBe(DEFAULT_SLOTS);
        expect(slotsFor(null)).toBe(DEFAULT_SLOTS);
        expect(slotsFor('ten')).toBe(DEFAULT_SLOTS);
    });
});

describe('which facts the block admits', () => {
    const tokensOf = (facts) => facts.length * 20;
    const facts = Array.from({ length: 5 }, (_, i) => ({ text: `Fact ${i}.` }));

    it('admits everything when the cap allows it', () => {
        expect(admitCanon({ facts, cap: 200, tokensOf })).toEqual({ facts, tokens: 100, dropped: 0 });
    });

    it('drops from the newest end, so the bytes above a dropped fact keep their offsets', () => {
        const admitted = admitCanon({ facts, cap: 60, tokensOf });

        expect(admitted.facts.map((fact) => fact.text)).toEqual(['Fact 0.', 'Fact 1.', 'Fact 2.']);
        expect(admitted).toMatchObject({ tokens: 60, dropped: 2 });
    });

    it('admits nothing when the cap is nothing, which is what a starved chat gets', () => {
        expect(admitCanon({ facts, cap: 0, tokensOf })).toEqual({ facts: [], tokens: 0, dropped: 5 });
        expect(admitCanon({ facts: [], cap: 500, tokensOf })).toEqual({ facts: [], tokens: 0, dropped: 0 });
    });
});

describe('what a pick is allowed to write', () => {
    it('drops a fact canon already holds, however it was rephrased', () => {
        const existing = [{ text: 'Her brother is dead.' }];
        const promoted = [
            { text: 'her brother is dead' },
            { text: 'Aster owns a green boat.' },
        ];

        expect(newFacts(promoted, existing)).toEqual({
            facts: [{ text: 'Aster owns a green boat.', entities: [], from: [] }], duplicates: 1,
        });
    });

    it('drops a repeat inside the batch itself', () => {
        const promoted = [{ text: 'They kissed.' }, { text: 'They kissed!' }];

        expect(newFacts(promoted, [])).toEqual({ facts: [{ text: 'They kissed.', entities: [], from: [] }], duplicates: 1 });
    });

    it('counts a fact with nothing to compare as refused rather than writing it', () => {
        expect(newFacts([{ text: '   ' }, { text: '...' }, {}], [])).toEqual({ facts: [], duplicates: 3 });
    });

    it('carries the tags and the citations across', () => {
        expect(newFacts([{ text: 'A fact.', entities: ['Wren'], from: [3] }], []).facts).toEqual([
            { text: 'A fact.', entities: ['Wren'], from: [3] },
        ]);
    });

    it('takes everything when canon is empty', () => {
        expect(newFacts([{ text: 'One.' }, { text: 'Two.' }])).toEqual({
            facts: [{ text: 'One.', entities: [], from: [] }, { text: 'Two.', entities: [], from: [] }],
            duplicates: 0,
        });
        expect(newFacts(null, [])).toEqual({ facts: [], duplicates: 0 });
    });
});

describe('what counts as the same fact', () => {
    it('ignores case, punctuation and runs of whitespace', () => {
        expect(normaliseFact('Her brother is dead.')).toBe(normaliseFact('HER BROTHER IS DEAD!'));
        expect(normaliseFact('They  kissed\n\nat the  lighthouse')).toBe(normaliseFact('They kissed at the lighthouse.'));
    });

    it('reads a typographic apostrophe as a straight one', () => {
        expect(normaliseFact('Wren’s brother is dead.')).toBe(normaliseFact('Wren\'s brother is dead.'));
    });

    it('keeps letters and numbers in any script', () => {
        expect(normaliseFact('The 3 sisters live in Kraków.')).toBe('the 3 sisters live in kraków');
    });

    it('is empty when there is nothing to compare', () => {
        expect(normaliseFact('   ')).toBe('');
        expect(normaliseFact('...')).toBe('');
        expect(normaliseFact(undefined)).toBe('');
        expect(normaliseFact(42)).toBe('');
    });
});
