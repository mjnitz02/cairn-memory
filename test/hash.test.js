import { describe, expect, it } from 'vitest';
import { hashString } from '../src/util/hash.js';

describe('the message hash', () => {
    it('is stable across calls and prefixed so it reads as a hash in a store dump', () => {
        expect(hashString('Wren: The lamp gutters.')).toBe(hashString('Wren: The lamp gutters.'));
        expect(hashString('Wren: The lamp gutters.')).toMatch(/^h:[0-9a-f]{14}$/);
    });

    it('changes on a one-character edit', () => {
        expect(hashString('Wren: The lamp gutters.')).not.toBe(hashString('Wren: The lamp gutters!'));
    });

    /**
     * Every stored scene is validated against this function, so changing its
     * output orphans every summary written so far (CLAUDE.md §8.32). Vectors come
     * from ST's getStringHash (public/scripts/utils.js:522), run once by hand.
     */
    it('is pinned to known vectors, so a change is a deliberate schema change', () => {
        expect(hashString('')).toBe('h:0bdcb81aee8d83');
        expect(hashString('hello')).toBe('h:106f3a63cd7226');
        expect(hashString('Wren: The lamp gutters.')).toBe('h:0623d4b92c267c');
    });

    it('hashes a non-string as the empty string rather than throwing', () => {
        expect(hashString(undefined)).toBe(hashString(''));
    });
});
