/**
 * The assembler — builds the memory block from the tiers (DESIGN.md §11).
 *
 * P1's target is *where* a see-saw step breaks the prefix, not moving the block
 * down. The history is the part that grows, so anything below it shifts every
 * turn; the block stays high. What has to change is inside it: a step must
 * change the block's **tail**, not its head (docs/decisions.md D-0019).
 *
 * That falls out of three things, and only the third is in this file:
 *
 *   1. The growth cadence advances the threshold in steps, so between steps the
 *      included set is identical (pipeline/scheduler.js).
 *   2. The eviction cadence only drops summaries when the prompt genuinely
 *      cannot hold them, and then drops a batch (pipeline/budgeter.js).
 *   3. The block is rendered oldest-first, so growth appends and the bytes
 *      already in the prompt keep their offsets.
 *
 * Decoupled that way, a step turn adds to the end of a block whose head is
 * unchanged, and the first changed byte moves from the block's start to its end
 * — the 13% turn becomes a ~90% one, on D-0019's arithmetic.
 *
 * **Not yet the writer.** This plans and measures; qvink still injects
 * (docs/decisions.md D-0020 sequences the handover after the byte-identical
 * check). Every turn it also renders qvink's *own* selection and compares that
 * to what qvink actually parked, so the reader and the renderer are proven
 * against the live block before anything depends on them.
 */
import { QVINK_SHORT_INJECTION, qvinkInjected, readScenes, resolveRendering } from '../memory/scenes.js';
import { createBudget, deriveCap, recoupled } from '../pipeline/budgeter.js';
import { createSeeSaw } from '../pipeline/scheduler.js';
import { commonPrefixLength, comparePrompts } from '../util/prefix.js';
import { createMaxPromptTokens } from '../util/context-size.js';
import { countTokens } from '../util/tokens.js';
import { debug } from '../util/log.js';

/** Starting chars-per-token, replaced by a measured ratio after the first turn. */
const INITIAL_CHARS_PER_TOKEN = 4;

/**
 * Render the block, the way qvink renders it (its index.js:3963-3974):
 * the separator leads each summary, and no summaries means no block at all
 * rather than an empty template.
 *
 * Oldest first. That is the load-bearing choice — see the file header.
 *
 * @param {Array<{text: string}>} scenes Chronological.
 * @param {{template: string, separator: string, macro: string}} rendering
 * @returns {string}
 */
export function renderBlock(scenes, { template, separator, macro }) {
    if (!scenes?.length) return '';

    const body = scenes.map((scene) => `${separator}${scene.text}`).join('');
    // A replacer function, not a replacement string: a summary containing `$&`
    // would otherwise be read as a substitution pattern and quietly mangled.
    return template.replace(macroPattern(macro), () => body);
}

/**
 * The rendered length, without rendering. The budgeter calls this once per
 * dropped summary while it is finding the floor, which is the one place the
 * arithmetic is worth having.
 *
 * @returns {number} Exactly `renderBlock(scenes, rendering).length`.
 */
export function blockChars(scenes, { template, separator, macro }) {
    if (!scenes?.length) return 0;

    const slots = template.match(macroPattern(macro))?.length ?? 0;
    const body = scenes.length * separator.length
        + scenes.reduce((total, scene) => total + scene.chars, 0);
    return template.length + slots * (body - macroToken(macro).length);
}

/**
 * The per-turn glue: read the chat, plan the block, measure what happened.
 *
 * Takes a *getter*, not a context (docs/st-api-surface.md, Hazards).
 *
 * @param {() => object} getContext Returns a fresh SillyTavern.getContext()
 * @param {{seeSaw?: object, budget?: object, maxPromptTokens?: Function}} [options]
 */
export function createAssembler(getContext, {
    seeSaw = createSeeSaw(),
    budget = createBudget(),
    maxPromptTokens = createMaxPromptTokens(),
} = {}) {
    let previousBlock = null;
    let charsPerToken = INITIAL_CHARS_PER_TOKEN;

    /**
     * @param {{promptTokens?: number}} [turn] What the observer measured for the
     *        prompt that just went out — the other half of the budget arithmetic.
     * @returns {Promise<object>} Counts and offsets only. The block text stays in
     *          here: a snapshot is logged to disk, and the chat body is not ours
     *          to write there.
     */
    async function plan({ promptTokens = 0 } = {}) {
        const context = getContext();
        const chat = Array.isArray(context.chat) ? context.chat : [];
        const rendering = resolveRendering(context.extensionSettings);
        const scenes = readScenes(chat, { showPrefill: rendering.showPrefill });

        // Everything in the prompt except the memory block. Measured, not assumed:
        // the block we are planning replaces the one qvink parked, so its cost
        // comes out of the total before the cap is drawn.
        const live = context.extensionPrompts?.[QVINK_SHORT_INJECTION]?.value ?? '';
        const liveTokens = live ? await countTokens(context, live) : 0;
        const otherTokens = Math.max(0, promptTokens - liveTokens);
        const maxPrompt = await maxPromptTokens(context);
        const cap = deriveCap({ maxPromptTokens: maxPrompt, otherTokens });

        const step = seeSaw.advance(chat.length);
        const candidates = scenes.filter(
            (scene) => scene.eligible && scene.index <= step.summarisedThrough,
        );

        const fit = budget.fit({
            scenes: candidates,
            cap,
            tokensOf: (list) => Math.ceil(blockChars(list, rendering) / charsPerToken),
        });

        const text = renderBlock(fit.kept, rendering);
        const tokens = text ? await countTokens(context, text) : 0;
        // Calibrate for next turn's fit. chars/4 overstates prose by roughly a
        // third, which would evict against a cap that was never really reached.
        if (text.length && tokens > 0) charsPerToken = text.length / tokens;

        const change = comparePrompts(previousBlock, text);
        previousBlock = text;

        // What the next step will add, from what this block costs per scene. One
        // scene per message is the ceiling rather than the rule, so this reads a
        // little high — which errs towards noticing the two cadences have
        // recoupled rather than towards missing it (pipeline/budgeter.js).
        const stepTokens = fit.kept.length
            ? Math.round((tokens / fit.kept.length) * seeSaw.step)
            : 0;
        const stuck = recoupled({ cap, floor: fit.floor, stepTokens });

        if (fit.evicted) {
            debug(`Memory block: evicted ${fit.evicted} scene(s) to the floor (${fit.tokens}/${cap} tokens).`);
        }
        if (stuck) {
            debug(`Memory block: ${cap - fit.floor} tokens of slack cannot hold a ${stepTokens}-token step; every step will rebuild.`);
        }

        return {
            source: 'qvink',
            scenes: scenes.length,
            candidates: candidates.length,
            summarisedThrough: step.summarisedThrough,
            stepped: step.stepped,
            stepReason: step.reason,
            rawWindow: seeSaw.rawWindow,
            step: seeSaw.step,
            included: fit.kept.length,
            oldest: fit.kept[0]?.index ?? null,
            newest: fit.kept[fit.kept.length - 1]?.index ?? null,
            evicted: fit.evicted,
            overCap: fit.over,
            cap,
            floor: fit.floor,
            slack: Math.max(0, cap - fit.floor),
            stepTokens,
            recoupled: stuck,
            maxPromptTokens: maxPrompt,
            otherTokens,
            chars: text.length,
            tokens,
            charsPerToken: round2(charsPerToken),
            // The D-0019 measurement, on the block alone: how far into the block
            // the first changed byte is. Near 100% means a step changed the tail.
            change: {
                stabilityPercent: change.stabilityPercent,
                divergenceAt: change.divergence?.index ?? null,
                divergencePercent: divergencePercent(change),
                previousChars: change.previousLength,
            },
            fidelity: checkFidelity(live, renderBlock(qvinkInjected(scenes), rendering)),
        };
    }

    return {
        plan,

        /** A new chat is a new block, a new see-saw and a new baseline. */
        reset() {
            seeSaw.reset();
            budget.reset();
            previousBlock = null;
            charsPerToken = INITIAL_CHARS_PER_TOKEN;
        },
    };
}

/**
 * Our renderer against qvink's live injection, on qvink's own selection.
 *
 * This is the gate D-0020 sequences the handover behind: until our render of
 * their set is their block byte for byte, taking over the injection would move
 * the block *and* silently change its contents, and no measurement afterwards
 * could tell the two apart.
 *
 * `approximate` is the honest part. qvink renders through
 * `substituteParamsExtended` (its index.js:3973), so a template carrying other ST
 * macros resolves there and not here — a mismatch then says nothing about the
 * reader.
 */
function checkFidelity(live, mirror) {
    if (!live) {
        return { compared: false, match: null, approximate: false, divergeAt: null, liveChars: 0, ourChars: mirror.length };
    }

    const approximate = /\{\{.+?\}\}/.test(mirror);
    const match = live === mirror;

    return {
        compared: true,
        match,
        approximate,
        divergeAt: match ? null : commonPrefixLength(live, mirror),
        liveChars: live.length,
        ourChars: mirror.length,
    };
}

function macroToken(macro) {
    return `{{${macro}}}`;
}

/** Case-insensitive, as ST's macro substitution is (public/script.js:3326). */
function macroPattern(macro) {
    return new RegExp(macroToken(macro).replace(/[{}]/g, '\\$&'), 'gi');
}

function divergencePercent(change) {
    if (!change.divergence || !change.previousLength) return null;
    return round1((change.divergence.index / change.previousLength) * 100);
}

function round1(value) {
    return Math.round(value * 10) / 10;
}

function round2(value) {
    return Math.round(value * 100) / 100;
}
