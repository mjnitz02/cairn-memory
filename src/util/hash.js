/**
 * A small string hash for telling whether a message changed since it was
 * summarised (docs/p2-plan.md §1).
 *
 * ST's `getStringHash` (public/scripts/utils.js:522) is not on `getContext()`
 * (public/scripts/st-context.js:115-309), so this is the same public-domain
 * cyrb53, reproduced. Every stored scene is checked against it, so its output
 * is part of the stored shape: changing it is a schema change (CLAUDE.md §8.32).
 */

/**
 * @param {string} text
 * @returns {string} `h:` and 14 hex digits (53 bits).
 */
export function hashString(text) {
    const str = typeof text === 'string' ? text : '';
    let h1 = 0xdeadbeef;
    let h2 = 0x41c6ce57;
    for (let i = 0; i < str.length; i++) {
        const ch = str.charCodeAt(i);
        h1 = Math.imul(h1 ^ ch, 2654435761);
        h2 = Math.imul(h2 ^ ch, 1597334677);
    }
    h1 = Math.imul(h1 ^ (h1 >>> 16), 2246822507) ^ Math.imul(h2 ^ (h2 >>> 13), 3266489909);
    h2 = Math.imul(h2 ^ (h2 >>> 16), 2246822507) ^ Math.imul(h1 ^ (h1 >>> 13), 3266489909);

    const value = 4294967296 * (2097151 & h2) + (h1 >>> 0);
    return `h:${value.toString(16).padStart(14, '0')}`;
}
