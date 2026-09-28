/**
 * What Cairn asks of every memory request, whatever the profile's preset says
 * (docs/decisions.md D-0086).
 *
 * Summaries, records, state and canon are short readings of short text, and a
 * reasoning model spends its whole token budget thinking about them: on OpenRouter
 * that reasoning is hidden and billed, and the reply comes back empty or cut off.
 * So Cairn asks for none. ST forwards the override into the request body
 * (public/scripts/extensions/shared.js:460) ahead of the preset
 * (public/scripts/custom-request.js:605).
 *
 * Pure: the context and profile come in.
 */

/** The value ST itself sends to OpenRouter for "Minimum" with thoughts hidden (public/scripts/openai.js:2618-2620). */
export const NO_REASONING = 'none';

/**
 * @param {object} context `SillyTavern.getContext()`
 * @param {string} [memoryProfileId]
 * @returns {object|null} The Connection Manager profile, or null.
 */
export function memoryProfile(context, memoryProfileId) {
    if (!memoryProfileId) return null;
    const profiles = context?.extensionSettings?.connectionManager?.profiles ?? [];
    return profiles.find((profile) => profile.id === memoryProfileId) ?? null;
}

/**
 * The chat completion source a profile sends to, as ST resolves it
 * (public/scripts/slash-commands.js:191, exposed at public/scripts/st-context.js:285).
 *
 * @returns {string|null}
 */
export function profileSource(context, profile) {
    if (!profile?.api) return null;
    return context?.CONNECT_API_MAP?.[profile.api]?.source ?? null;
}

/**
 * The fields Cairn adds to a memory request's body. Only OpenRouter is asked:
 * its backend passes `reasoning_effort` on as `reasoning.effort`
 * (src/endpoints/backends/chat-completions.js:2349), while other sources forward it
 * as it is and not every provider accepts `none`. A custom endpoint turns reasoning
 * off in its own request body, as the profile's preset already can.
 *
 * @returns {{reasoning_effort?: string}}
 */
export function requestOverrides(context, profile) {
    return profileSource(context, profile) === 'openrouter' ? { reasoning_effort: NO_REASONING } : {};
}
