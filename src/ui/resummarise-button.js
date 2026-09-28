/**
 * Cairn's two buttons in each message's actions menu, where qvink and WTrackerLite put
 * theirs: "Summarise with Cairn" (cubes stacked) redoes the summary and its index
 * record, and "Rebuild the world state" (boxes stacked) redoes the state on that
 * message (D-0089). A click asks the summarizer; the summarizer decides.
 *
 * The refusal messages are pure. `installResummariseButton` is the DOM glue.
 */
import { SLUG } from '../constants.js';
import { toast, warn } from '../util/log.js';
import { GATES } from './html.js';

export const RESUMMARISE_CLASS = `${SLUG}-resummarise`;
export const RESTATE_CLASS = `${SLUG}-restate`;

/** Why a message can't be summarised, for the refusals that aren't a closed gate. */
const REFUSED = Object.freeze({
    'off': 'Cairn is turned off',
    'no-message': 'the message is no longer in the chat',
    'hidden': 'hidden messages are not summarised',
    'too-short': 'the message is too short to summarise',
    'future': 'a newer version of Cairn wrote this message\'s memory',
});

/**
 * @param {number} index
 * @param {string} reason The summarizer's `resummarise` reason.
 * @returns {string}
 */
export function refusalMessage(index, reason) {
    // A gate's panel wording, without its "off —" or "waiting —" lead.
    const why = REFUSED[reason] ?? GATES[reason]?.replace(/^\w+ — /, '') ?? reason;
    return `Cairn can't summarise message #${index}: ${why}.`;
}

/** Why a message's world state can't be rebuilt, for the refusals that aren't a closed gate. */
const STATE_REFUSED = Object.freeze({
    'disabled': 'Cairn is turned off',
    'off': 'Keep the world state is turned off',
    'wtracker-loaded': 'WTracker is keeping the world state',
    'no-message': 'the message is no longer in the chat',
    'hidden': 'hidden messages have no world state',
    'future': 'a newer version of Cairn wrote this message\'s memory',
});

/**
 * @param {number} index
 * @param {string} reason The summarizer's `restate` reason.
 * @returns {string}
 */
export function restateRefusalMessage(index, reason) {
    const why = STATE_REFUSED[reason] ?? GATES[reason]?.replace(/^\w+ — /, '') ?? reason;
    return `Cairn can't rebuild the world state on message #${index}: ${why}.`;
}

/**
 * Each button: its class, icon and tooltip, what it asks the summarizer, and what a
 * refusal says. Listed in the order they appear in the menu.
 */
const BUTTONS = [
    {
        className: RESUMMARISE_CLASS,
        icon: 'fa-cubes-stacked',
        title: 'Summarise with Cairn (replaces this message\'s summary and its index record)',
        ask: 'resummarise',
        refusal: refusalMessage,
        what: 'summarise the message',
    },
    {
        className: RESTATE_CLASS,
        icon: 'fa-boxes-stacked',
        title: 'Rebuild the world state with Cairn (replaces the state on this message)',
        ask: 'restate',
        refusal: restateRefusalMessage,
        what: 'rebuild the world state',
    },
];

/**
 * Adds the buttons to ST's message template, so every message drawn from now on has
 * them, and answers clicks on them from the chat.
 *
 * @param {{resummarise: (index: number) => {queued: boolean, reason?: string},
 *          restate: (index: number) => {queued: boolean, reason?: string}}} summarizer
 */
export function installResummariseButton(summarizer) {
    try {
        // ST clones `#message_template .mes` for every message (public/script.js:448).
        const menu = document.querySelector('#message_template .mes_buttons .extraMesButtons');
        const chat = document.getElementById('chat');
        if (!menu || !chat) return;

        // Prepended last first, so they read in the order listed.
        for (const spec of [...BUTTONS].reverse()) {
            if (menu.querySelector(`.${spec.className}`)) continue;
            const button = document.createElement('div');
            button.title = spec.title;
            // `.mes_buttons .mes_button` answers Enter like a click (public/scripts/keyboard.js:17).
            button.className = `mes_button ${spec.className} fa-solid ${spec.icon}`;
            button.tabIndex = 0;
            menu.prepend(button);
        }

        chat.addEventListener('click', (event) => {
            const target = event.target instanceof Element ? event.target : null;
            const spec = target && BUTTONS.find((entry) => target.closest(`.${entry.className}`));
            if (!spec) return;
            try {
                const index = Number(target.closest('.mes[mesid]')?.getAttribute('mesid'));
                if (!Number.isInteger(index)) return;
                const { queued, reason } = summarizer[spec.ask](index);
                if (!queued) toast(spec.refusal(index, reason));
            } catch (err) {
                warn(`Could not ${spec.what}.`, err);
            }
        });
    } catch (err) {
        warn('Could not add Cairn\'s message buttons.', err);
    }
}
