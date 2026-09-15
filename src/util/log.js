import { SLUG } from '../constants.js';

/**
 * Namespaced logger. Quiet by default — debug output is opt-in via settings,
 * because a chatty extension makes the ST console useless for everyone else.
 */

const PREFIX = `[${SLUG}]`;

let debugEnabled = false;

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
