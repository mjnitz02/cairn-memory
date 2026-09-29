/**
 * The settings: their defaults, and versioning with forward migrations.
 *
 * Kept apart from store/schema.js because the defaults come from the modules that use
 * them, and the store must not import the pipeline to read a message.
 */
import { DEFAULT_SLOTS } from './memory/canon.js';
import { CANON_FRACTION, CAP_FRACTION, COMPACT_FRACTION } from './pipeline/budgeter.js';
import { RAW_WINDOW, STEP } from './pipeline/scheduler.js';
import { DEFAULT_LORE_CAP } from './prompt/lore-cap.js';
import { error } from './util/log.js';

/** Bump on any change to the settings shape. */
export const SETTINGS_VERSION = 1;

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
     * gets the default's improvements (docs/decisions.md D-0039).
     */
    summaryPrompt: '',
    /**
     * The index, canon and world-state prompts, on the same terms as `summaryPrompt`:
     * empty means the built-in default, and an edit missing the macro the call needs
     * falls back to it (docs/decisions.md D-0085).
     */
    indexPrompt: '',
    canonPrompt: '',
    statePrompt: '',
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
    /**
     * Keep the world state and put it in the prompt (docs/decisions.md D-0044).
     * Inert until a memory profile is chosen, and held while WTracker is loaded.
     */
    worldState: true,
    /**
     * Pick the story's spine out of the index and keep it at the head of the block
     * (docs/decisions.md D-0071). Inert until a memory profile is chosen, and held
     * while qvink is still writing the block.
     */
    keepCanon: true,
    /**
     * How many facts that pick fills. A count rather than a token cap: the spine does
     * not grow with the chat, so a long chat wants the same eight to twelve lines a
     * short one does, and leftover tokens fall back to summaries (D-0071).
     */
    canonSlots: DEFAULT_SLOTS,
    /**
     * Drop the card's example dialogue once summaries stand in for the early chat
     * (docs/decisions.md D-0068). Off leaves SillyTavern's own setting alone.
     */
    dropExamples: true,
    /**
     * The most tokens the lorebook may take in the prompt (docs/decisions.md D-0069).
     * Written into ST's own `world_info_budget_cap`, which ships at 0 — no cap —
     * so the percentage budget never binds. 0 here means the same: leave it alone.
     */
    loreCap: DEFAULT_LORE_CAP,
    /**
     * The budget's shares, as fractions (docs/decisions.md D-0085). The block's ceiling
     * share of the prompt, canon's of the block, and the compact tail's of what canon
     * leaves. Each is a ceiling, so what is not used falls back to summaries.
     */
    memoryFraction: CAP_FRACTION,
    canonFraction: CANON_FRACTION,
    compactFraction: COMPACT_FRACTION,
    /** Messages kept raw behind the summaries, and how far the see-saw steps (D-0068). */
    rawWindow: RAW_WINDOW,
    step: STEP,
    /**
     * How much the memory model may reason: `none`, `low`, or `preset` to leave it to the
     * profile's preset (docs/decisions.md D-0086, D-0088). Asked only of OpenRouter.
     */
    memoryReasoning: 'none',
    /**
     * Efforts a profile's model has refused, by `refusalKey`, so a reload does not pay for
     * the refusal again (D-0088). Cleared when `memoryReasoning` changes.
     */
    reasoningRefused: {},
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
