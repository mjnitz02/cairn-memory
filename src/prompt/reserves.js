/**
 * What the rest of the prompt needs, so the memory block can take what is left
 * (docs/decisions.md D-0052).
 *
 * A fixed 35% share (D-0038) is a share of a prompt nobody checked. On Esin a
 * 4,500-token card and a 5,000-token lorebook leave about 6,000 for a block
 * capped at 8,063, and the overflow is invisible from here: text completion
 * fills the history to the limit (public/script.js:4920) and then fits example
 * messages into what is left (:4959), so what goes missing is the card's
 * examples and the oldest raw messages, never the block.
 *
 * Every reserve here is worked out from the chat and the settings. **Nothing is
 * measured from a prompt that went out**, which is what keeps D-0033 standing:
 * the same chat always gets the same cap, a reload costs no cold start, and
 * there is nothing to store. Each is an *upper bound* rather than a guess, so
 * the leftover margin (pipeline/budgeter.js `MARGIN_FRACTION`) only has to cover
 * what no reserve can see — instruct wrappers, the story string's own wording,
 * other extensions' injections, and the gap between ST's tokenizer and the
 * model's.
 *
 * The pure half takes plain inputs and is tested without ST. The glue at the
 * bottom is the only part that touches `getContext()` or imports from ST, and
 * every path through it degrades to "no reserves", which the budgeter reads as
 * the fixed share it has been shipping (CLAUDE.md §4.17).
 */
import { RAW_WINDOW, STEP } from '../pipeline/scheduler.js';
import { MAX_STATE_CHARS } from '../memory/state-schema.js';
import { wtrackerLoaded } from '../memory/state.js';
import { hashString } from '../util/hash.js';
import { estimateTokens, countTokens } from '../util/tokens.js';
import { warn } from '../util/log.js';

/**
 * ST's World Info module. `getSortedEntries` and the budget settings are not on
 * `getContext()` (public/scripts/st-context.js:115-309), so they come from the
 * module the way util/context-size.js takes `getMaxPromptTokens` from
 * `/script.js`: an absolute specifier, because that is the URL ST itself loaded
 * it under (`./scripts/world-info.js` from `/script.js`, public/script.js:52),
 * and a *dynamic* import, because a failed import at module scope would stop the
 * extension loading.
 */
const ST_WORLD_INFO = '/scripts/world-info.js';

/**
 * The card fields ST puts in the story string (`storyStringParams`,
 * public/script.js:4703-4718), as `getCharacterCardFields` returns them
 * (public/script.js:3476, exposed at public/scripts/st-context.js:232).
 *
 * `version`, `creatorNotes`, `firstMessage` and `alternateGreetings` are on the
 * same object and are deliberately absent: none of them reaches the prompt.
 */
export const CARD_FIELDS = Object.freeze([
    'description', 'personality', 'scenario', 'persona', 'mesExamples', 'jailbreak', 'charDepthPrompt',
]);

/**
 * The same fields once the examples latch is set (docs/decisions.md D-0068). ST
 * blanks `mesExamplesArray` outright at public/script.js:4738-4739, so the
 * examples are not in the prompt and reserving for them would hand the margin
 * 2,176 tokens the block should have had — **the failure most likely to make the
 * whole reclaim invisible**, because the cap would not move and nothing would say
 * why.
 */
export const CARD_FIELDS_STRIPPED = Object.freeze(
    CARD_FIELDS.filter((field) => field !== 'mesExamples'),
);

/**
 * The longest run of raw messages the window ever holds. The see-saw keeps
 * `RAW_WINDOW` behind the threshold and advances in `STEP`s, so the turn before
 * a step is the widest it gets (pipeline/scheduler.js).
 */
export const RUN_LENGTH = RAW_WINDOW + STEP - 1;

/**
 * The world state's ceiling. Derived from the rendered widest valid state
 * (memory/state-schema.js `MAX_STATE_CHARS`) rather than typed in, so a schema
 * change carries the reserve with it. It is the *bound* and not the current
 * state because the state's size changes on every reply and the cap must not
 * (docs/decisions.md D-0043, D-0052).
 *
 * The 4-chars-per-token estimate reads a little above the ~330 tokens D-0043
 * measured, which errs towards reserving too much — the safe direction.
 */
export const STATE_RESERVE_TOKENS = estimateTokens('x'.repeat(MAX_STATE_CHARS));

/**
 * The heaviest run of `length` consecutive messages in the chat.
 *
 * "The heaviest the chat has had" needs no guess about how long messages are,
 * and over a growing chat it can only rise — so it changes when a heavier run is
 * written and on no other turn. A deletion or a branch can lower it, which
 * raises the cap, and a rise costs nothing.
 *
 * @param {number[]} tokens Per-message counts, in chat order, visible messages only.
 * @param {number} [length]
 * @returns {number}
 */
export function heaviestRun(tokens, length = RUN_LENGTH) {
    const counts = (tokens ?? []).map((n) => (Number.isFinite(n) ? Math.max(0, n) : 0));
    const width = Math.max(1, Math.floor(length) || 1);

    let sum = counts.slice(0, width).reduce((total, n) => total + n, 0);
    let best = sum;
    for (let i = width; i < counts.length; i++) {
        sum += counts[i] - counts[i - width];
        if (sum > best) best = sum;
    }
    return best;
}

/**
 * ST's World Info token budget: a share of the max prompt, optionally capped.
 * `Math.round(world_info_budget * maxContext / 100) || 1`, then the cap
 * (public/scripts/world-info.js:4736-4741). `maxContext` there is the caller's
 * `this_max_context`, which is `getMaxPromptTokens()` (public/script.js:4560),
 * so it is the same number the memory cap is a share of.
 *
 * @param {{maxPromptTokens: number, percent?: number, cap?: number}} input
 */
export function loreBudget({ maxPromptTokens, percent, cap }) {
    const max = Number.isFinite(maxPromptTokens) ? Math.max(0, maxPromptTokens) : 0;
    const share = Number.isFinite(percent) ? percent : 0;
    const budget = Math.round(share * max / 100) || 1;
    const limit = Number.isFinite(cap) ? cap : 0;
    return limit > 0 && budget > limit ? limit : budget;
}

/**
 * What the lorebooks can cost at most: the whole of every enabled entry, or the
 * budget if they come to more. ST stops adding entries once the running count
 * reaches the budget (world-info.js:5061), so lore cannot pass it — and an entry
 * marked `ignoreBudget` (:5669) is added on top of it, so it is added here too.
 *
 * Retrieval decides *which* entries fire; this is only how much they can weigh.
 *
 * @param {{entries: Array<{content?: string, disable?: boolean, ignoreBudget?: boolean}>,
 *          budget: number, sizeOf: (text: string) => Promise<number>}} input
 *        `entries` is `getSortedEntries()` — the same set the scan walks.
 * @returns {Promise<{tokens: number, bound: 'none'|'books'|'budget'}>}
 */
export async function loreReserve({ entries, budget, sizeOf }) {
    let budgeted = 0;
    let ignoring = 0;
    let enabled = 0;

    for (const entry of entries ?? []) {
        // A disabled entry never reaches the scan, so it costs nothing.
        if (entry?.disable) continue;
        enabled++;

        if (entry?.ignoreBudget) {
            ignoring += await sizeOf(entry?.content ?? '');
            continue;
        }
        // Past the budget the rest cannot add anything, and Akane's book is 110
        // entries — so stop counting rather than tokenize a book we have capped.
        if (budgeted > budget) continue;
        budgeted += await sizeOf(entry?.content ?? '');
    }

    if (!enabled) return { tokens: 0, bound: 'none' };
    const capped = budgeted > budget;
    return { tokens: (capped ? budget : budgeted) + ignoring, bound: capped ? 'budget' : 'books' };
}

/**
 * ST's system prompt for this generation, which is a choice and not a field:
 * the character's own when "prefer character prompt" is on and it has one,
 * otherwise the instruct system prompt while that is enabled, and nothing at all
 * on chat completion (public/script.js:4686-4696).
 *
 * @param {{powerUser?: object, cardSystem?: string, mainApi?: string}} input
 */
export function systemPromptText({ powerUser, cardSystem, mainApi }) {
    if (mainApi === 'openai') return '';
    const sysprompt = powerUser?.sysprompt;
    if (!sysprompt?.enabled) return '';
    return powerUser?.prefer_character_prompt && cardSystem
        ? String(cardSystem)
        : String(sysprompt.content ?? '');
}

/**
 * The card as one string to count. Joined rather than counted field by field so
 * the tokenizer is called once and the cache has one key per card.
 *
 * @param {object} fields `getCharacterCardFields()`
 * @param {string} [systemPrompt] From `systemPromptText`.
 * @param {{stripExamples?: boolean}} [options] The examples latch, which has to
 *        be the *same* latch that wrote `power_user.strip_examples` — a reserve
 *        that disagrees with the prompt is worse than either alone (D-0068).
 */
export function cardText(fields, systemPrompt = '', { stripExamples = false } = {}) {
    const names = stripExamples ? CARD_FIELDS_STRIPPED : CARD_FIELDS;
    return [systemPrompt, ...names.map((field) => fields?.[field] ?? '')]
        .map((part) => String(part ?? ''))
        .filter(Boolean)
        .join('\n');
}

/**
 * The per-turn glue. Takes a *getter*, not a context
 * (docs/st-api-surface.md, Hazards).
 *
 * @param {() => object} getContext Returns a fresh SillyTavern.getContext()
 * @param {{load?: () => Promise<object>, settings?: () => object,
 *          scope?: object, runLength?: number}} [options]
 *        `load` is injected in tests; there is no `/scripts/world-info.js`
 *        outside the browser.
 */
export function createReserves(getContext, {
    load = () => import(/* @vite-ignore */ ST_WORLD_INFO),
    settings = null,
    scope = globalThis,
    runLength = RUN_LENGTH,
} = {}) {
    /** text hash -> tokens. ST counts every message on every generation, so its own cache is warm. */
    const sizes = new Map();
    /** One warning per run of failures, not one per turn. */
    let warned = false;

    async function sized(context, text) {
        const key = hashString(String(text ?? ''));
        if (!sizes.has(key)) sizes.set(key, await countTokens(context, text));
        return sizes.get(key);
    }

    /**
     * @param {number} maxPromptTokens What the cap is a share of, and what ST
     *        works its own World Info budget out from.
     * @param {{runLength?: number, since?: number}} [options] `runLength` is the
     *        see-saw's own widest window, so a changed `RAW_WINDOW` or `STEP`
     *        cannot leave this reading a number the scheduler no longer uses.
     *        `since` is the threshold: messages after it go to the model raw.
     *        `stripExamples` is the examples latch (memory/examples.js).
     * @returns {Promise<{card: number, lore: number, loreBound: string,
     *                    loreBudget: number, window: number, windowNow: number,
     *                    state: number}|null>}
     *          null when a read failed: the budgeter then falls back to the fixed
     *          share rather than to a reserve of zero, which would hand the block
     *          room the prompt does not have.
     */
    async function read(maxPromptTokens, {
        runLength: width = runLength,
        since = -1,
        stripExamples = false,
    } = {}) {
        try {
            const context = getContext();
            const sizeOf = (text) => sized(context, text);

            const reserves = {
                card: await cardReserve(context, sizeOf, stripExamples),
                ...await loreFor(context, maxPromptTokens, sizeOf),
                ...await windowReserve(context, sizeOf, width, since),
                state: stateReserve(context),
            };

            warned = false;
            return reserves;
        } catch (err) {
            if (!warned) {
                warned = true;
                warn('Could not work out what the rest of the prompt needs; the memory block keeps its fixed share.', err);
            }
            return null;
        }
    }

    async function cardReserve(context, sizeOf, stripExamples) {
        const fields = context.getCharacterCardFields();
        const system = systemPromptText({
            powerUser: context.powerUserSettings,
            cardSystem: fields?.system,
            mainApi: context.mainApi,
        });
        return sizeOf(cardText(fields, system, { stripExamples }));
    }

    async function loreFor(context, maxPromptTokens, sizeOf) {
        const worldInfo = await load();
        const budget = loreBudget({
            maxPromptTokens,
            // Live `let` exports, so they are read at the point of use (D-0016).
            percent: Number(worldInfo.world_info_budget),
            cap: Number(worldInfo.world_info_budget_cap),
        });
        // `getSortedEntries` emits WORLDINFO_ENTRIES_LOADED (world-info.js:4604),
        // so this fires it a second time per generation. Nothing in ST listens,
        // and a third-party listener sees the same freshly built arrays ST's own
        // call will build again — but it is a side effect and it is ours.
        const { tokens, bound } = await loreReserve({
            entries: await worldInfo.getSortedEntries(),
            budget,
            sizeOf,
        });
        // The budget itself, not just what the books weigh against it: the holder
        // trims the held set to this number at a rebuild (docs/decisions.md D-0069),
        // and it has to be the same budget the reserve was worked out from or the
        // two disagree the way the card and the examples latch could (D-0068).
        return { lore: tokens, loreBound: bound, loreBudget: budget };
    }

    /**
     * Hidden messages are left out, as ST leaves them out of `coreChat`
     * (public/script.js:4496).
     *
     * `windowNow` is what the window weighs *this* turn. It is reported and never
     * planned against: the reserve has to be the same number between steps, and
     * this one swings by about 5,000 tokens across a cycle. It is there so a run
     * can be checked against what the margin actually had to cover.
     */
    async function windowReserve(context, sizeOf, width, since) {
        const chat = Array.isArray(context.chat) ? context.chat : [];
        const counts = [];
        let now = 0;

        for (let i = 0; i < chat.length; i++) {
            if (chat[i]?.is_system) continue;
            const count = await sizeOf(chat[i]?.mes ?? '');
            counts.push(count);
            if (i > since) now += count;
        }

        return { window: heaviestRun(counts, width), windowNow: now };
    }

    /** The bound while the state is on and no WTracker is holding it back, 0 otherwise. */
    function stateReserve(context) {
        if (settings?.()?.worldState === false) return 0;
        return wtrackerLoaded(context, { scope }) ? 0 : STATE_RESERVE_TOKENS;
    }

    return {
        read,

        /**
         * A new chat is a new card, a new book and new messages. The sizes are
         * keyed by content hash so they would still be correct, but nothing in
         * the old chat is worth carrying.
         */
        reset() {
            sizes.clear();
            warned = false;
        },

        get cached() {
            return sizes.size;
        },
    };
}
