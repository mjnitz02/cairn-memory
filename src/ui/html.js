/**
 * The inspector's shared pieces: a labelled row, a number, escaped text, and the
 * words for a closed memory-call gate (src/pipeline/gates.js). Pure strings.
 */
import { SLUG } from '../constants.js';

/** Why memory calls are idle, in the words of the switch that would change it. */
export const GATES = Object.freeze({
    'no-profile': 'off — no memory connection chosen',
    'group-chat': 'off — group chats are not supported',
    'no-chat': 'no chat open',
    'no-connection-manager': 'waiting — the Connection Manager extension is disabled',
    'profile-missing': 'waiting — the memory connection profile no longer exists',
    'qvink-summarising': 'waiting — Qvink\'s Auto Summarize is on',
});

export function row(label, value) {
    return `<div class="${SLUG}-row"><span>${label}</span><b>${value}</b></div>`;
}

export function fmt(n) {
    return Number(n ?? 0).toLocaleString();
}

export function escapeHtml(value) {
    return String(value ?? '').replace(/[&<>"']/g, (c) => (
        { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', '\'': '&#39;' }[c]
    ));
}
