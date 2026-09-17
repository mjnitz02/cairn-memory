import { describe, expect, it } from 'vitest';
import { CHARACTER_FIELDS, TEXT_FIELDS, applyPatch, validState } from '../src/memory/state-schema.js';
import {
    STATE_MAX_EARLIER,
    STATE_MAX_MESSAGES,
    STATE_MAX_TOKENS,
    STATE_PROMPT,
    parseStatePatch,
    statePatch,
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

/** What the model meant: Wren takes off her coat and walks out to the pier. */
const PATCH = Object.freeze({
    location: 'The ferry terminal, outer pier',
    characters: Object.freeze({ Wren: Object.freeze({ outfit: 'Grey jumper, jeans, boots' }) }),
});

const AFTER = {
    ...STATE,
    location: PATCH.location,
    characters: { Aster: STATE.characters.Aster, Wren: { ...STATE.characters.Wren, outfit: PATCH.characters.Wren.outfit } },
};

/** Synthetic, the shape of a corpus exchange: the user's turn, then the reply. */
const MESSAGES = [
    { name: 'Wren', is_user: true, mes: 'Wren pushed through the doors and out onto the pier.\n\n"I need air."' },
    { name: 'Aster', is_user: false, mes: 'Aster followed and leaned on the rail beside her. The wind had dropped, and Wren\'s shoulders came down with it.' },
];

/** The instructions as the model reads them: a first build's lines, or an update's. */
const instructions = (mode) => STATE_PROMPT.slice(0, STATE_PROMPT.indexOf('Current state:'))
    .replace(/\{\{#if (first|update)\}\}\n([\s\S]*?)\{\{\/if\}\}\n/g, (_, name, body) => (name === mode ? body : ''));

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

    it('gives an example the parser and schema accept whole', () => {
        const state = JSON.parse(STATE_PROMPT.match(/^State: (.*)$/m)[1]);
        const parsed = parseStatePatch(STATE_PROMPT.match(/^Patch: (.*)$/m)[1]);

        expect(validState(state)).toBe(true);
        expect(parsed.ok).toBe(true);
        expect(applyPatch(state, parsed.patch)).toEqual({
            value: {
                location: 'The ferry terminal, outer pier',
                characters: { Wren: { hair: 'Tied back', outfit: 'Grey jumper, jeans, boots' } },
            },
            changed: ['location', 'characters.hair', 'characters.outfit'],
            dropped: [],
        });
    });

    it('has no macros ST would expand', () => {
        expect(STATE_PROMPT.replace(/\{\{(?:state|earlier|messages|#if (?:earlier|first|update)|\/if)\}\}/g, '')).not.toContain('{{');
    });
});

describe('building one state request', () => {
    const context = createContext();
    const expand = (text) => context.substituteParams(text);

    it('sends the state, then the messages, as one user message with room for a reasoning model', () => {
        const request = statePatch.build({ state: STATE, messages: MESSAGES, expand });

        expect(statePatch.id).toBe('state-patch-v1');
        expect(request.maxTokens).toBe(STATE_MAX_TOKENS);
        expect(STATE_MAX_TOKENS).toBe(2048);
        expect(request.messages).toEqual([{
            role: 'user',
            content: `${instructions('update')}Current state:\n${JSON.stringify(STATE)}\n\n`
                + `New messages:\nWren: ${MESSAGES[0].mes}\n\nAster: ${MESSAGES[1].mes}\n\n`
                + 'Reply with the JSON patch only.',
        }]);
    });

    it('asks for only what changed once the record holds anything', () => {
        for (const state of [STATE, { characters: { Wren: {} } }]) {
            const content = statePatch.build({ state, messages: MESSAGES, expand }).messages[0].content;

            expect(content.startsWith(instructions('update'))).toBe(true);
            expect(content).not.toContain('first entry');
        }
    });

    it('asks a first build for everything the messages establish, not only what changed (D-0048)', () => {
        for (const state of [undefined, {}]) {
            const content = statePatch.build({ state, messages: MESSAGES, expand }).messages[0].content;

            expect(content.startsWith(instructions('first'))).toBe(true);
            expect(content).toMatch(/^IMPORTANT: The record is empty.*including hair and outfit/m);
            expect(content).not.toContain('Include only what the messages change');
            expect(content).not.toContain('When unsure whether something changed');
            expect(content).not.toContain('{{');
        }
        expect(instructions('first')).not.toMatch(/\n{3,}/);
        expect(instructions('update')).not.toMatch(/\n{3,}/);
    });

    it('sends {} on a cold start', () => {
        for (const request of [
            statePatch.build({ messages: MESSAGES, expand }),
            statePatch.build({ state: {}, messages: MESSAGES, expand }),
        ]) {
            expect(request.messages[0].content).toContain('Current state:\n{}\n\nNew messages:\n');
        }
    });

    it('puts earlier scenes between the state and the messages', () => {
        const request = statePatch.build({
            messages: MESSAGES,
            earlier: ['Wren and Aster reached the terminal.', { text: 'The board read DELAYED.' }],
            expand,
        });

        expect(request.messages[0].content).toContain(
            'Current state:\n{}\n\nEarlier events:\nWren and Aster reached the terminal.\nThe board read DELAYED.\n\nNew messages:\nWren: ',
        );
    });

    it('records which prompt wrote the state', () => {
        expect(statePatch.build({ messages: MESSAGES, expand }).prompt).toBe(hashString(STATE_PROMPT));
    });

    it('sends chat text and state values containing {{user}} literally', () => {
        const state = { location: 'The {{char}} Arms' };
        const messages = [{ name: 'Wren', mes: 'I wrote {{user}} and {{char}} in my diary.' }];
        const content = statePatch.build({ state, messages, earlier: ['{{char}} was quiet.'], expand }).messages[0].content;

        expect(content).toContain('{"location":"The {{char}} Arms"}');
        expect(content).toContain('Wren: I wrote {{user}} and {{char}} in my diary.');
        expect(content).toContain('{{char}} was quiet.');
    });

    it('refuses a request the caller got wrong, rather than sending it', () => {
        const six = Array(STATE_MAX_MESSAGES).fill(MESSAGES[0]);
        const five = Array(STATE_MAX_EARLIER).fill('An earlier scene.');

        expect(() => statePatch.build({ messages: six, earlier: five, expand })).not.toThrow();
        expect(() => statePatch.build({ messages: [...six, MESSAGES[1]], expand })).toThrow(RangeError);
        expect(() => statePatch.build({ messages: MESSAGES, earlier: [...five, 'one more'], expand })).toThrow(RangeError);
        expect(() => statePatch.build({ messages: [], expand })).toThrow(RangeError);
        expect(() => statePatch.build({ expand })).toThrow(RangeError);
        expect(() => statePatch.build({ state: { mood: 'calm' }, messages: MESSAGES, expand })).toThrow(TypeError);
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
        fullState: applied(AFTER, moved),
        capitalisedKeys: applied(AFTER, moved),
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
        nullRemovals: (() => {
            const { weather: _weather, ...rest } = AFTER;
            return applied({ ...rest, characters: { Wren: AFTER.characters.Wren } }, ['location', 'weather', 'characters.left', 'characters.outfit']);
        })(),
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
            const parsed = statePatch.parse(badStateOutputs[name](PATCH, STATE));

            if (!verdict.ok) {
                expect(parsed).toEqual(verdict);
                return;
            }
            expect(parsed.ok).toBe(true);
            const { value, changed, dropped } = applyPatch(STATE, parsed.patch);
            expect({ ok: true, value, changed, dropped }).toEqual(verdict);
        });
    }
});

describe('finding the patch in a reply', () => {
    const json = JSON.stringify(PATCH);

    it('takes a clean reply as it is', () => {
        expect(parseStatePatch(json)).toEqual({ ok: true, patch: PATCH });
    });

    it('takes the first object that parses, not whatever sits between the outermost braces', () => {
        expect(parseStatePatch(`${json}\n\nIf you want {more} detail, just ask.`)).toEqual({ ok: true, patch: PATCH });
        expect(parseStatePatch(`${json}\n{"location": "somewhere else"}`)).toEqual({ ok: true, patch: PATCH });
    });

    it('skips bracketed prose before the patch', () => {
        expect(parseStatePatch(`[Current scene] changes {as asked}:\n${json}`)).toEqual({ ok: true, patch: PATCH });
    });

    it('never takes an object nested inside one that does not parse', () => {
        expect(parseStatePatch('{"characters": {"Wren": {"outfit": "Grey jumper"}},}')).toEqual({ ok: false, reason: 'format' });
    });

    it('reads brackets and quotes inside strings as text', () => {
        const patch = { location: 'Under a sign reading "} ]" on the {board}', weather: 'A back\\slash of rain' };

        expect(parseStatePatch(`Patch:\n${JSON.stringify(patch)}`)).toEqual({ ok: true, patch });
    });

    it('calls a reply cut off inside a nested object truncated, though it has closing braces', () => {
        expect(parseStatePatch('{"characters": {"Wren": {"outfit": "Grey jumper"}, "Aster": {"ou'))
            .toEqual({ ok: false, reason: 'truncated' });
        expect(parseStatePatch('```json\n{"location": "The ferry')).toEqual({ ok: false, reason: 'truncated' });
    });

    it('rejects JSON that is not an object', () => {
        for (const reply of ['null', '"calmer"', '42', '[]', '```json\n["location"]\n```']) {
            expect(parseStatePatch(reply), reply).toEqual({ ok: false, reason: 'format' });
        }
    });

    it('rejects JSON a strict parser would', () => {
        for (const reply of ['{location: "The pier"}', '{"location": \'The pier\'}', '{"location": "The pier",}']) {
            expect(parseStatePatch(reply), reply).toEqual({ ok: false, reason: 'format' });
        }
    });

    it('recognises refusals however the apostrophe is typed', () => {
        for (const refusal of ['I cannot continue this roleplay.', 'Sorry, I can\'t help with that [scene].', 'As an AI, I won’t write this.']) {
            expect(parseStatePatch(refusal), refusal).toEqual({ ok: false, reason: 'refusal' });
        }
    });

    it('treats a missing, non-string or thought-only reply as empty', () => {
        expect(parseStatePatch(undefined)).toEqual({ ok: false, reason: 'empty' });
        expect(parseStatePatch({ location: 'x' })).toEqual({ ok: false, reason: 'empty' });
        expect(parseStatePatch('<think>nothing changed</think>\n  ')).toEqual({ ok: false, reason: 'empty' });
    });
});
