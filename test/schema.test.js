import { describe, expect, it } from 'vitest';
import { DEFAULT_SETTINGS, SETTINGS_VERSION, applyMigrations, migrateSettings } from '../src/store/schema.js';

describe('migrateSettings', () => {
    it('returns defaults for a fresh install', () => {
        expect(migrateSettings(undefined)).toEqual({ ...DEFAULT_SETTINGS });
    });

    it('returns defaults for a non-object', () => {
        expect(migrateSettings('nonsense')).toEqual({ ...DEFAULT_SETTINGS });
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
