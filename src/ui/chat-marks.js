/**
 * Cairn's summaries, shown under the messages they summarise — where qvink shows
 * its own (its index.js:1445-1511), so switching between them reads the same.
 *
 * Also the only feedback that summarising is happening at all: the message being
 * summarised says so while its request is out. Nothing here waits on it, and
 * nothing here blocks the chat (docs/p2-plan.md §3).
 *
 * `markMessages` and `renderMark` are pure. `createChatMarks` is the DOM glue.
 */
import { SLUG } from '../constants.js';
import { pendingScenes } from '../memory/scenes.js';
import { MAX_ATTEMPTS } from '../pipeline/summarizer.js';
import { readScene } from '../store/chat-store.js';
import { warn } from '../util/log.js';

/**
 * What each message shows. Only Cairn's own work: qvink draws its summaries itself
 * while it is enabled.
 *
 * @param {Array<object>} chat
 * @param {object|null} status The summarizer's `status`.
 * @returns {Map<number, {state: 'written'|'writing'|'waiting'|'failed'|'given-up',
 *          text?: string, reason?: string, attempts?: number}>}
 */
export function markMessages(chat, status) {
    const marks = new Map();
    (chat ?? []).forEach((message, index) => {
        const { status: stored, scene } = readScene(message);
        if (stored === 'valid') marks.set(index, { state: 'written', text: scene.text });
    });
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

/** @returns {string} The mark's inner HTML. Scene text is escaped, never formatted. */
export function renderMark(mark) {
    switch (mark.state) {
        case 'written':
            return `<span class="${SLUG}-scene-label">Cairn:</span> ${escapeHtml(mark.text)}`;
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
 * @param {{status: () => (object|null)}} options
 */
export function createChatMarks(getContext, { status }) {
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
            const marks = running ? markMessages(getContext().chat, status()) : new Map();
            for (const element of root.querySelectorAll('.mes[mesid]')) {
                draw(element, marks.get(Number(element.getAttribute('mesid'))));
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
        node.className = `${SLUG}-scene ${SLUG}-scene-${mark.state}`;
        node.innerHTML = html;
        drawn.set(node, html);
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

function escapeHtml(value) {
    return String(value ?? '').replace(/[&<>"']/g, (c) => (
        { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', '\'': '&#39;' }[c]
    ));
}
