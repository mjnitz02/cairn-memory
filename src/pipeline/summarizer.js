/**
 * The summarizer — the only file that calls a model (docs/decisions.md D-0037).
 *
 * It owns the queue, the transport, and what a failure does, for both kinds of
 * memory work: the state update and the summaries (docs/decisions.md D-0044). What a
 * prompt says and how a reply is read belong to the strategies (memory/*-strategy.js),
 * and what is waiting belongs to memory/scenes.js and memory/state.js.
 *
 * A failure writes nothing and toasts once per streak of its kind. A missing summary
 * holds the step before its message (pipeline/scheduler.js), and a missing state
 * leaves the previous one in the prompt. Nothing here may reach ST's event path
 * (CLAUDE.md §4.17).
 */
import { pendingScenes, sceneHistory } from '../memory/scenes.js';
import { perMessage, resolveSummaryPrompt } from '../memory/scene-strategy.js';
import { jobStillCurrent, pendingStateJob } from '../memory/state.js';
import { applyPatch } from '../memory/state-schema.js';
import { statePatch } from '../memory/state-strategy.js';
import { readScene, summarisable, writeScene, writeState } from '../store/chat-store.js';
import { hashString } from '../util/hash.js';
import { countTokens } from '../util/tokens.js';
import { debug, error, toast, toastOnce, warn } from '../util/log.js';
import { assessStateUpdates, assessSummarizing } from './gates.js';
import { MAX_ATTEMPTS, createTally } from './tally.js';

export { MAX_ATTEMPTS };

const NO_CONNECTION_MANAGER = 'Cairn needs the Connection Manager extension enabled to write memory summaries.';
const PROFILE_MISSING = 'Cairn\'s memory connection profile no longer exists. Choose another in Cairn\'s settings.';
const SAME_PROFILE = 'Cairn\'s memory connection is the profile this chat uses. Memory summaries should come from a separate model.';
const PROMPT_FALLBACK = 'Cairn\'s summary prompt has no {{message}}, so the default prompt is being used.';

/**
 * @param {() => object} getContext Returns a fresh SillyTavern.getContext()
 * @param {{settings: () => {memoryProfileId?: string, summaryPrompt?: string, worldState?: boolean},
 *          strategy?: object, stateStrategy?: object, clock?: () => number, onUpdate?: () => void}} options
 *        `strategy` is the summary strategy. `onUpdate` fires when a request goes out
 *        or settles, so the panel can follow work that happens between generations.
 */
export function createSummarizer(getContext, {
    settings, strategy = perMessage, stateStrategy = statePatch, clock = Date.now, onUpdate,
} = {}) {
    const summaries = createTally();
    const states = createTally({ dropped: 0 });
    /** The chat the tallies count for. A reload of the same chat keeps them. */
    let statsChat = null;
    let summaryGate = null;
    let stateGate = { reason: null, tracker: null };
    let running = false;
    let controller = null;
    let active = null;
    let again = false;
    /** Messages the user asked to have summarised, by object, since indexes shift. */
    const asked = [];
    /** The message a summary request is out for. */
    let writing = null;

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

    /**
     * The state first, since the very next prompt carries it, then summaries oldest
     * first, one request at a time. A summary is needed only when its message reaches
     * a step, 10 or more messages later (docs/decisions.md D-0044).
     */
    async function run() {
        let stateTried = false;
        while (running) {
            const context = getContext();
            const config = settings?.() ?? {};
            const gates = { summary: assessSummarizing(context, config), state: assessStateUpdates(context, config) };
            if (gates.summary.reason !== summaryGate || gates.state.reason !== stateGate.reason || gates.state.tracker !== stateGate.tracker) {
                summaryGate = gates.summary.reason;
                stateGate = { reason: gates.state.reason, tracker: gates.state.tracker };
                notify();
            }
            // The summary gate checks what both kinds need first, so its reason covers both.
            if (gates.summary.reason === 'no-connection-manager') toastOnce(NO_CONNECTION_MANAGER);
            if (gates.summary.reason === 'profile-missing') toastOnce(PROFILE_MISSING);
            if (gates.summary.sameProfile || gates.state.sameProfile) toastOnce(SAME_PROFILE);

            const { chat, chatId } = context;
            if (!stateTried) {
                stateTried = true;
                const job = gates.state.ready ? pendingStateJob(chat) : null;
                // Whatever becomes of it, summaries still run: a state that keeps failing must not starve them.
                if (job && !states.givenUp(stateKey(chatId, job))) {
                    await updateState(context, config, job);
                    notify();
                    continue;
                }
            }

            if (!gates.summary.ready) return;
            const requested = nextAsked(chat);
            if (requested !== undefined) {
                // A failure the user asked for is theirs to retry, so it doesn't end the run.
                await summarise(context, config, requested, { asked: true });
                notify();
                continue;
            }
            const index = pendingScenes(chat).find((at) => !summaries.givenUp(sceneKey(chatId, chat[at])));
            if (index === undefined) return;
            const landed = await summarise(context, config, index);
            // After the outcome is recorded, not when the request settles: a panel that
            // redraws in between shows the message as neither in flight nor written.
            notify();
            if (!landed) return;
        }
    }

    /**
     * One request through the memory profile, counted against its kind.
     *
     * @returns {Promise<{reply?: object, error?: unknown, signal: AbortSignal}>}
     */
    async function send(context, memoryProfileId, request, tally, index) {
        controller = new AbortController();
        const { signal } = controller;
        // A chat change swaps the stats while this is out; its cost belongs to the chat it was for.
        const counting = tally.stats;
        const started = clock();
        try {
            counting.calls++;
            // ST's tokenizer is the chat model's, not the memory model's: a size, not a bill.
            counting.tokensIn += await countTokens(context, request.messages.map((m) => m.content).join('\n'));
            tally.inFlight = index;
            notify();
            const reply = await context.ConnectionManagerRequestService.sendRequest(
                memoryProfileId, request.messages, request.maxTokens,
                { stream: false, signal, includePreset: true, includeInstruct: true },
            );
            counting.tokensOut += await countTokens(context, `${reply?.content ?? ''}${reply?.reasoning ?? ''}`);
            return { reply, signal };
        } catch (err) {
            return { error: err, signal };
        } finally {
            tally.inFlight = null;
            counting.lastMs = clock() - started;
            counting.ms += counting.lastMs;
        }
    }

    /** Bring the state up to the newest visible message. Its outcome is only recorded. */
    async function updateState(context, { memoryProfileId }, job) {
        const key = stateKey(context.chatId, job);
        let request;
        try {
            request = stateStrategy.build({
                state: job.state,
                messages: job.messages,
                earlier: job.earlier,
                expand: (text) => context.substituteParams(text),
            });
        } catch (err) {
            return failState(key, job.index, 'error', err);
        }

        const sent = await send(context, memoryProfileId, request, states, job.index);
        if (sent.signal.aborted) return discard('state', job.index, 'aborted');
        if (sent.error) return failState(key, job.index, 'error', sent.error);

        // Found by identity and checked against the hash of what was read, so an edit,
        // hide, deletion, swipe, continue or chat change meanwhile discards the reply.
        const now = getContext();
        const index = jobStillCurrent(now.chat, job);
        if (index < 0) return discard('state', job.index, 'the messages it read changed');

        const parsed = stateStrategy.parse(sent.reply?.content);
        if (!parsed.ok) return failState(key, index, parsed.reason);
        const { value, changed, dropped } = applyPatch(job.state, parsed.patch);
        if (dropped.length) {
            states.stats.dropped += dropped.length;
            debug(`Dropped from the state patch: ${dropped.map((drop) => `${drop.field} (${drop.reason})`).join(', ')}.`);
        }
        if (!writeState(now.chat, index, { value, read: job.read, changed, prompt: request.prompt, at: new Date(clock()).toISOString() })) {
            return failState(key, index, 'write');
        }

        states.succeed(key);
        debug(`Brought the state up to message #${index}: ${changed.length ? changed.join(', ') : 'no change'}.`);
        await save(now, 'the state');
    }

    /** The oldest asked-for message still in the chat, or undefined. */
    function nextAsked(chat) {
        while (asked.length) {
            const index = chat.indexOf(asked.shift());
            if (index >= 0) return index;
        }
        return undefined;
    }

    /**
     * @param {{asked?: boolean}} [options] `asked` when the user clicked for it: a failure then says so every time.
     * @returns {Promise<boolean>} Whether a scene was written, and the run should go on.
     */
    async function summarise(context, { memoryProfileId, summaryPrompt }, index, { asked: byUser = false } = {}) {
        const { chat, chatId } = context;
        const message = chat[index];
        const hash = hashString(message.mes);

        let request;
        try {
            request = strategy.build({
                message,
                history: sceneHistory(chat, index),
                template: summaryPrompt,
                expand: (text) => context.substituteParams(text),
            });
        } catch (err) {
            return failSummary(chatId, message, index, 'error', err, byUser);
        }
        if (request.fallback) toastOnce(PROMPT_FALLBACK);

        writing = message;
        const sent = await send(context, memoryProfileId, request, summaries, index);
        writing = null;
        if (sent.signal.aborted) return discard('summary', index, 'aborted');
        if (sent.error) return failSummary(chatId, message, index, 'error', sent.error, byUser);

        // Anything can happen in the seconds a request is out (docs/decisions.md D-0037). No
        // chat-id check: opening, reloading or renaming a chat refills the array with new
        // objects (public/script.js:7658, :10713), so the object test already catches it.
        const now = getContext();
        if (!now.chat.includes(message)) return discard('summary', index, 'no longer in the chat');
        if (hashString(message.mes) !== hash) return discard('summary', index, 'message edited');

        const parsed = strategy.parse(sent.reply?.content);
        if (!parsed.ok) return failSummary(chatId, message, index, parsed.reason, undefined, byUser);
        if (!writeScene(message, { text: parsed.text, prompt: request.prompt, at: new Date(clock()).toISOString() })) {
            return failSummary(chatId, message, index, 'write', undefined, byUser);
        }

        summaries.succeed(sceneKey(chatId, message));
        debug(`Summarised message #${index}.`);
        await save(now, 'a summary');
        return true;
    }

    async function save(context, what) {
        try {
            await context.saveChat();
        } catch (err) {
            warn(`Could not save the chat after writing ${what}.`, err);
        }
    }

    function discard(kind, index, why) {
        debug(`Discarded the ${kind} for message #${index}: ${why}.`);
        return false;
    }

    function failSummary(chatId, message, index, reason, err, byUser = false) {
        const outcome = summaries.fail(sceneKey(chatId, message), reason);
        if (byUser) {
            toast(`Summarising message #${index} failed (${reason}). Nothing was changed.`);
            if (err) warn(err);
            return false;
        }
        report(outcome, `The summary for message #${index} failed (${reason}).`, err);
        if (outcome.givenUp) {
            warn(`Gave up on message #${index} after ${outcome.count} failures. The memory step holds before it until the page is reloaded.`);
        }
        return false;
    }

    function failState(key, index, reason, err) {
        const outcome = states.fail(key, reason);
        report(outcome, `The world state update through message #${index} failed (${reason}).`, err);
        if (outcome.givenUp) {
            warn(`Gave up on the world state through message #${index} after ${outcome.count} failures. The previous state stays in the prompt until a new message arrives.`);
        }
    }

    function report({ first }, detail, err) {
        if (first) toast(`${detail} Cairn will try again after the next reply.`);
        else warn(detail);
        if (err) warn(err);
    }

    /** Waiting messages in the open chat that have failed at least once, oldest first. */
    function failed() {
        const { chat, chatId } = getContext();
        return pendingScenes(chat).flatMap((index) => {
            const record = summaries.record(sceneKey(chatId, chat[index]));
            return record ? [{ index, attempts: record.count, reason: record.reason }] : [];
        });
    }

    function givenUp() {
        return failed().filter((entry) => entry.attempts >= MAX_ATTEMPTS).map((entry) => entry.index);
    }

    /** The state tier's counterpart of `status`: one job at a time, so no lists. */
    function stateStatus() {
        const status = {
            ...states.stats, gate: stateGate.reason, tracker: stateGate.tracker, streak: states.streak,
            inFlight: states.inFlight, pending: null, failed: null, givenUp: false,
        };
        try {
            const { chat, chatId } = getContext();
            const job = pendingStateJob(chat);
            status.pending = Boolean(job);
            const record = job ? states.record(stateKey(chatId, job)) : undefined;
            if (record) {
                status.failed = { index: job.index, attempts: record.count, reason: record.reason };
                status.givenUp = record.count >= MAX_ATTEMPTS;
            }
        } catch (err) {
            warn('Could not read the state queue.', err);
        }
        return status;
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

    /**
     * The new text is already on the message (public/script.js:8178) when ST emits
     * this (:8405), so its summary and state are redone now, not after the next reply.
     * Not awaited, for the same reason as above.
     */
    function onMessageEdited() {
        drain();
    }

    /**
     * Summarise a message on the user's word, whatever the queue would do with it: a
     * written summary is replaced, a given-up message is tried again, and neither the last
     * message nor one before qvink's newest summary is passed over (docs/decisions.md D-0050).
     * The request waits behind the state update and goes ahead of the queue.
     *
     * @param {number} index
     * @returns {{queued: boolean, reason?: string}} `reason` is a summary gate's, or
     *          `off`, `no-message`, `hidden`, `too-short` or `future`.
     */
    function resummarise(index) {
        const refused = (reason) => ({ queued: false, reason });
        if (!running) return refused('off');
        const context = getContext();
        const message = context.chat?.[index];
        if (!message || typeof message.mes !== 'string') return refused('no-message');
        if (message.is_system) return refused('hidden');
        if (!summarisable(message)) return refused('too-short');
        // A newer Cairn's store is not ours to overwrite (store/chat-store.js).
        if (readScene(message).status === 'future') return refused('future');
        const gate = assessSummarizing(context, settings?.() ?? {});
        if (!gate.ready) return refused(gate.reason);

        // A second click while it is waiting or out changes nothing.
        if (message !== writing && !asked.includes(message)) {
            summaries.forget(sceneKey(context.chatId, message));
            asked.push(message);
            drain();
        }
        return { queued: true };
    }

    /** A request for the chat being left is abandoned; the new chat's queue starts. */
    function onChatChanged() {
        controller?.abort();
        const { chatId } = getContext();
        if (chatId !== statsChat) {
            summaries.resetStats();
            states.resetStats();
            statsChat = chatId;
        }
        notify();
        drain();
    }

    const listeners = [
        ['MESSAGE_RECEIVED', onMessageReceived],
        ['MESSAGE_EDITED', onMessageEdited],
        ['CHAT_CHANGED', onChatChanged],
    ];

    return {
        start() {
            if (running) return;
            const { eventSource, eventTypes, chatId } = getContext();
            for (const [event, listener] of listeners) eventSource.on(eventTypes[event], listener);
            statsChat = chatId;
            running = true;
            drain();
        },

        stop() {
            if (!running) return;
            const { eventSource, eventTypes } = getContext();
            for (const [event, listener] of listeners) eventSource.removeListener(eventTypes[event], listener);
            running = false;
            again = false;
            asked.length = 0;
            controller?.abort();
        },

        drain,

        resummarise,

        /** Resolves when no run is under way. */
        idle() {
            return active ?? Promise.resolve();
        },

        /** Messages in the open chat that have failed too often to try again this session. */
        givenUp,

        /**
         * Counts, sizes and timings for the open chat — never a summary's or a state's
         * text. `gate` is the last run's verdict (`assessSummarizing`), null before the
         * first run, and `state` holds the same for the state update.
         */
        get status() {
            const status = {
                ...summaries.stats, gate: summaryGate, streak: summaries.streak, inFlight: summaries.inFlight,
                pending: null, failed: [], givenUp: [], promptDefault: null, state: stateStatus(),
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

/** Summaries are tried again once the message's text changes. */
function sceneKey(chatId, message) {
    return `${chatId}\n${hashString(message.mes)}`;
}

/** A state update is tried again once what it reads changes: an edit, or a new message. */
function stateKey(chatId, job) {
    return `${chatId}\n${job.read}\n${job.hash}`;
}
