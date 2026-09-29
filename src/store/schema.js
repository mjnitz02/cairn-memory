/**
 * The stored-data schema: versioning and forward migrations for `extra.cairn`.
 * The settings have their own, in settings.js.
 *
 * CLAUDE.md §8.32: a change to a stored shape bumps the version here, ships a
 * migration, and gains a fixture of the old shape in the test suite. We never
 * orphan someone's accumulated memory.
 */

/** Bump on any change to what we write into message.extra / chatMetadata. */
export const STORE_VERSION = 4;

/**
 * `extra.cairn` migrations, keyed by the version being left. They run on read and
 * are never written back on their own: the next write to the message stores the
 * current shape.
 *
 * @type {Record<number, (store: object) => object>}
 */
export const STORE_MIGRATIONS = {
    // v2 adds `state` (docs/decisions.md D-0045). A v1 store has none, so it is already a v2 one.
    1: (store) => ({ ...store, v: 2 }),
    // v3 adds `canon` (docs/p4-plan.md decision 1). Same shape: a v2 store has none.
    2: (store) => ({ ...store, v: 3 }),
    // v4 adds `index` (docs/decisions.md D-0070). A v3 store has none, and a record is
    // re-derived from the summary it sits beside, so there is nothing to backfill here:
    // `pendingIndex` finds a summary without one and the queue writes it.
    3: (store) => ({ ...store, v: 4 }),
};

/**
 * Bring a stored `extra.cairn` up to the current version. Pure; never mutates input.
 *
 * @param {unknown} stored
 * @param {Record<number, (store: object) => object>} [migrations] Injected for tests.
 * @param {number} [targetVersion]
 * @returns {{status: 'none'|'invalid'|'future'|'ok', store: object|null}}
 */
export function migrateStore(stored, migrations = STORE_MIGRATIONS, targetVersion = STORE_VERSION) {
    if (stored === undefined) return { status: 'none', store: null };
    if (typeof stored !== 'object' || stored === null || Array.isArray(stored)
        || !Number.isInteger(stored.v) || stored.v < 1) {
        return { status: 'invalid', store: null };
    }
    // A newer Cairn's shape is not ours to interpret, and not ours to overwrite.
    if (stored.v > targetVersion) return { status: 'future', store: null };

    let store = stored;
    while (store.v < targetVersion) {
        const migrate = migrations[store.v];
        // Unlike settings there is nothing to merge a gap into: an unreadable store
        // costs one message its summary or state, which the queue rewrites.
        if (!migrate) return { status: 'invalid', store: null };
        const next = migrate(store);
        if (!(next.v > store.v)) {
            throw new Error(`Store migration from v${store.v} did not advance the version`);
        }
        store = next;
    }
    return { status: 'ok', store };
}
