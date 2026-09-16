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
 * **The plan is made before the prompt is built, and used.** It runs in the
 * generate interceptor, the last hook that is still ahead of prompt assembly
 * (public/script.js:4564 against :4635), and prompt/injector.js writes it. What
 * it may write is the handover gate's decision (prompt/handover.js): until qvink
 * is silent and our render has matched its live block byte for byte, the plan is
 * a measurement and nothing more (docs/decisions.md D-0020, D-0027).
 *
 * **The plan is a function of the chat, not of what was measured.** The cap is
 * a fixed share of the max prompt and every size is counted from the block itself, so the same
 * chat always gets the same block and nothing learned last turn can bend this one
 * (docs/decisions.md D-0033).
 */
import {
    QVINK_SHORT_INJECTION,
    pendingScenes,
    qvinkExcluding,
    qvinkInjected,
    qvinkInjecting,
    readScenes,
    resolvePlacement,
    resolveRendering,
} from '../memory/scenes.js';
import { createBudget, memoryCap, recoupled } from '../pipeline/budgeter.js';
import { createSeeSaw } from '../pipeline/scheduler.js';
import { assessHandover } from './handover.js';
import { commonPrefixLength, comparePrompts } from '../util/prefix.js';
import { createMaxPromptTokens } from '../util/context-size.js';
import { countTokens } from '../util/tokens.js';
import { debug } from '../util/log.js';

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
 * The per-turn glue: read the chat, plan the block, report what it planned.
 *
 * Takes a *getter*, not a context (docs/st-api-surface.md, Hazards).
 *
 * @param {() => object} getContext Returns a fresh SillyTavern.getContext()
 * @param {{seeSaw?: object, budget?: object, maxPromptTokens?: Function, own?: boolean}} [options]
 */
export function createAssembler(getContext, {
    seeSaw = createSeeSaw(),
    budget = createBudget(),
    maxPromptTokens = createMaxPromptTokens(),
    own = false,
} = {}) {
    let previousBlock = null;
    let ownInjection = Boolean(own);
    /** Has our renderer matched qvink's live block in this chat? See handover.js. */
    let proven = false;
    /** The report the observer logs, from the plan made earlier this turn. */
    let latest = null;

    /**
     * @returns {Promise<{report: object, text: string, blank: number[],
     *                    placement: object, writing: boolean}>}
     *          `report` is what the inspector and the disk log see — counts and
     *          offsets, never the chat's own words. `text` and `blank` are for
     *          the injector, and go no further.
     */
    async function plan() {
        const context = getContext();
        const chat = Array.isArray(context.chat) ? context.chat : [];
        const rendering = resolveRendering(context.extensionSettings);
        const scenes = readScenes(chat, { showPrefill: rendering.showPrefill });

        // The block qvink has parked right now: the fidelity mirror while it is
        // still the writer.
        const live = context.extensionPrompts?.[QVINK_SHORT_INJECTION]?.value ?? '';
        const fidelity = await checkFidelity(context, live, renderBlock(qvinkInjected(scenes), rendering));
        if (fidelity.compared && fidelity.match) proven = true;

        const placement = resolvePlacement(context.extensionSettings);
        const gate = assessHandover({
            own: ownInjection,
            injecting: qvinkInjecting(context.extensionPrompts),
            excluding: qvinkExcluding(context.extensionSettings),
            proven,
            // ST collects an injection by position (public/script.js:3312), so a
            // block parked outside those positions is written and never read.
            placed: placement.position >= 0,
        });

        const maxPrompt = await maxPromptTokens(context);
        const cap = memoryCap(maxPrompt);

        const pending = pendingScenes(chat);
        const step = seeSaw.advance(chat.length, { firstPending: pending[0] ?? null });
        // Every summary the block speaks for. The budget may drop the oldest of
        // them from the prompt, but they stay held back from the raw history
        // either way: an evicted summary's message is older still, and putting
        // its prose back would cost many times what the summary did.
        const covered = scenes.filter(
            (scene) => scene.eligible && scene.index <= step.summarisedThrough,
        );

        // Size candidates by this turn's own block, counted once: a ratio from
        // the text in hand, never one carried over from an earlier turn.
        const candidate = covered.filter((scene) => scene.index >= budget.oldest);
        const candidateText = renderBlock(candidate, rendering);
        const candidateTokens = candidateText ? await countTokens(context, candidateText) : 0;
        const charsPerToken = candidateTokens > 0 ? candidateText.length / candidateTokens : 1;
        const tokensOf = (list) => Math.ceil(blockChars(list, rendering) / charsPerToken);

        const fit = budget.fit({
            scenes: covered,
            cap,
            tokensOf,
            rebuild: step.reason === 'first-turn',
        });

        const text = renderBlock(fit.kept, rendering);
        const tokens = text === candidateText
            ? candidateTokens
            : (text ? await countTokens(context, text) : 0);

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

        latest = {
            source: sourceOf(fit.kept),
            cairnScenes: scenes.filter((scene) => scene.source === 'cairn').length,
            writing: gate.writing,
            handover: gate.reason,
            handoverDetail: gate.detail,
            proven,
            placement: placement.position,
            placementDefaulted: placement.defaulted,
            scenes: scenes.length,
            candidates: covered.length,
            blanked: covered.length,
            summarisedThrough: step.summarisedThrough,
            stepped: step.stepped,
            stepReason: step.reason,
            // A due step cut short by a missing summary (docs/p2-plan.md §3).
            stepWaiting: step.waiting,
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
            chars: text.length,
            tokens,
            // The D-0019 measurement, on the block alone: how far into the block
            // the first changed byte is. Near 100% means a step changed the tail.
            change: {
                stabilityPercent: change.stabilityPercent,
                divergenceAt: change.divergence?.index ?? null,
                divergencePercent: divergencePercent(change),
                previousChars: change.previousLength,
            },
            fidelity,
        };

        return {
            report: latest,
            text,
            blank: covered.map((scene) => scene.index),
            placement,
            writing: gate.writing,
        };
    }

    return {
        plan,

        /**
         * The handover lever, separate from `enabled`, so the run can be measured
         * with Cairn writing and with qvink writing while everything else — the
         * observer, the holder, the log — stays exactly the same.
         */
        setOwnEnabled(value) {
            ownInjection = Boolean(value);
            debug(`Memory block writing ${ownInjection ? 'on' : 'off'}.`);
        },

        /** A new chat is a new block, a new see-saw and a new baseline. */
        reset() {
            seeSaw.reset();
            budget.reset();
            previousBlock = null;
            proven = false;
            latest = null;
        },

        /** This turn's report, for the observer's snapshot. */
        get latest() {
            return latest;
        },

        get proven() {
            return proven;
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
 * qvink renders through `substituteParamsExtended` (its index.js:3973) and we do
 * not — our block is parked with its macros intact, because ST resolves them
 * when it collects the injections (public/script.js:3326), so the *prompt* is the
 * same either way. The comparison is the exception: a template carrying
 * `{{char}}` would diverge here for a reason that says nothing about the reader,
 * so the mirror is resolved before comparing and `resolved` records that it was.
 */
async function checkFidelity(context, live, mirror) {
    if (!live) {
        return { compared: false, match: null, resolved: false, divergeAt: null, liveChars: 0, ourChars: mirror.length };
    }

    const hasMacros = /\{\{.+?\}\}/.test(mirror);
    const compared = hasMacros ? substitute(context, mirror) : mirror;
    const match = live === compared;

    return {
        compared: true,
        match,
        resolved: hasMacros,
        divergeAt: match ? null : commonPrefixLength(live, compared),
        liveChars: live.length,
        ourChars: compared.length,
    };
}

/** public/scripts/st-context.js:164. Absent in an older ST: compare unresolved. */
function substitute(context, text) {
    try {
        return context.substituteParamsExtended?.(text) ?? text;
    } catch {
        return text;
    }
}

/** Who wrote the block's summaries: `qvink`, `cairn`, `mixed`, or null for no block. */
function sourceOf(scenes) {
    const sources = new Set(scenes.map((scene) => scene.source));
    if (!sources.size) return null;
    return sources.size > 1 ? 'mixed' : [...sources][0];
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

