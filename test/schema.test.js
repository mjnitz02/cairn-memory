import { describe, expect, it } from 'vitest';
import { STORE_VERSION, migrateStore } from '../src/store/schema.js';
import { STORE_V1 } from './fixtures/store-v1.js';
import { STORE_V2 } from './fixtures/store-v2.js';
import { STORE_V3, STORE_V3_CANON } from './fixtures/store-v3.js';
import { STORE_V4, STORE_V4_CANON } from './fixtures/store-v4.js';

describe('migrateStore', () => {
    it('reads a v1 store as a current one, with the scene untouched and no state', () => {
        const { status, store } = migrateStore(STORE_V1);

        expect(status).toBe('ok');
        expect(store).toEqual({ ...STORE_V1, v: STORE_VERSION });
        expect(store.state).toBeUndefined();
    });

    it('never mutates the stored object', () => {
        const stored = structuredClone(STORE_V1);
        migrateStore(stored);

        expect(stored).toEqual(STORE_V1);
    });

    it('returns a current store as it is', () => {
        const stored = { v: STORE_VERSION, scene: {} };
        expect(migrateStore(stored)).toEqual({ status: 'ok', store: stored });
    });

    it('tells none, invalid and future apart', () => {
        expect(migrateStore(undefined).status).toBe('none');
        for (const junk of [null, 'junk', [], {}, { v: 0 }, { v: '1' }]) {
            expect(migrateStore(junk).status, JSON.stringify(junk)).toBe('invalid');
        }
        expect(migrateStore({ v: STORE_VERSION + 1 })).toEqual({ status: 'future', store: null });
    });

    it('runs a chain, and treats a gap in the table as unreadable', () => {
        const migrations = { 1: (s) => ({ ...s, v: 2, a: true }), 2: (s) => ({ ...s, v: 3, b: s.a }) };

        expect(migrateStore({ v: 1 }, migrations, 3)).toEqual({ status: 'ok', store: { v: 3, a: true, b: true } });
        expect(migrateStore({ v: 1 }, {}, 3)).toEqual({ status: 'invalid', store: null });
    });

    it('refuses a migration that does not advance the version', () => {
        expect(() => migrateStore({ v: 1 }, { 1: (s) => ({ ...s }) }, 2)).toThrow(/did not advance the version/);
    });
});

/**
 * Every shape we have ever written still reads (CLAUDE.md §8.32). One case per
 * released version, from its own fixture rather than from a hand-made object, so
 * a fixture that drifts fails here too.
 */
describe('migrateStore — every stored shape we have shipped', () => {
    it('carries v1, v2, v3 and v4 forward to the current version with nothing lost', () => {
        for (const stored of [STORE_V1, STORE_V2, STORE_V3, STORE_V3_CANON, STORE_V4, STORE_V4_CANON]) {
            const { status, store } = migrateStore(stored);

            expect(status, `v${stored.v}`).toBe('ok');
            expect(store, `v${stored.v}`).toEqual({ ...stored, v: STORE_VERSION });
        }
    });

    it('leaves the index key absent below v4, so nothing is invented for it', () => {
        // The record is re-derived from the summary it sits beside; a migration that
        // filled it in would be guessing at the model's output (docs/decisions.md D-0070).
        for (const stored of [STORE_V1, STORE_V2, STORE_V3, STORE_V3_CANON]) {
            expect(migrateStore(stored).store.index).toBeUndefined();
        }
        expect(migrateStore(STORE_V4).store.index).toEqual(STORE_V4.index);
    });

    it('refuses a v5 store rather than overwriting what a newer Cairn wrote', () => {
        expect(migrateStore({ ...STORE_V4, v: STORE_VERSION + 1 }))
            .toEqual({ status: 'future', store: null });
    });

    it('has a migration registered for every version below the current one', () => {
        // The mechanical half of §8.32: bumping STORE_VERSION without a migration
        // makes every older chat unreadable, and this is what says so.
        for (let version = 1; version < STORE_VERSION; version++) {
            expect(migrateStore({ v: version }).status, `v${version}`).toBe('ok');
        }
    });
});
