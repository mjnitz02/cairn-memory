import { describe, expect, it } from 'vitest';
import {
    DEFAULT_SETTINGS, SETTINGS_VERSION, STORE_VERSION, applyMigrations, migrateSettings, migrateStore,
} from '../src/store/schema.js';
import { STORE_V1 } from './fixtures/store-v1.js';
import { STORE_V2 } from './fixtures/store-v2.js';
import { STORE_V3, STORE_V3_CANON } from './fixtures/store-v3.js';
import { STORE_V4, STORE_V4_CANON } from './fixtures/store-v4.js';

describe('migrateSettings', () => {
    it('returns defaults for a fresh install', () => {
        expect(migrateSettings(undefined)).toEqual({ ...DEFAULT_SETTINGS });
    });

    it('returns defaults for a non-object', () => {
        expect(migrateSettings('nonsense')).toEqual({ ...DEFAULT_SETTINGS });
    });

    it('keeps the world state on by default, so it needs only a memory profile (docs/decisions.md D-0044)', () => {
        expect(DEFAULT_SETTINGS.worldState).toBe(true);
        expect(migrateSettings({ version: SETTINGS_VERSION, memoryProfileId: 'profile-a' }).worldState).toBe(true);
        expect(migrateSettings({ version: SETTINGS_VERSION, worldState: false }).worldState).toBe(false);
    });

    it('defaults the budget to the constants it replaced, and the prompts to the built-in ones (D-0085)', () => {
        expect(DEFAULT_SETTINGS).toMatchObject({
            memoryFraction: 0.35, canonFraction: 0.20, compactFraction: 0.20, rawWindow: 8, step: 8,
            indexPrompt: '', canonPrompt: '', statePrompt: '',
        });
        // An install from before these existed gets them without a version bump.
        const older = migrateSettings({ version: SETTINGS_VERSION, canonSlots: 12 });
        expect(older).toMatchObject({ canonSlots: 12, compactFraction: 0.20, rawWindow: 8, indexPrompt: '' });
    });

    it('keeps user values and fills in missing keys', () => {
        const stored = { version: SETTINGS_VERSION, memoryProfileId: 'profile-a' };
        const migrated = migrateSettings(stored);

        expect(migrated.memoryProfileId).toBe('profile-a');
        expect(migrated.enabled).toBe(DEFAULT_SETTINGS.enabled);
        expect(migrated.showInspector).toBe(DEFAULT_SETTINGS.showInspector);
    });

    it('does not mutate the stored object', () => {
        const stored = { version: SETTINGS_VERSION, memoryProfileId: 'profile-a' };
        migrateSettings(stored);
        expect(stored).toEqual({ version: SETTINGS_VERSION, memoryProfileId: 'profile-a' });
    });

    it('falls back to defaults when no migration path exists', () => {
        // Unversioned pre-release settings: nothing safe to carry forward.
        expect(migrateSettings({ enabled: false })).toEqual({ ...DEFAULT_SETTINGS });
    });

    it('leaves a newer-than-current version untouched, so a downgrade is clean', () => {
        const future = { version: SETTINGS_VERSION + 1, enabled: false, somethingNew: 42 };
        expect(migrateSettings(future)).toEqual(future);
    });

    it('always lands on the current version', () => {
        expect(migrateSettings({ version: SETTINGS_VERSION }).version).toBe(SETTINGS_VERSION);
    });
});

describe('migrateSettings — additive keys', () => {
    it('fills a newly added key from defaults with no version bump', () => {
        // Why adding a setting does not need a migration entry.
        const stored = { version: SETTINGS_VERSION, enabled: true };
        expect(migrateSettings(stored).logToDisk).toBe(DEFAULT_SETTINGS.logToDisk);
    });
});

/**
 * These paths only open up once SETTINGS_VERSION passes 1, so they are exercised
 * against an injected table rather than waiting for a real user to find them.
 */
describe('applyMigrations — the engine', () => {
    it('runs a chain of migrations in order', () => {
        const migrations = {
            1: (s) => ({ ...s, version: 2, added: 'in v2' }),
            2: (s) => ({ ...s, version: 3, added: `${s.added}, kept in v3` }),
        };
        const result = applyMigrations({ version: 1, enabled: false }, migrations, 3);

        expect(result.version).toBe(3);
        expect(result.added).toBe('in v2, kept in v3');
        expect(result.enabled).toBe(false);
    });

    it('merges rather than wipes when the table has a gap', () => {
        // A versioned install with no path is our bug, not the user's —
        // resetting would silently discard their configuration.
        const stored = { version: 1, memoryProfileId: 'profile-a', enabled: false };
        const result = applyMigrations(stored, {}, 2);

        expect(result.memoryProfileId).toBe('profile-a');
        expect(result.enabled).toBe(false);
        expect(result.version).toBe(2);
    });

    it('still wipes unversioned pre-release settings, which cannot be trusted', () => {
        expect(applyMigrations({ enabled: false }, {}, 2)).toEqual({ ...DEFAULT_SETTINGS });
    });

    it('refuses a migration that does not advance the version', () => {
        const migrations = { 1: (s) => ({ ...s }) }; // forgot to set version
        expect(() => applyMigrations({ version: 1 }, migrations, 2))
            .toThrow(/did not advance the version/);
    });

    it('leaves a future version untouched so a downgrade is clean', () => {
        const future = { version: 99, somethingNew: true };
        expect(applyMigrations(future, {}, 2)).toEqual(future);
    });
});

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
