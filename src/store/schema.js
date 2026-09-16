/**
 * Settings and stored-data schema, with versioning and forward migrations.
 *
 * CLAUDE.md §8.32: a change to a stored shape bumps the version here, ships a
 * migration, and gains a fixture of the old shape in the test suite. We never
 * orphan someone's accumulated memory.
 */
import { error } from '../util/log.js';

/** Bump on any change to the settings shape. */
export const SETTINGS_VERSION = 1;

/** Bump on any change to what we write into message.extra / chatMetadata. */
export const STORE_VERSION = 1;

/**
 * Defaults must produce a working, inert extension: enabled but doing nothing
 * until a memory connection profile is chosen (DESIGN.md §3.1).
 */
export const DEFAULT_SETTINGS = Object.freeze({
    version: SETTINGS_VERSION,
    enabled: true,
    /** Connection profile id used for memory work. Never the roleplay profile. */
    memoryProfileId: '',
    /**
     * The summary prompt. Empty means the built-in default, so an unedited install
     * gets the default's improvements (docs/p2-plan.md §4).
     */
    summaryPrompt: '',
    /** Show the prompt inspector panel (DESIGN.md §10). */
    showInspector: true,
    /** Verbose console output. */
    debugLogging: false,
    /** Write each observed generation to data/<user>/user/files/. */
    logToDisk: true,
    /** Keep World Info entries in the prompt once they have activated (D-0023). */
    holdWorldInfo: true,
    /**
     * Write the memory block instead of leaving it to qvink (D-0027). On by
     * default, but the handover gate still decides each turn: while qvink is
     * injecting, Cairn plans and measures without writing anything.
     */
    ownMemoryBlock: true,
});

/**
 * Migrations from version N to N+1, keyed by the version being left.
 * Each takes a settings object and returns the next-version shape.
 *
 * **Adding a key with a default needs no migration and no version bump** —
 * `migrateSettings` fills missing keys from DEFAULT_SETTINGS. Bump only when an
 * existing key changes meaning, type, or name, and then register the migration
 * here in the same change.
 *
 * @type {Record<number, (settings: object) => object>}
 */
const SETTINGS_MIGRATIONS = {
    // 1: (settings) => ({ ...settings, version: 2, newKey: default }),
};

/**
 * Bring a stored settings object up to the current version, filling in any
 * defaults it is missing. Pure: safe to call on undefined, never mutates input.
 * @param {object} [stored]
 * @returns {object}
 */
export function migrateSettings(stored) {
    return applyMigrations(stored, SETTINGS_MIGRATIONS, SETTINGS_VERSION);
}

/**
 * The migration engine, with its table and target injected.
 *
 * Exported so the paths that only open up at a *future* version — a gap in the
 * table, a chain of several steps — can be tested today instead of the first
 * time a real user's settings hit them.
 *
 * @param {object} [stored]
 * @param {Record<number, (settings: object) => object>} migrations
 * @param {number} targetVersion
 */
export function applyMigrations(stored, migrations, targetVersion) {
    if (!stored || typeof stored !== 'object') {
        return { ...DEFAULT_SETTINGS };
    }

    let settings = { ...stored };
    let version = Number.isInteger(settings.version) ? settings.version : 0;

    while (version < targetVersion) {
        const migrate = migrations[version];
        if (!migrate) {
            // A versioned install with no registered path is our bug, not the
            // user's. Merging keeps whatever still makes sense; wiping to
            // defaults would silently discard their configuration.
            if (version > 0) {
                error(`No settings migration from v${version}; merging defaults instead of resetting.`);
                return { ...DEFAULT_SETTINGS, ...settings, version: targetVersion };
            }
            // Unversioned pre-release settings: nothing safe to carry forward.
            return { ...DEFAULT_SETTINGS };
        }
        settings = migrate(settings);
        const next = Number(settings.version);
        if (!(next > version)) {
            throw new Error(`Settings migration from v${version} did not advance the version`);
        }
        version = next;
    }

    // Unknown future version: leave it alone, let the user downgrade cleanly.
    if (version > targetVersion) {
        return settings;
    }

    return { ...DEFAULT_SETTINGS, ...settings, version: targetVersion };
}
