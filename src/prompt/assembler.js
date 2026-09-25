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
 * is silent, the plan is a measurement and nothing more (docs/decisions.md D-0020,
 * D-0027).
 *
 * **The plan is a function of the chat, not of what was measured.** The cap is
 * worked out from the chat and the settings (prompt/reserves.js) and every size is
 * counted from the block itself, so the same chat always gets the same block and
 * nothing learned last turn can bend this one (docs/decisions.md D-0033, D-0052).
 */
import { pendingScenes, qvinkExcluding, qvinkInjecting, readScenes } from '../memory/scenes.js';
import { admitCanon, canonFor, canonRoom } from '../memory/canon.js';
import { canonCap, createBudget, deriveCap, recoupled } from '../pipeline/budgeter.js';
import { pendingCompaction } from '../pipeline/compactor.js';
import { createSeeSaw } from '../pipeline/scheduler.js';
import { createExamplesLatch, examplesSuperseded } from '../memory/examples.js';
import { assessHandover } from './handover.js';
import { FIRST_TURN, isRebuild } from './rebuild.js';
import { createReserves } from './reserves.js';
import { comparePrompts } from '../util/prefix.js';
import { createMaxPromptTokens } from '../util/context-size.js';
import { countTokens } from '../util/tokens.js';
import { debug } from '../util/log.js';

/**
 * How the block reads: qvink's default template and separator (its index.js:93,
 * :133), so a chat handed over from qvink keeps the block it had, byte for byte
 * (docs/decisions.md D-0040).
 */
export const BLOCK_RENDERING = Object.freeze({
    template: '[Following is a list of recent events]:\n{{memories}}\n',
    separator: '\n* ',
    macro: 'memories',
});

/**
 * Canon's own section, above the summaries (docs/p4-plan.md decision 4). The same
 * shape as the block's, so the two read as one thing, and **no canon means no
 * section at all** — a chat that has never had a pass gets today's bytes exactly.
 */
export const CANON_RENDERING = Object.freeze({
    template: '[Established facts]:\n{{facts}}\n',
    separator: '\n* ',
    macro: 'facts',
});

/**
 * Where it goes: qvink's default placement (its index.js:153-156), `IN_PROMPT`
 * after the story string (public/script.js:486) with the system role.
 * `setExtensionPrompt`'s arguments (public/script.js:8926).
 */
export const BLOCK_PLACEMENT = Object.freeze({ position: 0, depth: 2, role: 0, scan: false });

/**
 * Render the block, the way qvink renders it (its index.js:3963-3974):
 * the separator leads each summary, and no summaries means no block at all
 * rather than an empty template.
 *
 * Oldest first. That is the load-bearing choice — see the file header.
 *
 * @param {Array<{text: string}>} scenes Chronological.
 * @param {{template: string, separator: string, macro: string}} [rendering]
 * @returns {string}
 */
export function renderBlock(items, { template, separator, macro } = BLOCK_RENDERING) {
    if (!items?.length) return '';

    const body = items.map((item) => `${separator}${item.text}`).join('');
    // A replacer function, not a replacement string: a summary containing `$&`
    // would otherwise be read as a substitution pattern and quietly mangled.
    return template.replace(macroPattern(macro), () => body);
}

/**
 * The whole memory block: canon's section, a blank line, then the summaries.
 *
 * Either half may be empty. With no canon this returns the summaries byte for byte,
 * which is what makes "no canon, no change" a test rather than a hope.
 */
export function renderMemory(canonText, sceneText) {
    if (!canonText) return sceneText;
    if (!sceneText) return canonText;
    return `${canonText}\n${sceneText}`;
}

/**
 * The rendered length, without rendering. The budgeter calls this once per
 * dropped summary while it is finding the floor, which is the one place the
 * arithmetic is worth having.
 *
 * @returns {number} Exactly `renderBlock(scenes, rendering).length`.
 */
export function blockChars(items, { template, separator, macro } = BLOCK_RENDERING) {
    if (!items?.length) return 0;

    const slots = template.match(macroPattern(macro))?.length ?? 0;
    const body = items.length * separator.length
        + items.reduce((total, item) => total + item.chars, 0);
    return template.length + slots * (body - macroToken(macro).length);
}

/**
 * The per-turn glue: read the chat, plan the block, report what it planned.
 *
 * Takes a *getter*, not a context (docs/st-api-surface.md, Hazards).
 *
 * @param {() => object} getContext Returns a fresh SillyTavern.getContext()
 * @param {{seeSaw?: object, budget?: object, maxPromptTokens?: Function,
 *          reserves?: object, settings?: () => object, own?: boolean,
 *          examplesLatch?: object}} [options]
 */
export function createAssembler(getContext, {
    seeSaw = createSeeSaw(),
    budget = createBudget(),
    maxPromptTokens = createMaxPromptTokens(),
    settings = null,
    reserves = createReserves(getContext, { settings }),
    examplesLatch = createExamplesLatch(getContext),
    own = false,
} = {}) {
    let previousBlock = null;
    /** Last turn's cap, so a change is logged once rather than every turn. */
    let previousCap = null;
    let ownInjection = Boolean(own);
    /** The report the observer logs, from the plan made earlier this turn. */
    let latest = null;
    /**
     * The newest message whose canon batch the block has admitted. Advances only on a
     * rebuild turn and only forward, like `budget.oldest` (docs/p4-plan.md decision 3):
     * canon sits at the block's head, so admitting a batch on an ordinary turn would
     * change bytes above every summary. A rebuild changes the head anyway, so the two
     * head-changes land together and cost one break instead of two.
     */
    let admittedThrough = -Infinity;
    /**
     * The canon cap in force at the last rebuild, held for the cycle. `canonCap`'s
     * guard tracks `stepTokens`, which moves every turn, so applying a live cap
     * re-trims the block's head mid-cycle — the break the mark above exists to avoid
     * (docs/decisions.md D-0059).
     */
    let admittedCap = null;
    /** This turn's compaction pass, for the summarizer. Never reaches the log. */
    let pendingPass = null;

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
        const scenes = readScenes(chat);

        const gate = assessHandover({
            own: ownInjection,
            injecting: qvinkInjecting(context.extensionPrompts),
            excluding: qvinkExcluding(context),
        });

        const pending = pendingScenes(chat);
        const step = seeSaw.advance(chat.length, { firstPending: pending[0] ?? null });

        // Once summaries stand in for messages, example dialogue is dominated by
        // the raw window and goes for good (docs/decisions.md D-0068). Derived
        // here, before the reserves are read, because `cardReserve` must size the
        // card the prompt will actually carry — a reserve that disagrees with the
        // flag hides the whole reclaim in the margin.
        const stripExamples = examplesSuperseded(scenes, step.summarisedThrough);
        const examples = examplesLatch.apply(stripExamples);

        // How much room the rest of the prompt leaves. Every part of it is worked
        // out from this chat and these settings — nothing measured from a prompt
        // that went out (docs/decisions.md D-0033, D-0052).
        const maxPrompt = await maxPromptTokens(context);
        const reserved = await reserves.read(maxPrompt, {
            runLength: seeSaw.rawWindow + seeSaw.step - 1,
            since: step.summarisedThrough,
            stripExamples: examples.stripped,
        });
        const budgeted = deriveCap({ maxPromptTokens: maxPrompt, reserves: reserved });
        const cap = budgeted.cap;
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
        const candidateText = renderBlock(candidate);
        const candidateTokens = candidateText ? await countTokens(context, candidateText) : 0;
        const charsPerToken = candidateTokens > 0 ? candidateText.length / candidateTokens : 1;
        const tokensOf = (list) => Math.ceil(blockChars(list) / charsPerToken);
        const canonTokensOf = (list) => Math.ceil(blockChars(list, CANON_RENDERING) / charsPerToken);

        // What the next step will add, from what this block costs per scene. One
        // scene per message is the ceiling rather than the rule, so this reads a
        // little high — which errs towards noticing the two cadences have
        // recoupled rather than towards missing it (pipeline/budgeter.js).
        //
        // Measured before the fit, because canon's cap is derived from it and the
        // scene budget from canon's cap. The candidate and the kept set share their
        // per-scene cost to within the template's own length, so the number the log
        // carries is the one P6 measured (docs/decisions.md D-0052).
        const stepTokens = candidate.length
            ? Math.round((candidateTokens / candidate.length) * seeSaw.step)
            : 0;

        const keepCanon = settings?.().keepCanon !== false;
        const canonFold = keepCanon ? canonFor(chat) : { facts: [], batches: 0, coveredThrough: null };
        const allFacts = withChars(canonFold.facts);
        const canonBudget = canonCap({ cap, stepTokens });
        // Last turn's admitted set, since the fit is what says whether this turn may
        // move the mark. Held at the last rebuild's cap: the live cap is reported, but
        // a cap that moves every turn may not rewrite the head on an ordinary one.
        const heldCap = admittedCap ?? canonBudget.cap;
        let canon = admitCanon({
            facts: allFacts.filter((fact) => fact.index <= admittedThrough),
            cap: heldCap,
            tokensOf: canonTokensOf,
        });

        let fit = budget.fit({
            scenes: covered,
            sceneCap: Math.max(0, cap - canon.tokens),
            tokensOf,
            rebuild: step.reason === FIRST_TURN,
        });

        // A rebuild changes the block's head whatever we do, so this is the turn a
        // new batch costs nothing extra. Admitting it shrinks the scene budget, so
        // the summaries are fitted again — to the floor of the budget they actually
        // have, not the one they had before canon grew.
        const rebuilt = isRebuild({ evicted: fit.evicted, stepReason: step.reason });
        let evicted = fit.evicted;
        if (rebuilt) admittedCap = canonBudget.cap;
        if (rebuilt && allFacts.length) {
            admittedThrough = Math.max(admittedThrough, allFacts[allFacts.length - 1].index);
            const admitted = admitCanon({ facts: allFacts, cap: canonBudget.cap, tokensOf: canonTokensOf });
            if (admitted.tokens !== canon.tokens) {
                canon = admitted;
                fit = budget.fit({
                    scenes: covered,
                    sceneCap: Math.max(0, cap - canon.tokens),
                    tokensOf,
                    rebuild: true,
                });
                evicted += fit.evicted;
            }
        }

        const sceneText = renderBlock(fit.kept);
        const canonText = renderBlock(canon.facts, CANON_RENDERING);
        const text = renderMemory(canonText, sceneText);
        const tokens = text === candidateText
            ? candidateTokens
            : (text ? await countTokens(context, text) : 0);

        const change = comparePrompts(previousBlock, text);
        previousBlock = text;

        const stuck = recoupled({ sceneCap: fit.sceneCap, floor: fit.floor, stepTokens });

        // Whether a compaction pass is due, worked out here because every number it
        // needs is this turn's budget (pipeline/compactor.js). The summarizer reads it
        // through a getter and runs it after the reply lands; it carries the chat's
        // own words, so it goes to the job and never to the report.
        const room = canonRoom({ facts: allFacts, cap: canonBudget.cap, tokensOf: canonTokensOf });
        const due = pendingCompaction({
            scenes: fit.kept,
            coveredThrough: canonFold.coveredThrough,
            sceneCap: fit.sceneCap,
            floor: fit.floor,
            stepTokens,
            room: room.facts,
            tokensOf,
        });
        pendingPass = {
            ...due,
            writing: gate.writing,
            canon: allFacts.map((fact) => ({ text: fact.text })),
            message: due.due ? chat[due.covers[1]] : null,
        };

        // The cap is meant to hold still between a card edit, a book edit, a
        // context change and a heavier run of messages. Saying when it moves is
        // how a run shows whether it does (docs/decisions.md D-0052).
        if (cap !== previousCap) {
            debug(`Memory block: cap ${previousCap ?? '—'} → ${cap} tokens, limited by ${budgeted.limitedBy}.`);
            previousCap = cap;
        }
        if (evicted) {
            debug(`Memory block: evicted ${evicted} scene(s) to the floor (${fit.tokens}/${fit.sceneCap} scene tokens).`);
        }
        if (stuck) {
            debug(`Memory block: ${fit.sceneCap - fit.floor} tokens of slack cannot hold a ${stepTokens}-token step; every step will rebuild.`);
        }

        latest = {
            source: sourceOf(fit.kept),
            cairnScenes: scenes.filter((scene) => scene.source === 'cairn').length,
            writing: gate.writing,
            handover: gate.reason,
            handoverDetail: gate.detail,
            scenes: scenes.length,
            candidates: covered.length,
            blanked: covered.length,
            summarisedThrough: step.summarisedThrough,
            stepped: step.stepped,
            stepReason: step.reason,
            // A due step cut short by a missing summary (docs/decisions.md D-0037).
            stepWaiting: step.waiting,
            rawWindow: seeSaw.rawWindow,
            step: seeSaw.step,
            // The examples latch (docs/decisions.md D-0068). The run's first check is
            // that `examplesStripped` goes false->true exactly once and never back,
            // and that `budgetCard` falls by the card's example tokens on the same
            // turn `examplesLatched` is true. Both, or the reclaim did not happen.
            examplesStripped: examples.stripped,
            examplesLatched: examples.changed,
            // The rebuild turn (docs/decisions.md D-0067). Everything discontinuous
            // batches here, and the injector reads it to know when the World Info
            // holder may re-evaluate what it is holding (D-0069).
            rebuilt,
            included: fit.kept.length,
            oldest: fit.kept[0]?.index ?? null,
            newest: fit.kept[fit.kept.length - 1]?.index ?? null,
            evicted,
            overCap: fit.over,
            cap,
            // Canon (docs/p4-plan.md §3). `canonAdmitted` is the check the run reads: it
            // may change only on a turn where `evicted > 0` or the step reason is
            // `first-turn`. Any other turn where it moves is decision 3 failing.
            canonFacts: allFacts.length,
            canonAdmitted: canon.facts.length,
            canonTokens: canon.tokens,
            canonCap: canonBudget.cap,
            // What the block was actually fitted to. Equal to `canonCap` on a rebuild;
            // between rebuilds it is the cap that rebuild froze (D-0059).
            canonCapApplied: admittedCap ?? heldCap,
            canonLimitedBy: canonBudget.limitedBy,
            canonFull: room.full,
            canonSpilled: allFacts.length - canon.facts.length,
            canonThrough: Number.isFinite(admittedThrough) ? admittedThrough : null,
            sceneCap: fit.sceneCap,
            // Where the cap came from, so a log says whether the ceiling or the
            // chat is what bound it (docs/decisions.md D-0052).
            budget: {
                share: budgeted.share,
                room: budgeted.room,
                margin: budgeted.margin,
                minimum: budgeted.minimum,
                limitedBy: budgeted.limitedBy,
                card: budgeted.parts?.card ?? null,
                lore: budgeted.parts?.lore ?? null,
                loreBound: reserved?.loreBound ?? null,
                // ST's own World Info budget, which the holder trims to (D-0069).
                loreBudget: reserved?.loreBudget ?? null,
                window: budgeted.parts?.window ?? null,
                // Reported, never planned against: it swings across a see-saw cycle.
                windowNow: reserved?.windowNow ?? null,
                state: budgeted.parts?.state ?? null,
            },
            floor: fit.floor,
            slack: Math.max(0, fit.sceneCap - fit.floor),
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
        };

        return {
            report: latest,
            text,
            blank: covered.map((scene) => scene.index),
            placement: BLOCK_PLACEMENT,
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
            reserves.reset();
            examplesLatch.reset();
            previousBlock = null;
            previousCap = null;
            admittedThrough = -Infinity;
            admittedCap = null;
            pendingPass = null;
            latest = null;
        },

        /** This turn's report, for the observer's snapshot. */
        get latest() {
            return latest;
        },

        /**
         * This turn's compaction pass, for the summarizer (docs/p4-plan.md decision 6).
         * Separate from `latest` because it carries the summaries a pass would read,
         * and the report is counts and offsets only.
         */
        get pendingPass() {
            return pendingPass;
        },
    };
}

/** Canon facts sized the way scenes are, so `blockChars` can price a candidate list. */
function withChars(facts) {
    return facts.map((fact) => ({ ...fact, chars: fact.text.length }));
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
    return new RegExp(macroToken(macro).replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'gi');
}

function divergencePercent(change) {
    if (!change.divergence || !change.previousLength) return null;
    return round1((change.divergence.index / change.previousLength) * 100);
}

function round1(value) {
    return Math.round(value * 10) / 10;
}

