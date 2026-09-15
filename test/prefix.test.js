import { describe, expect, it } from 'vitest';
import { commonPrefixLength, comparePrompts, flattenPrompt } from '../src/util/prefix.js';

describe('commonPrefixLength', () => {
    it('counts shared leading characters', () => {
        expect(commonPrefixLength('abcdef', 'abcxyz')).toBe(3);
    });

    it('is the full length when one is a prefix of the other', () => {
        expect(commonPrefixLength('abc', 'abcdef')).toBe(3);
    });

    it('is zero when nothing matches or either side is empty', () => {
        expect(commonPrefixLength('abc', 'xyz')).toBe(0);
        expect(commonPrefixLength('', 'abc')).toBe(0);
        expect(commonPrefixLength('abc', null)).toBe(0);
    });
});

describe('comparePrompts', () => {
    it('reports no stability on the first turn rather than guessing', () => {
        const result = comparePrompts(null, 'a prompt');
        expect(result.stabilityPercent).toBeNull();
        expect(result.divergence).toBeNull();
    });

    it('is 100% when the prompt only grew at the end — the healthy case', () => {
        const previous = 'x'.repeat(100);
        const result = comparePrompts(previous, previous + 'new turn');

        expect(result.commonPrefix).toBe(100);
        expect(result.stabilityPercent).toBe(round(100 / 108 * 100));
        expect(result.divergence.index).toBe(100);
    });

    it('is identical when nothing changed', () => {
        const result = comparePrompts('same', 'same');
        expect(result.stabilityPercent).toBe(100);
        expect(result.divergence).toBeNull();
    });

    it('collapses when something volatile moves above stable content', () => {
        // The WTrackerLite shape: a changing block near the top invalidates
        // everything after it (docs/decisions.md, Lessons).
        const tail = 'y'.repeat(900);
        const result = comparePrompts('turn 1 state' + tail, 'turn 2 state' + tail);

        expect(result.commonPrefix).toBe(5);
        expect(result.stabilityPercent).toBeLessThan(5);
    });

    it('shows both sides of the divergence point', () => {
        const result = comparePrompts('shared|OLD tail', 'shared|NEW tail');
        expect(result.divergence.previous).toBe('OLD tail');
        expect(result.divergence.current).toBe('NEW tail');
    });

    it('handles an empty current prompt without dividing by zero', () => {
        expect(comparePrompts('something', '').stabilityPercent).toBe(0);
    });
});

describe('flattenPrompt', () => {
    it('passes a text-completion string through unchanged', () => {
        expect(flattenPrompt('raw prompt')).toBe('raw prompt');
    });

    it('flattens a chat-completion message array', () => {
        const chat = [
            { role: 'system', content: 'be good' },
            { role: 'user', content: 'hello' },
        ];
        expect(flattenPrompt(chat)).toBe('system: be good\nuser: hello');
    });

    it('keeps the text parts of multimodal content', () => {
        const chat = [{ role: 'user', content: [{ type: 'text', text: 'look' }, { type: 'image_url' }] }];
        expect(flattenPrompt(chat)).toBe('user: look');
    });

    it('does not mutate the array it was given', () => {
        const chat = [{ role: 'user', content: 'hello' }];
        const before = structuredClone(chat);
        flattenPrompt(chat);
        expect(chat).toEqual(before);
    });

    it('returns an empty string for anything else', () => {
        expect(flattenPrompt(undefined)).toBe('');
        expect(flattenPrompt(42)).toBe('');
    });
});

function round(value) {
    return Math.round(value * 10) / 10;
}
