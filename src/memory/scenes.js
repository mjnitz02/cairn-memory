/**
 * Tier 2 — scene summaries (DESIGN.md §5).
 *
 * Tier 2 has two sources, one scene per message: the summaries qvink already
 * wrote, read and never rewritten, and Cairn's own in `extra.cairn`, which win
 * where both exist and count only while their message is unedited
 * (docs/decisions.md D-0037). The scene shape is the same for both, so the assembler
 * does not care which wrote it.
 *
 * Nothing else is read from qvink except whether it is still in the path
 * (interop/qvink.js, docs/decisions.md D-0040).
 *
 * Pure: plain data in, plain data out. No ST, no DOM, no network.
 */

import { readScene, summarisable } from '../store/chat-store.js';
import { QVINK_KEY } from '../interop/qvink.js';

/**
 * Every message carrying a scene, oldest first.
 *
 * A qvink `text` is its `memory` alone. Its prefill reaches its own block only
 * with `show_prefill` on (its index.js:3521), which is off by default (:113).
 *
 * @param {Array<object>} chat ST's live message array. Read only, never mutated.
 * @param {{key?: string}} [options]
 * @returns {Array<object>} `{index, source, text, chars, eligible, remembered,
 *          excluded, include, lagging}`
 */
export function readScenes(chat, { key = QVINK_KEY } = {}) {
    const scenes = [];

    (chat ?? []).forEach((message, index) => {
        const cairn = readScene(message);
        if (cairn.status === 'valid') {
            scenes.push({
                index,
                source: 'cairn',
                text: cairn.scene.text,
                chars: cairn.scene.text.length,
                eligible: true,
                remembered: false,
                excluded: false,
                include: null,
                lagging: false,
            });
            return;
        }
        // An edit invalidated Cairn's scene, and any qvink one on the same
        // message is older still: the message goes back to being raw.
        if (cairn.status === 'stale') return;

        const data = message?.extra?.[key];
        const memory = data?.memory;
        if (typeof memory !== 'string' || memory === '') return;

        const remembered = Boolean(data.remember);
        const excluded = Boolean(data.exclude);

        scenes.push({
            index,
            source: 'qvink',
            text: memory,
            chars: memory.length,
            // qvink's exclusion rule, minus the parts we cannot see from `extra`:
            // a `remember` flag bypasses everything, an `exclude` flag removes it
            // (its index.js:3745-3760). The message-length test is not reproduced
            // — a message too short to summarise has no summary to read.
            eligible: remembered || !excluded,
            remembered,
            excluded,
            include: data.include ?? null,
            lagging: Boolean(data.lagging),
        });
    });

    return scenes;
}

/**
 * Where Cairn's summarising starts: just after qvink's newest summary. Messages
 * qvink skipped before it stay as qvink left them, because summarising them now
 * would insert scenes into the middle of the block (docs/decisions.md D-0037).
 */
export function cairnStart(chat, { key = QVINK_KEY } = {}) {
    const list = chat ?? [];
    for (let index = list.length - 1; index >= 0; index--) {
        const memory = list[index]?.extra?.[key]?.memory;
        if (typeof memory === 'string' && memory !== '') return index + 1;
    }
    return 0;
}

/**
 * Messages waiting for a summary, oldest first: summarisable, at or after the
 * start, with no valid scene — and never the last message, which can still be
 * swiped, regenerated or edited (docs/decisions.md D-0037).
 *
 * @returns {number[]} Chat indexes.
 */
export function pendingScenes(chat, { key = QVINK_KEY } = {}) {
    const list = chat ?? [];
    const pending = [];
    for (let index = cairnStart(list, { key }); index < list.length - 1; index++) {
        const message = list[index];
        if (!summarisable(message)) continue;
        // A newer Cairn's store is not ours to overwrite (store/chat-store.js).
        const { status } = readScene(message);
        if (status !== 'valid' && status !== 'future') pending.push(index);
    }
    return pending;
}

/**
 * Messages a redo summarises, oldest first (docs/decisions.md D-0092): every summarisable
 * one from the first, whatever summary it has now — but never the last, never one Qvink's
 * user excluded, and never a newer Cairn's store.
 *
 * @returns {number[]} Chat indexes.
 */
export function redoScenes(chat, { key = QVINK_KEY } = {}) {
    const list = chat ?? [];
    const redo = [];
    for (let index = 0; index < list.length - 1; index++) {
        const message = list[index];
        if (!summarisable(message) || readScene(message).status === 'future') continue;
        const qvink = message.extra?.[key];
        if (qvink?.exclude && !qvink.remember) continue;
        redo.push(index);
    }
    return redo;
}

/** Scenes sent back with each summary request (docs/decisions.md D-0037). */
export const SCENE_HISTORY = 5;

/**
 * The scenes just before a message, oldest first: what Matt's qvink profile sends
 * back as context, from either source, and never one the user excluded.
 *
 * @returns {Array<object>} Scenes as `readScenes` returns them.
 */
export function sceneHistory(chat, index, { count = SCENE_HISTORY, key = QVINK_KEY } = {}) {
    return readScenes(chat, { key })
        .filter((scene) => scene.index < index && scene.eligible)
        .slice(-count);
}
