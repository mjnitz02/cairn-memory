import { describe, expect, it } from 'vitest';
import { CANON_MAX_TOKENS, CANON_PROMPT, canonPromote, parseCanonReply } from '../src/memory/canon-strategy.js';
import {
    MAX_ENTITIES, MAX_ENTITY_CHARS, MAX_FACTS_PER_PASS, MAX_FACT_CHARS,
} from '../src/memory/canon.js';
import { hashString } from '../src/util/hash.js';
import { badCanonOutputs } from './mocks/llm.js';

/** What the model meant to send, in the reply's own shape. */
const MEANT = [
    { fact: 'Wren\'s brother drowned in the spring flood.', entities: ['Wren'] },
    { fact: 'Aster crewed the winter run with Wren\'s brother.', entities: ['Aster', 'Wren'] },
    { fact: 'Aster promised to get Wren across the water before the feast day.', entities: ['Aster', 'Wren'] },
];

const SUMMARIES = [
    'Wren asked Aster whether she had known her brother, who drowned in the spring flood.',
    'Aster admitted she had crewed the winter run with him the year before.',
    'Aster promised to get Wren across the water before the feast day.',
];

const promoted = (parsed) => parsed.promote.map((fact) => fact.text);

describe('building a compaction pass', () => {
    it('sends the summaries, the canon and the room, and stores the prompt it used', () => {
        const request = canonPromote.build({
            summaries: SUMMARIES,
            canon: [{ text: 'Wren grew up on the harbour.' }],
            room: 5,
        });
        const [{ role, content }] = request.messages;

        expect(role).toBe('user');
        for (const summary of SUMMARIES) expect(content).toContain(summary);
        expect(content).toContain('Wren grew up on the harbour.');
        expect(content).toContain('At most 5 facts this time.');
        expect(request.maxTokens).toBe(CANON_MAX_TOKENS);
        expect(request.prompt).toBe(hashString(CANON_PROMPT));
        expect(request.room).toBe(5);
    });

    it('leaves the kept-facts block out when there is no canon yet', () => {
        const content = canonPromote.build({ summaries: SUMMARIES, room: 3 }).messages[0].content;

        expect(content).not.toContain('Facts already kept:');
        expect(content).toContain('Summaries about to be dropped:');
    });

    it('states every cap the parser enforces, so the model is not guessing', () => {
        const content = canonPromote.build({ summaries: SUMMARIES, room: 4 }).messages[0].content;

        expect(content).toContain(`at most ${MAX_FACT_CHARS} characters`);
        expect(content).toContain(`at most ${MAX_ENTITIES}`);
        expect(content).toContain(`at most ${MAX_ENTITY_CHARS} characters`);
    });

    it('names what to leave, as concretely as what to promote (DESIGN.md §12)', () => {
        expect(CANON_PROMPT).toContain('IMPORTANT:');
        // The state tier's fields, mood, and where the story might go (D-0043).
        for (const left of ['the weather', 'hair and outfit', 'How anyone felt', 'What might happen next']) {
            expect(CANON_PROMPT).toContain(left);
        }
        // The tiebreaker, and the reason it is the conservative one (plan decision 2).
        expect(CANON_PROMPT).toContain('can never be taken back');
    });

    it('applies ST macros to the template and never to the chat\'s own text', () => {
        const content = canonPromote.build({
            summaries: ['Wren typed {{user}} into the terminal.'],
            room: 1,
            expand: (text) => text.replaceAll('{{user}}', 'EXPANDED'),
        }).messages[0].content;

        expect(content).toContain('Wren typed {{user}} into the terminal.');
        expect(content).not.toContain('EXPANDED');
    });

    it('refuses a request it cannot make sense of rather than sending it', () => {
        expect(() => canonPromote.build({ summaries: [], room: 3 })).toThrow(RangeError);
        expect(() => canonPromote.build({ summaries: null, room: 3 })).toThrow(RangeError);
        expect(() => canonPromote.build({ summaries: SUMMARIES, room: 0 })).toThrow(RangeError);
        expect(() => canonPromote.build({ summaries: SUMMARIES, room: MAX_FACTS_PER_PASS + 1 })).toThrow(RangeError);
        expect(() => canonPromote.build({ summaries: SUMMARIES, room: 2.5 })).toThrow(RangeError);
        expect(() => canonPromote.build({ summaries: SUMMARIES, canon: 'none', room: 3 })).toThrow(TypeError);
    });
});

describe('reading a clean reply', () => {
    it('takes the facts and their tags', () => {
        const parsed = parseCanonReply(JSON.stringify({ promote: MEANT }));

        expect(parsed).toEqual({
            ok: true,
            promote: [
                { text: MEANT[0].fact, entities: ['Wren'] },
                { text: MEANT[1].fact, entities: ['Aster', 'Wren'] },
                { text: MEANT[2].fact, entities: ['Aster', 'Wren'] },
            ],
            dropped: [],
        });
    });

    it('takes a fact with no tags at all', () => {
        const parsed = parseCanonReply('{"promote":[{"fact":"They kissed at the lighthouse."}]}');

        expect(parsed.promote).toEqual([{ text: 'They kissed at the lighthouse.', entities: [] }]);
        expect(parsed.dropped).toEqual([]);
    });

    it('treats an empty list as a real answer, not a failure', () => {
        expect(parseCanonReply('{"promote":[]}')).toEqual({ ok: true, promote: [], dropped: [] });
    });
});

/** CLAUDE.md §3.12: the parser is tested against the catalogue, not against clean JSON. */
describe('reading the replies a model actually sends', () => {
    it('reads through a fence, a preamble and leaked reasoning', () => {
        for (const shape of ['fenced', 'preambleAndSignOff', 'leakedReasoning', 'orphanThinkClose']) {
            const parsed = parseCanonReply(badCanonOutputs[shape](MEANT));

            expect(parsed.ok, shape).toBe(true);
            expect(promoted(parsed), shape).toEqual(MEANT.map((fact) => fact.fact));
        }
    });

    it('rejects a reply that ran out of tokens', () => {
        expect(parseCanonReply(badCanonOutputs.truncated(MEANT))).toEqual({ ok: false, reason: 'truncated' });
        expect(parseCanonReply(badCanonOutputs.unterminatedReasoning())).toEqual({ ok: false, reason: 'truncated' });
    });

    it('tells a refusal apart from a reply it merely cannot read', () => {
        expect(parseCanonReply(badCanonOutputs.refusal())).toEqual({ ok: false, reason: 'refusal' });
        expect(parseCanonReply(badCanonOutputs.prose())).toEqual({ ok: false, reason: 'format' });
        expect(parseCanonReply(badCanonOutputs.empty())).toEqual({ ok: false, reason: 'empty' });
    });

    it('reads "nothing to promote" however the model says it', () => {
        expect(parseCanonReply(badCanonOutputs.nullPromote())).toEqual({ ok: true, promote: [], dropped: [] });
        expect(parseCanonReply(badCanonOutputs.noPromoteKey())).toEqual({ ok: true, promote: [], dropped: [] });
    });

    it('rejects a reply whose shape is not the one asked for', () => {
        expect(parseCanonReply(badCanonOutputs.bareArray(MEANT))).toEqual({ ok: false, reason: 'format' });
        expect(parseCanonReply('{"promote": "Wren\'s brother is dead."}')).toEqual({ ok: false, reason: 'format' });
    });

    it('drops the facts it cannot read and keeps the ones it can', () => {
        const wrongKey = parseCanonReply(badCanonOutputs.wrongKey(MEANT));
        expect(wrongKey.promote).toEqual([]);
        expect(wrongKey.dropped).toEqual(Array(3).fill({ reason: 'no-text' }));

        const strings = parseCanonReply(badCanonOutputs.plainStrings(MEANT));
        expect(strings.promote).toEqual([]);
        expect(strings.dropped).toEqual(Array(3).fill({ reason: 'not-a-fact' }));
    });

    it('drops a fact over its cap rather than cutting it, and keeps the rest', () => {
        const parsed = parseCanonReply(badCanonOutputs.overlong(MEANT));

        expect(promoted(parsed)).toEqual([MEANT[1].fact, MEANT[2].fact]);
        expect(parsed.dropped).toEqual([{ reason: 'fact-too-long' }]);
    });

    it('keeps a fact whose tags are the problem, dropping only the tags', () => {
        const many = parseCanonReply(badCanonOutputs.manyEntities(MEANT));
        expect(many.promote[0].entities).toEqual(['Wren', 'Aster', 'the flood', 'the harbour']);
        expect(many.dropped).toEqual(Array(2).fill({ reason: 'too-many-entities' }));

        const sentence = parseCanonReply(badCanonOutputs.entitySentence(MEANT));
        expect(sentence.promote[0]).toEqual({ text: MEANT[0].fact, entities: [] });
        expect(sentence.dropped).toEqual([{ reason: 'entity-too-long' }]);
    });

    it('takes only the facts there was room for, counting the rest', () => {
        const parsed = parseCanonReply(badCanonOutputs.overRoom(), { room: 3 });

        expect(parsed.promote).toHaveLength(3);
        expect(parsed.dropped).toEqual(Array(9).fill({ reason: 'over-room' }));
    });

    it('never takes more than one pass may promote, whatever room it is told', () => {
        const parsed = parseCanonReply(badCanonOutputs.overRoom(), { room: 99 });

        expect(parsed.promote).toHaveLength(MAX_FACTS_PER_PASS);
    });

    it('promotes a mood the prompt told it to leave, which only the run can catch', () => {
        // The parser cannot tell a fact from a feeling. This is why §5's quality read
        // reads the promoted facts rather than only counting them.
        const parsed = parseCanonReply(badCanonOutputs.mood(MEANT));

        expect(promoted(parsed)).toContain('Aster was shaken by the question.');
    });
});
