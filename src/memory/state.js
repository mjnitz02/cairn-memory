/**
 * Tier 1 — which state counts, and what the next update reads (docs/p3-plan.md
 * decisions 7-8, §3-4).
 *
 * Nothing is stored about which state is current. The newest valid state wins,
 * read fresh each time, so deletions, branches, swipes and edits roll back with no
 * bookkeeping (§5). Invalidation never cascades: an edit makes stale only the state
 * whose range it touched.
 *
 * Pure: plain data in, plain data out. No ST, no DOM, no network.
 */
import { hashRange, readRange, readState } from '../store/chat-store.js';
import { sceneHistory } from './scenes.js';
import { validState } from './state-schema.js';
import { STATE_MAX_EARLIER, STATE_MAX_MESSAGES } from './state-strategy.js';

/**
 * The two state writers Cairn stands aside for (decision 8). Folders are the ones
 * their repositories clone into, under ST's `third-party/` prefix
 * (src/endpoints/extensions.js:518). Interceptor names are from their manifests:
 * WTrackerLite's manifest.json, and WTracker's at github.com/bmen25124/SillyTavern-WTracker.
 */
export const WTRACKERS = Object.freeze([
    Object.freeze({
        name: 'WTrackerLite',
        extension: 'third-party/SillyTavern-WTrackerLite',
        interceptor: 'wtrackerliteGenerateInterceptor',
    }),
    Object.freeze({
        name: 'WTracker',
        extension: 'third-party/SillyTavern-WTracker',
        interceptor: 'wtrackerGenerateInterceptor',
    }),
]);

/**
 * The newest usable state at or before `through`, walking back. A state counts
 * only while its range hashes the same (store/chat-store.js) and its value is one
 * the schema accepts, since only those can be rendered or patched.
 *
 * @param {Array<object>} chat The live chat. Read only.
 * @param {number} [through] The newest index to consider; the last message by default.
 * @returns {{index: number, state: object}|null}
 */
export function newestState(chat, through = (chat?.length ?? 0) - 1) {
    for (let index = Math.min(through, (chat?.length ?? 0) - 1); index >= 0; index--) {
        const found = usableState(chat, index);
        if (found) return found;
    }
    return null;
}

/**
 * The state that belongs in this prompt, and how many prompt messages sit below
 * its message.
 *
 * `promptChat` is the interceptor's `coreChat`: hidden messages filtered out
 * (public/script.js:4496), the last popped on a swipe (:4498), and each entry a
 * fresh object sharing `extra` with the live chat (:4525). So messages are matched
 * by `extra` identity, never by index, and a swiped-away reply is simply not there.
 *
 * @param {Array<object>} chat The live chat. Read only.
 * @param {Array<object>} promptChat The interceptor's `chat`. Read only.
 * @returns {{index: number, state: object, depth: number}|null} `index` is the live chat's.
 */
export function stateForPrompt(chat, promptChat) {
    const indexOf = new Map();
    (chat ?? []).forEach((message, index) => {
        if (message?.extra && typeof message.extra === 'object') indexOf.set(message.extra, index);
    });

    const entries = promptChat ?? [];
    for (let at = entries.length - 1; at >= 0; at--) {
        const index = indexOf.get(entries[at]?.extra);
        if (index === undefined) continue;
        const found = usableState(chat, index);
        if (found) return { ...found, depth: entries.length - 1 - at };
    }
    return null;
}

/**
 * The next state update, or null when the newest visible message already carries
 * a valid state. It reads every visible message after that state, up to
 * STATE_MAX_MESSAGES of the newest. When it has to leave older ones out (a cold
 * start, or catching up), the scenes just before what it reads go in as background.
 *
 * The state update includes the last message, unlike summaries (decision 2).
 *
 * @param {Array<object>} chat The live chat. Read only.
 * @returns {null|{
 *     index: number, message: object, read: number, hash: string,
 *     messages: Array<object>, state: object, baseIndex: number|null, earlier: string[],
 * }} `message` and `hash` are what `jobStillCurrent` checks before the write.
 */
export function pendingStateJob(chat) {
    const list = chat ?? [];
    let index = list.length - 1;
    while (index >= 0 && !visible(list[index])) index--;
    if (index < 0) return null;
    // A newer Cairn's store is not ours to overwrite (store/chat-store.js).
    if (readState(list, index).status === 'future') return null;

    const base = newestState(list, index);
    if (base?.index === index) return null;

    const unread = [];
    for (let at = (base?.index ?? -1) + 1; at <= index; at++) {
        if (visible(list[at])) unread.push(at);
    }
    const read = Math.min(unread.length, STATE_MAX_MESSAGES);
    const messages = readRange(list, index, read);
    const earlier = unread.length > read
        ? sceneHistory(list, unread[unread.length - read], { count: STATE_MAX_EARLIER }).map((scene) => scene.text)
        : [];

    return {
        index,
        message: list[index],
        read,
        hash: hashRange(messages),
        messages,
        state: base?.state.value ?? {},
        baseIndex: base?.index ?? null,
        earlier,
    };
}

/**
 * Where to write a finished job's state, or -1 when the reply must be discarded:
 * the message is gone, or anything in the range it read has changed — an edit, a
 * hide, a deletion, or a swipe, which keeps `extra` and replaces `mes`
 * (public/script.js:6671-6684). A message after the range does not matter.
 *
 * @param {Array<object>} chat The live chat, as it is now.
 * @param {{message: object, read: number, hash: string}} job
 */
export function jobStillCurrent(chat, job) {
    const index = (chat ?? []).indexOf(job?.message);
    if (index < 0) return -1;
    const range = readRange(chat, index, job.read);
    return range && hashRange(range) === job.hash ? index : -1;
}

/**
 * Which state writer is loaded, if any: a second one in the prompt is what this
 * project exists to end. Loaded means its interceptor is defined, which only its
 * running code does (ST calls it by that name, public/scripts/extensions.js:2035),
 * or its manifest is installed and not disabled (:524, :626). Its settings are
 * never read: they outlive it (docs/decisions.md D-0040).
 *
 * @param {object} context SillyTavern.getContext()
 * @param {{scope?: object}} [options] Where interceptors are defined; `globalThis` in ST.
 * @returns {string|null} Its display name.
 */
export function wtrackerLoaded(context, { scope = globalThis } = {}) {
    const { extensionSettings, getExtensionManifest } = context ?? {};
    const disabled = extensionSettings?.disabledExtensions ?? [];
    const loaded = WTRACKERS.find((tracker) => typeof scope?.[tracker.interceptor] === 'function'
        || (Boolean(getExtensionManifest?.(tracker.extension)) && !disabled.includes(tracker.extension)));
    return loaded?.name ?? null;
}

function usableState(chat, index) {
    const { status, state } = readState(chat, index);
    return status === 'valid' && validState(state.value) ? { index, state } : null;
}

function visible(message) {
    return Boolean(message) && !message.is_system;
}
