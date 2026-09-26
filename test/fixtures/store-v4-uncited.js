/**
 * A v4 canon batch as it was written *before* canon became a pick (docs/decisions.md
 * D-0071): facts with no `from` and a batch with no `slots`.
 *
 * Written out by hand, and kept separate from `store-v4.js` rather than versioned,
 * because both fields are optional on read: the store version did not move for them,
 * so the two shapes are the same version and have to both read. What this fixture
 * guards is the degrade — an uncited fact cannot be invalidated by a record going
 * away, so it is kept rather than dropped, which is the same choice D-0074 made for an
 * unreadable kind.
 *
 * The text is `store-v4.js`'s, so the only difference between the two is the citation.
 */
export const STORE_V4_CANON_UNCITED = Object.freeze({
    facts: Object.freeze([
        Object.freeze({
            text: 'Wren\'s brother drowned in the spring flood.',
            entities: Object.freeze(['Wren', 'the spring flood']),
        }),
        Object.freeze({
            text: 'Aster promised to get Wren across the water before the feast day.',
            entities: Object.freeze(['Aster', 'Wren', 'the feast day']),
        }),
    ]),
    covers: Object.freeze([0, 1]),
    prompt: 'h:3e91f4a0c7b218',
    at: '2026-09-17T09:12:04.000Z',
});
