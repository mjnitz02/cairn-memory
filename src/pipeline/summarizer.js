/**
 * The summarizer — the only file that calls a model (docs/decisions.md D-0037).
 *
 * It owns the queue, the transport, and what a failure does. The three kinds of memory
 * work take their turn in it: the state update first because the very next prompt
 * carries it (D-0044), then summaries because a missing one holds the step (D-0037),
 * then a compaction pass, which has a whole see-saw step of slack (docs/p4-plan.md
 * decision 7). What a prompt says and how a reply is read belong to the strategies
 * (memory/*-strategy.js); what one job of a kind *is* belongs to its own file
 * (state-job.js, canon-job.js), and the summary job is inline because it is the
 * queue's own unit of work.
 *
 * A failure writes nothing and toasts once per streak of its kind. A missing summary
 * holds the step before its message (pipeline/scheduler.js), a missing state leaves the
 * previous one in the prompt, and a failed pass lets eviction proceed exactly as it
 * does today. Nothing here may reach ST's event path (CLAUDE.md §4.17).
 */
import { pendingScenes, sceneHistory } from '../memory/scenes.js';
import { perMessage, resolveSummaryPrompt } from '../memory/scene-strategy.js';
import { readScene, summarisable, writeScene } from '../store/chat-store.js';
import { hashString } from '../util/hash.js';
import { countTokens } from '../util/tokens.js';
import { debug, error, toast, toastOnce, warn } from '../util/log.js';
import { assessCompaction, assessStateUpdates, assessSummarizing } from './gates.js';
import { createCanonJob } from './canon-job.js';
import { createStateJob } from './state-job.js';
import { MAX_ATTEMPTS, createTally } from './tally.js';

export { MAX_ATTEMPTS };

const NO_CONNECTION_MANAGER = 'Cairn needs the Connection Manager extension enabled to write memory summaries.';
const PROFILE_MISSING = 'Cairn\'s memory connection profile no longer exists. Choose another in Cairn\'s settings.';
const SAME_PROFILE = 'Cairn\'s memory connection is the profile this chat uses. Memory summaries should come from a separate model.';
const PROMPT_FALLBACK = 'Cairn\'s summary prompt has no {{message}}, so the default prompt is being used.';

/**
 * @param {() => object} getContext Returns a fresh SillyTavern.getContext()
 * @param {{settings: () => {memoryProfileId?: string, summaryPrompt?: string,
 *              worldState?: boolean, keepCanon?: boolean},
 *          strategy?: object, stateStrategy?: object, canonStrategy?: object,
 *          clock?: () => number, onUpdate?: () => void, memory?: () => object|null}} options
 *        `strategy` is the summary strategy. `onUpdate` fires when a request goes out
 *        or settles, so the panel can follow work that happens between generations.
 *        `memory` returns the assembler's pending compaction pass for the turn just
 *        planned — the budget lives there, so this file never re-derives it.
 */
export function createSummarizer(getContext, {
    settings, strategy = perMessage, stateStrategy, canonStrategy, clock = Date.now, onUpdate, memory,
} = {}) {
    const summaries = createTally();
    /** The chat the tallies count for. A reload of the same chat keeps them. */
    let statsChat = null;
    let summaryGate = null;
    let stateGate = { reason: null, tracker: null };
    let canonGate = { reason: null };
    let running = false;
    let controller = null;
    let active = null;
    let again = false;
    /** Messages the user asked to have summarised, by object, since indexes shift. */
    const asked = [];
    /** The message a summary request is out for. */
    let writing = null;

    // The two kinds that are one job at a time. They take the queue's transport and
    // failure policy and own nothing else (pipeline/state-job.js, canon-job.js).
    const machinery = { getContext, send, save, discard, report, clock };
    const state = createStateJob({ ...machinery, ...(stateStrategy ? { strategy: stateStrategy } : {}) });
    const canon = createCanonJob({
        ...machinery, pending: memory, ...(canonStrategy ? { strategy: canonStrategy } : {}),
    });

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
     * first, then a compaction pass. One request at a time, in that order of urgency
     * (docs/decisions.md D-0037, D-0044; docs/p4-plan.md decision 7). A summary is needed
     * only when its message reaches a step, 10 or more messages later; a pass has the
     * whole step before its rebuild.
     */
    async function run() {
        let stateTried = false;
        let canonTried = false;
        while (running) {
            const context = getContext();
            const config = settings?.() ?? {};
            const gates = {
                summary: assessSummarizing(context, config),
                state: assessStateUpdates(context, config),
                canon: assessCompaction(context, config, { writing: memory?.()?.writing }),
            };
            if (gates.summary.reason !== summaryGate || gates.state.reason !== stateGate.reason
                || gates.state.tracker !== stateGate.tracker || gates.canon.reason !== canonGate.reason) {
                summaryGate = gates.summary.reason;
                stateGate = { reason: gates.state.reason, tracker: gates.state.tracker };
                canonGate = { reason: gates.canon.reason };
                notify();
            }
            // The summary gate checks what every kind needs first, so its reason covers all three.
            if (gates.summary.reason === 'no-connection-manager') toastOnce(NO_CONNECTION_MANAGER);
            if (gates.summary.reason === 'profile-missing') toastOnce(PROFILE_MISSING);
            if (gates.summary.sameProfile || gates.state.sameProfile) toastOnce(SAME_PROFILE);

            const { chat, chatId } = context;
            if (!stateTried) {
                stateTried = true;
                const job = gates.state.ready ? state.pending(chat) : null;
                // Whatever becomes of it, summaries still run: a state that keeps failing must not starve them.
                if (job && !state.givenUp(chatId, job)) {
                    await state.run(context, config, job);
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
            if (index !== undefined) {
                const landed = await summarise(context, config, index);
                // After the outcome is recorded, not when the request settles: a panel that
                // redraws in between shows the message as neither in flight nor written.
                notify();
                if (!landed) return;
                continue;
            }

            // Last, and only once the summaries are all written: a pass reads them.
            if (canonTried) return;
            canonTried = true;
            const pass = gates.canon.ready ? canon.pending() : null;
            if (!pass || canon.givenUp(chatId, pass)) return;
            await canon.run(context, config, pass);
            notify();
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
            state.tally.resetStats();
            canon.tally.resetStats();
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
         * Counts, sizes and timings for the open chat — never a summary's, a state's or
         * a fact's text. `gate` is the last run's verdict (`assessSummarizing`), null
         * before the first run, and `state` and `canon` hold the same for the other two
         * kinds.
         */
        get status() {
            const status = {
                ...summaries.stats, gate: summaryGate, streak: summaries.streak, inFlight: summaries.inFlight,
                pending: null, failed: [], givenUp: [], promptDefault: null,
                state: state.status(stateGate), canon: canon.status(canonGate),
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

