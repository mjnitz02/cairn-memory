/**
 * The summarizer — the only file that calls a model (docs/decisions.md D-0037).
 *
 * It owns the queue, the transport, and what a failure does. The four kinds of memory
 * work take their turn in it: the state update first because the very next prompt
 * carries it (D-0044), then summaries because a missing one holds the step (D-0037),
 * then the index batch, whose records the compact tier needs before the next rebuild
 * (D-0075), then a compaction pass, which has a whole see-saw step of slack
 * (docs/p4-plan.md decision 7). What a prompt says and how a reply is read belong to the strategies
 * (memory/*-strategy.js); what one job of a kind *is* belongs to its own file
 * (summary-, state-, index- and canon-job.js), on the skeleton they share (job.js).
 *
 * A failure writes nothing and toasts once per streak of its kind. A missing summary
 * holds the step before its message (pipeline/scheduler.js), a missing state leaves the
 * previous one in the prompt, and a failed pass lets eviction proceed exactly as it
 * does today. Nothing here may reach ST's event path (CLAUDE.md §4.17).
 */
import { pendingScenes, redoScenes } from '../memory/scenes.js';
import { stateJobAt } from '../memory/state.js';
import { describeReply } from '../memory/model-reply.js';
import { readScene, summarisable } from '../store/chat-store.js';
import { countTokens } from '../util/tokens.js';
import { debug, error, toastOnce, warn } from '../util/log.js';
import { assessCompaction, assessIndexing, assessStateUpdates, assessSummarizing } from './gates.js';
import { createCanonJob } from './canon-job.js';
import { createIndexJob } from './index-job.js';
import { READ_CHANGED, createStateJob } from './state-job.js';
import { createSummaryJob } from './summary-job.js';
import { adoptionPlan, createAdoption } from './adopt.js';
import { DEFAULT_SLOTS } from '../memory/canon.js';
import { STEP } from './scheduler.js';
import { isBadRequest, memoryProfile, refusalKey, requestOverrides } from './request-options.js';

const NO_CONNECTION_MANAGER = 'Cairn needs the Connection Manager extension enabled to write memory summaries.';
const PROFILE_MISSING = 'Cairn\'s memory connection profile no longer exists. Choose another in Cairn\'s settings.';
const SAME_PROFILE = 'Cairn\'s memory connection is the profile this chat uses. Memory summaries should come from a separate model.';
/** Reasons a reply arrived and could not be read, as against a transport or write failure. */
const READ_FAILURES = new Set(['empty', 'refusal', 'format', 'truncated', 'no-facts']);
const EFFORT_REFUSED = (effort) => `The memory model's provider refused reasoning effort "${effort}", so Cairn asks it for `
    + 'less from now on. Changing Cairn\'s reasoning setting tries again.';

/**
 * @param {() => object} getContext Returns a fresh SillyTavern.getContext()
 * @param {{settings: () => {memoryProfileId?: string, summaryPrompt?: string,
 *              worldState?: boolean, keepCanon?: boolean},
 *          strategy?: object, stateStrategy?: object, canonStrategy?: object,
 *          clock?: () => number, onUpdate?: () => void, memory?: () => object|null,
 *          onCall?: (entry: object) => void}} options
 *        `strategy` is the summary strategy; `indexStrategy` is the index batch's.
 *        `onUpdate` fires when a request goes out
 *        or settles, so the panel can follow work that happens between generations.
 *        `memory` returns the assembler's pending compaction pass for the turn just
 *        planned — the budget lives there, so this file never re-derives it.
 *        `onCall` gets one entry per memory call once its outcome is known, for the
 *        chat's log (D-0093): sizes, timings and reasons, never a model's text.
 */
export function createSummarizer(getContext, {
    settings, strategy, stateStrategy, canonStrategy, indexStrategy,
    clock = Date.now, onUpdate, memory, onCall,
} = {}) {
    /** The settings as they are now: read at the point of use, since the panel changes them live. */
    const readSettings = () => settings?.() ?? {};
    /** The chat the tallies count for. A reload of the same chat keeps them. */
    let statsChat = null;
    let summaryGate = null;
    let stateGate = { reason: null, tracker: null };
    let canonGate = { reason: null };
    let indexGate = { reason: null };
    let running = false;
    let controller = null;
    let active = null;
    let again = false;
    /**
     * The chat the user has acted in since it was opened. Opening a chat, or loading the
     * page on one, makes no memory call: the queue waits for a send, a generation, an
     * edit or a resummarise there, so a chat opened by mistake costs nothing (D-0088).
     */
    let activeIn = null;
    /** Profile and model → reasoning efforts refused, alongside the saved latch (D-0086, D-0088). */
    const refusedEfforts = new Map();

    /** What this profile's model has refused: this session's, and what earlier sessions saved. */
    function refusedFor(config, key) {
        return new Set([...(refusedEfforts.get(key) ?? []), ...(config.reasoningRefused?.[key] ?? [])]);
    }

    /** Remember a refusal in the settings, so the next page load starts past it. */
    function latchRefusal(context, config, key, refused) {
        refusedEfforts.set(key, refused);
        try {
            config.reasoningRefused = { ...(config.reasoningRefused ?? {}), [key]: [...refused] };
            context.saveSettingsDebounced?.();
        } catch (err) {
            warn('Could not save the refused reasoning effort.', err);
        }
    }
    /** Messages the user asked to have summarised, by object, since indexes shift. */
    const asked = [];
    /** Messages the user asked to have their world state rebuilt on, likewise (D-0089). */
    const askedStates = [];
    /** The message a rebuild is out for, so a second click while it is out changes nothing. */
    let restating = null;

    // Each kind takes the queue's transport and owns nothing else (pipeline/*-job.js).
    const machinery = { getContext, send, save, clock };
    const strategyOf = (given) => (given ? { strategy: given } : {});
    const summary = createSummaryJob({ ...machinery, ...strategyOf(strategy) });
    const state = createStateJob({ ...machinery, ...strategyOf(stateStrategy) });
    const indexer = createIndexJob({ ...machinery, ...strategyOf(indexStrategy) });
    const canon = createCanonJob({ ...machinery, pending: memory, ...strategyOf(canonStrategy) });
    /** Every kind of memory work: the one list the log, the stats and a chat change walk. */
    const kinds = [summary, state, indexer, canon];
    const summarise = (context, config, index, options) => summary.run(context, config, index, options);
    const adoption = createAdoption({ getContext, summarise, indexer, canon, save, clock });
    for (const kind of kinds) {
        kind.tally.onOutcome = (outcome) => logCall(kind.job, outcome);
    }
    /** The call out or just back, until its job says how it ended (D-0093). */
    let call = null;
    /** The adoption under way, or null. The queue holds while it runs (D-0090). */
    let adopting = null;

    /**
     * Start a run, or fold this trigger into the one under way. Never rejects.
     *
     * @param {string} [why] What asked for the run, for the debug log: every memory call
     *        is traced back to the event that caused it.
     */
    function drain(why = 'asked') {
        if (!running) return Promise.resolve();
        if (adopting) {
            debug(`Queue: ${why} — waiting for the adoption to finish.`);
            return Promise.resolve();
        }
        if (activeIn === null || activeIn !== getContext().chatId) {
            debug(`Queue: ${why} — waiting for activity in this chat.`);
            return Promise.resolve();
        }
        if (active) {
            debug(`Queue: ${why} — folded into the run under way.`);
            again = true;
            return active;
        }
        debug(`Queue: run started by ${why}.`);
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
        let stateRetried = false;
        let canonTried = false;
        let indexTried = false;
        while (running) {
            const context = getContext();
            const config = readSettings();
            const writing = memory?.()?.writing;
            const gates = {
                summary: assessSummarizing(context, config),
                state: assessStateUpdates(context, config),
                canon: assessCompaction(context, config, { writing }),
                index: assessIndexing(context, config, { writing }),
            };
            if (gates.summary.reason !== summaryGate || gates.state.reason !== stateGate.reason
                || gates.state.tracker !== stateGate.tracker || gates.canon.reason !== canonGate.reason
                || gates.index.reason !== indexGate.reason) {
                summaryGate = gates.summary.reason;
                stateGate = { reason: gates.state.reason, tracker: gates.state.tracker };
                canonGate = { reason: gates.canon.reason };
                indexGate = { reason: gates.index.reason };
                notify();
            }
            // The summary gate checks what every kind needs first, so its reason covers all three.
            if (gates.summary.reason === 'no-connection-manager') toastOnce(NO_CONNECTION_MANAGER);
            if (gates.summary.reason === 'profile-missing') toastOnce(PROFILE_MISSING);
            if (gates.summary.sameProfile || gates.state.sameProfile) toastOnce(SAME_PROFILE);

            const { chat, chatId } = context;
            // A rebuild the user asked for goes first, as the state does: they are waiting on it.
            const rebuildAt = nextIn(askedStates, chat);
            if (rebuildAt !== undefined) {
                const job = gates.state.ready ? stateJobAt(chat, rebuildAt) : null;
                if (job) {
                    state.forget(chatId, job);
                    restating = job.message;
                    try {
                        await state.run(context, config, job);
                    } finally {
                        restating = null;
                    }
                    notify();
                }
                continue;
            }
            if (!stateTried) {
                stateTried = true;
                const job = gates.state.ready ? state.pending(chat) : null;
                // Whatever becomes of it, summaries still run: a state that keeps failing must not starve them.
                if (job && !state.givenUp(chatId, job)) {
                    // A message rewritten with no edit event (a formatter) would otherwise wait a whole turn.
                    if (await state.run(context, config, job) === READ_CHANGED && !stateRetried) {
                        stateRetried = true;
                        stateTried = false;
                    }
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
            const index = pendingScenes(chat).find((at) => !summary.givenUp(chatId, chat[at]));
            if (index !== undefined) {
                const landed = await summarise(context, config, index);
                // After the outcome is recorded, not when the request settles: a panel that
                // redraws in between shows the message as neither in flight nor written.
                notify();
                if (!landed) return;
                continue;
            }

            // The index next, and only once the summaries are all written: a record is a
            // reading of a summary, so an unwritten summary is work that comes first.
            if (!indexTried) {
                indexTried = true;
                const batch = gates.index.ready ? indexer.pending() : null;
                // Whatever becomes of it, a compaction pass still gets its turn.
                if (batch && !indexer.givenUp(chatId, batch)) {
                    await indexer.run(context, config, batch);
                    notify();
                    continue;
                }
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
    async function send(context, memoryProfileId, request, job, index) {
        const { tally } = job;
        controller = new AbortController();
        const { signal } = controller;
        // A chat change swaps the stats while this is out; its cost belongs to the chat it was for.
        const counting = tally.stats;
        const started = clock();
        debug(`Queue: sending ${job.kind.article} for #${index}.`);
        // A call its job never settled still gets its line, rather than lending its sizes to the next.
        if (call) logCall(call.job, { outcome: 'unsettled' });
        call = {
            job, chatId: context.chatId, at: new Date(started).toISOString(), message: index,
            model: memoryProfile(context, memoryProfileId)?.model ?? null,
            tokensIn: null, tokensOut: null, replyChars: null, reply: null, error: null, ms: null,
        };
        const open = call;
        try {
            counting.calls++;
            // ST's tokenizer is the chat model's, not the memory model's: a size, not a bill.
            open.tokensIn = await countTokens(context, request.messages.map((m) => m.content).join('\n'));
            counting.tokensIn += open.tokensIn;
            tally.inFlight = index;
            notify();
            const reply = await sendAskingLittleReasoning(context, memoryProfileId, request, signal, counting);
            open.tokensOut = await countTokens(context, `${reply?.content ?? ''}${reply?.reasoning ?? ''}`);
            open.replyChars = (reply?.content ?? '').length;
            open.reply = reply?.content ?? '';
            counting.tokensOut += open.tokensOut;
            return { reply, signal };
        } catch (err) {
            open.error = String(err?.message ?? err).slice(0, 500);
            return { error: err, signal };
        } finally {
            tally.inFlight = null;
            counting.lastMs = clock() - started;
            counting.ms += counting.lastMs;
            open.ms = counting.lastMs;
        }
    }

    /**
     * Ask for no reasoning, then less, then whatever the preset says: an endpoint that
     * cannot stop thinking refuses the request outright rather than ignoring the ask.
     * A refused effort is not asked of that model again this session.
     */
    async function sendAskingLittleReasoning(context, memoryProfileId, request, signal, counting) {
        const profile = memoryProfile(context, memoryProfileId);
        const key = refusalKey(profile);
        const config = readSettings();
        for (;;) {
            const refused = refusedFor(config, key);
            const overrides = requestOverrides(context, profile, refused, config.memoryReasoning);
            try {
                debug(`Queue: reasoning effort ${overrides.reasoning_effort ?? 'as the preset has it'}.`);
                return await context.ConnectionManagerRequestService.sendRequest(
                    memoryProfileId, request.messages, request.maxTokens,
                    { stream: false, signal, includePreset: true, includeInstruct: true },
                    overrides,
                );
            } catch (err) {
                const effort = overrides.reasoning_effort;
                if (!effort || signal.aborted || !isBadRequest(err)) throw err;
                latchRefusal(context, config, key, new Set([...refused, effort]));
                toastOnce(EFFORT_REFUSED(effort));
                counting.calls++;
            }
        }
    }

    /**
     * One line for the chat's log: the call and how its job ended. A failure before any
     * call (a prompt that would not build) gets a line too, with no call fields.
     */
    function logCall(job, { outcome, reason = null, attempt = null }) {
        const sent = call?.job === job ? call : null;
        if (sent) call = null;
        if (!onCall) return;
        try {
            // A structured reply that could not be read keeps where it broke (D-0094).
            const detail = outcome === 'failed' && job !== summary.job && READ_FAILURES.has(reason) && sent?.reply
                ? describeReply(sent.reply) : null;
            onCall({
                kind: 'call',
                at: sent?.at ?? new Date(clock()).toISOString(),
                job: job.kind.log,
                message: sent?.message ?? null,
                during: adopting ? (adopting.redo ? 'redo' : 'adopt') : 'queue',
                outcome,
                reason,
                attempt,
                error: sent?.error ?? null,
                ms: sent?.ms ?? null,
                tokens_in: sent?.tokensIn ?? null,
                tokens_out: sent?.tokensOut ?? null,
                reply_chars: sent?.replyChars ?? null,
                ...(detail && {
                    reply_error: detail.error, reply_at: detail.at, reply_near: detail.near, reply_tail: detail.tail,
                }),
                model: sent?.model ?? null,
                chat_id: sent?.chatId ?? getContext().chatId ?? null,
            });
        } catch (err) {
            warn('Could not log a memory call.', err);
        }
    }

    /** The oldest asked-for message still in the chat, or undefined. */
    function nextAsked(chat) {
        return nextIn(asked, chat);
    }

    /** Take the oldest message in `list` that is still in the chat, and return its index. */
    function nextIn(list, chat) {
        while (list.length) {
            const index = chat.indexOf(list.shift());
            if (index >= 0) return index;
        }
        return undefined;
    }

    async function save(context, what) {
        try {
            await context.saveChat();
        } catch (err) {
            warn(`Could not save the chat after writing ${what}.`, err);
        }
    }

    /** A panel that throws costs the panel, not the summary. */
    function notify() {
        try {
            onUpdate?.();
        } catch (err) {
            warn('Could not report summarizer progress.', err);
        }
    }

    /** Activity in the open chat: from here on its queue may run. */
    function act(why) {
        activeIn = getContext().chatId;
        return drain(why);
    }

    /**
     * After render, not on MESSAGE_RECEIVED: a formatter such as WeatherPack rewrites the
     * reply in a `makeFirst` listener here, and ST awaits it before ours (D-0091).
     * Not awaited. A greeting is not a reply: ST emits one as `first_message` every time a
     * chat holding only the greeting is opened (public/script.js:7703-7706), so it runs only
     * a queue already unlocked.
     */
    function onMessageRendered(_index, type) {
        if (type === 'first_message') drain('a greeting');
        else act('a reply');
    }

    /**
     * A generation the user started: a send, a swipe, a continue or an impersonate
     * (public/script.js:4299). It unlocks the queue without running it: work starts when
     * the reply lands, so a generation never races a state update reading its own prompt.
     * ST's dry runs, which the prompt manager makes on opening a chat, and quiet
     * generations another extension starts are not the user's.
     */
    function onGenerationStarted(type, _params, dryRun) {
        if (dryRun || type === 'quiet') return;
        if (activeIn !== getContext().chatId) debug('Queue: a generation — memory work starts with the reply.');
        activeIn = getContext().chatId;
    }

    /**
     * The new text is already on the message (public/script.js:8178) when ST emits
     * this (:8405), so its summary and state are redone now, not after the next reply.
     * Not awaited, for the same reason as above.
     */
    function onMessageEdited() {
        act('an edit');
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
        const gate = assessSummarizing(context, readSettings());
        if (!gate.ready) return refused(gate.reason);

        // A second click while it is waiting or out changes nothing.
        if (message !== summary.writing && !asked.includes(message)) {
            summary.forget(context.chatId, message);
            asked.push(message);
            act(`a resummarise of #${index}`);
        }
        return { queued: true };
    }

    /**
     * Rebuild the world state on a message, on the user's word (D-0089): it reads every
     * visible message since the state before it and replaces any state already there.
     * Only the newest state reaches the prompt, so this matters most on the newest
     * message, but any visible one may be rebuilt.
     *
     * @param {number} index
     * @returns {{queued: boolean, reason?: string}} `reason` is a state gate's, or
     *          `disabled`, `no-message`, `hidden` or `future`.
     */
    function restate(index) {
        const refused = (reason) => ({ queued: false, reason });
        if (!running) return refused('disabled');
        const context = getContext();
        const message = context.chat?.[index];
        if (!message || typeof message.mes !== 'string') return refused('no-message');
        if (message.is_system) return refused('hidden');
        const gate = assessStateUpdates(context, readSettings());
        if (!gate.ready) return refused(gate.reason);
        if (!stateJobAt(context.chat, index)) return refused('future');

        if (message !== restating && !askedStates.includes(message)) {
            askedStates.push(message);
            act(`a world state rebuild of #${index}`);
        }
        return { queued: true };
    }

    /** What adopting (or redoing, D-0092) the open chat would take, or why it can't be (D-0090). */
    function adoptionPreview({ redo = false } = {}) {
        if (!running) return { ok: false, reason: 'disabled' };
        if (adopting) return { ok: false, reason: 'adopting' };
        const context = getContext();
        const config = readSettings();
        const gate = assessSummarizing(context, config);
        if (!gate.ready) return { ok: false, reason: gate.reason };
        const every = config.step || STEP;
        const pending = (redo ? redoScenes : pendingScenes)(context.chat);
        return { ok: true, every, ...adoptionPlan(context.chat, { every, pending, redo }) };
    }

    /**
     * Adopt the open chat: import, summarise, then index and pick canon at the pace of the
     * story (pipeline/adopt.js). The queue holds until it is done, and a chat change or
     * `cancelAdoption` stops it between calls. It is activity in the chat (D-0088).
     *
     * @param {{onProgress?: (update: object) => void, redo?: boolean}} [options] `redo`
     *        summarises every message again and rebuilds the index and canon from nothing.
     * @returns {Promise<{ok: boolean, reason?: string, imported?: number, summarised?: number,
     *            steps?: number, cancelled?: boolean}>}
     */
    async function adopt({ onProgress, redo = false } = {}) {
        const preview = adoptionPreview({ redo });
        if (!preview.ok) return preview;
        const { chatId } = getContext();
        const run = { cancelled: false, chatId, redo };
        adopting = run;
        activeIn = chatId;
        try {
            await (active ?? Promise.resolve());
            const config = readSettings();
            const result = await adoption.run(config, {
                every: preview.every,
                slots: config.keepCanon === false ? 0 : (config.canonSlots || DEFAULT_SLOTS),
                pending: () => (redo ? redoScenes : pendingScenes)(getContext().chat),
                redo,
                cancelled: () => run.cancelled || getContext().chatId !== chatId,
                progress: (update) => {
                    debug(`Adopting: ${JSON.stringify(update)}`);
                    notify();
                    try {
                        onProgress?.(update);
                    } catch (err) {
                        warn('Could not report adoption progress.', err);
                    }
                },
            });
            return { ok: true, ...result };
        } catch (err) {
            error('Adopting the chat failed.', err);
            return { ok: false, reason: 'error' };
        } finally {
            adopting = null;
            notify();
            drain('the adoption finishing');
        }
    }

    /** A request for the chat being left is abandoned; the new chat's queue starts. */
    function onChatChanged() {
        if (adopting) adopting.cancelled = true;
        controller?.abort();
        const { chatId } = getContext();
        if (chatId !== statsChat) {
            for (const kind of kinds) kind.tally.resetStats();
            statsChat = chatId;
        }
        notify();
        drain('a chat change');
    }

    const listeners = [
        ['CHARACTER_MESSAGE_RENDERED', onMessageRendered],
        ['GENERATION_STARTED', onGenerationStarted],
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
            drain('start');
        },

        stop() {
            if (!running) return;
            const { eventSource, eventTypes } = getContext();
            for (const [event, listener] of listeners) eventSource.removeListener(eventTypes[event], listener);
            running = false;
            again = false;
            asked.length = 0;
            askedStates.length = 0;
            if (adopting) adopting.cancelled = true;
            controller?.abort();
        },

        drain,

        resummarise,

        restate,

        adoptionPreview,

        adopt,

        /** Stop an adoption between calls; what it has written stays. */
        cancelAdoption() {
            if (adopting) adopting.cancelled = true;
        },

        get adopting() {
            return adopting !== null;
        },

        /** Resolves when no run is under way. */
        idle() {
            return active ?? Promise.resolve();
        },

        /** Messages in the open chat that have failed too often to try again this session. */
        givenUp: summary.givenUpIn,

        /**
         * Counts, sizes and timings for the open chat — never a summary's, a state's or
         * a fact's text. `gate` is the last run's verdict (`assessSummarizing`), null
         * before the first run, and `state` and `canon` hold the same for the other two
         * kinds.
         */
        get status() {
            const config = readSettings();
            const status = {
                ...summary.status({ reason: summaryGate }, config), model: null, reasoning: null,
                state: state.status(stateGate), canon: canon.status(canonGate),
                index: indexer.status(indexGate),
            };
            try {
                // Which model the calls went to, and what Cairn asked of it: a run that
                // switches models mid-chat is otherwise read off latency (D-0086).
                const context = getContext();
                const profile = memoryProfile(context, config.memoryProfileId);
                status.model = profile?.model ?? null;
                status.reasoning = requestOverrides(
                    context, profile, refusedFor(config, refusalKey(profile)), config.memoryReasoning,
                ).reasoning_effort ?? null;
            } catch (err) {
                warn('Could not read the memory model.', err);
            }
            return status;
        },
    };
}
