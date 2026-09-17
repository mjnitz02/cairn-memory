/**
 * Whether Cairn may make memory calls now, for each kind of work, and if not, why.
 * The reasons are what the panel and the log show (src/ui/inspector.js,
 * src/util/disk-log.js), so a closed gate never looks like an idle queue.
 */
import { qvinkSummarising } from '../memory/scenes.js';
import { wtrackerLoaded } from '../memory/state.js';

/**
 * Whether Cairn may summarise in this chat now, and if not, why.
 *
 * @param {object} context SillyTavern.getContext()
 * @param {{memoryProfileId?: string}} settings
 * @returns {{ready: boolean, reason: string, sameProfile: boolean}}
 */
export function assessSummarizing(context, { memoryProfileId } = {}) {
    const reason = memoryCallsBlocked(context, memoryProfileId)
        ?? (qvinkSummarising(context) ? 'qvink-summarising' : null);
    if (reason) return { ready: false, reason, sameProfile: false };
    return { ready: true, reason: 'ready', sameProfile: sameProfile(context, memoryProfileId) };
}

/**
 * Whether Cairn may update the world state in this chat now, and if not, why.
 * qvink keeps no state, so it has no say here; a loaded WTracker does, and
 * `tracker` names it (docs/decisions.md D-0046).
 *
 * @param {object} context SillyTavern.getContext()
 * @param {{memoryProfileId?: string, worldState?: boolean}} settings
 * @returns {{ready: boolean, reason: string, sameProfile: boolean, tracker: string|null}}
 */
export function assessStateUpdates(context, { memoryProfileId, worldState } = {}) {
    const blocked = (reason, tracker = null) => ({ ready: false, reason, sameProfile: false, tracker });
    // The switch first: when the user turned it off, that is the reason worth showing.
    if (worldState === false) return blocked('off');
    const reason = memoryCallsBlocked(context, memoryProfileId);
    if (reason) return blocked(reason);
    const tracker = wtrackerLoaded(context);
    if (tracker) return blocked('wtracker-loaded', tracker);
    return { ready: true, reason: 'ready', sameProfile: sameProfile(context, memoryProfileId), tracker: null };
}

/** What every memory call needs, or the reason it cannot be made. */
function memoryCallsBlocked(context, memoryProfileId) {
    const settings = context?.extensionSettings ?? {};

    // No profile, no memory calls (docs/decisions.md D-0006).
    if (!memoryProfileId) return 'no-profile';
    if (context.groupId) return 'group-chat';
    if (!context.chatId) return 'no-chat';
    // sendRequest throws on both before it looks at the profile (extensions/shared.js:427).
    if (!context.ConnectionManagerRequestService || (settings.disabledExtensions ?? []).includes('connection-manager')) {
        return 'no-connection-manager';
    }
    if (!(settings.connectionManager?.profiles ?? []).some((profile) => profile.id === memoryProfileId)) return 'profile-missing';
    return null;
}

function sameProfile(context, memoryProfileId) {
    return context.extensionSettings?.connectionManager?.selectedProfile === memoryProfileId;
}
