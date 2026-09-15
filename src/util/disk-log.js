/**
 * Writes the observer's snapshots to a file on disk, so a run can be read
 * directly instead of copied out of the inspector by hand.
 *
 * Uses ST's own Data Bank endpoint (`/api/files/upload`,
 * src/endpoints/files.js:28) rather than inventing a transport or adding a
 * server plugin. It writes whole files, not appends, so we rewrite the full
 * rolling log each time — a few hundred KB at most for a long session.
 *
 * Lands in `data/<user>/user/files/`.
 */
import { warn, debug } from './log.js';

/** Fixed name so the path is predictable between sessions. */
export const LOG_FILENAME = 'cairn-inspector.jsonl';

/** Wait for a quiet moment before writing; generations arrive in bursts. */
const WRITE_DELAY_MS = 1500;

export function createDiskLog({ filename = LOG_FILENAME, delayMs = WRITE_DELAY_MS } = {}) {
    const entries = [];
    let enabled = false;
    let timer = null;
    let lastPath = null;

    async function flush(getContext) {
        timer = null;
        if (!entries.length) return;

        try {
            const context = getContext();
            const body = entries.map((entry) => JSON.stringify(entry)).join('\n') + '\n';

            const response = await fetch('/api/files/upload', {
                method: 'POST',
                headers: context.getRequestHeaders(),
                body: JSON.stringify({ name: filename, data: toBase64(body) }),
            });

            if (!response.ok) throw new Error(`${response.status} ${await response.text()}`);

            lastPath = (await response.json()).path;
            debug(`Wrote ${entries.length} snapshot(s) to ${lastPath}`);
        } catch (err) {
            // A diagnostic that cannot write is still only a diagnostic.
            warn('Could not write the inspector log.', err);
        }
    }

    return {
        setEnabled(value) {
            enabled = Boolean(value);
        },

        /** Queue a snapshot. Writes are debounced, not per-turn. */
        append(snapshot, getContext) {
            if (!enabled) return;

            entries.push(toEntry(snapshot));
            clearTimeout(timer);
            timer = setTimeout(() => flush(getContext), delayMs);
        },

        /** Drop the accumulated run — a new chat is a new run. */
        reset() {
            entries.length = 0;
        },

        get count() {
            return entries.length;
        },

        get path() {
            return lastPath;
        },
    };
}

/**
 * One line per generation. Flat and self-describing: this file is meant to be
 * read by a person or a script that has never seen the code.
 */
function toEntry(snapshot) {
    return {
        at: snapshot.at,
        api: snapshot.api,
        prompt_tokens: snapshot.promptTokens,
        prompt_chars: snapshot.promptChars,
        max_context: snapshot.maxContext,
        context_percent: snapshot.contextPercent,
        stability_percent: snapshot.stability.stabilityPercent,
        common_prefix: snapshot.stability.commonPrefix,
        previous_chars: snapshot.stability.previousLength,
        divergence_index: snapshot.stability.divergence?.index ?? null,
        divergence_previous: snapshot.stability.divergence?.previous ?? null,
        divergence_current: snapshot.stability.divergence?.current ?? null,
        // Which block the prefix broke inside. `precision` says how much to
        // trust it — see attributeOffset in src/prompt/locate.js.
        divergence_in: snapshot.divergenceIn?.key ?? null,
        divergence_in_owner: snapshot.divergenceIn?.owner ?? null,
        divergence_in_offset: snapshot.divergenceIn?.offsetInEntry ?? null,
        divergence_in_precision: snapshot.divergenceIn?.precision ?? null,
        injected_tokens: snapshot.summary.tokens,
        injected_tokens_estimated: snapshot.inventory.some((entry) => entry.estimated),
        injection_count: snapshot.summary.count,
        writers: snapshot.summary.writers,
        by_owner: snapshot.summary.byOwner,
        injections: snapshot.inventory.map((entry) => ({
            key: entry.key,
            owner: entry.owner,
            position: entry.positionName,
            depth: entry.depth,
            tokens: entry.tokens,
            chars: entry.chars,
            // Where it actually landed, which is the only way to tell a plan
            // that was written from a plan that was honoured.
            offset: entry.offset ?? null,
            offset_percent: entry.offsetPercent ?? null,
            match: entry.match ?? null,
        })),
        world_info: snapshot.worldInfo.map((entry) => ({
            world: entry.world,
            uid: entry.uid,
            comment: entry.comment,
            order: entry.order ?? null,
        })),
        // Entries tied on `order` keep activation order, which changes per turn.
        world_info_tied: snapshot.worldInfoOrdering?.tiedEntries ?? 0,
        world_info_ordering_stable: snapshot.worldInfoOrdering?.stable ?? null,
        // How many entries the holder is keeping in; null when it is off, which is
        // what tells a control run apart from a treatment run.
        world_info_held: snapshot.worldInfoHeld ?? null,
    };
}

/** UTF-8 safe: btoa alone throws on anything outside Latin-1. */
function toBase64(text) {
    const bytes = new TextEncoder().encode(text);
    let binary = '';
    for (const byte of bytes) binary += String.fromCharCode(byte);
    return btoa(binary);
}
