/**
 * Where the world state goes in the prompt (docs/decisions.md D-0042): in the
 * chat, directly after the newest message the state has read. In normal play that is
 * depth 1, between the reply it includes and the user's new message.
 *
 * The state is found in the interceptor's `chat` by `extra` identity, so a hidden,
 * popped or deleted message can't supply it (memory/state.js `stateForPrompt`).
 */
import { SLUG } from '../constants.js';
import { stateForPrompt, wtrackerLoaded } from '../memory/state.js';
import { renderState } from '../memory/state-schema.js';
import { countTokens } from '../util/tokens.js';

export const STATE_INJECTION = `${SLUG}_state`;

/**
 * `IN_CHAT` (public/script.js:484) with the system role (:494), out of the World
 * Info scan. The depth is worked out each turn.
 */
export const STATE_PLACEMENT = Object.freeze({ position: 1, role: 0, scan: false });

/**
 * Which state belongs in this prompt, and at what depth, or why none does.
 *
 * `depth` counts the prompt entries after the state's message, which is how ST
 * places an in-chat prompt (`doChatInject`, public/script.js:5628, :5665-5666). The
 * count is exact on both prompt paths only because a state behind the step is never
 * placed: every message after it is newer than the blanking, so none of them is
 * dropped by the ignore flag before chat completion counts depth (openai.js:584).
 *
 * @param {object} context SillyTavern.getContext()
 * @param {Array<object>} promptChat The interceptor's `chat`. Read only.
 * @param {{worldState?: boolean, summarisedThrough?: number, scope?: object}} [options]
 *        `summarisedThrough` is the see-saw's, in live-chat indexes; -1 when unknown.
 * @returns {{reason: 'injected'|'off'|'wtracker-loaded'|'none-yet'|'empty'|'behind-step',
 *            tracker: string|null, index: number|null, depth: number|null, text: string, changed: string[]}}
 */
export function placeState(context, promptChat, { worldState, summarisedThrough = -1, scope } = {}) {
    const result = (reason, found = null, text = '', tracker = null) => ({
        reason, tracker, index: found?.index ?? null, depth: found?.depth ?? null, text,
        changed: text ? [...(found.state.changed ?? [])] : [],
    });

    if (worldState === false) return result('off');
    const tracker = wtrackerLoaded(context, { scope });
    if (tracker) return result('wtracker-loaded', null, '', tracker);

    const found = stateForPrompt(context?.chat, promptChat);
    if (!found) return result('none-yet');
    // Older than the newest summary in the block, so no longer what is true now.
    if (found.index <= summarisedThrough) return result('behind-step', found);
    const text = renderState(found.state.value);
    return text ? result('injected', found, text) : result('empty', found);
}

/**
 * The per-turn glue: place the state, and report what was placed.
 *
 * @param {() => object} getContext Returns a fresh SillyTavern.getContext()
 * @param {{settings?: () => {worldState?: boolean}, scope?: object}} [options]
 */
export function createStatePlacement(getContext, { settings, scope } = {}) {
    /** Last generation's injected text, '' for none, null before the first. */
    let previousText = null;
    let counted = { text: '', tokens: 0 };
    /** This turn's report, for the observer's snapshot. */
    let latest = null;

    /**
     * @param {Array<object>} promptChat The interceptor's `chat`. Read only.
     * @param {{summarisedThrough?: number}} [step]
     * @returns {Promise<{text: string, depth: number|null, placement: object}>}
     */
    async function plan(promptChat, { summarisedThrough = -1 } = {}) {
        const context = getContext();
        const placed = placeState(context, promptChat, {
            worldState: settings?.()?.worldState, summarisedThrough, scope,
        });

        // The tokenizer isn't free and the state rarely changes, so count once per distinct text.
        if (placed.text !== counted.text) {
            counted = { text: placed.text, tokens: placed.text ? await countTokens(context, placed.text) : 0 };
        }

        latest = {
            injected: placed.reason === 'injected',
            reason: placed.reason,
            tracker: placed.tracker,
            index: placed.index,
            depth: placed.depth,
            chars: placed.text.length,
            tokens: counted.tokens,
            // Whether the text differs from last turn's; null on the first turn, with no baseline.
            changed: previousText === null ? null : placed.text !== previousText,
            changeKinds: placed.changed,
            // For the panel only. The disk log records kinds and sizes, never this.
            text: placed.text,
        };
        previousText = placed.text;

        return { text: placed.text, depth: placed.depth, placement: STATE_PLACEMENT };
    }

    return {
        plan,

        /** A new chat is a new baseline. */
        reset() {
            previousText = null;
            latest = null;
        },

        get latest() {
            return latest;
        },
    };
}
