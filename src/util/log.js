import { DISPLAY_NAME, SLUG } from '../constants.js';

/**
 * Namespaced logger. Quiet by default — debug output is opt-in via settings,
 * because a chatty extension makes the ST console useless for everyone else.
 */

const PREFIX = `[${SLUG}]`;

let debugEnabled = false;

/** Messages already shown to the user, so a per-turn failure toasts once. */
const toasted = new Set();

/** @param {boolean} enabled */
export function setDebugEnabled(enabled) {
    debugEnabled = Boolean(enabled);
}

export function isDebugEnabled() {
    return debugEnabled;
}

/** Suppressed unless debug logging is on. */
export function debug(...args) {
    if (debugEnabled) {
        console.debug(PREFIX, ...args);
    }
}

/** Notable but not wrong — always shown. */
export function info(...args) {
    console.info(PREFIX, ...args);
}

/** Recoverable: we degraded, the chat is fine. */
export function warn(...args) {
    console.warn(PREFIX, ...args);
}

/** Something we did not expect. Still must not escape into ST's generate path. */
export function error(...args) {
    console.error(PREFIX, ...args);
}

/**
 * One user-visible warning per session, per message.
 *
 * A degraded generate hook can degrade on every single turn (CLAUDE.md §4.17
 * asks for *one* toast, not one per turn), and `toastr` only exists inside ST —
 * outside it this is a no-op so the pure modules stay runnable.
 *
 * @param {string} message
 */
export function toastOnce(message) {
    if (toasted.has(message)) return;
    toasted.add(message);
    toast(message);
}

/**
 * A user-visible warning, every time. For a caller that counts for itself — a
 * failure streak, say — where once per session would hide the next streak.
 *
 * @param {string} message
 */
export function toast(message) {
    warn(message);
    if (typeof toastr !== 'undefined') toastr.warning(message, DISPLAY_NAME);
}

/** Test seam: a new session starts quiet again. */
export function resetToasts() {
    toasted.clear();
}
