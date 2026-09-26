import { describe, expect, it } from 'vitest';
import {
    DEFAULT_KIND, INDEX_HEADER, KINDS, KIND_MEANINGS, MAX_LINE_CHARS, MAX_SLOT_CHARS, MAX_WHO,
    MAX_WHO_CHARS, compactLine, kindRank, normaliseRecord, renderIndex, renderRecord, validRecord,
} from '../src/memory/index-record.js';
import { estimateTokens } from '../src/util/tokens.js';

const MEANT = {
    kind: 'major',
    who: ['Aster', 'Wren'],
    what: 'Aster promised to get Wren across before the feast day',
    changed: 'Wren has a crossing promised',
    because: 'the ferry was posted delayed',
    background: 'Aster and Wren were raised in the same terminal town',
    line: 'Aster promised to get Wren across before the feast day, the ferry having been posted delayed.',
};

const filled = (over = {}) => normaliseRecord({ ...MEANT, ...over }).record;

describe('the record shape', () => {
    it('names the four kinds of thing a story is made of, in rank order (D-0064)', () => {
        expect(KINDS).toEqual(['cast', 'major', 'description', 'filler']);
        for (const kind of KINDS) expect(KIND_MEANINGS[kind]).toBeTypeOf('string');
        expect(kindRank('cast')).toBeLessThan(kindRank('filler'));
        expect(kindRank('major')).toBeLessThan(kindRank('description'));
    });

    it('ranks an unknown kind last rather than throwing', () => {
        expect(kindRank('dialogue')).toBe(KINDS.length);
        expect(kindRank(undefined)).toBe(KINDS.length);
    });

    it('accepts exactly what the normaliser produces', () => {
        expect(validRecord(filled())).toBe(true);
        expect(validRecord(filled({ changed: '', because: '' }))).toBe(true);
        expect(validRecord(filled({ who: [] }))).toBe(true);
    });

    it('refuses a record the normaliser could not have made', () => {
        expect(validRecord(null)).toBe(false);
        expect(validRecord({ ...MEANT, kind: 'dialogue' })).toBe(false);
        expect(validRecord({ ...MEANT, what: '' })).toBe(false);
        // `changed` and `because` are always present as strings, even when empty.
        expect(validRecord({ kind: 'filler', who: [], what: 'Wren waited' })).toBe(false);
        expect(validRecord({ ...MEANT, changed: null })).toBe(false);
        expect(validRecord({ ...MEANT, who: 'Aster, Wren' })).toBe(false);
        expect(validRecord({ ...MEANT, what: 'x'.repeat(MAX_SLOT_CHARS + 1) })).toBe(false);
        expect(validRecord({ ...MEANT, who: Array(MAX_WHO + 1).fill('Wren') })).toBe(false);
    });
});

describe('normalising a record', () => {
    it('trims, lowercases the kind and folds a repeated name', () => {
        const { record, dropped } = normaliseRecord({
            kind: ' MAJOR ', who: ['Aster', ' Wren ', 'Aster'], what: '  Aster promised a crossing  ',
        });

        expect(record).toEqual({
            kind: 'major',
            who: ['Aster', 'Wren'],
            what: 'Aster promised a crossing',
            changed: '',
            because: '',
            background: '',
            line: '',
        });
        expect(dropped).toEqual([]);
    });

    it('keeps the record when the kind is unreadable and says so (D-0070)', () => {
        // The kind is a prior the deriver may overrule, so losing it costs less than
        // losing the slots. `filler` is the least privileged of the four on purpose.
        const { record, dropped } = normaliseRecord({ ...MEANT, kind: 'dialogue' });

        expect(record.kind).toBe(DEFAULT_KIND);
        expect(record.what).toBe(MEANT.what);
        expect(dropped).toEqual([{ slot: 'kind', reason: 'unknown-kind' }]);
    });

    it('rejects a record with no what, because that is the whole record', () => {
        expect(normaliseRecord({ kind: 'filler', who: ['Wren'] }).record).toBeNull();
        expect(normaliseRecord({ ...MEANT, what: '   ' }).dropped).toEqual([{ slot: 'what', reason: 'no-what' }]);
        expect(normaliseRecord('a record').record).toBeNull();
        expect(normaliseRecord(null).dropped).toEqual([{ slot: 'record', reason: 'not-a-record' }]);
    });

    it('drops an over-long what rather than cutting it (docs/decisions.md D-0053)', () => {
        const long = normaliseRecord({ ...MEANT, what: 'x'.repeat(MAX_SLOT_CHARS + 1) });

        expect(long.record).toBeNull();
        expect(long.dropped).toEqual([{ slot: 'what', reason: 'too-long' }]);
    });

    it('empties an over-long changed or because and keeps the rest of the record', () => {
        const { record, dropped } = normaliseRecord({
            ...MEANT, changed: 'y'.repeat(MAX_SLOT_CHARS + 1), because: 'z'.repeat(MAX_SLOT_CHARS + 1),
        });

        expect(record.what).toBe(MEANT.what);
        expect(record.changed).toBe('');
        expect(record.because).toBe('');
        expect(dropped).toEqual([{ slot: 'changed', reason: 'too-long' }, { slot: 'because', reason: 'too-long' }]);
    });

    it('treats null and missing slots as empty, not as broken', () => {
        expect(normaliseRecord({ ...MEANT, changed: null, because: undefined, background: null, line: undefined }).record)
            .toEqual({ ...MEANT, changed: '', because: '', background: '', line: '' });
        expect(normaliseRecord({ ...MEANT, changed: null }).dropped).toEqual([]);
    });

    it('takes the first MAX_WHO names and counts the rest', () => {
        const { record, dropped } = normaliseRecord({
            ...MEANT, who: ['Wren', 'Aster', 'the harbourmaster', 'the ferryman', 'the boy', ''],
        });

        expect(record.who).toHaveLength(MAX_WHO);
        // Reported in the order they arrived: the fifth name is past the cap, then a blank.
        expect(dropped).toEqual([{ slot: 'who', reason: 'too-many-names' }, { slot: 'who', reason: 'blank-name' }]);
    });

    it('drops a name written as a sentence', () => {
        const { record, dropped } = normaliseRecord({ ...MEANT, who: ['x'.repeat(MAX_WHO_CHARS + 1), 'Wren'] });

        expect(record.who).toEqual(['Wren']);
        expect(dropped).toEqual([{ slot: 'who', reason: 'name-too-long' }]);
    });

    it('reports who sent as a string, and stores no names', () => {
        const { record, dropped } = normaliseRecord({ ...MEANT, who: 'Aster, Wren' });

        expect(record.who).toEqual([]);
        expect(dropped).toEqual([{ slot: 'who', reason: 'not-a-list' }]);
    });

    it('never mutates what it was given', () => {
        const raw = { ...MEANT, who: ['Aster', 'Wren'] };
        normaliseRecord(raw);
        expect(raw).toEqual({ ...MEANT, who: ['Aster', 'Wren'] });
    });
});

describe('rendering the index', () => {
    it('writes fixed columns with no labels, so the header pays for them once', () => {
        expect(renderRecord(filled(), 12))
            .toBe('12 | major | Aster, Wren | Aster promised to get Wren across before the feast day'
                + ' | Wren has a crossing promised | the ferry was posted delayed'
                + ' | Aster and Wren were raised in the same terminal town');
        expect(INDEX_HEADER).toBe('n | kind | who | what | changed | because | background');
    });

    it('leaves an unfilled slot as an empty column', () => {
        expect(renderRecord(filled({ changed: '', because: '', background: '' }), 3))
            .toBe('3 | major | Aster, Wren | Aster promised to get Wren across before the feast day |  |  | ');
    });

    it('never renders the line, whatever it holds (docs/decisions.md D-0076)', () => {
        // A leaked line costs the deriver ~3,600 tokens of prose it has no use for.
        const long = filled({ line: 'x'.repeat(MAX_LINE_CHARS) });
        expect(renderRecord(long, 4)).toBe(renderRecord(filled({ line: '' }), 4));
        expect(renderIndex([long])).not.toContain('xxx');
    });

    it('gives the block the line, or null when there is none', () => {
        expect(compactLine(filled())).toBe(MEANT.line);
        expect(compactLine(filled({ line: '' }))).toBe(null);
        expect(compactLine(filled({ line: '   ' }))).toBe(null);
        // A record written before the line existed reads as no line, not as broken.
        expect(compactLine({ kind: 'filler', who: [], what: 'Wren waited' })).toBe(null);
        expect(compactLine(null)).toBe(null);
    });

    it('drops an over-long line and keeps the record (D-0075)', () => {
        const { record, dropped } = normaliseRecord({ ...MEANT, line: 'x'.repeat(MAX_LINE_CHARS + 1) });
        expect(record.line).toBe('');
        expect(record.what).toBe(MEANT.what);
        expect(dropped).toEqual([{ slot: 'line', reason: 'too-long' }]);
    });

    it('numbers the whole index from 1, header first', () => {
        const records = [filled(), filled({ kind: 'filler', changed: '', because: '' })];
        const lines = renderIndex(records).split('\n');

        expect(lines[0]).toBe(INDEX_HEADER);
        expect(lines[1].startsWith('1 | ')).toBe(true);
        expect(lines[2].startsWith('2 | filler | ')).toBe(true);
        expect(renderIndex([])).toBe('');
    });

    it('costs what stage 0c measured, with a ceiling that is not that number', () => {
        // 38.2 tokens mean over the 85 real summaries, median 33 (docs/decisions.md
        // D-0076). A thin record is well under it; what this file can *guarantee* is the
        // ceiling, so the ceiling is what is asserted.
        const typical = normaliseRecord({ kind: 'filler', who: ['Wren'], what: 'Wren waited out the delay in the terminal' }).record;
        expect(estimateTokens(renderRecord(typical, 12))).toBeLessThan(25);

        const worst = {
            kind: 'description',
            who: Array.from({ length: MAX_WHO }, () => 'n'.repeat(MAX_WHO_CHARS)),
            what: 'w'.repeat(MAX_SLOT_CHARS),
            changed: 'c'.repeat(MAX_SLOT_CHARS),
            because: 'b'.repeat(MAX_SLOT_CHARS),
            background: 'g'.repeat(MAX_SLOT_CHARS),
            line: 'l'.repeat(MAX_LINE_CHARS),
        };
        expect(validRecord(worst)).toBe(true);
        expect(renderRecord(worst, 159).length).toBeLessThanOrEqual(580);
        expect(estimateTokens(renderRecord(worst, 159))).toBeLessThan(150);
        // The line has its own ceiling and the deriver never pays it.
        expect(estimateTokens(worst.line)).toBeLessThan(45);
    });
});
