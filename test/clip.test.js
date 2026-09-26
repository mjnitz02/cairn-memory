import { describe, expect, it } from 'vitest';
import { HARD_CAP_RATIO, clip, hardCap } from '../src/util/clip.js';

/** docs/decisions.md D-0085: state the soft cap, cut at the hard one. */
describe('clipping a model-written string', () => {
    it('sets the hard cap half again past the soft one', () => {
        expect(HARD_CAP_RATIO).toBe(1.5);
        expect(hardCap(100)).toBe(150);
        expect(hardCap(160)).toBe(240);
    });

    it('leaves a string within the hard cap exactly as written', () => {
        const text = 'x'.repeat(150);
        expect(clip(text, 150)).toEqual({ text, clipped: false });
        expect(clip('', 10)).toEqual({ text: '', clipped: false });
    });

    it('cuts at the last word that fits, and says it did', () => {
        const { text, clipped } = clip('Aster rowed Wren across the water before the feast day', 30);
        expect(clipped).toBe(true);
        expect(text).toBe('Aster rowed Wren across the…');
        expect(text.length).toBeLessThanOrEqual(30);
    });

    it('does not leave a dangling comma or dash before the ellipsis', () => {
        expect(clip('Aster rowed, Wren waited — the tide turned', 26).text).toBe('Aster rowed, Wren waited…');
        expect(clip('one, two, three, four, five', 12).text).toBe('one, two…');
    });

    it('cuts mid-word rather than losing most of the cap to one long word', () => {
        const { text } = clip(`a ${'x'.repeat(50)}`, 20);
        expect(text).toHaveLength(20);
        expect(text.endsWith('…')).toBe(true);
    });
});
