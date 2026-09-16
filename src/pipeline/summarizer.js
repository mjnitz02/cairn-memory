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
import { perMessage, resolveSummaryPrompt } from '../memory/scene-strategy.js';
import { writeScene } from '../store/chat-store.js';
import { hashString } from '../util/hash.js';
import { countTokens } from '../util/tokens.js';
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

/** Counters for the open chat. The log keeps running totals, so a reader diffs two lines. */
function freshStats() {
    return { calls: 0, written: 0, failures: 0, lastReason: null, lastMs: null, ms: 0, tokensIn: 0, tokensOut: 0 };
}

/**
 * @param {() => object} getContext Returns a fresh SillyTavern.getContext()
 * @param {{settings: () => {memoryProfileId?: string, summaryPrompt?: string},
 *          strategy?: object, clock?: () => number, onUpdate?: () => void}} options
 *        `onUpdate` fires when a request goes out or settles, so the panel can follow
 *        work that happens between generations.
 */
export function createSummarizer(getContext, { settings, strategy = perMessage, clock = Date.now, onUpdate } = {}) {
    /** `chatId` + message hash → `{count, reason}` this session. An edit starts the count again. */
    const attempts = new Map();
    let stats = freshStats();
    /** The chat `stats` counts for. A reload of the same chat keeps them. */
    let statsChat = null;
    let gateReason = null;
    /** The message a request is out for, or null. */
    let inFlight = null;
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
            if (gate.reason !== gateReason) {
                gateReason = gate.reason;
                notify();
            }
            if (gate.reason === 'no-connection-manager') toastOnce(NO_CONNECTION_MANAGER);
            if (gate.reason === 'profile-missing') toastOnce(PROFILE_MISSING);
            if (!gate.ready) return;
            if (gate.sameProfile) toastOnce(SAME_PROFILE);

            const { chat, chatId } = context;
            const index = pendingScenes(chat).find((at) => failuresOf(chatId, chat[at]) < MAX_ATTEMPTS);
            if (index === undefined) return;
            const landed = await summarise(context, config, index);
            // After the outcome is recorded, not when the request settles: a panel that
            // redraws in between shows the message as neither in flight nor written.
            notify();
            if (!landed) return;
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
        // A chat change swaps `stats` while this is out; its cost belongs to the chat it was for.
        const counting = stats;
        const started = clock();
        try {
            request = strategy.build({
                message,
                history: sceneHistory(chat, index),
                template: summaryPrompt,
                expand: (text) => context.substituteParams(text),
            });
            if (request.fallback) toastOnce(PROMPT_FALLBACK);
            counting.calls++;
            // ST's tokenizer is the chat model's, not the memory model's: a size, not a bill.
            counting.tokensIn += await countTokens(context, request.messages.map((m) => m.content).join('\n'));
            inFlight = index;
            notify();
            reply = await context.ConnectionManagerRequestService.sendRequest(
                memoryProfileId, request.messages, request.maxTokens,
                { stream: false, signal, includePreset: true, includeInstruct: true },
            );
            counting.tokensOut += await countTokens(context, `${reply?.content ?? ''}${reply?.reasoning ?? ''}`);
        } catch (err) {
            if (signal.aborted) return discard(index, 'aborted');
            return fail(chatId, message, index, 'error', err);
        } finally {
            inFlight = null;
            counting.lastMs = clock() - started;
            counting.ms += counting.lastMs;
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
        stats.written++;
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
        const count = failuresOf(chatId, message) + 1;
        attempts.set(key, { count, reason });
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
        return attempts.get(keyOf(chatId, message))?.count ?? 0;
    }

    /** Waiting messages in the open chat that have failed at least once, oldest first. */
    function failed() {
        const { chat, chatId } = getContext();
        return pendingScenes(chat).flatMap((index) => {
            const record = attempts.get(keyOf(chatId, chat[index]));
            return record ? [{ index, attempts: record.count, reason: record.reason }] : [];
        });
    }

    function givenUp() {
        return failed().filter((entry) => entry.attempts >= MAX_ATTEMPTS).map((entry) => entry.index);
    }

    /** A panel that throws costs the panel, not the summary. */
    function notify() {
        try {
            onUpdate?.();
        } catch (err) {
            warn('Could not report summarizer progress.', err);
        }
    }

    /** Not awaited: ST awaits this event before it renders the reply (public/script.js:6781-6782). */
    function onMessageReceived() {
        drain();
    }

    /** A request for the chat being left is abandoned; the new chat's queue starts. */
    function onChatChanged() {
        controller?.abort();
        const { chatId } = getContext();
        if (chatId !== statsChat) {
            stats = freshStats();
            statsChat = chatId;
        }
        notify();
        drain();
    }

    return {
        start() {
            if (running) return;
            const { eventSource, eventTypes, chatId } = getContext();
            eventSource.on(eventTypes.MESSAGE_RECEIVED, onMessageReceived);
            eventSource.on(eventTypes.CHAT_CHANGED, onChatChanged);
            statsChat = chatId;
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
        givenUp,

        /**
         * Counts, sizes and timings for the open chat — never a summary's text. `gate`
         * is the last run's verdict (`assessSummarizing`), null before the first run.
         */
        get status() {
            const status = {
                ...stats, gate: gateReason, streak, inFlight, pending: null, failed: [], givenUp: [], promptDefault: null,
            };
            try {
                // The default is what goes out when the prompt is unedited *or* unusable.
                const prompt = resolveSummaryPrompt(settings?.()?.summaryPrompt);
                status.promptDefault = !prompt.edited || prompt.fallback;
                status.pending = pendingScenes(getContext().chat).length;
                status.failed = failed();
                status.givenUp = status.failed.filter((entry) => entry.attempts >= MAX_ATTEMPTS).map((entry) => entry.index);
            } catch (err) {
                warn('Could not read the summary queue.', err);
            }
            return status;
        },
    };
}

function keyOf(chatId, message) {
    return `${chatId}\n${hashString(message.mes)}`;
}
