import { describe, expect, it } from 'vitest';
import { attributeOffset, locateInjections } from '../src/prompt/locate.js';

/**
 * Shapes mirror the real thing: a card at the top, one large memory block below
 * it, then a short raw window — the arrangement measured on turn 6 of the P0 run
 * (docs/decisions.md D-0018), where the block was 77% of the prompt and the
 * break landed on its first character.
 */
const CARD = 'You are Elizabeth. '.repeat(10);
const MEMORY = '[Following is a list of recent events]:\nShe left the club. She went home.';
const HISTORY = '\nMatt: are you okay?\nElizabeth: I am fine.';
const PROMPT = CARD + MEMORY + HISTORY;

const inventory = [
    { key: 'qvink_memory_short', owner: 'qvink', label: 'Qvink Memory (short)', chars: MEMORY.length },
];
const texts = { qvink_memory_short: MEMORY };

describe('locateInjections', () => {
    it('finds an injection and reports where it sits as a share of the prompt', () => {
        const [entry] = locateInjections(PROMPT, inventory, texts);

        expect(entry).toMatchObject({
            offset: CARD.length,
            endOffset: CARD.length + MEMORY.length,
            match: 'exact',
            ambiguous: false,
        });
        expect(entry.offsetPercent).toBeCloseTo((CARD.length / PROMPT.length) * 100, 1);
    });

    it('carries the original entry through untouched', () => {
        const [entry] = locateInjections(PROMPT, inventory, texts);
        expect(entry).toMatchObject({ key: 'qvink_memory_short', owner: 'qvink', chars: MEMORY.length });
    });

    it('never mutates the inventory it was given', () => {
        const before = structuredClone(inventory);
        locateInjections(PROMPT, inventory, texts);
        expect(inventory).toEqual(before);
    });

    it('matches on the trimmed value, because ST trims before joining', () => {
        // public/script.js:3320 — `prompts.map(x => x.value.trim())`.
        const [entry] = locateInjections(PROMPT, inventory, { qvink_memory_short: `\n\n${MEMORY}\n\n` });
        expect(entry).toMatchObject({ offset: CARD.length, match: 'exact' });
    });

    it('falls back to the macro-free head when a value carries macros', () => {
        // The P1 case: Cairn parks `{{outlet::x}}` and ST substitutes it later
        // (public/script.js:3326), so the parked value is not in the prompt.
        const parked = '[Canon]\nThings that are permanently true.\n{{outlet::esin_lore}}';
        const prompt = `${CARD}[Canon]\nThings that are permanently true.\nHer brother is dead.`;

        const [entry] = locateInjections(prompt, [{ key: 'cairn_1_canon' }], { cairn_1_canon: parked });

        // Located, but its extent is unknown — the macro expanded to who knows what.
        expect(entry).toMatchObject({ offset: CARD.length, endOffset: null, match: 'probe' });
    });

    it('refuses a probe too short to identify anything', () => {
        const [entry] = locateInjections('xx hello yy', [{ key: 'k' }], { k: 'hello {{macro}}' });
        expect(entry).toMatchObject({ offset: null, match: 'none' });
    });

    it('flags an ambiguous match rather than silently taking the first', () => {
        const repeated = 'the same block of text, repeated verbatim';
        const [entry] = locateInjections(`${repeated} ... ${repeated}`, [{ key: 'k' }], { k: repeated });
        expect(entry).toMatchObject({ match: 'exact', ambiguous: true });
    });

    it('reports a missing injection rather than guessing at zero', () => {
        // Offset 0 would read as "at the very top of the prompt", which is a
        // real and different finding.
        const [entry] = locateInjections(PROMPT, [{ key: 'k' }], { k: 'text that is not in the prompt at all' });
        expect(entry).toMatchObject({ offset: null, offsetPercent: null, match: 'none' });
    });

    it('survives empty and missing inputs', () => {
        expect(locateInjections('', [], {})).toEqual([]);
        expect(locateInjections(undefined, undefined, undefined)).toEqual([]);
        expect(locateInjections(PROMPT, [{ key: 'k' }], {})[0]).toMatchObject({ match: 'none' });
    });
});

describe('attributeOffset', () => {
    const located = locateInjections(PROMPT, inventory, texts);

    it('names the block a break landed inside, and how far in', () => {
        // The real finding from turn 6: the break was on the block's first char.
        expect(attributeOffset(CARD.length, located)).toMatchObject({
            key: 'qvink_memory_short',
            owner: 'qvink',
            offsetInEntry: 0,
            precision: 'inside',
        });
    });

    it('measures the offset from the block start, not the prompt start', () => {
        expect(attributeOffset(CARD.length + 7, located)).toMatchObject({ offsetInEntry: 7, precision: 'inside' });
    });

    it('says "above every injection" when the break is in the card', () => {
        // A break here means the character card or persona moved — a different
        // failure from the see-saw, and one no injection can be blamed for.
        expect(attributeOffset(5, located)).toMatchObject({ key: null, precision: 'none' });
    });

    it('distinguishes a break after a block from one inside it', () => {
        // Past the memory block is the raw history: this is the healthy case,
        // where only the newest messages changed.
        expect(attributeOffset(CARD.length + MEMORY.length + 3, located))
            .toMatchObject({ key: 'qvink_memory_short', precision: 'after' });
    });

    it('picks the last block that starts at or before the offset', () => {
        const two = [
            { key: 'cairn_1_canon', offset: 0, endOffset: 100, match: 'exact' },
            { key: 'cairn_2_scenes', offset: 100, endOffset: 500, match: 'exact' },
        ];
        expect(attributeOffset(250, two)).toMatchObject({ key: 'cairn_2_scenes', precision: 'inside' });
    });

    it('will not claim certainty about a block it only probe-matched', () => {
        const probed = [{ key: 'cairn_1_canon', offset: 0, endOffset: null, match: 'probe' }];
        expect(attributeOffset(50, probed)).toMatchObject({ key: 'cairn_1_canon', precision: 'probe' });
    });

    it('ignores blocks it could not locate', () => {
        const mixed = [
            { key: 'missing', offset: null, match: 'none' },
            { key: 'found', offset: 10, endOffset: 20, match: 'exact' },
        ];
        expect(attributeOffset(15, mixed)).toMatchObject({ key: 'found' });
    });

    it('returns null when there is no divergence to attribute', () => {
        expect(attributeOffset(null, located)).toBeNull();
        expect(attributeOffset(undefined, located)).toBeNull();
    });
});
