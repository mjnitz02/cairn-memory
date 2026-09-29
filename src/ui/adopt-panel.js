/**
 * "Adopt this chat", in the settings panel (docs/decisions.md D-0090). A batch of paid
 * calls, so it lives behind a collapsed section and a confirmation that says what it will
 * cost, and never on a message where it could be hit by accident.
 *
 * `adoptionMessage` and `progressText` are pure. `installAdoptControls` is the DOM glue.
 */
import { SLUG } from '../constants.js';
import { toast, warn } from '../util/log.js';
import { GATES, escapeHtml } from './html.js';

const REFUSED = Object.freeze({
    disabled: 'Cairn is turned off',
    adopting: 'an adoption is already running',
});

/** Why the chat can't be adopted, in the panel's words. */
export function adoptionRefusal(reason) {
    const why = REFUSED[reason] ?? GATES[reason]?.replace(/^\w+ — /, '') ?? reason;
    return `Cairn can't adopt this chat: ${why}.`;
}

/** The confirmation's body: what will happen, and roughly what it costs. */
export function adoptionMessage(preview) {
    const lines = [
        '<h3>Adopt this chat?</h3>',
        '<p>Cairn will walk this chat from the first message as if it had been on all along:</p>',
        '<ul>',
        `<li>take <b>${preview.imports.length}</b> summaries from Qvink as its own (no calls);</li>`,
        `<li>summarise <b>${preview.summaries}</b> messages that have none;</li>`,
        `<li>then, every <b>${preview.every}</b> summaries, index them and re-pick canon — <b>${preview.steps}</b> steps.</li>`,
        '</ul>',
        `<p>About <b>${preview.calls}</b> calls to the memory model. Canon is re-picked at each step and the earlier picks stay under their messages as history. You can cancel between calls, and what is written stays.</p>`,
    ];
    return lines.join('');
}

/** One line for the panel while it runs. */
export function progressText(update) {
    switch (update.phase) {
        case 'import':
            return `Took ${update.imported} summaries from Qvink.`;
        case 'summarise':
            return `Summarising ${update.done + 1} of ${update.of}…`;
        case 'replay':
            return `Step ${update.step} of ${update.of}: indexing and picking canon through message #${update.through}…`;
        default:
            return '';
    }
}

/**
 * @param {object} context SillyTavern.getContext()
 * @param {{adoptionPreview: Function, adopt: Function, cancelAdoption: Function}} summarizer
 * @param {{onAdopted?: () => void}} [options] Called once it stops, done or not, since
 *        whatever it wrote is new memory the next prompt should be rebuilt from.
 */
export function installAdoptControls(context, summarizer, { onAdopted } = {}) {
    try {
        const start = document.getElementById(`${SLUG}_adopt`);
        const cancel = document.getElementById(`${SLUG}_adoptCancel`);
        const status = document.getElementById(`${SLUG}_adoptStatus`);
        if (!start || !cancel || !status) return;

        const running = (on) => {
            start.hidden = on;
            cancel.hidden = !on;
        };

        start.addEventListener('click', async () => {
            try {
                const preview = summarizer.adoptionPreview();
                if (!preview.ok) {
                    toast(adoptionRefusal(preview.reason));
                    return;
                }
                const { callGenericPopup, POPUP_TYPE, POPUP_RESULT } = context;
                // Enter answers no: a batch of paid calls needs a click, not a keystroke.
                const answer = await callGenericPopup(adoptionMessage(preview), POPUP_TYPE.CONFIRM, '', {
                    okButton: 'Adopt', cancelButton: 'Cancel', defaultResult: POPUP_RESULT.NEGATIVE,
                });
                if (answer !== POPUP_RESULT.AFFIRMATIVE) return;

                running(true);
                status.textContent = 'Starting…';
                const result = await summarizer.adopt({ onProgress: (update) => { status.textContent = progressText(update); } });
                if (result.ok) onAdopted?.();
                status.innerHTML = result.ok
                    ? `${result.cancelled ? 'Stopped' : 'Done'}: ${escapeHtml(String(result.imported))} imported, `
                        + `${escapeHtml(String(result.summarised))} summarised, ${escapeHtml(String(result.steps))} steps.`
                    : escapeHtml(adoptionRefusal(result.reason));
            } catch (err) {
                warn('Could not adopt the chat.', err);
                status.textContent = 'The adoption stopped with an error; see the console.';
            } finally {
                running(false);
            }
        });

        cancel.addEventListener('click', () => {
            summarizer.cancelAdoption();
            status.textContent = 'Stopping after the call in progress…';
        });
    } catch (err) {
        warn('Could not add the adopt controls.', err);
    }
}
