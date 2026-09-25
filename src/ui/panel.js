import { EXTENSION_PATH, SLUG } from '../constants.js';
import { DEFAULT_SUMMARY_PROMPT } from '../memory/scene-strategy.js';
import { setDebugEnabled } from '../util/log.js';

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
    bindCheckbox(context, 'enabled', (value) => handlers.onEnabledChange?.(value));
    bindCheckbox(context, 'showInspector', (value) => toggleInspector(value));
    bindCheckbox(context, 'logToDisk', (value) => handlers.onLogToDiskChange?.(value));
    bindCheckbox(context, 'holdWorldInfo', (value) => handlers.onHoldWorldInfoChange?.(value));
    bindNumber(context, 'loreCap', (value) => handlers.onLoreCapChange?.(value));
    bindCheckbox(context, 'ownMemoryBlock', (value) => handlers.onOwnMemoryBlockChange?.(value));
    bindCheckbox(context, 'worldState', (value) => handlers.onWorldStateChange?.(value));
    bindCheckbox(context, 'keepCanon', (value) => handlers.onKeepCanonChange?.(value));
    bindCheckbox(context, 'debugLogging', (value) => setDebugEnabled(value));

    populateProfiles(context, settings.memoryProfileId);
    bindSelect(context, 'memoryProfileId', (value) => handlers.onMemoryProfileChange?.(value));
    bindSummaryPrompt(context);

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
function bindSummaryPrompt(context) {
    const input = field('summaryPrompt');
    if (!input) return;
    const store = (value) => {
        context.extensionSettings[SLUG].summaryPrompt = value.trim() === DEFAULT_SUMMARY_PROMPT.trim() ? '' : value;
        context.saveSettingsDebounced();
    };

    input.value = context.extensionSettings[SLUG].summaryPrompt || DEFAULT_SUMMARY_PROMPT;
    input.addEventListener('input', () => store(input.value));
    field('summaryPromptReset')?.addEventListener('click', () => {
        input.value = DEFAULT_SUMMARY_PROMPT;
        store(input.value);
    });
}

function bindCheckbox(context, key, onChange) {
    const input = field(key);
    if (!input) return;
    input.checked = Boolean(context.extensionSettings[SLUG][key]);
    input.addEventListener('change', () => {
        context.extensionSettings[SLUG][key] = input.checked;
        context.saveSettingsDebounced();
        onChange?.(input.checked);
    });
}

/**
 * A whole number of tokens, never negative and never NaN: a blanked box reads as
 * 0, which is the same "no cap" ST's own field means (src/prompt/lore-cap.js).
 */
function bindNumber(context, key, onChange) {
    const input = field(key);
    if (!input) return;
    input.value = String(context.extensionSettings[SLUG][key] ?? 0);
    input.addEventListener('change', () => {
        const value = Math.max(0, Math.floor(Number(input.value)) || 0);
        input.value = String(value);
        context.extensionSettings[SLUG][key] = value;
        context.saveSettingsDebounced();
        onChange?.(value);
    });
}

function bindSelect(context, key, onChange) {
    const input = field(key);
    if (!input) return;
    input.addEventListener('change', () => {
        context.extensionSettings[SLUG][key] = input.value;
        context.saveSettingsDebounced();
        onChange?.(input.value);
    });
}

function field(key) {
    return document.getElementById(`${SLUG}_${key}`);
}

function escapeHtml(value) {
    return String(value).replace(/[&<>"']/g, (c) => (
        { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', '\'': '&#39;' }[c]
    ));
}
