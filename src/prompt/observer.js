/**
 * Read-only prompt observer — phase P0 (DESIGN.md §13).
 *
 * Watches the finished prompt on its way out and records what it was made of
 * and how much of it the model had already cached. It writes nothing back and
 * clones nothing: this runs alongside whatever else is installed, and the one
 * thing it must never do is perturb the prompt it is measuring.
 *
 * Handlers never throw. A diagnostic that breaks a generation is worse than no
 * diagnostic (CLAUDE.md §4.17).
 */
import { buildInventory, summarizeInventory } from './inventory.js';
import { assessOrdering } from './lorebook.js';
import { attributeOffset, locateInjections } from './locate.js';
import { comparePrompts, flattenPrompt } from '../util/prefix.js';
import { countTokens } from '../util/tokens.js';
import { debug, warn } from '../util/log.js';

const DEFAULT_HISTORY = 20;

/**
 * Takes a *getter*, not a context. `SillyTavern.getContext()` returns a snapshot:
 * `extensionPrompts` and `chatMetadata` are reassigned by ST (`extension_prompts = {}`
 * in clearChat, public/script.js:1590; `chat_metadata` in ten places including
 * updateChatMetadata, :8979) and `maxContext` is a copied number. A context held
 * across turns silently goes stale — which is exactly how the inspector came to
 * report zero injections while qvink was visibly injecting.
 *
 * @param {() => object} getContext Returns a fresh SillyTavern.getContext()
 * @param {{limit?: number, onSnapshot?: (snapshot: object) => void}} [options]
 */
export function createObserver(getContext, { limit = DEFAULT_HISTORY, onSnapshot } = {}) {
    /**
     * Previous flattened prompt per API path — the baseline the meter compares
     * against. Keyed by API because a text-completion string and a flattened
     * chat-completion array share almost no prefix: comparing across them
     * reports a collapse that is an artifact of switching backend, not a
     * finding about the prompt.
     */
    const previousPrompts = new Map();

    /** WI fires before the prompt hooks, so entries wait here for the snapshot. */
    let pendingWorldInfo = [];

    const snapshots = [];
    let running = false;

    async function record(api, prompt) {
        // Re-read every turn. See the note on getContext above.
        const context = getContext();

        const extensionPrompts = context.extensionPrompts;
        const flat = flattenPrompt(prompt);
        const stability = comparePrompts(previousPrompts.get(api) ?? null, flat);
        const counted = await buildInventory(extensionPrompts, {
            countTokens: (text) => countTokens(context, text),
        });
        // Where each block sits, so the divergence index has a name rather than
        // being an offset someone has to go and look up by hand.
        const inventory = locateInjections(flat, counted, textsOf(extensionPrompts));
        const promptTokens = await countTokens(context, flat);
        const maxContext = Number(context.maxContext) || 0;

        const snapshot = {
            at: new Date().toISOString(),
            api,
            promptChars: flat.length,
            promptTokens,
            maxContext,
            contextPercent: maxContext ? round1((promptTokens / maxContext) * 100) : null,
            stability,
            divergenceIn: attributeOffset(stability.divergence?.index, inventory),
            inventory,
            summary: summarizeInventory(inventory),
            worldInfo: pendingWorldInfo,
            worldInfoOrdering: assessOrdering(pendingWorldInfo),
        };

        previousPrompts.set(api, flat);
        pendingWorldInfo = [];

        snapshots.push(snapshot);
        if (snapshots.length > limit) snapshots.shift();

        debug(`${api}: ${promptTokens} tokens, stability ${stability.stabilityPercent ?? '—'}%`);
        onSnapshot?.(snapshot);
        return snapshot;
    }

    /**
     * Text completion — `{prompt, dryRun}`, public/script.js:5243.
     * We read `eventData.prompt` and never assign to it.
     */
    async function onTextCompletion(eventData) {
        if (eventData?.dryRun) return;
        try {
            await record('text-completion', eventData?.prompt);
        } catch (err) {
            warn('Observer failed on text-completion prompt.', err);
        }
    }

    /**
     * Chat completion — `{chat, dryRun}`, public/scripts/openai.js:1619.
     * `eventData.chat` is ST's live array. We read it in place: no clone, no
     * write-back (docs/decisions.md, Lessons).
     */
    async function onChatCompletion(eventData) {
        if (eventData?.dryRun) return;
        try {
            await record('chat-completion', eventData?.chat);
        } catch (err) {
            warn('Observer failed on chat-completion prompt.', err);
        }
    }

    /**
     * World Info activations — public/scripts/world-info.js:902. Emitted after
     * placement is already decided, so this is accounting, not interception.
     */
    function onWorldInfoActivated(entries) {
        try {
            pendingWorldInfo = (entries ?? []).map((entry) => ({
                world: entry?.world ?? '',
                uid: entry?.uid,
                comment: entry?.comment ?? '',
                position: entry?.position,
                depth: entry?.depth,
                // The sort key. Ties here reshuffle the block every turn.
                order: entry?.order,
                outletName: entry?.outletName ?? '',
            }));
        } catch (err) {
            warn('Observer failed to record World Info activations.', err);
            pendingWorldInfo = [];
        }
    }

    return {
        start() {
            if (running) return;
            const { eventSource, eventTypes } = getContext();
            eventSource.on(eventTypes.GENERATE_AFTER_COMBINE_PROMPTS, onTextCompletion);
            eventSource.on(eventTypes.CHAT_COMPLETION_PROMPT_READY, onChatCompletion);
            eventSource.on(eventTypes.WORLD_INFO_ACTIVATED, onWorldInfoActivated);
            running = true;
            debug('Observer started.');
        },

        stop() {
            if (!running) return;
            const { eventSource, eventTypes } = getContext();
            eventSource.removeListener(eventTypes.GENERATE_AFTER_COMBINE_PROMPTS, onTextCompletion);
            eventSource.removeListener(eventTypes.CHAT_COMPLETION_PROMPT_READY, onChatCompletion);
            eventSource.removeListener(eventTypes.WORLD_INFO_ACTIVATED, onWorldInfoActivated);
            running = false;
            debug('Observer stopped.');
        },

        /** A new chat is a new baseline; comparing across chats is meaningless. */
        resetBaseline() {
            previousPrompts.clear();
            pendingWorldInfo = [];
        },

        get running() {
            return running;
        },

        get snapshots() {
            return snapshots;
        },

        get latest() {
            return snapshots[snapshots.length - 1] ?? null;
        },
    };
}

/** Key -> raw value, the form locateInjections() searches with. */
function textsOf(extensionPrompts) {
    const texts = {};
    for (const [key, prompt] of Object.entries(extensionPrompts ?? {})) {
        texts[key] = prompt?.value ?? '';
    }
    return texts;
}

function round1(value) {
    return Math.round(value * 10) / 10;
}
