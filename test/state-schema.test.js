import { describe, expect, it } from 'vitest';
import {
    CHANGE_KINDS,
    CHARACTER_FIELDS,
    MAX_CHARACTERS,
    MAX_NAME_CHARS,
    MAX_STATE_CHARS,
    STATE_HEADER,
    TEXT_FIELDS,
    applyPatch,
    renderState,
    validState,
} from '../src/memory/state-schema.js';
import { STORE_V2 } from './fixtures/store-v2.js';
import { mulberry32 } from './helpers/random.js';

/** Synthetic. Two characters with typical values: about Esin's WTrackerLite JSON size (docs/p3-plan.md decision 4). */
const TERMINAL = Object.freeze({
    location: 'The ferry terminal, waiting room',
    weather: 'Drizzle outside; damp and cold indoors',
    characters: Object.freeze({
        Aster: Object.freeze({ hair: 'Pinned up', outfit: 'Oilskin coat over a fisherman\'s jumper' }),
        Wren: Object.freeze({ hair: 'Loose, damp from the rain', outfit: 'Wool coat over a grey jumper, jeans, boots' }),
    }),
});

const x = (n) => 'x'.repeat(n);

function deepFreeze(value) {
    if (typeof value === 'object' && value !== null) {
        Object.values(value).forEach(deepFreeze);
        Object.freeze(value);
    }
    return value;
}

describe('the schema', () => {
    it('is WTrackerLite\'s fields, with the plan\'s caps (docs/p3-plan.md decision 4)', () => {
        expect(TEXT_FIELDS).toEqual({ location: 120, weather: 80 });
        expect(CHARACTER_FIELDS).toEqual({ hair: 80, outfit: 120 });
        expect([MAX_CHARACTERS, MAX_NAME_CHARS]).toEqual([5, 40]);
    });

    it('accepts the v2 fixture\'s stored state', () => {
        expect(validState(STORE_V2.state.value)).toBe(true);
        expect(STORE_V2.state.changed.every((kind) => CHANGE_KINDS.includes(kind))).toBe(true);
    });

    it('rejects what applyPatch never writes', () => {
        expect(validState({})).toBe(true);
        for (const bad of [
            null, [], 'The pier',
            { time: 'Evening' },
            { threads: ['Whether the ferry runs'] },
            { location: '' },
            { location: '   ' },
            { location: 7 },
            { location: x(121) },
            { characters: {} },
            { characters: { Wren: { mood: 'calm' } } },
            { characters: { Wren: { outfit: x(121) } } },
            { characters: { Wren: 'present' } },
            { characters: { 7: {} } },
            { characters: { [x(41)]: {} } },
            { characters: Object.fromEntries(['A', 'B', 'C', 'D', 'E', 'F'].map((name) => [name, {}])) },
        ]) {
            expect(validState(bad), JSON.stringify(bad)).toBe(false);
        }
    });
});

describe('applying a patch', () => {
    it('changes what the patch names and keeps every other field\'s bytes', () => {
        const { value, changed, dropped } = applyPatch(TERMINAL, {
            location: 'The ferry terminal, outer pier',
            characters: { Wren: { outfit: 'Grey jumper, jeans, boots' } },
        });

        expect(value).toEqual({
            ...TERMINAL,
            location: 'The ferry terminal, outer pier',
            characters: { ...TERMINAL.characters, Wren: { ...TERMINAL.characters.Wren, outfit: 'Grey jumper, jeans, boots' } },
        });
        expect(changed).toEqual(['location', 'characters.outfit']);
        expect(dropped).toEqual([]);
    });

    it('reads {} as no change', () => {
        expect(applyPatch(TERMINAL, {})).toEqual({ value: TERMINAL, changed: [], dropped: [] });
    });

    it('records nothing when a patch repeats current values, as a model resending the whole state does', () => {
        const { value, changed } = applyPatch(TERMINAL, structuredClone(TERMINAL));

        expect(value).toEqual(TERMINAL);
        expect(changed).toEqual([]);
    });

    it('builds a state from {} on a cold start', () => {
        const { value, changed } = applyPatch({}, structuredClone(TERMINAL));

        expect(value).toEqual(TERMINAL);
        expect(changed).toEqual(['location', 'weather', 'characters.arrived']);
    });

    it('clears a field on null or a blank string, leaving it out rather than empty', () => {
        const { value, changed } = applyPatch(TERMINAL, { weather: null, location: '  ', characters: { Aster: { hair: '' } } });

        expect(value).not.toHaveProperty('weather');
        expect(value).not.toHaveProperty('location');
        expect(value.characters.Aster).toEqual({ outfit: TERMINAL.characters.Aster.outfit });
        expect(changed).toEqual(['location', 'weather', 'characters.hair']);
        expect(validState(value)).toBe(true);
    });

    it('matches key names case-insensitively', () => {
        const { value, dropped } = applyPatch(TERMINAL, { Location: 'The pier', CHARACTERS: { Wren: { Outfit: 'Grey jumper' } } });

        expect(value.location).toBe('The pier');
        expect(value.characters.Wren.outfit).toBe('Grey jumper');
        expect(dropped).toEqual([]);
    });

    it('takes the first spelling of a key and drops the second', () => {
        const { value, dropped } = applyPatch(TERMINAL, { location: 'The pier', Location: 'The car park' });

        expect(value.location).toBe('The pier');
        expect(dropped).toEqual([{ field: 'location', reason: 'duplicate-key' }]);
    });

    describe('characters', () => {
        it('reaches a character by name whatever the case, keeping the stored spelling', () => {
            const { value, changed } = applyPatch(TERMINAL, { characters: { wren: { hair: 'Tied back' } } });

            expect(Object.keys(value.characters)).toEqual(['Aster', 'Wren']);
            expect(value.characters.Wren.hair).toBe('Tied back');
            expect(changed).toEqual(['characters.hair']);
        });

        it('appends a newcomer after everyone already present', () => {
            const { value, changed } = applyPatch(TERMINAL, {
                characters: { Brannock: { hair: 'Cropped', outfit: 'Harbour uniform' } },
            });

            expect(Object.keys(value.characters)).toEqual(['Aster', 'Wren', 'Brannock']);
            expect(changed).toEqual(['characters.arrived']);
        });

        it('keeps a newcomer with no fields, since being present is news', () => {
            const { value } = applyPatch(TERMINAL, { characters: { Brannock: {} } });

            expect(value.characters.Brannock).toEqual({});
            expect(validState(value)).toBe(true);
        });

        it('removes a character on null, and all of them on characters: null', () => {
            const one = applyPatch(TERMINAL, { characters: { Aster: null } });
            expect(Object.keys(one.value.characters)).toEqual(['Wren']);
            expect(one.changed).toEqual(['characters.left']);

            const all = applyPatch(TERMINAL, { characters: null });
            expect(all.value).not.toHaveProperty('characters');
            expect(all.changed).toEqual(['characters.left']);
        });

        it('lets one leave and another arrive in the same patch at the cap', () => {
            const five = applyPatch({}, { characters: Object.fromEntries(['A', 'B', 'C', 'D', 'E'].map((n) => [`Crew ${n}`, {}])) }).value;
            const { value, dropped } = applyPatch(five, { characters: { 'Crew F': { outfit: 'Deck boots' }, 'Crew A': null } });

            expect(Object.keys(value.characters)).toEqual(['Crew B', 'Crew C', 'Crew D', 'Crew E', 'Crew F']);
            expect(dropped).toEqual([]);
        });

        it('changes nothing when removing a character who is not present', () => {
            expect(applyPatch(TERMINAL, { characters: { Brannock: null } })).toEqual({ value: TERMINAL, changed: [], dropped: [] });
        });
    });

    it('never mutates the current state or the patch, and shares no object with either', () => {
        const current = deepFreeze(structuredClone(TERMINAL));
        const patch = deepFreeze({ characters: { Wren: { hair: 'Tied back' }, Brannock: { outfit: 'Harbour uniform' } } });

        const { value } = applyPatch(current, patch);

        expect(current).toEqual(TERMINAL);
        expect(value.characters).not.toBe(current.characters);
        expect(value.characters.Aster).not.toBe(current.characters.Aster);
        expect(value.characters.Brannock).not.toBe(patch.characters.Brannock);
    });

    it('refuses a patch that is not an object and a current state that is not valid', () => {
        for (const patch of [null, [], 'no change', 3]) {
            expect(() => applyPatch(TERMINAL, patch)).toThrow(TypeError);
        }
        expect(() => applyPatch({ location: x(121) }, {})).toThrow(TypeError);
        expect(() => applyPatch(undefined, {})).toThrow(TypeError);
    });
});

describe('dropping what breaks the schema', () => {
    /** Each drops exactly one field; the location change beside it always applies. */
    const cases = [
        ['a time of day, which the roleplay model keeps', { time: 'Late evening' }, { field: 'unknown', reason: 'unknown-key' }],
        ['open threads, which the roleplay model keeps', { threads: ['Whether the ferry runs'] }, { field: 'unknown', reason: 'unknown-key' }],
        ['WTrackerLite\'s list of who is present', { charactersPresent: ['Wren'] }, { field: 'unknown', reason: 'unknown-key' }],
        ['a wrong type', { weather: { condition: 'Rain' } }, { field: 'weather', reason: 'wrong-type' }],
        ['a value over its cap', { weather: x(81) }, { field: 'weather', reason: 'too-long' }],
        ['a character sub-field over its cap', { characters: { Wren: { hair: x(81) } } }, { field: 'characters.hair', reason: 'too-long' }],
        ['a mood, which the roleplay model keeps', { characters: { Wren: { mood: 'calmer' } } }, { field: 'characters.unknown', reason: 'unknown-key' }],
        ['a character that is not an object', { characters: { Wren: 'still here' } }, { field: 'characters', reason: 'wrong-type' }],
        ['characters as a list', { characters: ['Wren'] }, { field: 'characters', reason: 'wrong-type' }],
        ['a name over its cap', { characters: { [x(41)]: {} } }, { field: 'characters', reason: 'bad-name' }],
        ['a blank name', { characters: { ' ': {} } }, { field: 'characters', reason: 'bad-name' }],
        ['an integer-like name, which would enumerate out of order', { characters: { 7: {} } }, { field: 'characters', reason: 'bad-name' }],
        ['__proto__ as a name', JSON.parse('{"characters": {"__proto__": {"hair": "Slicked back"}}}'), { field: 'characters', reason: 'bad-name' }],
        ['the same character twice', { characters: { Wren: { hair: 'Tied back' }, WREN: { hair: 'Loose' } } }, { field: 'characters', reason: 'duplicate-key' }],
        ['an outfit as a list of garments', { characters: { Wren: { outfit: ['Jumper', 'jeans'] } } }, { field: 'characters.outfit', reason: 'wrong-type' }],
    ];

    it.each(cases)('drops %s and applies the rest', (_label, bad, drop) => {
        const { value, dropped } = applyPatch(TERMINAL, { location: 'The pier', ...bad });

        expect(dropped).toEqual([drop]);
        expect(value.location).toBe('The pier');
        expect(validState(value)).toBe(true);
    });

    it('keeps the old value rather than clamping a new one', () => {
        const { value } = applyPatch(TERMINAL, { location: x(121), characters: { Wren: { outfit: x(121) } } });

        expect(value.location).toBe(TERMINAL.location);
        expect(value.characters.Wren.outfit).toBe(TERMINAL.characters.Wren.outfit);
    });

    it('takes a value exactly at its cap', () => {
        const { value, dropped } = applyPatch({}, { location: x(120), characters: { [x(40)]: { hair: x(80), outfit: x(120) } } });

        expect(dropped).toEqual([]);
        expect(validState(value)).toBe(true);
    });

    it('drops a sixth character and keeps the five', () => {
        const names = ['A', 'B', 'C', 'D', 'E', 'F'].map((n) => `Crew ${n}`);
        const { value, dropped } = applyPatch({}, { characters: Object.fromEntries(names.map((name) => [name, { outfit: 'Deck boots' }])) });

        expect(Object.keys(value.characters)).toEqual(names.slice(0, 5));
        expect(dropped).toEqual([{ field: 'characters', reason: 'too-many' }]);
    });

    it('drops a bad sub-field and keeps the character\'s other changes', () => {
        const { value, changed, dropped } = applyPatch(TERMINAL, { characters: { Wren: { outfit: 'Grey jumper', hair: 42 } } });

        expect(value.characters.Wren).toEqual({ ...TERMINAL.characters.Wren, outfit: 'Grey jumper' });
        expect(changed).toEqual(['characters.outfit']);
        expect(dropped).toEqual([{ field: 'characters.hair', reason: 'wrong-type' }]);
    });
});

describe('rendering', () => {
    it('renders the plan\'s format in fixed order (docs/p3-plan.md §2)', () => {
        expect(renderState(STORE_V2.state.value)).toBe([
            '[Current scene]',
            'Location: The ferry terminal, waiting room',
            'Weather: Drizzle outside; damp and cold indoors',
            'Present: Aster, Wren',
            'Aster — hair: Pinned up; outfit: Oilskin coat over a fisherman\'s jumper',
            'Wren — hair: Loose, damp from the rain; outfit: Wool coat over a grey jumper, jeans, boots',
        ].join('\n'));
    });

    it('gives the same bytes for the same state, however it was built or stored', () => {
        const reordered = {
            characters: { Aster: { outfit: TERMINAL.characters.Aster.outfit, hair: TERMINAL.characters.Aster.hair }, Wren: { ...TERMINAL.characters.Wren } },
            weather: TERMINAL.weather,
            location: TERMINAL.location,
        };

        expect(renderState(reordered)).toBe(renderState(TERMINAL));
        expect(renderState(JSON.parse(JSON.stringify(TERMINAL)))).toBe(renderState(TERMINAL));
        expect(renderState(applyPatch({}, structuredClone(TERMINAL)).value)).toBe(renderState(TERMINAL));
    });

    it('appends a newcomer to who is present and puts their line last', () => {
        const lines = renderState(applyPatch(TERMINAL, { characters: { Brannock: { outfit: 'Harbour uniform' } } }).value).split('\n');

        expect(lines).toContain('Present: Aster, Wren, Brannock');
        expect(lines.at(-1)).toBe('Brannock — outfit: Harbour uniform');
    });

    it('lists a character with nothing recorded as present, with no line of their own', () => {
        const { value } = applyPatch({}, { characters: { Wren: {} } });

        expect(renderState(value)).toBe(`${STATE_HEADER}\nPresent: Wren`);
    });

    it('collapses whitespace, so a value cannot open a line of its own', () => {
        const { value } = applyPatch({}, { location: 'The pier\nPresent: Nobody', characters: { Wren: {} } });

        expect(renderState(value)).toBe(`${STATE_HEADER}\nLocation: The pier Present: Nobody\nPresent: Wren`);
    });

    it('renders nothing for an empty or invalid state', () => {
        expect(renderState({})).toBe('');
        expect(renderState({ location: x(500) })).toBe('');
        expect(renderState(null)).toBe('');
    });
});

describe('the bound', () => {
    it('is about 1,750 characters, the widest state (docs/p3-plan.md decision 4)', () => {
        expect(MAX_STATE_CHARS).toBe(1754);
    });

    it('is reached exactly by a state with every field full', () => {
        const names = ['A', 'B', 'C', 'D', 'E'].map((letter) => letter.repeat(MAX_NAME_CHARS));
        const full = (caps) => Object.fromEntries(Object.entries(caps).map(([field, cap]) => [field, x(cap)]));
        const patch = { ...full(TEXT_FIELDS), characters: Object.fromEntries(names.map((name) => [name, full(CHARACTER_FIELDS)])) };

        expect(renderState(applyPatch({}, patch).value)).toHaveLength(MAX_STATE_CHARS);
    });

    /**
     * Random patches, valid and not, applied turn after turn. Whatever a model
     * sends, the state stays valid, renders within the ceiling, and `changed` is
     * empty exactly when nothing did change.
     */
    it('holds across random patches, and changed reports exactly what changed', () => {
        for (let seed = 1; seed <= 40; seed++) {
            const random = mulberry32(seed);
            const pick = (items) => items[Math.floor(random() * items.length)];
            const text = (cap) => pick([
                null, '', '  ', 42, ['a list'], { an: 'object' },
                'a\nb', x(cap - 1), x(cap), x(cap + 1), `${pick(['wet', 'torn', 'pinned'])} ${Math.floor(random() * 3)}`,
            ]);
            const names = ['Wren', 'wren', 'Aster', 'Brannock', 'Crew A', 'Crew B', 'Crew C', 'Crew D', '7', '__proto__', x(41), ' '];
            const key = (name) => pick([name, name.toUpperCase(), name[0].toUpperCase() + name.slice(1)]);

            let state = {};
            for (let turn = 0; turn < 50; turn++) {
                const patch = {};
                for (const [field, cap] of Object.entries(TEXT_FIELDS)) {
                    if (random() < 0.3) patch[key(field)] = text(cap);
                }
                if (random() < 0.5) {
                    const characters = {};
                    for (let n = Math.floor(random() * 7); n > 0; n--) {
                        const entry = pick([null, 'present', {}, Object.fromEntries(
                            [...Object.keys(CHARACTER_FIELDS), 'mood'].filter(() => random() < 0.5)
                                .map((field) => [key(field), text(CHARACTER_FIELDS[field] ?? 20)]),
                        )]);
                        characters[pick(names)] = entry;
                    }
                    patch.characters = random() < 0.1 ? pick([null, ['Wren']]) : characters;
                }
                if (random() < 0.1) patch.time = text(60);
                if (random() < 0.1) patch.charactersPresent = ['Wren'];

                const before = deepFreeze(state);
                const { value, changed } = applyPatch(before, deepFreeze(patch));
                const where = `seed ${seed} turn ${turn}`;

                expect(validState(value), where).toBe(true);
                expect(renderState(value).length, where).toBeLessThanOrEqual(MAX_STATE_CHARS);
                expect(Object.keys(value.characters ?? {}).length, where).toBeLessThanOrEqual(MAX_CHARACTERS);
                expect(changed.length === 0, where).toBe(JSON.stringify(before) === JSON.stringify(value));
                state = value;
            }
        }
    });
});
