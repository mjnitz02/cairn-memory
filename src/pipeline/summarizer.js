/**
 * The summarizer — the only file that calls a model (docs/p2-plan.md §2).
 *
 * It owns the queue, the transport, and what a failure does. What the prompt says
 * and how a reply is read belong to the strategy (memory/scene-strategy.js), and
 * which messages wait belongs to memory/scenes.js.
 *
 * A failure writes nothing and toasts once per streak, and the step holds before
 * the message instead (pipeline/scheduler.js), so the raw window grows rather
 * than memory being lost. Nothing here may reach ST's event path (CLAUDE.md §4.17).
 */
import { pendingScenes, qvinkSummarising, sceneHistory } from '../memory/scenes.js';
import { perMessage } from '../memory/scene-strategy.js';
import { writeScene } from '../store/chat-store.js';
import { hashString } from '../util/hash.js';
import { debug, error, toast, toastOnce, warn } from '../util/log.js';

/** Failures before a message is left alone for the rest of the session. */
export const MAX_ATTEMPTS = 3;

const NO_CONNECTION_MANAGER = 'Cairn needs the Connection Manager extension enabled to write memory summaries.';
const PROFILE_MISSING = 'Cairn\'s memory connection profile no longer exists. Choose another in Cairn\'s settings.';
const SAME_PROFILE = 'Cairn\'s memory connection is the profile this chat uses. Memory summaries should come from a separate model.';
const PROMPT_FALLBACK = 'Cairn\'s summary prompt has no {{message}}, so the default prompt is being used.';

/**
 * Whether Cairn may summarise in this chat now, and if not, why.
 *
 * @param {object} context SillyTavern.getContext()
 * @param {{memoryProfileId?: string}} settings
 * @returns {{ready: boolean, reason: string, sameProfile: boolean}}
 */
export function assessSummarizing(context, { memoryProfileId } = {}) {
    const blocked = (reason) => ({ ready: false, reason, sameProfile: false });
    const settings = context?.extensionSettings ?? {};
    const manager = settings.connectionManager;

    // No profile, no memory calls (docs/decisions.md D-0006).
    if (!memoryProfileId) return blocked('no-profile');
    if (context.groupId) return blocked('group-chat');
    if (!context.chatId) return blocked('no-chat');
    // sendRequest throws on both before it looks at the profile (extensions/shared.js:427).
    if (!context.ConnectionManagerRequestService || (settings.disabledExtensions ?? []).includes('connection-manager')) {
        return blocked('no-connection-manager');
    }
    if (!(manager?.profiles ?? []).some((profile) => profile.id === memoryProfileId)) return blocked('profile-missing');
    if (qvinkSummarising(settings)) return blocked('qvink-summarising');

    return { ready: true, reason: 'ready', sameProfile: manager?.selectedProfile === memoryProfileId };
}

/**
 * @param {() => object} getContext Returns a fresh SillyTavern.getContext()
 * @param {{settings: () => {memoryProfileId?: string, summaryPrompt?: string},
 *          strategy?: object, clock?: () => number}} options
 */
export function createSummarizer(getContext, { settings, strategy = perMessage, clock = Date.now } = {}) {
    /** `chatId` + message hash → failures this session. An edit starts the count again. */
    const attempts = new Map();
    const stats = { gate: null, calls: 0, failures: 0, lastReason: null, lastMs: null };
    let streak = 0;
    let running = false;
    let controller = null;
    let active = null;
    let again = false;

    /** Start a run, or fold this trigger into the one under way. Never rejects. */
    function drain() {
        if (!running) return Promise.resolve();
        if (active) {
            again = true;
            return active;
        }
        active = (async () => {
            do {
                again = false;
                try {
                    await run();
                } catch (err) {
                    error('Summarizer failed.', err);
                }
            } while (again && running);
            active = null;
        })();
        return active;
    }

    /** Oldest first, one at a time, until the queue is empty or a request does not land. */
    async function run() {
        while (running) {
            const context = getContext();
            const config = settings?.() ?? {};
            const gate = assessSummarizing(context, config);
            stats.gate = gate.reason;
            if (gate.reason === 'no-connection-manager') toastOnce(NO_CONNECTION_MANAGER);
            if (gate.reason === 'profile-missing') toastOnce(PROFILE_MISSING);
            if (!gate.ready) return;
            if (gate.sameProfile) toastOnce(SAME_PROFILE);

            const { chat, chatId } = context;
            const index = pendingScenes(chat).find((at) => failuresOf(chatId, chat[at]) < MAX_ATTEMPTS);
            if (index === undefined) return;
            if (!await summarise(context, config, index)) return;
        }
    }

    /** @returns {Promise<boolean>} Whether a scene was written, and the run should go on. */
    async function summarise(context, { memoryProfileId, summaryPrompt }, index) {
        const { chat, chatId } = context;
        const message = chat[index];
        const hash = hashString(message.mes);
        controller = new AbortController();
        const { signal } = controller;

        let request;
        let reply;
        const started = clock();
        try {
            request = strategy.build({
                message,
                history: sceneHistory(chat, index),
                template: summaryPrompt,
                expand: (text) => context.substituteParams(text),
            });
            if (request.fallback) toastOnce(PROMPT_FALLBACK);
            stats.calls++;
            reply = await context.ConnectionManagerRequestService.sendRequest(
                memoryProfileId, request.messages, request.maxTokens,
                { stream: false, signal, includePreset: true, includeInstruct: true },
            );
        } catch (err) {
            if (signal.aborted) return discard(index, 'aborted');
            return fail(chatId, message, index, 'error', err);
        } finally {
            stats.lastMs = clock() - started;
        }

        // Anything can happen in the seconds a request is out (docs/p2-plan.md §2). No
        // chat-id check: opening, reloading or renaming a chat refills the array with new
        // objects (public/script.js:7658, :10713), so the object test already catches it.
        const now = getContext();
        if (signal.aborted) return discard(index, 'aborted');
        if (!now.chat.includes(message)) return discard(index, 'no longer in the chat');
        if (hashString(message.mes) !== hash) return discard(index, 'message edited');

        const parsed = strategy.parse(reply?.content);
        if (!parsed.ok) return fail(chatId, message, index, parsed.reason);
        if (!writeScene(message, { text: parsed.text, prompt: request.prompt, at: new Date(clock()).toISOString() })) {
            return fail(chatId, message, index, 'write');
        }

        attempts.delete(keyOf(chatId, message));
        streak = 0;
        debug(`Summarised message #${index}.`);
        try {
            await now.saveChat();
        } catch (err) {
            warn('Could not save the chat after writing a summary.', err);
        }
        return true;
    }

    function discard(index, why) {
        debug(`Discarded the summary for message #${index}: ${why}.`);
        return false;
    }

    function fail(chatId, message, index, reason, err) {
        const key = keyOf(chatId, message);
        const count = (attempts.get(key) ?? 0) + 1;
        attempts.set(key, count);
        stats.failures++;
        stats.lastReason = reason;
        streak++;

        const detail = `The summary for message #${index} failed (${reason}).`;
        if (streak === 1) toast(`${detail} Cairn will try again after the next reply.`);
        else warn(detail);
        if (err) warn(err);
        if (count >= MAX_ATTEMPTS) {
            warn(`Gave up on message #${index} after ${count} failures. The memory step holds before it until the page is reloaded.`);
        }
        return false;
    }

    function failuresOf(chatId, message) {
        return attempts.get(keyOf(chatId, message)) ?? 0;
    }

    /** Not awaited: ST awaits this event before it renders the reply (public/script.js:6781-6782). */
    function onMessageReceived() {
        drain();
    }

    /** A request for the chat being left is abandoned; the new chat's queue starts. */
    function onChatChanged() {
        controller?.abort();
        drain();
    }

    return {
        start() {
            if (running) return;
            const { eventSource, eventTypes } = getContext();
            eventSource.on(eventTypes.MESSAGE_RECEIVED, onMessageReceived);
            eventSource.on(eventTypes.CHAT_CHANGED, onChatChanged);
            running = true;
            drain();
        },

        stop() {
            if (!running) return;
            const { eventSource, eventTypes } = getContext();
            eventSource.removeListener(eventTypes.MESSAGE_RECEIVED, onMessageReceived);
            eventSource.removeListener(eventTypes.CHAT_CHANGED, onChatChanged);
            running = false;
            again = false;
            controller?.abort();
        },

        drain,

        /** Resolves when no run is under way. */
        idle() {
            return active ?? Promise.resolve();
        },

        /** Messages in the open chat that have failed too often to try again this session. */
        givenUp() {
            const { chat, chatId } = getContext();
            return pendingScenes(chat).filter((index) => failuresOf(chatId, chat[index]) >= MAX_ATTEMPTS);
        },

        get status() {
            return { ...stats, streak };
        },
    };
}

function keyOf(chatId, message) {
    return `${chatId}\n${hashString(message.mes)}`;
}
