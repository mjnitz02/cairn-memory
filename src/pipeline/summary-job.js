/**
 * One kind of memory work: one message's scene summary (docs/decisions.md D-0037).
 *
 * The queue and the transport are the summarizer's, and the failure policy is the shared
 * job's (pipeline/job.js). What this file owns is the shape of one summary: the scenes
 * sent back with it, what invalidates it while the request is out, and what is written
 * when it lands. A missing summary holds the step before its message
 * (pipeline/scheduler.js), which is why summaries run ahead of the index and canon.
 */
import { pendingScenes, sceneHistory } from '../memory/scenes.js';
import { perMessage, resolveSummaryPrompt } from '../memory/scene-strategy.js';
import { writeScene } from '../store/chat-store.js';
import { hashString } from '../util/hash.js';
import { debug, toast, toastOnce, warn } from '../util/log.js';
import { createJob, failureDetail } from './job.js';
import { MAX_ATTEMPTS } from './tally.js';

const PROMPT_FALLBACK = 'Cairn\'s summary prompt has no {{message}}, so the default prompt is being used.';

/**
 * @param {{getContext: () => object, send: Function, save: Function, clock: () => number,
 *          strategy?: object}} machinery The summarizer's transport and shared helpers.
 */
export function createSummaryJob({ getContext, send, save, clock, strategy = perMessage }) {
    const job = createJob({
        log: 'summary',
        name: 'summary',
        article: 'a summary',
        /** Summaries are tried again once the message's text changes. */
        key: (chatId, message) => `${chatId}\n${hashString(message.mes)}`,
        failed: (_message, at) => `The summary for message #${at}`,
        gaveUp: (_message, at, count) => `Gave up on message #${at} after ${count} failures. The memory step holds before it until the page is reloaded.`,
    }, { send });
    /** The message a summary request is out for. */
    let writing = null;

    /** A failure the user asked for toasts every time: it is theirs to retry. */
    function fail(chatId, message, index, reason, err, byUser) {
        if (!byUser) return job.fail(chatId, message, reason, err, index);
        job.tally.fail(job.kind.key(chatId, message), reason);
        toast(failureDetail(`Summarising message #${index} failed (${reason}). Nothing was changed.`, reason));
        if (err) warn(err);
        return false;
    }

    /** Waiting messages in the open chat that have failed at least once, oldest first. */
    function failed() {
        const { chat, chatId } = getContext();
        return pendingScenes(chat).flatMap((index) => {
            const record = job.record(chatId, chat[index]);
            return record ? [{ index, attempts: record.count, reason: record.reason }] : [];
        });
    }

    return {
        job,
        tally: job.tally,

        get writing() {
            return writing;
        },

        givenUp: job.givenUp,

        forget: job.forget,

        /**
         * @param {{asked?: boolean}} [options] `asked` when the user clicked for it: a failure then says so every time.
         * @returns {Promise<boolean>} Whether a scene was written, and the run should go on.
         */
        async run(context, { memoryProfileId, summaryPrompt }, index, { asked = false } = {}) {
            const { chat, chatId } = context;
            const message = chat[index];
            const hash = hashString(message.mes);

            let sent;
            writing = message;
            try {
                sent = await job.request(context, memoryProfileId, message, index, () => {
                    const request = strategy.build({
                        message,
                        history: sceneHistory(chat, index),
                        template: summaryPrompt,
                        expand: (text) => context.substituteParams(text),
                    });
                    if (request.fallback) toastOnce(PROMPT_FALLBACK);
                    return request;
                }, { fail: (reason, err) => fail(chatId, message, index, reason, err, asked) });
            } finally {
                writing = null;
            }
            if (!sent) return false;

            // Anything can happen in the seconds a request is out (docs/decisions.md D-0037). No
            // chat-id check: opening, reloading or renaming a chat refills the array with new
            // objects (public/script.js:7658, :10713), so the object test already catches it.
            const now = getContext();
            if (!now.chat.includes(message)) return job.discard(index, 'no longer in the chat');
            if (hashString(message.mes) !== hash) return job.discard(index, 'message edited');

            const parsed = strategy.parse(sent.reply?.content);
            if (!parsed.ok) return fail(chatId, message, index, parsed.reason, undefined, asked);
            if (!writeScene(message, { text: parsed.text, prompt: sent.request.prompt, at: new Date(clock()).toISOString() })) {
                return fail(chatId, message, index, 'write', undefined, asked);
            }

            job.succeed(chatId, message);
            debug(`Summarised message #${index}.`);
            await save(now, 'a summary');
            return true;
        },

        /** Messages in the open chat that have failed too often to try again this session. */
        givenUpIn: () => failed().filter((entry) => entry.attempts >= MAX_ATTEMPTS).map((entry) => entry.index),

        /** Unlike the other kinds', lists: many summaries can be waiting or failing at once. */
        status: (gate, config) => job.status(gate, (status) => {
            // The default is what goes out when the prompt is unedited *or* unusable.
            const prompt = resolveSummaryPrompt(config.summaryPrompt);
            status.promptDefault = !prompt.edited || prompt.fallback;
            status.pending = pendingScenes(getContext().chat).length;
            status.failed = failed();
            status.givenUp = status.failed.filter((entry) => entry.attempts >= MAX_ATTEMPTS).map((entry) => entry.index);
        }, { failed: [], givenUp: [], promptDefault: null }),
    };
}
