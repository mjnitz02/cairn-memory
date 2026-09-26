import { describe, expect, it } from 'vitest';
import { BLOCK_PLACEMENT, BLOCK_RENDERING, blockChars, createAssembler, renderBlock } from '../src/prompt/assembler.js';
import { QVINK_EXTENSION, readScenes } from '../src/memory/scenes.js';
import { CAP_FRACTION, createBudget } from '../src/pipeline/budgeter.js';
import { RAW_WINDOW, STEP, createSeeSaw } from '../src/pipeline/scheduler.js';
import { createObserver } from '../src/prompt/observer.js';
import { createReserves, heaviestRun } from '../src/prompt/reserves.js';
import { collectedKeys, createContext, extension_prompt_types } from './mocks/sillytavern.js';
import { makeBook, makeWorldInfoModule } from './mocks/world-info.js';
import { makeQvinkChat, makeQvinkSettings, makeSummary } from './mocks/qvink.js';
import { cairnCanonStore, cairnIndexStore, cairnStore, cairnSummary, makeMixedChat } from './mocks/cairn.js';
import { pendingScenes } from '../src/memory/scenes.js';
import { hashString } from '../src/util/hash.js';
import { mulberry32 } from './helpers/random.js';

/**
 * qvink's own rendering, re-derived here rather than by calling ours: template
 * with `{{memories}}` replaced by each summary led by the separator
 * (its index.js:3906-3916, :3963-3974). An oracle that called the code under
 * test would prove only that it agrees with itself.
 */
function asQvinkWouldRender(scenes) {
    if (!scenes.length) return '';
    const body = scenes.map((scene) => `\n* ${scene.text}`).join('');
    return `[Following is a list of recent events]:\n${body}\n`;
}

/**
 * `cap` is sugar for the max prompt that gives it. The default `reserves` reads
 * nothing, which is the degrade the budgeter answers with the fixed share
 * (docs/decisions.md D-0038) — so a test that is not about the cap gets exactly
 * the cap it asked for. The reserves themselves are exercised below.
 */
const NO_RESERVES = Object.freeze({ read: async () => null, reset() {} });

/**
 * The see-saw's threshold for a chat of this length, derived rather than typed
 * in: `RAW_WINDOW` and `STEP` are two numbers P5 moved once and may move again
 * (docs/decisions.md D-0068), and a fixture that hardcodes their arithmetic fails
 * for the wrong reason when they do (CLAUDE.md §9.35).
 */
const threshold = (length) => length - 1 - RAW_WINDOW;

function harness({
    seeSaw = createSeeSaw(),
    budget = createBudget(),
    cap = 1_000_000,
    maxPrompt = Math.ceil(cap / CAP_FRACTION),
    reserves = NO_RESERVES,
    settings = makeQvinkSettings(),
    qvink = true,
} = {}) {
    const context = createContext({ chat: [], extensions: qvink ? [QVINK_EXTENSION] : [] });
    context.extensionSettings.qvink_memory = settings;

    const assembler = createAssembler(() => context, {
        seeSaw,
        budget,
        reserves,
        maxPromptTokens: async () => maxPrompt,
    });

    return {
        context,
        assembler,

        /** One turn, planned in the interceptor before the prompt is built. */
        async plan() {
            return (await assembler.plan()).report;
        },

        /** The whole plan, including the parts only the injector sees. */
        write() {
            return assembler.plan();
        },

        /** One turn on a chat of the given length. */
        turn(length) {
            context.chat = makeQvinkChat({ length, summarisedThrough: length - 11 });
            return this.plan();
        },
    };
}

/**
 * A run where the gate is open: qvink is installed, set to "Macro Only" and no
 * longer excluding (docs/decisions.md D-0020, D-0027).
 */
function handedOver(run, { length = 40 } = {}) {
    const chat = makeQvinkChat({ length, summarisedThrough: length - 11 });
    run.context.chat = chat;
    run.assembler.setOwnEnabled(true);
    run.context.extensionSettings.qvink_memory.exclude_messages_after_threshold = false;
    // "Macro Only" keeps the value and unplaces it
    // (extension_prompt_types.NONE, public/script.js:484).
    run.context.setExtensionPrompt('qvink_memory_short', asQvinkWouldRender(readScenes(chat)), -1, 2);
    return run;
}

describe('rendering the block', () => {
    it('renders what qvink renders by default, oldest first, so a handed-over block keeps its bytes', () => {
        const scenes = readScenes(makeQvinkChat({ length: 3 }));

        expect(renderBlock(scenes)).toBe(asQvinkWouldRender(scenes));
        expect(renderBlock(scenes, BLOCK_RENDERING)).toBe(asQvinkWouldRender(scenes));
    });

    it('is nothing at all when there is nothing to say (qvink index.js:3965)', () => {
        expect(renderBlock([], BLOCK_RENDERING)).toBe('');
        expect(blockChars([], BLOCK_RENDERING)).toBe(0);
    });

    it('treats a summary containing $& as text, not as a substitution pattern', () => {
        const scenes = [{ text: 'She said $& and then $` happened.', chars: 33 }];

        expect(renderBlock(scenes, BLOCK_RENDERING)).toContain('$& and then $`');
    });

    it('sizes the block without building it', () => {
        for (const length of [1, 2, 7, 40]) {
            const scenes = readScenes(makeQvinkChat({ length }));
            expect(blockChars(scenes, BLOCK_RENDERING)).toBe(renderBlock(scenes, BLOCK_RENDERING).length);
        }
    });

    it('sizes a template with several macro slots the way it renders it', () => {
        const rendering = { ...BLOCK_RENDERING, template: 'A{{memories}}B{{MEMORIES}}C' };
        const scenes = readScenes(makeQvinkChat({ length: 3 }));

        expect(blockChars(scenes, rendering)).toBe(renderBlock(scenes, rendering).length);
    });

    it('reads a macro name literally, regex metacharacters and all', () => {
        const rendering = { ...BLOCK_RENDERING, template: '<{{a.b\\c}}|{{aXb\\c}}>', macro: 'a.b\\c' };
        const scenes = [{ text: 'x', chars: 1 }];

        expect(renderBlock(scenes, rendering)).toBe(`<${rendering.separator}x|{{aXb\\c}}>`);
        expect(blockChars(scenes, rendering)).toBe(renderBlock(scenes, rendering).length);
    });
});

/**
 * The invariant P1 exists for (docs/decisions.md D-0019).
 *
 * qvink fuses growth and eviction into one trigger, so a see-saw step changes the
 * block's first byte and invalidates the whole prompt below it: 13% stability,
 * one turn in ten, forever. Split the cadences and a step appends at the tail
 * instead, leaving the head — and the cache — intact.
 *
 * The control runs the same code in qvink's regime (advance every turn, evict
 * exactly enough to fit) on the same chat, because "our numbers look good" is not
 * a finding unless the other arm is there to be compared against.
 */
describe('a see-saw step changes the block tail, not its head', () => {
    it('leaves the block byte-identical between steps', async () => {
        const run = harness();
        await run.turn(31);

        for (let length = 32; length < 31 + STEP; length++) {
            const plan = await run.turn(length);
            expect(plan.stepped).toBe(false);
            expect(plan.change.stabilityPercent).toBe(100);
            expect(plan.change.divergenceAt).toBeNull();
        }
    });

    it('breaks at the very end of the block when it does step', async () => {
        const run = harness();
        await run.turn(31);
        for (let length = 32; length < 31 + STEP; length++) await run.turn(length);

        const step = await run.turn(31 + STEP);

        expect(step.stepped).toBe(true);
        expect(step.included).toBe(31);
        // The head survived: everything but the template's trailing newline was
        // still in the prompt the model had already read.
        expect(step.change.divergencePercent).toBeGreaterThan(99);
    });

    it('beats the regime it replaces over a run, on the same chat', async () => {
        // A cap the block eventually reaches, because that is the only regime
        // where the two policies differ: D-0019's point is that the collapse is
        // not an event but the steady state once the window is at the frontier.
        const treatment = harness({ cap: 6_000 });
        const control = harness({
            // qvink's defaults, in our own code: advance the threshold on every
            // message (its index.js:138) and evict exactly enough to fit.
            seeSaw: createSeeSaw({ step: 0 }),
            budget: createBudget({ floorFraction: 1 }),
            cap: 6_000,
        });

        const treated = [];
        const controlled = [];
        for (let length = 31; length <= 200; length++) {
            treated.push(await treatment.turn(length));
            controlled.push(await control.turn(length));
        }

        // A rebuild: the first changed byte fell in the block's first half, so
        // the model re-reads the block and everything under it.
        const rebuilds = (plans) => plans
            .filter((plan) => (plan.change.divergencePercent ?? 100) < 50).length;

        expect(rebuilds(controlled)).toBeGreaterThan(80);
        expect(rebuilds(treated)).toBeLessThan(5);

        // Same summaries, same chat, same cap — only the cadences differ.
        expect(controlled.filter((plan) => plan.evicted).length).toBeGreaterThan(80);
        expect(treated.filter((plan) => plan.evicted).length).toBeLessThan(5);
    });

    it('holds the head across a step even after the cap has bound once', async () => {
        const run = harness({ cap: 6_000 });
        const plans = [];
        for (let length = 31; length <= 160; length++) plans.push(await run.turn(length));

        const afterFirstEviction = plans.findIndex((plan) => plan.evicted) + 1;
        // Every step but the ones that are themselves the next eviction.
        const later = plans.slice(afterFirstEviction).filter((plan) => plan.stepped && !plan.evicted);

        expect(later.length).toBeGreaterThan(2);
        expect(later.every((plan) => plan.change.divergencePercent > 99)).toBe(true);
    });
});

/**
 * The reclaim's end-to-end check (docs/decisions.md D-0068). The two things a run
 * reads off the log, asserted here so a run never has to be the first place they
 * are noticed.
 */
describe('the example-dialogue latch, over a played chat', () => {
    it('flips once, never back, and says which turn it moved on', async () => {
        const run = harness();
        const plans = [];
        for (let length = 2; length <= 60; length++) plans.push(await run.turn(length));

        const stripped = plans.map((plan) => plan.examplesStripped);
        expect(stripped.at(0)).toBe(false);
        expect(stripped.at(-1)).toBe(true);
        // Monotonic: once true it stays true for the rest of the chat.
        expect(stripped.indexOf(true)).toBe(stripped.lastIndexOf(false) + 1);

        // And the cache miss is exactly one turn — the turn it first read true.
        const moved = plans.filter((plan) => plan.examplesLatched);
        expect(moved.length).toBe(1);
        expect(moved[0]).toBe(plans[stripped.indexOf(true)]);
    });

    it('goes back to false on a branch taken before the first summary', async () => {
        const run = harness();
        await run.turn(60);
        expect((await run.turn(60)).examplesStripped).toBe(true);

        expect((await run.turn(4)).examplesStripped).toBe(false);
    });

    it('is written straight into ST, and put back on a new chat', async () => {
        const run = harness();
        await run.turn(60);
        expect(run.context.powerUserSettings.strip_examples).toBe(true);

        run.assembler.reset();
        expect(run.context.powerUserSettings.strip_examples).toBe(false);
    });
});

describe('eviction under a cap the block cannot fit', () => {
    it('drops a batch once rather than a summary per turn', async () => {
        const run = harness({ cap: 6_000 });
        const evictions = [];

        for (let length = 31; length <= 200; length++) {
            const plan = await run.turn(length);
            if (plan.evicted) evictions.push({ at: length, count: plan.evicted });
        }

        expect(evictions.length).toBeGreaterThan(0);
        expect(evictions.every((event) => event.count > 1)).toBe(true);

        // Rebuilds are spaced by growth, not by turn: the floor buys back half a
        // cap, which is several see-saw steps of summaries.
        const gaps = evictions.slice(1).map((event, i) => event.at - evictions[i].at);
        expect(Math.min(...gaps)).toBeGreaterThan(30);
    });

    it('never lets the block exceed the cap it was given', async () => {
        const run = harness({ cap: 6_000 });

        for (let length = 31; length <= 200; length++) {
            const plan = await run.turn(length);
            expect(plan.tokens).toBeLessThanOrEqual(plan.cap);
        }
    });
});

/**
 * The deferral only holds while a rebuild buys back more room than a step
 * consumes. Under a cap barely wider than one step it does not, and every step
 * is a rebuild again — qvink's behaviour reached by a longer road, with nothing
 * on screen to say so. Hence a detector rather than a hope (CLAUDE.md §9.35).
 */
describe('detecting the two cadences collapsing back into one', () => {
    it('says so when the cap cannot hold a step past the floor', async () => {
        // Sized in units of `STEP`, because "barely wider than one step" is what
        // this test means and a step is `STEP` summaries wide (D-0068).
        const run = harness({ cap: 150 * STEP });
        const plans = [];
        for (let length = 31; length <= 70; length++) plans.push(await run.turn(length));

        expect(plans.at(-1).recoupled).toBe(true);

        // And the symptom it predicts is really there: the block rebuilds on the
        // see-saw's own cadence rather than many steps apart. This is the mirror
        // of the healthy case below, which spaces its evictions more than 30
        // turns out.
        const evictions = plans
            .map((plan, at) => ({ at, evicted: plan.evicted }))
            .filter((event) => event.evicted);
        expect(evictions.length).toBeGreaterThan(2);
        const gaps = evictions.slice(1).map((event, i) => event.at - evictions[i].at);
        expect(Math.max(...gaps)).toBeLessThan(30);
    });

    it('stays quiet on a cap several steps wide', async () => {
        const run = harness({ cap: 6_000 });
        const plans = [];
        for (let length = 31; length <= 200; length++) plans.push(await run.turn(length));

        expect(plans.some((plan) => plan.recoupled)).toBe(false);
        expect(plans.at(-1).slack).toBeGreaterThan(plans.at(-1).stepTokens);
    });
});

describe('the block is Cairn\'s own, not a mirror of qvink', () => {
    it('ignores qvink\'s template, separator, prefill and position settings', async () => {
        const run = handedOver(harness({
            settings: makeQvinkSettings({
                short_template: '[Recap]\n{{memories}}',
                summary_injection_separator: '\n- ',
                show_prefill: true,
                short_term_position: 1,
                short_term_depth: 16,
                short_term_role: 1,
            }),
        }));

        const plan = await run.write();

        expect(plan.writing).toBe(true);
        expect(plan.text.startsWith('[Following is a list of recent events]:\n\n* Scene 0: ')).toBe(true);
        expect(plan.text).not.toContain('Summary: ');
        expect(plan.placement).toEqual(BLOCK_PLACEMENT);
    });

    it('parks the block where ST collects it, since writing is also blanking (D-0029)', () => {
        const context = createContext({ chat: [] });
        const { position, depth, scan, role } = BLOCK_PLACEMENT;
        context.setExtensionPrompt('cairn_memory', 'block', position, depth, scan, role);

        expect(position).toBe(extension_prompt_types.IN_PROMPT);
        expect(collectedKeys(context.extensionPrompts)).toEqual(['cairn_memory']);
    });
});

describe('branches, swipes and new chats', () => {
    it('follows the chat back when a branch shortens it', async () => {
        const run = harness();
        await run.turn(61);
        expect((await run.turn(61)).newest).toBe(threshold(61));

        const branched = await run.turn(36);

        expect(branched.summarisedThrough).toBe(threshold(36));
        expect(branched.newest).toBe(threshold(36));
        expect(branched.stepReason).toBe('rollback');
    });

    it('starts from nothing on a new chat', async () => {
        const run = harness();
        await run.turn(61);
        run.assembler.reset();

        const first = await run.turn(31);

        expect(first.stepReason).toBe('first-turn');
        expect(first.change.stabilityPercent).toBeNull();
        expect(first.oldest).toBe(0);
    });
});

describe('what the plan reports', () => {
    it('never carries the block text, only its size', async () => {
        const plan = await harness().turn(41);
        const serialised = JSON.stringify(plan);

        // The plan is written to disk with the snapshot. The chat body is not
        // ours to put there (src/prompt/locate.js makes the same promise).
        expect(serialised).not.toContain('Scene 0:');
        expect(plan.chars).toBeGreaterThan(0);
        expect(plan.tokens).toBeGreaterThan(0);
    });

    it('names who wrote the summaries in the block', async () => {
        const qvinkOnly = harness();
        qvinkOnly.context.chat = makeMixedChat({ length: 61, qvinkThrough: 59, cairnThrough: 59 });
        const cairnOnly = harness();
        // qvink's summaries end before the block's reach, so every scene in it is Cairn's.
        cairnOnly.context.chat = makeMixedChat({ length: 61, qvinkThrough: -1, cairnThrough: 59 });

        expect(await qvinkOnly.plan()).toMatchObject({ source: 'qvink', cairnScenes: 0 });
        expect(await cairnOnly.plan()).toMatchObject({ source: 'cairn', cairnScenes: 60 });
    });

    it('reports an empty plan rather than throwing on a chat with no summaries', async () => {
        const run = harness();
        run.context.chat = [{ name: 'Wren', is_user: true, mes: 'hello', extra: {} }];

        const plan = await run.plan();

        expect(plan).toMatchObject({ scenes: 0, included: 0, chars: 0, tokens: 0, oldest: null });
    });
});

/**
 * P1 step 3 — who writes (docs/decisions.md D-0020, D-0027).
 *
 * The assembler decides; prompt/injector.js acts. What matters here is that the
 * decision is made from the live state of the other extension every turn, and
 * from whether it runs at all rather than from settings it left behind.
 */
describe('handing the injection over', () => {
    it('plans but does not write while qvink is still injecting', async () => {
        const run = harness();
        run.assembler.setOwnEnabled(true);
        const chat = makeQvinkChat({ length: 40, summarisedThrough: 29 });
        run.context.chat = chat;
        run.context.setExtensionPrompt(
            'qvink_memory_short', asQvinkWouldRender(readScenes(chat)), 0, 2,
        );

        const plan = await run.plan();

        expect(plan.writing).toBe(false);
        expect(plan.handover).toBe('qvink-injecting');
        // ...and the block is still fully planned, which is what makes the switch
        // a switch rather than a rebuild.
        expect(plan.included).toBeGreaterThan(0);
    });

    it('writes once qvink is silent', async () => {
        const run = handedOver(harness());

        const plan = await run.write();

        expect(plan.writing).toBe(true);
        expect(plan.report.handover).toBe('writing');
        expect(plan.text).toContain('Scene 0:');
        expect(plan.placement).toEqual({ position: 0, depth: 2, role: 0, scan: false });
    });

    it('will not write while qvink is still taking messages out of the history', async () => {
        const run = handedOver(harness());
        run.context.extensionSettings.qvink_memory.exclude_messages_after_threshold = true;

        expect((await run.plan()).handover).toBe('qvink-excluding');
    });

    it('writes with qvink uninstalled, whatever its saved settings still say', async () => {
        // ST keeps an extension's settings after it is removed. They describe
        // nothing that runs, so they must not hold the gate shut.
        const run = harness({ qvink: false, settings: makeQvinkSettings({ exclude_messages_after_threshold: true }) });
        run.assembler.setOwnEnabled(true);
        run.context.chat = makeQvinkChat({ length: 40, summarisedThrough: 29 });

        expect(await run.plan()).toMatchObject({ writing: true, handover: 'writing' });
    });

    it('writes with qvink disabled, whatever its saved settings still say', async () => {
        // A disabled extension is never loaded (public/scripts/extensions.js:626).
        const run = harness({ settings: makeQvinkSettings({ exclude_messages_after_threshold: true }) });
        run.context.extensionSettings.disabledExtensions.push(QVINK_EXTENSION);
        run.assembler.setOwnEnabled(true);
        run.context.chat = makeQvinkChat({ length: 40, summarisedThrough: 29 });

        expect(await run.plan()).toMatchObject({ writing: true, handover: 'writing' });
    });

    it('writes on the first turn of a new chat, with nothing to earn first', async () => {
        // A disabled qvink parks no block, so a gate that waited to compare
        // against one never opened after a reload.
        const run = handedOver(harness());
        run.assembler.reset();
        delete run.context.extensionPrompts.qvink_memory_short;

        expect(await run.plan()).toMatchObject({ writing: true, stepReason: 'first-turn' });
    });

    it('holds back every message the block speaks for, evicted ones included', async () => {
        const run = handedOver(harness({ cap: 6_000 }), { length: 40 });
        run.context.chat = makeQvinkChat({ length: 200, summarisedThrough: 189 });

        const plan = await run.write();

        expect(plan.report.evicted).toBeGreaterThan(0);
        // The block dropped the oldest summaries; their messages stay out of the
        // history all the same. Putting that prose back would cost many times
        // what the summary did.
        expect(plan.blank).toContain(0);
        expect(plan.blank.length).toBeGreaterThan(plan.report.included);
        expect(plan.blank.at(-1)).toBe(plan.report.summarisedThrough);
    });

    it('places the block where it always does, whatever position qvink names', async () => {
        // Mirroring qvink's "Macro Only" once parked our block at NONE while 92
        // messages were blanked (docs/decisions.md D-0029).
        const run = handedOver(harness());

        for (const position of [-1, 0, 1, 2, -7, undefined, 'nonsense']) {
            run.context.extensionSettings.qvink_memory.short_term_position = position;
            const plan = await run.write();

            expect(plan.writing).toBe(true);
            expect(plan.placement).toEqual(BLOCK_PLACEMENT);
            expect(plan.blank.length).toBeGreaterThan(0);
        }
    });

    it('keeps the block out of the report and in the plan', async () => {
        const run = handedOver(harness());

        const plan = await run.write();

        expect(JSON.stringify(plan.report)).not.toContain('Scene 0:');
        expect(plan.text).toContain('Scene 0:');
    });
});

/**
 * The plan is a function of the chat (docs/decisions.md D-0033). Esin, 2026-09-16:
 * four turns of learned state — a measured budget, a projection, a stored split,
 * a calibrated ratio — each with its own cold start, and a reload took until turn
 * 4 to reach a stable prefix. The first turn of a session may rebuild; the second
 * must not.
 */
describe('the plan is a function of the chat', () => {
    it('picks the cache up on the second turn of a session, even after evicting', async () => {
        const run = harness({ cap: 6_000 });

        const first = await run.turn(200);
        const second = await run.turn(201);

        expect(first.stepReason).toBe('first-turn');
        expect(first.evicted).toBeGreaterThan(0);
        expect(second.stepped).toBe(false);
        expect(second.evicted).toBe(0);
        expect(second.change.stabilityPercent).toBe(100);
    });

    it('lands the first turn of a session at the floor, so the slack is bought up front', async () => {
        const first = await harness({ cap: 6_000 }).turn(200);

        expect(first.tokens).toBeLessThanOrEqual(first.floor);
        expect(first.overCap).toBe(true);
    });

    it('builds the same block from the same chat, whichever session asks', async () => {
        // A reload is a fresh assembler on the same chat: nothing carried over,
        // and nothing needed.
        const before = harness({ cap: 6_000 });
        const after = harness({ cap: 6_000 });
        const chat = makeQvinkChat({ length: 200, summarisedThrough: 189 });
        before.context.chat = chat;
        after.context.chat = chat;

        const a = await before.write();
        const b = await after.write();

        expect(b.text).toBe(a.text);
        expect(b.blank).toEqual(a.blank);
    });

    it('caps the block at 35% of the max prompt, whatever qvink\'s own limit says', async () => {
        // Esin's numbers: qvink's 7,500 tokens gave way to 35% of 22,016.
        const run = harness({
            maxPrompt: 22_016,
            settings: makeQvinkSettings({ short_term_context_limit: 7_500, short_term_context_type: 'tokens' }),
        });
        const plan = await run.turn(41);

        expect(plan).toMatchObject({ cap: 7_705, maxPromptTokens: 22_016 });
        expect(plan).not.toHaveProperty('capType');
    });

    it('does not let what else is in the prompt bend the cap', async () => {
        // The rest of the prompt is not an input. A budget read off the last
        // prompt is how the block went from 99% full to half in two turns.
        const run = harness({ cap: 6_000 });
        run.context.chat = makeQvinkChat({ length: 200, summarisedThrough: 189 });
        const before = await run.write();
        run.context.setExtensionPrompt('2_floating_prompt', 'x'.repeat(40_000), 1, 4);
        const after = await run.write();

        expect(after.report.cap).toBe(before.report.cap);
        expect(after.text).toBe(before.text);
    });

    it('has nothing to be told after a prompt goes out', () => {
        // The guard against the next feedback loop: an observe() is how it came in.
        expect(harness().assembler.observe).toBeUndefined();
    });
});

/**
 * P2's invariants on the plan (CLAUDE.md §3.10, docs/decisions.md D-0037). Cairn's scenes are
 * hand-written onto the chat here; nothing in these tests calls a model.
 */
describe('P2: a block read from qvink and Cairn together', () => {
    /** Independent of readScenes: the store's own hash, or a qvink summary with no Cairn store. */
    function hasValidScene(message) {
        const store = message?.extra?.cairn;
        if (store) return store.scene?.hash === hashString(message.mes);
        return typeof message?.extra?.qvink_memory?.memory === 'string' && message.extra.qvink_memory.memory !== '';
    }

    it('renders the qvink part byte-identically to P1, and appends Cairn after it', async () => {
        const run = harness();
        run.context.chat = makeMixedChat({ length: 61, qvinkThrough: 29, cairnThrough: 59 });

        const { text, report } = await run.write();

        const qvinkPart = [...Array(30).keys()].map((i) => ({ text: makeSummary(i) }));
        const cairnPart = [...Array(threshold(61) - 29).keys()].map((i) => ({ text: cairnSummary(30 + i) }));
        const p1 = asQvinkWouldRender(qvinkPart);
        expect(report).toMatchObject({ summarisedThrough: threshold(61), source: 'mixed', cairnScenes: 30 });
        expect(text).toBe(asQvinkWouldRender([...qvinkPart, ...cairnPart]));
        // Everything but the template's closing newline is a shared prefix.
        expect(text.startsWith(p1.slice(0, -1))).toBe(true);
    });

    it('holds the step while a summary is missing, and takes it once filled', async () => {
        const run = harness();
        run.context.chat = makeMixedChat({ length: 41, qvinkThrough: 19, cairnThrough: 39 });
        expect((await run.plan()).summarisedThrough).toBe(threshold(41));

        run.context.chat = makeMixedChat({ length: 51, qvinkThrough: 19, cairnThrough: 49, gaps: [35] });
        const held = await run.write();
        expect(held.report).toMatchObject({ summarisedThrough: threshold(41), stepReason: 'held', stepWaiting: true });
        expect(Math.max(...held.blank)).toBe(threshold(41));

        run.context.chat[35].extra.cairn = cairnStore(run.context.chat[35], cairnSummary(35));
        expect(await run.plan()).toMatchObject({ summarisedThrough: threshold(51), stepReason: 'step', stepWaiting: false });
    });

    it('is not held by a message too short or hidden to summarise', async () => {
        for (const skip of [{ short: [35] }, { hidden: [35] }]) {
            const run = harness();
            run.context.chat = makeMixedChat({ length: 41, qvinkThrough: 19, cairnThrough: 39 });
            await run.plan();

            run.context.chat = makeMixedChat({ length: 51, qvinkThrough: 19, cairnThrough: 49, ...skip });
            const plan = await run.write();

            expect(plan.report, JSON.stringify(skip)).toMatchObject({ summarisedThrough: threshold(51), stepReason: 'step' });
            expect(plan.blank).not.toContain(35);
        }
    });

    it('stops blanking an edited message and queues it again', async () => {
        const run = harness();
        run.context.chat = makeMixedChat({ length: 61, qvinkThrough: 19, cairnThrough: 59 });
        expect((await run.write()).blank).toContain(30);

        run.context.chat[30].mes += ' An afterthought.';
        const plan = await run.write();

        expect(plan.blank).not.toContain(30);
        expect(plan.text).not.toContain(cairnSummary(30));
        expect(pendingScenes(run.context.chat)).toContain(30);
    });

    it('keeps the scenes a branch kept, and blanks nothing past the cut', async () => {
        const run = harness();
        run.context.chat = makeMixedChat({ length: 61, qvinkThrough: 19, cairnThrough: 59 });
        await run.write();

        // A branch is a structuredClone of the chat up to the message
        // (public/scripts/bookmarks.js:173).
        run.context.chat = structuredClone(run.context.chat.slice(0, 36));
        const plan = await run.write();

        expect(plan.report.stepReason).toBe('rollback');
        expect(plan.blank.at(-1)).toBe(threshold(36));
        expect(plan.blank.every((i) => i < 36 && hasValidScene(run.context.chat[i]))).toBe(true);
        expect(plan.text).toContain(cairnSummary(threshold(36)));
    });

    /**
     * The property behind all of the above, over random play: whatever edits,
     * deletions, hides and branches happen, every message the plan blanks has a
     * valid scene standing in for it.
     */
    it('never blanks a message without a valid scene, across random chats', async () => {
        for (let seed = 1; seed <= 25; seed++) {
            const random = mulberry32(seed);
            const pick = (n) => Math.floor(random() * n);
            const run = harness({ seeSaw: createSeeSaw({ rawWindow: 6, step: 4 }) });
            run.context.chat = makeMixedChat({ length: 30, qvinkThrough: pick(20) - 1, cairnThrough: 28 });

            for (let turn = 0; turn < 60; turn++) {
                const chat = run.context.chat;
                const roll = random();
                if (roll < 0.45) {
                    const source = makeMixedChat({ length: chat.length + 1, qvinkThrough: -1, cairnThrough: -1 });
                    const message = source.at(-1);
                    delete message.extra.qvink_memory;
                    chat.push(message);
                    // The summariser catching up, most turns but not all.
                    const pending = pendingScenes(chat);
                    if (pending.length && random() < 0.8) {
                        chat[pending[0]].extra.cairn = cairnStore(chat[pending[0]], cairnSummary(pending[0]));
                    }
                } else if (roll < 0.65 && chat.length) {
                    chat[pick(chat.length)].mes += ` edit ${turn}.`;
                } else if (roll < 0.75 && chat.length) {
                    chat.splice(pick(chat.length), 1);
                } else if (roll < 0.82 && chat.length) {
                    chat[pick(chat.length)].is_system = true;
                } else if (roll < 0.9 && chat.length > 2) {
                    run.context.chat = structuredClone(chat.slice(0, 1 + pick(chat.length - 1)));
                }

                const plan = await run.write();
                const now = run.context.chat;
                for (const index of plan.blank) {
                    expect(index, `seed ${seed} turn ${turn}`).toBeLessThan(now.length);
                    expect(hasValidScene(now[index]), `seed ${seed} turn ${turn} index ${index}`).toBe(true);
                }
            }
        }
    });
});

/**
 * Where the cap comes from (docs/decisions.md D-0052). The block is planned
 * against a number worked out from the rest of the prompt, so these are the
 * tests that the number is a *function of the chat*: still between events,
 * unchanged by a reload, and cheap when it does move.
 */
describe('the cap the block is planned against', () => {
    /** Reserves under our hand, so a "card edit" is one line rather than a fixture. */
    function stubReserves(values) {
        const state = { card: 0, lore: 0, loreBound: 'none', window: 0, windowNow: 0, state: 0, ...values };
        return {
            read: async () => ({ ...state }),
            reset() {},
            set(next) {
                Object.assign(state, next);
            },
        };
    }

    /** A chat with real-length messages and a summary on every one. */
    function corpusChat(length) {
        return makeQvinkChat({ length, summarisedThrough: length });
    }

    it('is what the chat leaves once the rest of the prompt is reserved', async () => {
        const reserves = stubReserves({ card: 4_500, lore: 5_000, loreBound: 'books', window: 7_968, state: 330 });
        const run = harness({ maxPrompt: 23_040, reserves });
        run.context.chat = corpusChat(40);

        const report = await run.plan();

        expect(report.cap).toBe(4_090);
        expect(report.budget).toMatchObject({
            limitedBy: 'room', share: 8_063, room: 4_090, margin: 1_152,
            card: 4_500, lore: 5_000, loreBound: 'books', window: 7_968, state: 330,
        });
    });

    it('keeps the fixed share when the chat leaves that much room', async () => {
        const reserves = stubReserves({ card: 500, window: 800 });
        const run = harness({ maxPrompt: 23_040, reserves });
        run.context.chat = corpusChat(40);

        const report = await run.plan();

        expect(report.cap).toBe(8_063);
        expect(report.budget.limitedBy).toBe('share');
    });

    it('falls back to the fixed share when the reserves cannot be read', async () => {
        const run = harness({ maxPrompt: 23_040, reserves: NO_RESERVES });
        run.context.chat = corpusChat(40);

        const report = await run.plan();

        expect(report.cap).toBe(8_063);
        expect(report.budget).toMatchObject({ limitedBy: 'unknown', card: null, lore: null });
    });

    /**
     * D-0033, mechanically. The observer reports what a prompt cost and the
     * assembler is handed that report — this is the test that nothing flows the
     * other way.
     */
    it('is unmoved by what the last prompt turned out to cost', async () => {
        const reserves = stubReserves({ card: 4_500, lore: 5_000, window: 7_968, state: 330 });
        const run = harness({ maxPrompt: 23_040, reserves });
        run.context.chat = corpusChat(40);
        const first = await run.write();

        const observer = createObserver(() => run.context, { memory: () => run.assembler.latest });
        observer.start();
        for (const prompt of ['x'.repeat(400_000), '', 'y'.repeat(9)]) {
            await run.context.eventSource.emit(
                run.context.eventTypes.GENERATE_AFTER_COMBINE_PROMPTS, { prompt, dryRun: false },
            );
        }

        const again = await run.write();

        expect(again.report.cap).toBe(first.report.cap);
        expect(again.text).toBe(first.text);
    });

    it('is the same after a reload as before it', async () => {
        const reserves = stubReserves({ card: 4_500, lore: 5_000, window: 7_968, state: 330 });
        const before = harness({ maxPrompt: 23_040, reserves });
        before.context.chat = corpusChat(60);
        const first = await before.plan();

        // A reload is a new assembler, a new see-saw and a new budget on the same chat.
        const after = harness({ maxPrompt: 23_040, reserves });
        after.context.chat = corpusChat(60);

        expect((await after.plan()).cap).toBe(first.cap);
    });

    /**
     * A card or book edit, or a heavier run of messages, lowers the cap. The cost
     * has to be one rebuild at most, or the cap would be a second eviction
     * cadence on top of the budget's (docs/decisions.md D-0019).
     */
    it('costs one rebuild when it falls below the block, and nothing when it does not', async () => {
        const reserves = stubReserves({ card: 500, window: 800 });
        const run = harness({ maxPrompt: 16_000, reserves });
        run.context.chat = corpusChat(40);
        // The first turn is a rebuild whatever the cap is; measure from the second.
        await run.plan();
        const full = await run.write();
        expect(full.report.cap).toBe(5_600);
        expect(full.report.evicted).toBe(0);

        // A book edit that takes the cap down, but not past the block.
        reserves.set({ lore: 9_000 });
        const easy = await run.write();
        expect(easy.report.cap).toBeLessThan(full.report.cap);
        expect(easy.report.cap).toBeGreaterThan(easy.report.tokens);
        expect(easy.report.evicted).toBe(0);
        expect(easy.text).toBe(full.text);

        // And a heavier run of messages that takes it below the block: one
        // rebuild, to the new floor.
        reserves.set({ lore: 9_000, window: 8_000 });
        const hard = await run.write();
        expect(hard.report.budget.limitedBy).toBe('starved');
        expect(hard.report.evicted).toBeGreaterThan(0);
        expect(hard.report.tokens).toBeLessThanOrEqual(hard.report.floor);

        // ...and only one. The turn after it is byte-identical.
        expect((await run.write()).text).toBe(hard.text);
    });

    /** A rise is free, and never re-admits what the mark has already passed. */
    it('costs nothing when it rises, and does not bring evicted summaries back', async () => {
        const reserves = stubReserves({ card: 500, lore: 9_000, window: 8_000 });
        const run = harness({ maxPrompt: 16_000, reserves });
        run.context.chat = corpusChat(40);
        const evicting = await run.write();
        expect(evicting.report.evicted).toBeGreaterThan(0);

        reserves.set({ lore: 0, window: 800 });
        const risen = await run.write();

        expect(risen.report.cap).toBeGreaterThan(evicting.report.cap);
        expect(risen.report.evicted).toBe(0);
        expect(risen.text).toBe(evicting.text);
        expect(risen.report.oldest).toBe(evicting.report.oldest);
    });

    /**
     * The P6 gate (DESIGN.md §13): the cap has to hold still between events. Over
     * a 200-message chat with corpus-sized messages, the only turns it may move on
     * are the ones that write a heavier 19-message run — and after the early
     * turns those become rare.
     */
    it('holds still across a 200-message chat but for a heavier run of messages', async () => {
        const context = createContext({ chat: [], extensions: [QVINK_EXTENSION] });
        context.extensionSettings.qvink_memory = makeQvinkSettings();
        const worldInfo = makeWorldInfoModule({ entries: makeBook(), budget: 25 });
        const reserves = createReserves(() => context, { load: async () => worldInfo, scope: {} });
        const assembler = createAssembler(() => context, {
            reserves, maxPromptTokens: async () => 23_040,
        });

        const random = mulberry32(0x0652);
        const whole = corpusChat(200);
        // Corpus-shaped spread: a median around 300 tokens, with heavy replies.
        for (const message of whole) message.mes = 'x'.repeat(Math.round((180 + random() * 420) * 4));

        const sizes = whole.map((message) => Math.ceil(message.mes.length / 4));
        const moved = [];
        let previousCap = null;
        let previousRun = -1;

        for (let length = 1; length <= whole.length; length++) {
            context.chat = whole.slice(0, length);
            const { cap } = await assembler.plan().then((plan) => plan.report);
            const run = heaviestRun(sizes.slice(0, length), 19);

            if (cap !== previousCap) moved.push({ length, heavier: run > previousRun });
            previousCap = cap;
            previousRun = run;
        }

        // Every move is a turn that wrote a heavier run; no move happens otherwise.
        expect(moved.every((turn) => turn.heavier)).toBe(true);
        // And once the window is full they are rare: most of them are the first
        // nineteen turns, where each message added is itself a heavier run.
        expect(moved.filter((turn) => turn.length > 19).length).toBeLessThan(15);
    });
});

/**
 * P4: canon at the block's head (docs/p4-plan.md decisions 3, 4 and 5). The
 * invariants here are the ones that are invisible in play (CLAUDE.md §3.10):
 * whether the block still reads byte-identically without canon, and whether canon
 * only ever enters on a turn that was rebuilding anyway.
 */
describe('canon at the head of the block', () => {
    /** A chat with summaries, plus canon batches at the given message indexes. */
    function withCanon(run, length, batches) {
        run.context.chat = makeQvinkChat({ length, summarisedThrough: length - 11 });
        for (const [index, facts, covers] of batches) {
            run.context.chat[index].extra.cairn = cairnCanonStore(facts, covers);
        }
        return run;
    }

    it('renders today\'s bytes exactly for a chat that has never had a pass', async () => {
        const run = harness({ cap: 6_000 });
        run.context.chat = makeQvinkChat({ length: 40, summarisedThrough: 29 });
        const { report, text } = await run.write();

        expect(text).toBe(asQvinkWouldRender(readScenes(run.context.chat).slice(0, threshold(40) + 1)));
        expect(text).not.toContain('[Established facts]');
        expect(report.canonFacts).toBe(0);
        expect(report.canonAdmitted).toBe(0);
        expect(report.canonTokens).toBe(0);
    });

    it('puts the facts above the summaries, in their own section', async () => {
        const run = harness({ cap: 6_000 });
        withCanon(run, 40, [[5, ['Her brother is dead.', 'They kissed at the lighthouse.'], [0, 5]]]);
        const { text } = await run.write();

        expect(text).toMatch(/^\[Established facts\]:\n\n\* Her brother is dead\.\n\* They kissed at the lighthouse\.\n\n\[Following is a list of recent events\]:/);
    });

    /**
     * Decision 3, and the check §5's run reads: a batch written between rebuilds
     * changes nothing, and the rebuild turn admits it. Canon moving on any other
     * turn would change bytes above every summary and break the whole block.
     */
    it('admits a new batch only on a turn that was rebuilding anyway', async () => {
        const run = harness({ cap: 6_000 });
        const plans = [];
        let written = false;

        for (let length = 31; length <= 200; length++) {
            run.context.chat = makeQvinkChat({ length, summarisedThrough: length - 11 });
            // One batch from the start, and a second written mid-run, well before
            // any rebuild is due.
            run.context.chat[5].extra.cairn = cairnCanonStore(['Her brother is dead.'], [0, 5]);
            if (length >= 60) written = true;
            if (written) run.context.chat[9].extra.cairn = cairnCanonStore(['Aster owns a green boat.'], [6, 9]);
            plans.push({ length, ...(await run.plan()) });
        }

        const moved = plans.filter((plan, i) => i > 0 && plan.canonAdmitted !== plans[i - 1].canonAdmitted);
        expect(moved.length).toBeGreaterThan(0);
        for (const plan of moved) {
            expect(plan.evicted > 0 || plan.stepReason === 'first-turn', `turn ${plan.length}`).toBe(true);
        }
        // And it did land: the second batch is in the block by the end.
        expect(plans.at(-1).canonAdmitted).toBe(2);
    });

    /**
     * The same invariant under a *moving* cap, which is what the P4 run hit
     * (docs/decisions.md D-0059). `canonCap`'s guard is `cap - 2 * stepTokens`, so
     * summaries that lengthen as a chat runs drag the cap down twice as fast — and
     * a cap applied live re-trims the block's head on ordinary turns. The fixture
     * above cannot catch it: uniform summaries hold `stepTokens` still.
     */
    it('holds the admitted set when a lengthening chat drags the canon cap down', async () => {
        // Esin's proportions: a ~2.4k block where one see-saw step costs about half
        // of it, which is where the guard takes over from the share.
        const run = harness({ cap: 2_500 });
        const plans = [];

        for (let length = 31; length <= 200; length++) {
            // Summaries lengthen as the chat runs, which is what moved `stepTokens`
            // on Esin (1,031 to 1,193 against a 2,440 cap). 353 is the mock's
            // default and MAX_SUMMARY_CHARS is 1_500, so this stays in range.
            const chars = 340 + Math.round((length - 31) * 1.1);
            run.context.chat = makeQvinkChat({ length, summarisedThrough: length - 11, chars });
            run.context.chat[5].extra.cairn = cairnCanonStore(
                ['Her brother is dead.', 'Aster owns a green boat.', 'The lamp in the hall is broken.'],
                [0, 5],
            );
            plans.push({ length, ...(await run.plan()) });
        }

        // The fixture has to actually move the cap, or it proves nothing.
        const caps = plans.map((plan) => plan.canonCap);
        expect(Math.min(...caps), 'the cap never fell — fixture is too gentle').toBeLessThan(caps[0]);

        const moved = plans.filter((plan, i) => i > 0 && plan.canonAdmitted !== plans[i - 1].canonAdmitted);
        for (const plan of moved) {
            expect(plan.evicted > 0 || plan.stepReason === 'first-turn', `turn ${plan.length}`).toBe(true);
        }

        // What the freeze costs: canon may sit above the live cap between rebuilds.
        // It may never sit above the one its rebuild froze, and the block as a whole
        // may never exceed its cap — that one is not negotiable, it is the prompt.
        // Canon's own see-saw guarantee has its own test below.
        for (const plan of plans) {
            expect(plan.canonTokens, `turn ${plan.length}`).toBeLessThanOrEqual(plan.canonCapApplied);
            expect(plan.tokens, `turn ${plan.length}`).toBeLessThanOrEqual(plan.cap);
        }
    });

    it('holds the canon text byte-identical between rebuilds', async () => {
        const run = harness({ cap: 6_000 });
        const heads = [];

        for (let length = 31; length <= 80; length++) {
            run.context.chat = makeQvinkChat({ length, summarisedThrough: length - 11 });
            run.context.chat[5].extra.cairn = cairnCanonStore(['Her brother is dead.'], [0, 5]);
            run.context.chat[9].extra.cairn = cairnCanonStore(['Aster owns a green boat.'], [6, 9]);
            const { report, text } = await run.write();
            if (!report.evicted && report.stepReason !== 'first-turn') {
                heads.push(text.slice(0, text.indexOf('[Following')));
            }
        }

        expect(new Set(heads).size).toBe(1);
    });

    it('admits everything on the first turn of a session, so a reload catches up', async () => {
        const fresh = () => {
            const run = harness({ cap: 6_000 });
            run.context.chat = makeQvinkChat({ length: 60, summarisedThrough: 49 });
            run.context.chat[5].extra.cairn = cairnCanonStore(['One.'], [0, 5]);
            run.context.chat[9].extra.cairn = cairnCanonStore(['Two.'], [6, 9]);
            return run;
        };

        expect((await fresh().plan()).canonAdmitted).toBe(2);
    });

    it('rolls a branch back with no rollback code', async () => {
        const run = harness({ cap: 6_000 });
        withCanon(run, 60, [[5, ['One.'], [0, 5]], [49, ['Two.'], [6, 49]]]);
        expect((await run.plan()).canonAdmitted).toBe(2);

        // A branch takes the chat back past the second batch's message.
        run.context.chat = run.context.chat.slice(0, 40);
        expect((await run.plan()).canonAdmitted).toBe(1);
    });

    it('never lets the whole block exceed the cap, canon included', async () => {
        const run = harness({ cap: 6_000 });
        const facts = Array.from({ length: 40 }, (_, i) => `Durable fact number ${i + 1}, stated plainly and at some length.`);

        for (let length = 31; length <= 200; length++) {
            run.context.chat = makeQvinkChat({ length, summarisedThrough: length - 11 });
            run.context.chat[5].extra.cairn = cairnCanonStore(facts, [0, 5]);
            const plan = await run.plan();

            expect(plan.tokens, `turn ${length}`).toBeLessThanOrEqual(plan.cap);
            expect(plan.canonTokens, `turn ${length}`).toBeLessThanOrEqual(plan.canonCap);
        }
    });

    /** Decision 5's guard, end to end: canon must never recouple the see-saw. */
    it('is squeezed out before the two cadences collapse', async () => {
        const run = harness({ cap: 6_000 });
        const facts = Array.from({ length: 60 }, (_, i) => `Durable fact number ${i + 1}, stated plainly and at some length.`);

        for (let length = 31; length <= 200; length++) {
            run.context.chat = makeQvinkChat({ length, summarisedThrough: length - 11 });
            run.context.chat[5].extra.cairn = cairnCanonStore(facts, [0, 5]);
            const plan = await run.plan();

            expect(plan.recoupled, `turn ${length}`).toBe(false);
            expect(plan.sceneCap, `turn ${length}`).toBeGreaterThanOrEqual(2 * plan.stepTokens);
        }
    });

    it('leaves the block alone when the setting is off', async () => {
        const context = createContext({ chat: [], extensions: [QVINK_EXTENSION] });
        context.extensionSettings.qvink_memory = makeQvinkSettings();
        const assembler = createAssembler(() => context, {
            reserves: NO_RESERVES,
            maxPromptTokens: async () => Math.ceil(6_000 / CAP_FRACTION),
            settings: () => ({ keepCanon: false }),
        });
        context.chat = makeQvinkChat({ length: 40, summarisedThrough: 29 });
        context.chat[5].extra.cairn = cairnCanonStore(['Her brother is dead.'], [0, 5]);

        const { report, text } = await assembler.plan();

        expect(text).toBe(asQvinkWouldRender(readScenes(context.chat).slice(0, threshold(40) + 1)));
        expect(report.canonFacts).toBe(0);
        expect(report.canonAdmitted).toBe(0);
    });
});

/**
 * The rebuild turn, named in the report (docs/decisions.md D-0067).
 *
 * Everything discontinuous batches onto the turn the block's head is moving
 * anyway — canon admission, the examples latch, and the World Info holder's trim
 * (D-0069). Each of those reads this flag, so a flag that is true on an ordinary
 * turn spends a prefix break nobody asked for, and the block looks perfectly
 * correct the whole time.
 */
describe('the rebuild turn', () => {
    it('is the first turn of a session, and the turns that evict', async () => {
        const run = harness({ cap: 6_000 });

        const first = await run.turn(200);
        const held = await run.turn(201);

        expect(first.stepReason).toBe('first-turn');
        expect(first.rebuilt).toBe(true);
        expect(held.evicted).toBe(0);
        expect(held.rebuilt).toBe(false);
    });

    it('is false on every turn that neither evicts nor starts a session', async () => {
        const run = harness({ cap: 1_000_000 });
        const reports = [];
        for (let length = 20; length <= 60; length++) reports.push(await run.turn(length));

        // A cap nothing can reach: one rebuild at the start and none after it.
        expect(reports.filter((report) => report.rebuilt)).toHaveLength(1);
        expect(reports[0].rebuilt).toBe(true);
    });

    it('agrees with the eviction it is derived from, over a whole run', async () => {
        const run = harness({ cap: 6_000 });
        const reports = [];
        for (let length = 20; length <= 120; length++) reports.push(await run.turn(length));

        for (const report of reports) {
            expect(report.rebuilt).toBe(report.evicted > 0 || report.stepReason === 'first-turn');
        }
        // Or the equivalence above holds over a run with only one kind of turn in it.
        expect(reports.some((report) => report.rebuilt)).toBe(true);
        expect(reports.some((report) => !report.rebuilt)).toBe(true);
    });
});

/**
 * The block's two fidelities (docs/decisions.md D-0075, D-0076). Distant summaries are
 * demoted to the one-sentence line on their index record instead of being evicted, so the
 * held horizon roughly doubles. The invariants that matter are that a demotion lands only
 * on a turn that was already rewriting the block's head, and that the tail's share is
 * never held back from full summaries when there are no lines to put in it.
 */
describe('the compact tier', () => {
    /** The same chat, with a record — and optionally a line — on every Cairn summary. */
    function withRecords(chat, { lines = true, from = 0 } = {}) {
        chat.forEach((message, index) => {
            const text = message.extra?.cairn?.scene?.text;
            if (!text) return;
            const line = lines && index >= from ? `Wren settled matter ${index} before the tide turned.` : '';
            message.extra.cairn = cairnIndexStore(message, text, { line });
        });
        return chat;
    }

    /** One run over a growing chat, every summary Cairn's. `prepare` adds the records. */
    async function run(prepare, { cap = 3_000, from = 31, to = 120 } = {}) {
        const harnessed = harness({ cap });
        const plans = [];
        for (let length = from; length <= to; length++) {
            harnessed.context.chat = prepare(makeMixedChat({
                length, qvinkThrough: -1, cairnThrough: length - 11,
            }));
            plans.push(await harnessed.plan());
        }
        return plans;
    }

    it('keeps the whole scene budget for full summaries while no line exists', async () => {
        // The failure this guards: a sixth of the budget reserved for a tail that cannot be
        // filled, which is D-0068's card-and-examples disagreement in a second place.
        const plans = await run((chat) => withRecords(chat, { lines: false }));
        const last = plans.at(-1);

        expect(last.blockCompact).toBe(0);
        expect(last.compactCap).toBe(0);
        expect(last.fullCap).toBe(last.sceneCap);
        expect(plans.every((plan) => plan.demoted === 0)).toBe(true);
    });

    it('demotes instead of evicting, and holds more summaries for it', async () => {
        const without = await run((chat) => withRecords(chat, { lines: false }));
        const with_ = await run((chat) => withRecords(chat));

        expect(with_.at(-1).blockCompact).toBeGreaterThan(0);
        expect(with_.at(-1).blockFull).toBeGreaterThan(0);
        expect(with_.at(-1).included).toBe(with_.at(-1).blockFull + with_.at(-1).blockCompact);
        // The whole point of the tier, stated as a number.
        expect(with_.at(-1).included).toBeGreaterThan(without.at(-1).included);
        // And the oldest summary the block speaks for is older than it was.
        expect(with_.at(-1).oldest).toBeLessThan(without.at(-1).oldest);
    });

    it('demotes only on a turn that was already rewriting the head', async () => {
        // The tier's one real hazard: a split that moved mid-cycle would demote on an
        // ordinary turn, which rewrites the block's head and breaks the prefix for nothing.
        const plans = await run((chat) => withRecords(chat));

        expect(plans.some((plan) => plan.demoted > 0)).toBe(true);
        for (const plan of plans) {
            if (plan.demoted > 0) expect(plan.rebuilt).toBe(true);
        }
    });

    it('renders one document, compact lines first', async () => {
        const harnessed = harness({ cap: 3_000 });
        harnessed.context.chat = withRecords(makeMixedChat({ length: 120, qvinkThrough: -1, cairnThrough: 109 }));
        // Two turns: the first one's rebuild is what demotes.
        await harnessed.plan();
        const plan = await harnessed.plan();

        const { text } = await harnessed.write();
        const firstLine = text.indexOf('before the tide turned.');
        const firstFull = text.indexOf('Cairn ');
        expect(plan.blockCompact).toBeGreaterThan(0);
        expect(firstLine).toBeGreaterThanOrEqual(0);
        expect(firstFull).toBeGreaterThan(firstLine);
    });

    it('evicts a summary with no line exactly as it does today, and counts it', async () => {
        // Half the chat indexed, the older half not: the tail cannot hold what has no line,
        // so those summaries evict as they do today and the count says why. Once the block
        // has moved past the unindexed span the count falls back to zero on its own, which
        // is why this reads the whole run rather than its last turn.
        const plans = await run((chat) => withRecords(chat, { from: 60 }));
        const missed = plans.filter((plan) => plan.compactMissing > 0);

        expect(missed.length).toBeGreaterThan(0);
        for (const plan of missed) expect(plan.included).toBe(plan.blockFull + plan.blockCompact);
        // And the tier still works for the half that does have lines.
        expect(plans.at(-1).blockCompact).toBeGreaterThan(0);
        expect(plans.at(-1).compactMissing).toBe(0);
    });
});
