import { EXTENSION_PATH, SLUG } from '../constants.js';
import { CANON_PROMPT } from '../memory/canon-strategy.js';
import { INDEX_PROMPT } from '../memory/index-strategy.js';
import { DEFAULT_SUMMARY_PROMPT } from '../memory/scene-strategy.js';
import { STATE_PROMPT } from '../memory/state-strategy.js';
import { setDebugEnabled } from '../util/log.js';
import { escapeHtml } from './html.js';

/**
 * Settings panel. Every control here has a one-sentence description in
 * settings.html and a default that works unconfigured (CLAUDE.md §4.16).
 */

/**
 * Render the panel into ST's extension settings column and bind its controls.
 * @param {object} context SillyTavern.getContext()
 * @param {{onEnabledChange?: (enabled: boolean) => void,
 *           onLogToDiskChange?: (enabled: boolean) => void,
 *           onHoldWorldInfoChange?: (enabled: boolean) => void,
 *           onLoreCapChange?: (cap: number) => void,
 *           onOwnMemoryBlockChange?: (enabled: boolean) => void,
 *           onWorldStateChange?: (enabled: boolean) => void,
 *           onKeepCanonChange?: (enabled: boolean) => void,
 *           onMemoryProfileChange?: (profileId: string) => void}} [handlers]
 * @returns {Promise<HTMLElement>} The element the inspector renders into.
 */
export async function renderSettingsPanel(context, handlers = {}) {
    const settings = context.extensionSettings[SLUG];
    const html = await context.renderExtensionTemplateAsync(EXTENSION_PATH, 'settings');
    document.getElementById('extensions_settings').insertAdjacentHTML('beforeend', html);

    // The panel reports the change; index.js decides what it means.
    bind(context, 'enabled', CHECKBOX, (value) => handlers.onEnabledChange?.(value));
    bind(context, 'showInspector', CHECKBOX, (value) => toggleInspector(value));
    bind(context, 'logToDisk', CHECKBOX, (value) => handlers.onLogToDiskChange?.(value));
    bind(context, 'holdWorldInfo', CHECKBOX, (value) => handlers.onHoldWorldInfoChange?.(value));
    bind(context, 'loreCap', wholeNumber(), (value) => handlers.onLoreCapChange?.(value));
    bind(context, 'ownMemoryBlock', CHECKBOX, (value) => handlers.onOwnMemoryBlockChange?.(value));
    bind(context, 'worldState', CHECKBOX, (value) => handlers.onWorldStateChange?.(value));
    bind(context, 'keepCanon', CHECKBOX, (value) => handlers.onKeepCanonChange?.(value));
    // The budget and the pick are planned afresh every generation, so these need no
    // handler: a changed slot count makes the next plan's pick due (pipeline/compactor.js).
    bind(context, 'canonSlots', wholeNumber());
    for (const key of ['memoryFraction', 'canonFraction', 'compactFraction']) bind(context, key, PERCENT);
    bind(context, 'rawWindow', wholeNumber({ min: 1 }));
    bind(context, 'step', wholeNumber());
    bind(context, 'debugLogging', CHECKBOX, (value) => setDebugEnabled(value));

    populateProfiles(context, settings.memoryProfileId);
    bind(context, 'memoryProfileId', SELECT, (value) => handlers.onMemoryProfileChange?.(value));
    // A new choice is a fresh start: what a provider refused before is asked again (D-0088).
    bind(context, 'memoryReasoning', SELECT, () => {
        context.extensionSettings[SLUG].reasoningRefused = {};
        context.saveSettingsDebounced();
    });
    bindPrompt(context, 'summaryPrompt', DEFAULT_SUMMARY_PROMPT);
    bindPrompt(context, 'indexPrompt', INDEX_PROMPT);
    bindPrompt(context, 'canonPrompt', CANON_PROMPT);
    bindPrompt(context, 'statePrompt', STATE_PROMPT);

    toggleInspector(settings.showInspector);
    return document.getElementById(`${SLUG}_inspector`);
}

function toggleInspector(visible) {
    const block = document.getElementById(`${SLUG}_inspector_block`);
    if (block) block.hidden = !visible;
}

/**
 * The memory model is never the roleplay model (DESIGN.md §3.1), so this lists
 * Connection Manager profiles and stays empty-by-default rather than guessing.
 */
function populateProfiles(context, selectedId) {
    const select = field('memoryProfileId');
    if (!select) return;

    const profiles = context.extensionSettings.connectionManager?.profiles ?? [];
    const options = ['<option value="">— none selected —</option>'];
    for (const profile of profiles) {
        const selected = profile.id === selectedId ? ' selected' : '';
        options.push(`<option value="${escapeHtml(profile.id)}"${selected}>${escapeHtml(profile.name)}</option>`);
    }
    select.innerHTML = options.join('');
}

/**
 * Shows the default rather than an empty box, so there is something to edit, and
 * stores the default as empty, so an unedited prompt keeps following the default.
 */
function bindPrompt(context, key, fallback) {
    const input = field(key);
    if (!input) return;
    const store = (value) => {
        context.extensionSettings[SLUG][key] = value.trim() === fallback.trim() ? '' : value;
        context.saveSettingsDebounced();
    };

    input.value = context.extensionSettings[SLUG][key] || fallback;
    input.addEventListener('input', () => store(input.value));
    field(`${key}Reset`)?.addEventListener('click', () => {
        input.value = fallback;
        store(input.value);
    });
}

/**
 * One control, bound to its setting: it shows the stored value, and a change stores what
 * the control reads, shows that back (so a clamped number reads as stored), saves, and
 * tells the caller.
 *
 * @param {{show: (input: HTMLElement, value: unknown) => void, read: (input: HTMLElement) => unknown}} kind
 */
function bind(context, key, kind, onChange) {
    const input = field(key);
    if (!input) return;
    kind.show(input, context.extensionSettings[SLUG][key]);
    input.addEventListener('change', () => {
        const value = kind.read(input);
        context.extensionSettings[SLUG][key] = value;
        kind.show(input, value);
        context.saveSettingsDebounced();
        onChange?.(value);
    });
}

const CHECKBOX = {
    show: (input, value) => { input.checked = Boolean(value); },
    read: (input) => input.checked,
};

/**
 * A whole number of tokens, never negative and never NaN: a blanked box reads as
 * 0, which is the same "no cap" ST's own field means (src/prompt/lore-cap.js).
 */
const wholeNumber = ({ min = 0 } = {}) => ({
    show: (input, value) => { input.value = String(value ?? 0); },
    read: (input) => Math.max(min, Math.floor(Number(input.value)) || 0),
});

/**
 * A share, shown as a whole percent and stored as a fraction, so the budget reads it as
 * the constant it replaced. Held under 90%: a block that takes the whole prompt leaves
 * nothing for the story.
 */
const PERCENT = {
    show: (input, value) => { input.value = String(Math.round((value ?? 0) * 100)); },
    read: (input) => Math.min(90, Math.max(0, Math.round(Number(input.value)) || 0)) / 100,
};

const SELECT = {
    show: (input, value) => { if (input.options.length && value !== undefined) input.value = value; },
    read: (input) => input.value,
};

function field(key) {
    return document.getElementById(`${SLUG}_${key}`);
}
