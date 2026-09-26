import { describe, expect, it } from 'vitest';
import { CHARACTER_FIELDS, TEXT_FIELDS, mergeReply, validState } from '../src/memory/state-schema.js';
import {
    STATE_MAX_EARLIER,
    STATE_MAX_MESSAGES,
    STATE_MAX_TOKENS,
    STATE_PROMPT,
    parseStateReply,
    resolveStatePrompt,
    stateRecord,
} from '../src/memory/state-strategy.js';
import { hashString } from '../src/util/hash.js';
import { badStateOutputs } from './mocks/llm.js';
import { createContext } from './mocks/sillytavern.js';

/** Synthetic, and the shape of test/fixtures/store-v2.js: two characters present. */
const STATE = Object.freeze({
    location: 'The ferry terminal, waiting room',
    weather: 'Drizzle outside; damp and cold indoors',
    characters: Object.freeze({
        Aster: Object.freeze({ hair: 'Pinned up', outfit: 'Oilskin coat over a fisherman\'s jumper' }),
        Wren: Object.freeze({ hair: 'Loose, damp from the rain', outfit: 'Wool coat over a grey jumper, jeans, boots' }),
    }),
});

/** What the model meant: the whole record after Wren takes off her coat and walks out to the pier. */
const REPLY = Object.freeze({
    location: 'The ferry terminal, outer pier',
    weather: STATE.weather,
    characters: Object.freeze({
        Aster: Object.freeze({ ...STATE.characters.Aster }),
        Wren: Object.freeze({ hair: STATE.characters.Wren.hair, outfit: 'Grey jumper, jeans, boots' }),
    }),
});

const AFTER = {
    ...STATE,
    location: REPLY.location,
    characters: { Aster: STATE.characters.Aster, Wren: { ...STATE.characters.Wren, outfit: REPLY.characters.Wren.outfit } },
};

/** Synthetic, the shape of a corpus exchange: the user's turn, then the reply. */
const MESSAGES = [
    { name: 'Wren', is_user: true, mes: 'Wren pushed through the doors and out onto the pier.\n\n"I need air."' },
    { name: 'Aster', is_user: false, mes: 'Aster followed and leaned on the rail beside her. The wind had dropped, and Wren\'s shoulders came down with it.' },
];

/** Everything above the record: one set of instructions now, with no branches (D-0053). */
const INSTRUCTIONS = STATE_PROMPT.slice(0, STATE_PROMPT.indexOf('Current record:'));

describe('the state prompt', () => {
    it('lists exactly the schema\'s fields, in render order', () => {
        const top = [...STATE_PROMPT.matchAll(/^- (\w+):/gm)].map((match) => match[1]);
        const nested = [...STATE_PROMPT.matchAll(/^ {2}- (\w+):/gm)].map((match) => match[1]);

        expect(top).toEqual([...Object.keys(TEXT_FIELDS), 'characters']);
        expect(nested).toEqual(Object.keys(CHARACTER_FIELDS));
    });

    it('tells the model each field\'s cap, taken from the schema', () => {
        for (const [field, cap] of Object.entries({ ...TEXT_FIELDS, ...CHARACTER_FIELDS })) {
            expect(STATE_PROMPT, field).toMatch(new RegExp(`^ *- ${field}: .*\\(${cap}\\)$`, 'm'));
        }
        expect(STATE_PROMPT).toMatch(/^- characters: .*at most 5, keyed by name \(40\)/m);
    });

    it('shows a whole record in and a whole record out, which the parser and schema accept', () => {
        const record = JSON.parse(STATE_PROMPT.match(/^Record: (.*)$/m)[1]);
        const parsed = parseStateReply(STATE_PROMPT.match(/^Reply: (.*)$/m)[1]);

        expect(validState(record)).toBe(true);
        expect(parsed.ok).toBe(true);
        // Every field the record carries comes back, weather copied across unchanged.
        expect(Object.keys(parsed.record)).toEqual(Object.keys(record));
        expect(parsed.record.weather).toBe(record.weather);
        expect(mergeReply(record, parsed.record)).toEqual({
            value: {
                location: 'The ferry terminal, outer pier',
                weather: record.weather,
                characters: { Wren: { hair: 'Tied back', outfit: 'Grey jumper, jeans, boots' } },
            },
            changed: ['location', 'characters.hair', 'characters.outfit'],
            dropped: [],
        });
    });

    it('asks for the whole record, with no changes-only branch left (D-0053)', () => {
        expect(STATE_PROMPT).not.toMatch(/\{\{#if (first|update)\}\}/);
        expect(STATE_PROMPT).not.toContain('Include only what the messages change');
        expect(STATE_PROMPT).not.toContain('null');
        expect(STATE_PROMPT).toContain('Write every field every time');
    });

    it('has no macros ST would expand', () => {
        expect(STATE_PROMPT.replace(/\{\{(?:state|earlier|messages|#if earlier|\/if)\}\}/g, '')).not.toContain('{{');
    });
});

describe('building one state request', () => {
    const context = createContext();
    const expand = (text) => context.substituteParams(text);

    it('sends the record, then the messages, as one user message with room for a reasoning model', () => {
        const request = stateRecord.build({ state: STATE, messages: MESSAGES, expand });

        expect(stateRecord.id).toBe('state-record-v1');
        expect(request.maxTokens).toBe(STATE_MAX_TOKENS);
        expect(STATE_MAX_TOKENS).toBe(2048);
        expect(request.messages).toEqual([{
            role: 'user',
            content: `${INSTRUCTIONS}Current record:\n${JSON.stringify(STATE)}\n\n`
                + `New messages:\nWren: ${MESSAGES[0].mes}\n\nAster: ${MESSAGES[1].mes}\n\n`
                + 'Reply with the complete record as JSON, and nothing else.',
        }]);
    });

    it('sends the same instructions whatever the record holds, so one prompt hash covers every state (D-0053)', () => {
        const contents = [STATE, { characters: { Wren: {} } }, {}, undefined]
            .map((state) => stateRecord.build({ state, messages: MESSAGES, expand }).messages[0].content);

        for (const content of contents) {
            expect(content.startsWith(INSTRUCTIONS)).toBe(true);
            expect(content).not.toContain('{{');
        }
        expect(INSTRUCTIONS).not.toMatch(/\n{3,}/);
    });

    it('sends {} on a cold start', () => {
        for (const request of [
            stateRecord.build({ messages: MESSAGES, expand }),
            stateRecord.build({ state: {}, messages: MESSAGES, expand }),
        ]) {
            expect(request.messages[0].content).toContain('Current record:\n{}\n\nNew messages:\n');
        }
    });

    it('puts earlier scenes between the record and the messages', () => {
        const request = stateRecord.build({
            messages: MESSAGES,
            earlier: ['Wren and Aster reached the terminal.', { text: 'The board read DELAYED.' }],
            expand,
        });

        expect(request.messages[0].content).toContain(
            'Current record:\n{}\n\nEarlier events:\nWren and Aster reached the terminal.\nThe board read DELAYED.\n\nNew messages:\nWren: ',
        );
    });

    it('records which prompt wrote the state', () => {
        expect(stateRecord.build({ messages: MESSAGES, expand }).prompt).toBe(hashString(STATE_PROMPT));
    });

    it('sends chat text and state values containing {{user}} literally', () => {
        const state = { location: 'The {{char}} Arms' };
        const messages = [{ name: 'Wren', mes: 'I wrote {{user}} and {{char}} in my diary.' }];
        const content = stateRecord.build({ state, messages, earlier: ['{{char}} was quiet.'], expand }).messages[0].content;

        expect(content).toContain('{"location":"The {{char}} Arms"}');
        expect(content).toContain('Wren: I wrote {{user}} and {{char}} in my diary.');
        expect(content).toContain('{{char}} was quiet.');
    });

    it('refuses a request the caller got wrong, rather than sending it', () => {
        const six = Array(STATE_MAX_MESSAGES).fill(MESSAGES[0]);
        const five = Array(STATE_MAX_EARLIER).fill('An earlier scene.');

        expect(() => stateRecord.build({ messages: six, earlier: five, expand })).not.toThrow();
        expect(() => stateRecord.build({ messages: [...six, MESSAGES[1]], expand })).toThrow(RangeError);
        expect(() => stateRecord.build({ messages: MESSAGES, earlier: [...five, 'one more'], expand })).toThrow(RangeError);
        expect(() => stateRecord.build({ messages: [], expand })).toThrow(RangeError);
        expect(() => stateRecord.build({ expand })).toThrow(RangeError);
        expect(() => stateRecord.build({ state: { mood: 'calm' }, messages: MESSAGES, expand })).toThrow(TypeError);
    });
});

/**
 * The parser and the merge against every reply in the catalogue (CLAUDE.md §3.12).
 * A reply is rejected whole with a reason, or its patch applies with every
 * schema-breaking field dropped and counted.
 */
describe('parsing and applying a state reply', () => {
    const applied = (value, changed, dropped = []) => ({ ok: true, value, changed, dropped });
    const rejected = (reason) => ({ ok: false, reason });
    const moved = ['location', 'characters.outfit'];

    const expected = {
        fenced: applied(AFTER, moved),
        preambleAndSignOff: applied(AFTER, moved),
        leakedReasoning: applied(AFTER, moved),
        orphanThinkClose: applied(AFTER, moved),
        capitalisedKeys: applied(AFTER, moved),

        // The point of D-0053: what a reply leaves out keeps its stored bytes, so a
        // record that loses hair, or the cast, or everything but one field, loses nothing.
        missingFields: applied(AFTER, moved),
        sparse: applied({ ...STATE, location: REPLY.location }, ['location']),
        emptyCast: applied({ ...STATE, location: REPLY.location }, ['location'], [{ field: 'characters', reason: 'empty' }]),

        // Leaving a character out is the one thing that does remove something.
        castDropped: applied(
            { ...STATE, location: REPLY.location, characters: { Wren: AFTER.characters.Wren } },
            ['location', 'characters.left', 'characters.outfit'],
        ),

        unknownField: applied(AFTER, moved, [{ field: 'unknown', reason: 'unknown-key' }]),
        wrongType: applied(AFTER, moved, [{ field: 'weather', reason: 'wrong-type' }]),
        overlong: applied({ ...AFTER, location: STATE.location }, ['characters.outfit'], [{ field: 'location', reason: 'too-long' }]),
        sixCharacters: applied(
            { ...AFTER, characters: { ...AFTER.characters, Bram: { outfit: 'Harbour uniform' }, Cora: { hair: 'Short and grey' }, Dell: {} } },
            ['location', 'characters.arrived', 'characters.outfit'],
            [{ field: 'characters', reason: 'too-many' }],
        ),
        unknownSubKey: applied(AFTER, moved, [{ field: 'characters.unknown', reason: 'unknown-key' }]),
        noChange: applied(STATE, []),
        // A model still writing nulls: the weather null is refused, Aster's removes her.
        nullRemovals: applied(
            { ...STATE, location: REPLY.location, characters: { Wren: AFTER.characters.Wren } },
            ['location', 'characters.left', 'characters.outfit'],
            [{ field: 'weather', reason: 'blank' }],
        ),
        truncated: rejected('truncated'),
        unterminatedReasoning: rejected('truncated'),
        refusal: rejected('refusal'),
        prose: rejected('format'),
        array: rejected('format'),
        empty: rejected('empty'),
    };

    it('has a verdict for every entry in badStateOutputs', () => {
        expect(Object.keys(expected).sort()).toEqual(Object.keys(badStateOutputs).sort());
    });

    for (const [name, verdict] of Object.entries(expected)) {
        it(`${verdict.ok ? 'applies' : 'rejects'} ${name}`, () => {
            const parsed = stateRecord.parse(badStateOutputs[name](REPLY, STATE));

            if (!verdict.ok) {
                expect(parsed).toEqual(verdict);
                return;
            }
            expect(parsed.ok).toBe(true);
            const { value, changed, dropped } = mergeReply(STATE, parsed.record);
            expect({ ok: true, value, changed, dropped }).toEqual(verdict);
        });
    }
});

describe('finding the record in a reply', () => {
    const json = JSON.stringify(REPLY);

    it('takes a clean reply as it is', () => {
        expect(parseStateReply(json)).toEqual({ ok: true, record: REPLY });
    });

    it('takes the first object that parses, not whatever sits between the outermost braces', () => {
        expect(parseStateReply(`${json}\n\nIf you want {more} detail, just ask.`)).toEqual({ ok: true, record: REPLY });
        expect(parseStateReply(`${json}\n{"location": "somewhere else"}`)).toEqual({ ok: true, record: REPLY });
    });

    it('skips bracketed prose before the record', () => {
        expect(parseStateReply(`[Current scene] changes {as asked}:\n${json}`)).toEqual({ ok: true, record: REPLY });
    });

    it('never takes an object nested inside one that does not parse', () => {
        expect(parseStateReply('{"characters": {"Wren": {"outfit": "Grey jumper"}},}')).toEqual({ ok: false, reason: 'format' });
    });

    it('reads brackets and quotes inside strings as text', () => {
        const record = { location: 'Under a sign reading "} ]" on the {board}', weather: 'A back\\slash of rain' };

        expect(parseStateReply(`Record:\n${JSON.stringify(record)}`)).toEqual({ ok: true, record });
    });

    it('calls a reply cut off inside a nested object truncated, though it has closing braces', () => {
        expect(parseStateReply('{"characters": {"Wren": {"outfit": "Grey jumper"}, "Aster": {"ou'))
            .toEqual({ ok: false, reason: 'truncated' });
        expect(parseStateReply('```json\n{"location": "The ferry')).toEqual({ ok: false, reason: 'truncated' });
    });

    it('rejects JSON that is not an object', () => {
        for (const reply of ['null', '"calmer"', '42', '[]', '```json\n["location"]\n```']) {
            expect(parseStateReply(reply), reply).toEqual({ ok: false, reason: 'format' });
        }
    });

    it('rejects JSON a strict parser would', () => {
        for (const reply of ['{location: "The pier"}', '{"location": \'The pier\'}', '{"location": "The pier",}']) {
            expect(parseStateReply(reply), reply).toEqual({ ok: false, reason: 'format' });
        }
    });

    it('recognises refusals however the apostrophe is typed', () => {
        for (const refusal of ['I cannot continue this roleplay.', 'Sorry, I can\'t help with that [scene].', 'As an AI, I won’t write this.']) {
            expect(parseStateReply(refusal), refusal).toEqual({ ok: false, reason: 'refusal' });
        }
    });

    it('treats a missing, non-string or thought-only reply as empty', () => {
        expect(parseStateReply(undefined)).toEqual({ ok: false, reason: 'empty' });
        expect(parseStateReply({ location: 'x' })).toEqual({ ok: false, reason: 'empty' });
        expect(parseStateReply('<think>nothing changed</think>\n  ')).toEqual({ ok: false, reason: 'empty' });
    });
});

describe('an edited state prompt (docs/decisions.md D-0085)', () => {
    const messages = [{ name: 'Wren', mes: 'Wren ties her hair back.' }];

    it('is sent as written when it keeps the record and the messages', () => {
        const edited = 'Record: {{state}}\nNew: {{messages}}';
        const request = stateRecord.build({ state: {}, messages, template: edited });
        expect(request.messages[0].content).toBe('Record: {}\nNew: Wren: Wren ties her hair back.');
        expect(request.prompt).toBe(hashString(edited));
        expect(request.fallback).toBe(false);
    });

    it('falls back to the built-in prompt when either is missing', () => {
        for (const broken of ['New: {{messages}}', 'Record: {{state}}']) {
            const request = stateRecord.build({ state: {}, messages, template: broken });
            expect(request.prompt).toBe(hashString(STATE_PROMPT));
            expect(request.fallback).toBe(true);
        }
        expect(resolveStatePrompt('   ')).toEqual({ template: STATE_PROMPT, edited: false, fallback: false });
    });
});
