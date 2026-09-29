/**
 * The summaries, shown under the messages they summarise — where qvink shows its
 * own (its index.js:1445-1511), so switching between them reads the same — with the
 * world state and any canon batch stored on each message collapsed beneath them.
 *
 * Also the only feedback that memory work is happening at all: the message being
 * summarised says so while its request is out, and so does the message a world state
 * is being written for, whether the queue or the rebuild button asked (D-0089). Nothing here waits on it, and
 * nothing here blocks the chat (docs/how-it-works.md, "Writing summaries").
 *
 * `markMessages` and `renderMark` are pure. `createChatMarks` is the DOM glue.
 */
import { SLUG } from '../constants.js';
import { pendingScenes, qvinkDisplaying, readScenes } from '../memory/scenes.js';
import { usableState, wtrackerLoaded } from '../memory/state.js';
import { canonTexts } from './canon-section.js';
import { renderState } from '../memory/state-schema.js';
import { MAX_ATTEMPTS } from '../pipeline/tally.js';
import { warn } from '../util/log.js';
import { escapeHtml } from './html.js';

/**
 * What each message shows: the summary the memory block reads for it, and Cairn's
 * work in progress. A stale Cairn summary hides qvink's on the same message too,
 * because the block reads neither (memory/scenes.js).
 *
 * @param {Array<object>} chat
 * @param {object|null} status The summarizer's `status`.
 * @param {{showQvink?: boolean}} [options] `showQvink` while qvink isn't drawing its own.
 * @returns {Map<number, {state: 'written'|'qvink'|'writing'|'waiting'|'failed'|'given-up',
 *          text?: string, excluded?: boolean, reason?: string, attempts?: number}>}
 */
export function markMessages(chat, status, { showQvink = false } = {}) {
    const marks = new Map();
    for (const scene of readScenes(chat)) {
        if (scene.source === 'cairn') marks.set(scene.index, { state: 'written', text: scene.text });
        else if (showQvink) marks.set(scene.index, { state: 'qvink', text: scene.text, excluded: !scene.eligible });
    }
    if (!status) return marks;

    for (const { index, attempts, reason } of status.failed ?? []) {
        marks.set(index, { state: attempts >= MAX_ATTEMPTS ? 'given-up' : 'failed', attempts, reason });
    }
    // "Waiting" only while it is true: behind a closed gate nothing is coming.
    if (status.gate === 'ready') {
        for (const index of pendingScenes(chat)) {
            if (!marks.has(index)) marks.set(index, { state: 'waiting' });
        }
    }
    if (Number.isInteger(status.inFlight)) marks.set(status.inFlight, { state: 'writing' });
    return marks;
}

/**
 * The world state on each message that carries one the reader would use, rendered as
 * the prompt carries it. A state with nothing recorded has nothing to show.
 *
 * @param {Array<object>} chat
 * @returns {Map<number, string>}
 */
export function stateTexts(chat) {
    const texts = new Map();
    (chat ?? []).forEach((_, index) => {
        const found = usableState(chat, index);
        const text = found ? renderState(found.state.value) : '';
        if (text) texts.set(index, text);
    });
    return texts;
}

/**
 * The message a world state is being written for right now, or null. One at a time, so
 * there is no queue to show: the state is brought up to date after each reply.
 *
 * @param {object|null} status The summarizer's `status`.
 * @returns {number|null}
 */
export function stateWriting(status) {
    const index = status?.state?.inFlight;
    return Number.isInteger(index) ? index : null;
}

export const STATE_WRITING_HTML = '<i class="fa-solid fa-spinner fa-spin"></i> Cairn is updating the world state…';

/** @returns {string} The mark's inner HTML. Scene text is escaped, never formatted. */
export function renderMark(mark) {
    switch (mark.state) {
        case 'written':
            return `<span class="${SLUG}-scene-label">Cairn:</span> ${escapeHtml(mark.text)}`;
        case 'qvink':
            // Excluded in qvink, so the block leaves it out.
            return `<span class="${SLUG}-scene-label">${mark.excluded ? 'Qvink (excluded):' : 'Qvink:'}</span> ${escapeHtml(mark.text)}`;
        case 'writing':
            return `<i class="fa-solid fa-spinner fa-spin"></i> Cairn is summarising this message…`;
        case 'waiting':
            return 'Waiting for Cairn to summarise this message.';
        case 'failed':
            return `Cairn's summary failed (${escapeHtml(mark.reason)}). It will try again after the next reply.`;
        case 'given-up':
            return `Cairn gave up on this summary after ${mark.attempts} failures (${escapeHtml(mark.reason)}). `
                + 'The memory step waits here until you edit the message or reload the page.';
        default:
            return '';
    }
}

/**
 * @param {() => object} getContext
 * @param {{status: () => (object|null),
 *          settings?: () => {worldState?: boolean, keepCanon?: boolean}}} options
 */
export function createChatMarks(getContext, { status, settings }) {
    let running = false;
    /** What each mark element last drew, so an unchanged mark is not rewritten. */
    const drawn = new WeakMap();

    /** Never throws: a mark that cannot be drawn costs the mark (CLAUDE.md §4.17). */
    function refresh() {
        try {
            // #chat and .mes[mesid] are ST's (public/script.js:449, :1654); .mes_text is
            // the message body inside each (public/index.html:7461).
            const root = document.getElementById('chat');
            if (!root) return;
            const context = getContext();
            const marks = running
                ? markMessages(context.chat, status(), { showQvink: !qvinkDisplaying(context) })
                : new Map();
            // Hidden where no state goes in the prompt: switched off, or a WTracker keeps its own.
            const showStates = running && settings?.()?.worldState !== false && !wtrackerLoaded(context);
            const states = showStates ? stateTexts(context.chat) : new Map();
            const updating = showStates ? stateWriting(status()) : null;
            // Hidden where no canon goes in the prompt. Unlike a summary or a state, a
            // fact cannot be taken back, so seeing it is the only check there is.
            const showCanon = running && settings?.()?.keepCanon !== false;
            const facts = showCanon ? canonTexts(context.chat) : new Map();
            for (const element of root.querySelectorAll('.mes[mesid]')) {
                const index = Number(element.getAttribute('mesid'));
                draw(element, marks.get(index));
                drawStateWriting(element, index === updating);
                drawState(element, states.get(index));
                drawCanon(element, facts.get(index));
            }
        } catch (err) {
            warn('Could not show summaries in the chat.', err);
        }
    }

    function draw(element, mark) {
        let node = element.querySelector(`.${SLUG}-scene`);
        if (!mark) {
            node?.remove();
            return;
        }
        const html = renderMark(mark);
        if (node && drawn.get(node) === html) return;
        if (!node) {
            const body = element.querySelector('.mes_text');
            if (!body) return;
            node = document.createElement('div');
            body.after(node);
        }
        node.className = `${SLUG}-scene ${SLUG}-scene-${mark.state}${mark.excluded ? ` ${SLUG}-scene-excluded` : ''}`;
        node.innerHTML = html;
        drawn.set(node, html);
    }

    /**
     * Its own line, above the state it will replace, so an open World state section is
     * never redrawn and closed by the spinner coming and going.
     */
    function drawStateWriting(element, writing) {
        let node = element.querySelector(`.${SLUG}-state-writing`);
        if (!writing) {
            node?.remove();
            return;
        }
        if (node) return;
        const body = element.querySelector('.mes_text');
        if (!body) return;
        node = document.createElement('div');
        node.className = `${SLUG}-state-writing`;
        node.innerHTML = STATE_WRITING_HTML;
        (element.querySelector(`.${SLUG}-scene`) ?? body).after(node);
    }

    /**
     * Below the summary if there is one. A summary drawn later goes directly after the
     * body, so it still lands above this.
     */
    function drawState(element, text) {
        drawDetails(element, 'state', 'World state', text, ['state-writing', 'scene']);
    }

    /** Below the state, so the head of the block reads last where it was written. */
    function drawCanon(element, text) {
        drawDetails(element, 'canon', 'Established facts', text, ['state', 'scene']);
    }

    /**
     * A collapsed section under a message, placed after the first of `after` it has, else
     * after the body. Only the text is rewritten, so an open section stays open.
     */
    function drawDetails(element, kind, title, text, after) {
        let node = element.querySelector(`.${SLUG}-${kind}`);
        if (text === undefined) {
            node?.remove();
            return;
        }
        if (!node) {
            const body = element.querySelector('.mes_text');
            if (!body) return;
            node = document.createElement('details');
            node.className = `${SLUG}-${kind}`;
            node.innerHTML = `<summary>${title}</summary><pre></pre>`;
            const anchor = after.map((name) => element.querySelector(`.${SLUG}-${name}`)).find(Boolean);
            (anchor ?? body).after(node);
        }
        const pre = node.querySelector('pre');
        if (pre.textContent !== text) pre.textContent = text;
    }

    /** Every event after which ST has built or rebuilt message elements. */
    function events({ eventTypes }) {
        return [
            eventTypes.CHAT_CHANGED,
            eventTypes.MORE_MESSAGES_LOADED,
            eventTypes.CHARACTER_MESSAGE_RENDERED,
            eventTypes.USER_MESSAGE_RENDERED,
            eventTypes.MESSAGE_UPDATED,
            eventTypes.MESSAGE_DELETED,
            eventTypes.MESSAGE_SWIPED,
        ];
    }

    return {
        refresh,

        start() {
            if (running) return;
            const context = getContext();
            for (const type of events(context)) context.eventSource.on(type, refresh);
            running = true;
            refresh();
        },

        stop() {
            if (!running) return;
            const context = getContext();
            for (const type of events(context)) context.eventSource.removeListener(type, refresh);
            running = false;
            refresh();
        },
    };
}
