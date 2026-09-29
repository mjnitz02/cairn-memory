/**
 * "Adopt this chat", in the settings panel (docs/decisions.md D-0090). A batch of paid
 * calls, so it lives behind a collapsed section and a confirmation that says what it will
 * cost, and never on a message where it could be hit by accident.
 *
 * "Redo from scratch" is the same walk over every message again (D-0092).
 *
 * `adoptionMessage`, `progressText` and `doneText` are pure. `installAdoptControls` is the DOM glue.
 */
import { SLUG } from '../constants.js';
import { toast, warn } from '../util/log.js';
import { GATES } from './html.js';

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
    if (preview.redo) {
        return [
            '<h3>Redo this chat\'s memory?</h3>',
            '<p>Cairn will rebuild this chat\'s memory from the first message, on the memory model it uses now:</p>',
            '<ul>',
            `<li>summarise all <b>${preview.summaries}</b> messages again, replacing Cairn's summaries and taking none from Qvink;</li>`,
            `<li>clear the index and every canon pick, then every <b>${preview.every}</b> summaries index them and pick canon again — <b>${preview.steps}</b> steps.</li>`,
            '</ul>',
            `<p>About <b>${preview.calls}</b> calls to the memory model. The old index and canon are gone once it starts; a summary that fails keeps the old one. The world state is left as it is. You can cancel between calls, and what is written stays.</p>`,
        ].join('');
    }
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
        case 'clear':
            return `Cleared the index and canon from ${update.cleared} messages.`;
        case 'summarise':
            return `Summarising ${update.done + 1} of ${update.of}…`;
        case 'replay':
            return `Step ${update.step} of ${update.of}: indexing and picking canon through message #${update.through}…`;
        default:
            return '';
    }
}

/** The panel's line once it stops. */
export function doneText(result) {
    const counts = [
        ...(result.cleared ? [`${result.cleared} cleared`] : []),
        ...(result.imported ? [`${result.imported} imported`] : []),
        `${result.summarised} summarised`,
        `${result.steps} steps`,
    ];
    return `${result.cancelled ? 'Stopped' : 'Done'}: ${counts.join(', ')}.`;
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
        const redo = document.getElementById(`${SLUG}_adoptRedo`);
        const cancel = document.getElementById(`${SLUG}_adoptCancel`);
        const status = document.getElementById(`${SLUG}_adoptStatus`);
        if (!start || !redo || !cancel || !status) return;

        const running = (on) => {
            start.hidden = on;
            redo.hidden = on;
            cancel.hidden = !on;
        };

        const begin = async (again) => {
            try {
                const preview = summarizer.adoptionPreview({ redo: again });
                if (!preview.ok) {
                    toast(adoptionRefusal(preview.reason));
                    return;
                }
                const { callGenericPopup, POPUP_TYPE, POPUP_RESULT } = context;
                // Enter answers no: a batch of paid calls needs a click, not a keystroke.
                const answer = await callGenericPopup(adoptionMessage(preview), POPUP_TYPE.CONFIRM, '', {
                    okButton: again ? 'Redo' : 'Adopt', cancelButton: 'Cancel', defaultResult: POPUP_RESULT.NEGATIVE,
                });
                if (answer !== POPUP_RESULT.AFFIRMATIVE) return;

                running(true);
                status.textContent = 'Starting…';
                const result = await summarizer.adopt({
                    redo: again,
                    onProgress: (update) => { status.textContent = progressText(update); },
                });
                if (result.ok) onAdopted?.();
                status.textContent = result.ok ? doneText(result) : adoptionRefusal(result.reason);
            } catch (err) {
                warn('Could not adopt the chat.', err);
                status.textContent = 'The adoption stopped with an error; see the console.';
            } finally {
                running(false);
            }
        };
        start.addEventListener('click', () => begin(false));
        redo.addEventListener('click', () => begin(true));

        cancel.addEventListener('click', () => {
            summarizer.cancelAdoption();
            status.textContent = 'Stopping after the call in progress…';
        });
    } catch (err) {
        warn('Could not add the adopt controls.', err);
    }
}
