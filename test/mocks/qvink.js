/**
 * qvink Memory's per-message data, as it actually appears.
 *
 * P1 reads summaries qvink has already written (docs/decisions.md D-0020), so
 * these fixtures are the shape the reader is tested against. Content is invented;
 * the shape was confirmed against a real chat in `~/workspaces/cairn-corpus`
 * before this file was written and none of it was copied (CLAUDE.md §3.13).
 *
 * What the real thing looks like, and what is reproduced here:
 *
 *   - every one of 123 messages carried `extra.qvink_memory`, 122 with a summary;
 *   - the keys are exactly the eleven below (qvink's index.js:3490-3560);
 *   - summaries ran 196-641 characters, median 353;
 *   - `prefill` was `"Summary: "` on all of them, and `show_prefill` was off, so
 *     it never reached the prompt (its index.js:113, :3521);
 *   - `include` was `"short"` on 122 and null on the one with no summary;
 *   - the last 15 messages were `lagging: true` — summarised, but still in the
 *     raw window, so held back from the injection (its index.js:3830).
 */

/** qvink's index.js:45 */
export const QVINK_KEY = 'qvink_memory';

/**
 * One message's worth. Every key the real data has, so a reader that depends on
 * one we did not model fails here rather than in play.
 */
export function makeQvinkData({
    index = 0,
    chars = 353,
    include = 'short',
    lagging = false,
    remember = false,
    exclude = false,
    edited = false,
    memory = null,
} = {}) {
    return {
        memory: memory ?? makeSummary(index, chars),
        prefill: 'Summary: ',
        hash: 1_000_000_000_000 + index,
        edited,
        error: null,
        reasoning: '',
        exclude,
        remember,
        remember_auto: true,
        include,
        lagging,
    };
}

/**
 * A summary of a given length, unique to its index. Uniqueness matters: two
 * identical summaries would make a prefix comparison agree by accident.
 */
export function makeSummary(index, chars = 353) {
    const head = `Scene ${index}: `;
    const filler = `the pair talk, something shifts, and detail ${index} lands. `;
    let text = head;
    while (text.length < chars) text += filler;
    return text.slice(0, Math.max(head.length, chars));
}

/**
 * A chat where every message carries a summary.
 *
 * `lagging` follows qvink's rule — `i > summarisedThrough` (its index.js:3830) —
 * so the `include`/`lagging` flags describe a coherent turn rather than an
 * arbitrary one, which is what the fidelity mirror renders from.
 *
 * @param {{length?: number, summarisedThrough?: number, chars?: number,
 *          exclude?: number[], remember?: number[]}} [options]
 */
export function makeQvinkChat({
    length = 40,
    summarisedThrough = length - 11,
    chars = 353,
    exclude = [],
    remember = [],
} = {}) {
    const chat = [];

    for (let index = 0; index < length; index++) {
        const isUser = index % 2 === 0;
        chat.push({
            name: isUser ? 'Wren' : 'Aster',
            is_user: isUser,
            is_system: false,
            send_date: '2026-01-01T00:00:00.000Z',
            mes: `${isUser ? 'Wren' : 'Aster'} speaks at turn ${index}.`,
            swipe_id: 0,
            extra: {
                [QVINK_KEY]: makeQvinkData({
                    index,
                    chars,
                    lagging: index > summarisedThrough,
                    exclude: exclude.includes(index),
                    remember: remember.includes(index),
                }),
            },
        });
    }

    return chat;
}

/**
 * qvink's own settings bag, as `extension_settings.qvink_memory`
 * (its index.js:655). Defaults are its own (its index.js:93, :113, :133).
 */
export function makeQvinkSettings(overrides = {}) {
    return {
        short_template: '[Following is a list of recent events]:\n{{memories}}\n',
        summary_injection_separator: '\n* ',
        show_prefill: false,
        ...overrides,
    };
}
