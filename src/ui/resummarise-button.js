/**
 * The "Summarise with Cairn" button in each message's actions menu, where qvink and
 * WTrackerLite put theirs. A click asks the summarizer; the summarizer decides.
 *
 * `refusalMessage` is pure. `installResummariseButton` is the DOM glue.
 */
import { SLUG } from '../constants.js';
import { toast, warn } from '../util/log.js';
import { GATES } from './html.js';

export const RESUMMARISE_CLASS = `${SLUG}-resummarise`;

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

/**
 * Adds the button to ST's message template, so every message drawn from now on has
 * it, and answers clicks on it from the chat.
 *
 * @param {{resummarise: (index: number) => {queued: boolean, reason?: string}}} summarizer
 */
export function installResummariseButton({ resummarise }) {
    try {
        // ST clones `#message_template .mes` for every message (public/script.js:448).
        const menu = document.querySelector('#message_template .mes_buttons .extraMesButtons');
        const chat = document.getElementById('chat');
        if (!menu || !chat) return;

        if (!menu.querySelector(`.${RESUMMARISE_CLASS}`)) {
            const button = document.createElement('div');
            button.title = 'Summarise with Cairn (replaces this message\'s summary)';
            // `.mes_buttons .mes_button` answers Enter like a click (public/scripts/keyboard.js:17).
            button.className = `mes_button ${RESUMMARISE_CLASS} fa-solid fa-cubes-stacked`;
            button.tabIndex = 0;
            menu.prepend(button);
        }

        chat.addEventListener('click', (event) => {
            const button = event.target instanceof Element ? event.target.closest(`.${RESUMMARISE_CLASS}`) : null;
            if (!button) return;
            try {
                const index = Number(button.closest('.mes[mesid]')?.getAttribute('mesid'));
                if (!Number.isInteger(index)) return;
                const { queued, reason } = resummarise(index);
                if (!queued) toast(refusalMessage(index, reason));
            } catch (err) {
                warn('Could not summarise the message.', err);
            }
        });
    } catch (err) {
        warn('Could not add the summarise button.', err);
    }
}
