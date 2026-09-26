import { describe, expect, it } from 'vitest';
import { CANON_MAX_TOKENS, CANON_PROMPT, canonPick, parseCanonReply } from '../src/memory/canon-strategy.js';
import {
    MAX_ENTITIES, MAX_ENTITY_CHARS, MAX_FACT_CHARS, MAX_SLOTS, MAX_SOURCES,
} from '../src/memory/canon.js';
import { INDEX_HEADER } from '../src/memory/index-record.js';
import { hashString } from '../src/util/hash.js';
import { badCanonOutputs } from './mocks/llm.js';

/** What the model meant to send, in the reply's own shape. */
const MEANT = [
    { fact: 'Wren\'s brother drowned in the spring flood.', entities: ['Wren'], from: [1] },
    { fact: 'Aster crewed the winter run with Wren\'s brother.', entities: ['Aster', 'Wren'], from: [2] },
    { fact: 'Aster rowed Wren across the water before the feast day.', entities: ['Aster', 'Wren'], from: [4] },
];

/** A small index, in the shape `renderIndex` takes. */
const RECORDS = [
    {
        kind: 'filler', who: ['Wren', 'Aster'], what: 'Wren asked Aster about the ferry timetable',
        changed: '', because: '', background: 'Wren\'s brother drowned in the spring flood', line: 'Wren asked about the ferry.',
    },
    {
        kind: 'major', who: ['Aster'], what: 'Aster admitted she crewed the winter run with Wren\'s brother',
        changed: 'Aster knew Wren\'s brother', because: 'Wren asked her outright', background: '', line: 'Aster admitted she knew him.',
    },
    {
        kind: 'description', who: ['Aster', 'Wren'], what: 'Aster and Wren waited out the fog in the terminal',
        changed: '', because: 'the crossing was posted delayed', background: '', line: 'They waited out the fog.',
    },
    {
        kind: 'major', who: ['Aster'], what: 'Aster rowed Wren across the water before the feast day',
        changed: 'Wren is across the water', because: 'the ferry never sailed', background: 'Aster promised her a crossing', line: 'Aster rowed her across.',
    },
];

const picked = (parsed) => parsed.picked.map((fact) => fact.text);

describe('building a canon pick', () => {
    it('sends the whole index under its header, and stores the prompt it used', () => {
        const request = canonPick.build({ records: RECORDS, slots: 3 });
        const [{ role, content }] = request.messages;

        expect(role).toBe('user');
        expect(content).toContain(INDEX_HEADER);
        for (const record of RECORDS) expect(content).toContain(record.what);
        // Numbered from 1, because the rows are what the model cites back.
        expect(content).toContain('4 | major | Aster | Aster rowed Wren across the water');
        expect(request.maxTokens).toBe(CANON_MAX_TOKENS);
        expect(request.prompt).toBe(hashString(CANON_PROMPT));
        expect(request).toMatchObject({ slots: 3, records: 4 });
    });

    it('asks for exactly the slots it was given, because the budget is the calibration', () => {
        // An absolute question makes a small model say yes to everything, which is what
        // produced P4's canon (docs/decisions.md D-0064, D-0071).
        expect(canonPick.build({ records: RECORDS, slots: 3 }).messages[0].content)
            .toContain('Choose exactly 3 facts');
        expect(canonPick.build({ records: RECORDS, slots: 9 }).messages[0].content)
            .toContain('Exactly 9 facts');
    });

    it('never leaks the compact line into the index, which would cost the pick thousands of tokens', () => {
        // `renderRecord` renders slots only (D-0076): the deriver reads structure and
        // the block reads prose, and the two must not cross.
        const content = canonPick.build({ records: RECORDS, slots: 3 }).messages[0].content;

        for (const record of RECORDS) expect(content).not.toContain(record.line);
    });

    it('states every cap the parser enforces, so the model is not guessing', () => {
        const content = canonPick.build({ records: RECORDS, slots: 4 }).messages[0].content;

        expect(content).toContain(`at most ${MAX_FACT_CHARS} characters`);
        expect(content).toContain(`at most ${MAX_SOURCES}`);
        expect(content).toContain(`at most ${MAX_ENTITIES}`);
        expect(content).toContain(`at most ${MAX_ENTITY_CHARS} characters`);
    });

    it('names what to leave, as concretely as what to pick (DESIGN.md §12)', () => {
        expect(CANON_PROMPT).toContain('IMPORTANT:');
        // The state tier's fields, mood, and where the story might go (D-0043).
        for (const left of ['the weather', 'hair and outfit', 'How anyone felt', 'What might happen next']) {
            expect(CANON_PROMPT).toContain(left);
        }
        // The two instructions the pick exists for: overrule the label, chain the cause.
        expect(CANON_PROMPT).toContain('you may overrule it');
        expect(CANON_PROMPT).toContain('Chain the causes');
    });

    it('shows a filler row being picked, so the kind is visibly not a gate', () => {
        // A local label is unstable under hindsight (D-0070). The worked example has to
        // demonstrate that, or the prompt's own rule reads as decoration.
        expect(CANON_PROMPT).toContain('Row 1 is marked filler and is still picked');
    });

    it('applies ST macros to the template and never to the chat\'s own text', () => {
        const content = canonPick.build({
            records: [{ ...RECORDS[0], what: 'Wren typed {{user}} into the terminal' }],
            slots: 1,
            expand: (text) => text.replaceAll('{{user}}', 'EXPANDED'),
        }).messages[0].content;

        expect(content).toContain('Wren typed {{user}} into the terminal');
        expect(content).not.toContain('EXPANDED');
    });

    it('refuses a request it cannot make sense of rather than sending it', () => {
        expect(() => canonPick.build({ records: [], slots: 3 })).toThrow(RangeError);
        expect(() => canonPick.build({ records: null, slots: 3 })).toThrow(RangeError);
        expect(() => canonPick.build({ records: RECORDS, slots: 0 })).toThrow(RangeError);
        expect(() => canonPick.build({ records: RECORDS, slots: MAX_SLOTS + 1 })).toThrow(RangeError);
        expect(() => canonPick.build({ records: RECORDS, slots: 2.5 })).toThrow(RangeError);
    });
});

describe('reading a clean reply', () => {
    it('takes the facts, their tags and the rows they cite', () => {
        const parsed = parseCanonReply(JSON.stringify({ canon: MEANT }), { slots: 3, records: 4 });

        expect(parsed).toEqual({
            ok: true,
            picked: [
                { text: MEANT[0].fact, entities: ['Wren'], from: [1] },
                { text: MEANT[1].fact, entities: ['Aster', 'Wren'], from: [2] },
                { text: MEANT[2].fact, entities: ['Aster', 'Wren'], from: [4] },
            ],
            dropped: [],
            short: 0,
        });
    });

    it('takes a fact with no tags, as long as it cites a row', () => {
        const parsed = parseCanonReply('{"canon":[{"fact":"They kissed at the lighthouse.","from":[2]}]}', { slots: 2, records: 4 });

        expect(parsed.picked).toEqual([{ text: 'They kissed at the lighthouse.', entities: [], from: [2] }]);
        expect(parsed.dropped).toEqual([]);
    });

    it('accepts a short pick and reports the shortfall, because a short story has a short spine', () => {
        const parsed = parseCanonReply(JSON.stringify({ canon: MEANT }), { slots: 10, records: 4 });

        expect(parsed).toMatchObject({ ok: true, short: 7 });
        expect(parsed.picked).toHaveLength(3);
    });
});

/** CLAUDE.md §3.12: the parser is tested against the catalogue, not against clean JSON. */
describe('reading the replies a model actually sends', () => {
    const limits = { slots: 3, records: 5 };

    it('reads through a fence, a preamble and leaked reasoning', () => {
        for (const shape of ['fenced', 'preambleAndSignOff', 'leakedReasoning', 'orphanThinkClose']) {
            const parsed = parseCanonReply(badCanonOutputs[shape](MEANT), limits);

            expect(parsed.ok, shape).toBe(true);
            expect(picked(parsed), shape).toEqual(MEANT.map((fact) => fact.fact));
        }
    });

    it('reads a bare array, the envelope forgotten', () => {
        expect(picked(parseCanonReply(badCanonOutputs.bareArray(MEANT), limits)))
            .toEqual(MEANT.map((fact) => fact.fact));
    });

    it('rejects a reply that ran out of tokens', () => {
        expect(parseCanonReply(badCanonOutputs.truncated(MEANT), limits)).toEqual({ ok: false, reason: 'truncated' });
        expect(parseCanonReply(badCanonOutputs.unterminatedReasoning(), limits)).toEqual({ ok: false, reason: 'truncated' });
    });

    it('tells a refusal apart from a reply it merely cannot read', () => {
        expect(parseCanonReply(badCanonOutputs.refusal(), limits)).toEqual({ ok: false, reason: 'refusal' });
        expect(parseCanonReply(badCanonOutputs.prose(), limits)).toEqual({ ok: false, reason: 'format' });
        expect(parseCanonReply(badCanonOutputs.empty(), limits)).toEqual({ ok: false, reason: 'empty' });
    });

    it('rejects a pick that picked nothing, unlike P4\'s promotion pass', () => {
        // `{"promote":[]}` was a real answer to "is anything here permanent". There is
        // no real answer to "choose the rows this story needs" that chooses none.
        expect(parseCanonReply(badCanonOutputs.emptyPick(), limits)).toEqual({ ok: false, reason: 'no-facts' });
        expect(parseCanonReply(badCanonOutputs.nullCanon(), limits)).toEqual({ ok: false, reason: 'format' });
    });

    it('rejects a reply whose shape is not the one asked for', () => {
        expect(parseCanonReply('{"canon": "Wren\'s brother is dead."}', limits)).toEqual({ ok: false, reason: 'format' });
    });

    it('drops the facts it cannot read, and a reply of only those is a rejection', () => {
        expect(parseCanonReply(badCanonOutputs.wrongKey(MEANT), limits)).toEqual({ ok: false, reason: 'no-facts' });
        expect(parseCanonReply(badCanonOutputs.plainStrings(MEANT), limits)).toEqual({ ok: false, reason: 'no-facts' });
    });

    it('drops a fact that cites nothing, because an uncited fact is a permanent one', () => {
        // The citation is how a fact dies when the record it rests on does
        // (memory/canon.js). Without one, the pick is the bag D-0071 undid.
        expect(parseCanonReply(badCanonOutputs.uncited(MEANT), limits)).toEqual({ ok: false, reason: 'no-facts' });
    });

    it('drops a row that was never in the index, and one that is not a number', () => {
        const parsed = parseCanonReply(badCanonOutputs.badRows(MEANT), limits);

        expect(picked(parsed)).toEqual([MEANT[1].fact]);
        expect(parsed.picked[0].from).toEqual([2]);
        expect(parsed.dropped).toEqual([
            { reason: 'bad-row' }, { reason: 'no-source' }, { reason: 'bad-row' },
        ]);
    });

    it('takes only the rows a fact may cite, counting the rest', () => {
        const parsed = parseCanonReply(badCanonOutputs.manyRows(MEANT), { slots: 3, records: 8 });

        expect(parsed.picked[0].from).toHaveLength(MAX_SOURCES);
        expect(parsed.dropped).toEqual(Array(5 - MAX_SOURCES).fill({ reason: 'too-many-rows' }));
    });

    it('drops a fact over its cap rather than cutting it, and keeps the rest', () => {
        const parsed = parseCanonReply(badCanonOutputs.overlong(MEANT), limits);

        expect(picked(parsed)).toEqual([MEANT[1].fact, MEANT[2].fact]);
        expect(parsed.dropped).toEqual([{ reason: 'fact-too-long' }]);
    });

    it('keeps a fact whose tags are the problem, dropping only the tags', () => {
        const many = parseCanonReply(badCanonOutputs.manyEntities(MEANT), limits);
        expect(many.picked[0].entities).toEqual(['Wren', 'Aster', 'the flood', 'the harbour']);
        expect(many.dropped).toEqual(Array(2).fill({ reason: 'too-many-entities' }));

        const sentence = parseCanonReply(badCanonOutputs.entitySentence(MEANT), limits);
        expect(sentence.picked[0]).toEqual({ text: MEANT[0].fact, entities: [], from: [1] });
        expect(sentence.dropped).toEqual([{ reason: 'entity-too-long' }]);
    });

    it('takes only the facts there were slots for, counting the rest', () => {
        const parsed = parseCanonReply(badCanonOutputs.overSlots(), { slots: 3, records: 12 });

        expect(parsed.picked).toHaveLength(3);
        expect(parsed.dropped).toEqual(Array(9).fill({ reason: 'over-slots' }));
    });

    it('never takes more than a pick may fill, whatever slot count it is told', () => {
        const parsed = parseCanonReply(badCanonOutputs.overSlots(), { slots: 99, records: 12 });

        expect(parsed.picked).toHaveLength(12);
        expect(parseCanonReply(badCanonOutputs.overSlots(), { slots: MAX_SLOTS, records: 12 }).picked)
            .toHaveLength(12);
    });

    it('picks a mood the prompt told it to leave, which only the run can catch', () => {
        // The parser cannot tell a fact from a feeling. This is why the gate reads the
        // picked facts against the yardstick rather than only counting them.
        const parsed = parseCanonReply(badCanonOutputs.mood(MEANT), limits);

        expect(picked(parsed)).toContain('Aster was shaken by the question.');
    });
});
