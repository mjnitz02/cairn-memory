/**
 * The inspector's World state section (docs/how-it-works.md): what the state queue is
 * doing, then the state as this prompt carried it. The panel is local and the chat
 * is the user's own, so it shows the text; the disk log never does.
 */
import { SLUG } from '../constants.js';
import { GATES, escapeHtml, fmt, row } from './html.js';

/** Why no state is in the prompt, keyed by `placeState`'s reason. */
const NOT_PLACED = Object.freeze({
    'off': 'World state is switched off',
    'none-yet': 'no state written yet',
    'empty': 'the state has nothing recorded yet',
});

/**
 * @param {object|null} status The summarizer's `status.state`.
 * @param {object|null} placement The state placement's report from the last generation.
 * @returns {string}
 */
export function renderStateSection(status, placement) {
    if (!status && !placement) return '';

    return renderGivenUp(status) + `
        <details class="${SLUG}-details">
            <summary>World state: ${describeWork(status)}</summary>
            ${renderPlacement(placement)}
            ${status ? renderCosts(status) : ''}
        </details>`;
}

function describeWork(status) {
    if (!status) return 'not started';
    if (status.inFlight != null) return `writing through message #${status.inFlight}`;
    if (status.gate === null) return 'not started';
    if (status.gate === 'off') return 'off';
    if (status.gate === 'wtracker-loaded') return `waiting — ${escapeHtml(status.tracker)} is loaded`;
    if (status.gate !== 'ready') return escapeHtml(GATES[status.gate] ?? status.gate);
    if (status.givenUp) return `<span class="${SLUG}-poor">gave up</span>`;
    return status.pending ? 'waiting' : 'up to date';
}

function renderPlacement(placement) {
    if (!placement) return row('In the prompt', '<span class="dim">no generation observed yet</span>');
    if (!placement.injected) return row('In the prompt', `no — ${describeReason(placement)}`);

    // Deeper than 1 means the queue is behind the chat (docs/decisions.md D-0042).
    const behind = placement.depth > 1 ? ` <span class="${SLUG}-fair">— behind the chat</span>` : '';
    const kinds = placement.changeKinds?.length ? placement.changeKinds.map(escapeHtml).join(', ') : 'nothing';
    return `<pre class="${SLUG}-diff">${escapeHtml(placement.text)}</pre>
        ${row('Depth', `${fmt(placement.depth)} from the end${behind}`)}
        ${row('Size', `${fmt(placement.chars)} chars, ${fmt(placement.tokens)} tokens`)}
        ${row('Last change', kinds)}`;
}

function describeReason(placement) {
    if (placement.reason === 'wtracker-loaded') return `${escapeHtml(placement.tracker)} is loaded`;
    if (placement.reason === 'behind-step') {
        return `the newest state, on message #${fmt(placement.index)}, is older than the memory step`;
    }
    return escapeHtml(NOT_PLACED[placement.reason] ?? placement.reason);
}

function renderCosts(status) {
    const failures = status.failures
        ? `<span class="${SLUG}-poor">${fmt(status.failures)} failed</span> <span class="dim">(last: ${escapeHtml(status.lastReason)})</span>`
        : 'none failed';
    const dropped = status.dropped ? `, ${fmt(status.dropped)} fields dropped` : '';
    const average = status.calls ? `${fmt(Math.round(status.ms / status.calls))} ms a request` : '—';

    return row('This chat', `${fmt(status.written)} written from ${fmt(status.calls)} requests, ${failures}${dropped}`)
        + row('Time', average)
        + row('Tokens', `${fmt(status.tokensIn)} in, ${fmt(status.tokensOut)} out <span class="dim">(estimated)</span>`);
}

function renderGivenUp(status) {
    if (!status?.givenUp || !status.failed) return '';

    return `<div class="${SLUG}-warn">Cairn gave up updating the world state through message
        #${fmt(status.failed.index)} after repeated failures. The previous state stays in the prompt until
        a new message arrives or one is edited.</div>`;
}
