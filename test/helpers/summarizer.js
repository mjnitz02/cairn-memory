import { createSummarizer } from '../../src/pipeline/summarizer.js';
import { createRequestService } from '../mocks/llm.js';
import { createContext, startActive } from '../mocks/sillytavern.js';

/** The memory profile, and the roleplay one the chat uses: never the same (DESIGN.md §3.1). */
export const MEMORY = Object.freeze({ id: 'memory-profile', name: 'GLM (memory)' });
export const ROLEPLAY = Object.freeze({ id: 'roleplay-profile', name: 'Local (roleplay)' });

/**
 * A summarizer over `chat`, answering from `responses`, as the queue tests drive it.
 *
 * @param {object} options
 * @param {Array<object>} options.chat
 * @param {Array<unknown>} [options.responses] What the request service replies, in order.
 * @param {object} [options.service] A request service of the test's own, in place of `responses`.
 * @param {object} [options.defaults] The file's settings, under the test's own `settings`.
 * @param {object} [options.settings] Read on every call, so a test may change it mid-run.
 * @param {object} [options.context] More for `createContext`.
 * @param {boolean} [options.start] Open the queue as a user's activity does (`startActive`).
 *        The summarizer itself still waits for `start()`.
 * @param {object} [options.rest] Passed to `createSummarizer`: `memory`, `clock`, `onUpdate`,
 *        `onCall` and the strategies.
 */
export function queueHarness({
    chat, responses = [], service, defaults = {}, settings = {}, context: contextOptions = {}, start = true, ...rest
}) {
    const requests = service ?? createRequestService({ responses });
    const context = createContext({
        chat,
        profiles: [MEMORY, ROLEPLAY],
        selectedProfile: ROLEPLAY.id,
        requestService: requests,
        ...contextOptions,
    });
    const summarizer = createSummarizer(() => context, {
        settings: () => ({ memoryProfileId: MEMORY.id, ...defaults, ...settings }),
        ...rest,
    });
    if (start) startActive(summarizer, context);
    return { context, service: requests, summarizer, chat: context.chat };
}
