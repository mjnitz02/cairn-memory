import { describe, expect, it } from 'vitest';
import { BLOCK_PLACEMENT, BLOCK_RENDERING, blockChars, createAssembler, renderBlock } from '../src/prompt/assembler.js';
import { QVINK_EXTENSION, readScenes } from '../src/memory/scenes.js';
import { CAP_FRACTION, createBudget } from '../src/pipeline/budgeter.js';
import { createSeeSaw } from '../src/pipeline/scheduler.js';
import { collectedKeys, createContext, extension_prompt_types } from './mocks/sillytavern.js';
import { makeQvinkChat, makeQvinkSettings, makeSummary } from './mocks/qvink.js';
import { cairnStore, cairnSummary, makeMixedChat } from './mocks/cairn.js';
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
 * `cap` is sugar for the max prompt that gives it: the cap is a fixed share of the
 * max prompt (docs/decisions.md D-0038), and rounding up keeps it exact.
 */
function harness({
    seeSaw = createSeeSaw(),
    budget = createBudget(),
    cap = 1_000_000,
    maxPrompt = Math.ceil(cap / CAP_FRACTION),
    settings = makeQvinkSettings(),
    qvink = true,
} = {}) {
    const context = createContext({ chat: [], extensions: qvink ? [QVINK_EXTENSION] : [] });
    context.extensionSettings.qvink_memory = settings;

    const assembler = createAssembler(() => context, {
        seeSaw,
        budget,
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

        for (let length = 32; length <= 40; length++) {
            const plan = await run.turn(length);
            expect(plan.stepped).toBe(false);
            expect(plan.change.stabilityPercent).toBe(100);
            expect(plan.change.divergenceAt).toBeNull();
        }
    });

    it('breaks at the very end of the block when it does step', async () => {
        const run = harness();
        await run.turn(31);
        for (let length = 32; length <= 40; length++) await run.turn(length);

        const step = await run.turn(41);

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
        const run = harness({ cap: 1_500 });
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
        expect((await run.turn(61)).newest).toBe(50);

        const branched = await run.turn(36);

        expect(branched.summarisedThrough).toBe(25);
        expect(branched.newest).toBe(25);
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
        const cairnPart = [...Array(21).keys()].map((i) => ({ text: cairnSummary(30 + i) }));
        const p1 = asQvinkWouldRender(qvinkPart);
        expect(report).toMatchObject({ summarisedThrough: 50, source: 'mixed', cairnScenes: 30 });
        expect(text).toBe(asQvinkWouldRender([...qvinkPart, ...cairnPart]));
        // Everything but the template's closing newline is a shared prefix.
        expect(text.startsWith(p1.slice(0, -1))).toBe(true);
    });

    it('holds the step while a summary is missing, and takes it once filled', async () => {
        const run = harness();
        run.context.chat = makeMixedChat({ length: 41, qvinkThrough: 19, cairnThrough: 39 });
        expect((await run.plan()).summarisedThrough).toBe(30);

        run.context.chat = makeMixedChat({ length: 51, qvinkThrough: 19, cairnThrough: 49, gaps: [35] });
        const held = await run.write();
        expect(held.report).toMatchObject({ summarisedThrough: 30, stepReason: 'held', stepWaiting: true });
        expect(Math.max(...held.blank)).toBe(30);

        run.context.chat[35].extra.cairn = cairnStore(run.context.chat[35], cairnSummary(35));
        expect(await run.plan()).toMatchObject({ summarisedThrough: 40, stepReason: 'step', stepWaiting: false });
    });

    it('is not held by a message too short or hidden to summarise', async () => {
        for (const skip of [{ short: [35] }, { hidden: [35] }]) {
            const run = harness();
            run.context.chat = makeMixedChat({ length: 41, qvinkThrough: 19, cairnThrough: 39 });
            await run.plan();

            run.context.chat = makeMixedChat({ length: 51, qvinkThrough: 19, cairnThrough: 49, ...skip });
            const plan = await run.write();

            expect(plan.report, JSON.stringify(skip)).toMatchObject({ summarisedThrough: 40, stepReason: 'step' });
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
        expect(plan.blank.at(-1)).toBe(25);
        expect(plan.blank.every((i) => i < 36 && hasValidScene(run.context.chat[i]))).toBe(true);
        expect(plan.text).toContain(cairnSummary(25));
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
