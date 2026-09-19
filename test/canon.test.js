import { describe, expect, it } from 'vitest';
import {
    COLD_FACT_TOKENS, MAX_FACTS_PER_PASS, admitCanon, canonFor, canonRoom, newFacts, normaliseFact,
} from '../src/memory/canon.js';
import { STORE_VERSION } from '../src/store/schema.js';
import { cairnCanonStore } from './mocks/cairn.js';
import { makeQvinkChat } from './mocks/qvink.js';
import { storeV3Chat, STORE_V3_CANON } from './fixtures/store-v3.js';

/** A chat with canon batches at the given indexes. */
function chatWithCanon(batches, { length = 24 } = {}) {
    const chat = makeQvinkChat({ length });
    for (const [index, facts, covers] of batches) {
        chat[index].extra.cairn = cairnCanonStore(facts, covers);
    }
    return chat;
}

describe('the canon fold', () => {
    it('reads every batch in the chat, oldest first', () => {
        const chat = chatWithCanon([
            [3, ['Her brother is dead.', 'They met at the harbour.'], [0, 3]],
            [9, ['Aster owns a green boat.'], [4, 9]],
        ]);

        const { facts, batches, coveredThrough } = canonFor(chat);

        expect(facts.map((fact) => fact.text)).toEqual([
            'Her brother is dead.', 'They met at the harbour.', 'Aster owns a green boat.',
        ]);
        expect(facts.map((fact) => fact.index)).toEqual([3, 3, 9]);
        expect(batches).toBe(2);
        expect(coveredThrough).toBe(9);
    });

    it('reports nothing for a chat that has never had a pass', () => {
        expect(canonFor(makeQvinkChat({ length: 12 }))).toEqual({ facts: [], batches: 0, coveredThrough: null });
        expect(canonFor([])).toEqual({ facts: [], batches: 0, coveredThrough: null });
        expect(canonFor(null)).toEqual({ facts: [], batches: 0, coveredThrough: null });
    });

    it('folds out a repeat an older build wrote, so it renders once', () => {
        // The pass refuses a repeat before writing it; this is the safety net that
        // makes the fold idempotent whatever is already on disk.
        const chat = chatWithCanon([
            [3, ['Her brother is dead.'], [0, 3]],
            [9, ['Her brother is dead!', 'Aster owns a green boat.'], [4, 9]],
        ]);

        expect(canonFor(chat).facts.map((fact) => fact.text)).toEqual([
            'Her brother is dead.', 'Aster owns a green boat.',
        ]);
    });

    it('keeps the tags it never reads, so P5 inherits them', () => {
        const chat = chatWithCanon([[3, [{ text: 'Her brother is dead.', entities: ['Wren'] }], [0, 3]]]);

        expect(canonFor(chat).facts[0].entities).toEqual(['Wren']);
    });

    it('takes the newest covers[1] however the batches are ordered', () => {
        const chat = chatWithCanon([
            [3, ['One.'], [0, 7]],
            [9, ['Two.'], [4, 5]],
        ]);

        expect(canonFor(chat).coveredThrough).toBe(7);
    });

    it('skips a malformed batch and a batch from a newer Cairn', () => {
        const chat = chatWithCanon([[9, ['Kept.'], [4, 9]]]);
        chat[3].extra.cairn = { v: STORE_VERSION, canon: { facts: 'not a list', covers: [0, 3], prompt: 'h:1', at: 'T' } };
        chat[5].extra.cairn = { ...cairnCanonStore(['Newer.'], [0, 5]), v: STORE_VERSION + 1 };

        const { facts, batches } = canonFor(chat);

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

        expect(canonFor(chat.slice(0, 9)).facts.map((fact) => fact.text)).toEqual(['Her brother is dead.']);
        expect(canonFor(chat.slice(0, 3))).toEqual({ facts: [], batches: 0, coveredThrough: null });
    });

    it('keeps a fact after the messages it was promoted from are edited', () => {
        // docs/p4-plan.md decision 2: a fact says something happened, and no edit unmakes it.
        const chat = storeV3Chat();
        chat[0].mes = 'Something else entirely.';
        chat[1].mes = `${chat[1].mes} Then the fog closed in.`;

        expect(canonFor(chat).facts.map((fact) => fact.text))
            .toEqual(STORE_V3_CANON.canon.facts.map((fact) => fact.text));
    });
});

describe('the room canon has left', () => {
    const tokensOf = (facts) => facts.length * 20;

    it('measures what the facts in hand cost, not what they were assumed to cost', () => {
        const facts = Array.from({ length: 10 }, (_, i) => ({ text: `Fact ${i}.` }));

        expect(canonRoom({ facts, cap: 400, tokensOf })).toEqual({
            tokens: 200, cap: 400, spare: 200, facts: MAX_FACTS_PER_PASS, full: false,
        });
    });

    it('never offers more than one pass may promote', () => {
        expect(canonRoom({ facts: [{ text: 'One.' }], cap: 1000, tokensOf }).facts).toBe(MAX_FACTS_PER_PASS);
    });

    it('falls back to the cold estimate before a chat has any facts', () => {
        expect(canonRoom({ facts: [], cap: COLD_FACT_TOKENS * 3, tokensOf })).toEqual({
            tokens: 0, cap: COLD_FACT_TOKENS * 3, spare: COLD_FACT_TOKENS * 3, facts: 3, full: false,
        });
    });

    it('is full when not one more fact fits, which is what stops the call being made', () => {
        const facts = Array.from({ length: 10 }, (_, i) => ({ text: `Fact ${i}.` }));

        expect(canonRoom({ facts, cap: 210, tokensOf })).toMatchObject({ facts: 0, full: true });
        expect(canonRoom({ facts, cap: 220, tokensOf })).toMatchObject({ facts: 1, full: false });
    });

    it('is full when there is no cap at all, so a starved chat gets no canon', () => {
        expect(canonRoom({ facts: [], cap: 0, tokensOf })).toMatchObject({ facts: 0, full: true });
        expect(canonRoom({ facts: [], cap: -100, tokensOf })).toMatchObject({ cap: 0, facts: 0, full: true });
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

describe('what a pass is allowed to add', () => {
    it('drops a fact canon already holds, however it was rephrased', () => {
        const existing = [{ text: 'Her brother is dead.' }];
        const promoted = [
            { text: 'her brother is dead' },
            { text: 'Aster owns a green boat.' },
        ];

        expect(newFacts(promoted, existing)).toEqual({
            facts: [{ text: 'Aster owns a green boat.', entities: [] }], duplicates: 1,
        });
    });

    it('drops a repeat inside the batch itself', () => {
        const promoted = [{ text: 'They kissed.' }, { text: 'They kissed!' }];

        expect(newFacts(promoted, [])).toEqual({ facts: [{ text: 'They kissed.', entities: [] }], duplicates: 1 });
    });

    it('counts a fact with nothing to compare as refused rather than writing it', () => {
        expect(newFacts([{ text: '   ' }, { text: '...' }, {}], [])).toEqual({ facts: [], duplicates: 3 });
    });

    it('carries the tags across', () => {
        expect(newFacts([{ text: 'A fact.', entities: ['Wren'] }], []).facts).toEqual([
            { text: 'A fact.', entities: ['Wren'] },
        ]);
    });

    it('takes everything when canon is empty', () => {
        expect(newFacts([{ text: 'One.' }, { text: 'Two.' }])).toEqual({
            facts: [{ text: 'One.', entities: [] }, { text: 'Two.', entities: [] }], duplicates: 0,
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
