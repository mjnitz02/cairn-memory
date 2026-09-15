import { describe, expect, it } from 'vitest';
import { blockChars, createAssembler, renderBlock } from '../src/prompt/assembler.js';
import { QVINK_DEFAULTS, readScenes, qvinkInjected } from '../src/memory/scenes.js';
import { createBudget } from '../src/pipeline/budgeter.js';
import { createSeeSaw } from '../src/pipeline/scheduler.js';
import { createContext } from './mocks/sillytavern.js';
import { makeQvinkChat, makeQvinkSettings } from './mocks/qvink.js';

const RENDERING = {
    template: QVINK_DEFAULTS.template,
    separator: QVINK_DEFAULTS.separator,
    macro: QVINK_DEFAULTS.macro,
};

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

function harness({
    seeSaw = createSeeSaw(),
    budget = createBudget(),
    maxPrompt = 1_000_000,
    settings = makeQvinkSettings(),
} = {}) {
    const context = createContext({ chat: [] });
    context.extensionSettings.qvink_memory = settings;

    const assembler = createAssembler(() => context, {
        seeSaw,
        budget,
        maxPromptTokens: async () => maxPrompt,
    });

    return {
        context,
        assembler,
        /** One observed generation on a chat of the given length. */
        turn(length, { promptTokens = 0 } = {}) {
            context.chat = makeQvinkChat({ length, summarisedThrough: length - 11 });
            return assembler.plan({ promptTokens });
        },
    };
}

describe('rendering the block', () => {
    it('leads each summary with the separator, oldest first', () => {
        const scenes = readScenes(makeQvinkChat({ length: 3 }));

        expect(renderBlock(scenes, RENDERING)).toBe(asQvinkWouldRender(scenes));
    });

    it('is nothing at all when there is nothing to say (qvink index.js:3965)', () => {
        expect(renderBlock([], RENDERING)).toBe('');
        expect(blockChars([], RENDERING)).toBe(0);
    });

    it('treats a summary containing $& as text, not as a substitution pattern', () => {
        const scenes = [{ text: 'She said $& and then $` happened.', chars: 33 }];

        expect(renderBlock(scenes, RENDERING)).toContain('$& and then $`');
    });

    it('sizes the block without building it', () => {
        for (const length of [1, 2, 7, 40]) {
            const scenes = readScenes(makeQvinkChat({ length }));
            expect(blockChars(scenes, RENDERING)).toBe(renderBlock(scenes, RENDERING).length);
        }
    });

    it('sizes a template with several macro slots the way it renders it', () => {
        const rendering = { ...RENDERING, template: 'A{{memories}}B{{MEMORIES}}C' };
        const scenes = readScenes(makeQvinkChat({ length: 3 }));

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
        const treatment = harness({ maxPrompt: 9_000 });
        const control = harness({
            // qvink's defaults, in our own code: advance the threshold on every
            // message (its index.js:138) and evict exactly enough to fit.
            seeSaw: createSeeSaw({ step: 0 }),
            budget: createBudget({ floorFraction: 1 }),
            maxPrompt: 9_000,
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
        const run = harness({ maxPrompt: 9_000 });
        const plans = [];
        for (let length = 31; length <= 160; length++) plans.push(await run.turn(length));

        const afterFirstEviction = plans.findIndex((plan) => plan.evicted) + 1;
        const later = plans.slice(afterFirstEviction).filter((plan) => plan.stepped);

        expect(later.length).toBeGreaterThan(2);
        expect(later.every((plan) => plan.change.divergencePercent > 99)).toBe(true);
    });
});

describe('eviction under a cap the block cannot fit', () => {
    it('drops a batch once rather than a summary per turn', async () => {
        const run = harness({ maxPrompt: 9_000 });
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
        const run = harness({ maxPrompt: 9_000 });

        for (let length = 31; length <= 200; length++) {
            const plan = await run.turn(length);
            expect(plan.tokens).toBeLessThanOrEqual(plan.cap);
        }
    });

    it('takes the rest of the prompt out of the cap', async () => {
        const run = harness({ maxPrompt: 10_000 });
        const plan = await run.turn(41, { promptTokens: 4_000 });

        // Nothing is injected in this harness, so the whole prompt is "everything
        // else" and the block has to fit in what is left.
        expect(plan.otherTokens).toBe(4_000);
        expect(plan.cap).toBe(6_000);
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
        const run = harness({ maxPrompt: 1_200 });
        const plans = [];
        for (let length = 31; length <= 70; length++) plans.push(await run.turn(length));

        expect(plans.at(-1).recoupled).toBe(true);
        // And the symptom it predicts is really there.
        const steps = plans.filter((plan) => plan.stepped).slice(1);
        expect(steps.every((plan) => plan.evicted > 0)).toBe(true);
    });

    it('stays quiet on a cap several steps wide', async () => {
        const run = harness({ maxPrompt: 9_000 });
        const plans = [];
        for (let length = 31; length <= 200; length++) plans.push(await run.turn(length));

        expect(plans.some((plan) => plan.recoupled)).toBe(false);
        expect(plans.at(-1).slack).toBeGreaterThan(plans.at(-1).stepTokens);
    });
});

describe('the fidelity check against qvink live block', () => {
    it('matches qvink own injection byte for byte', async () => {
        const run = harness();
        const chat = makeQvinkChat({ length: 40, summarisedThrough: 29 });
        const expected = asQvinkWouldRender(qvinkInjected(readScenes(chat)));

        run.context.chat = chat;
        run.context.setExtensionPrompt('qvink_memory_short', expected, 0, 2);
        const plan = await run.assembler.plan({ promptTokens: 0 });

        expect(plan.fidelity).toMatchObject({ compared: true, match: true, divergeAt: null });
        expect(plan.fidelity.liveChars).toBe(expected.length);
    });

    it('says where it diverges when qvink block is not what we would build', async () => {
        const run = harness();
        const chat = makeQvinkChat({ length: 40, summarisedThrough: 29 });
        const scenes = readScenes(chat);
        // qvink dropped one; we would not have.
        const theirs = asQvinkWouldRender(qvinkInjected(scenes).filter((s) => s.index !== 4));

        run.context.chat = chat;
        run.context.setExtensionPrompt('qvink_memory_short', theirs, 0, 2);
        const plan = await run.assembler.plan({ promptTokens: 0 });

        expect(plan.fidelity.match).toBe(false);
        expect(plan.fidelity.divergeAt).toBeGreaterThan(0);
    });

    it('flags a template carrying macros it cannot resolve', async () => {
        const run = harness({
            settings: makeQvinkSettings({ short_template: '{{char}} recalls:\n{{memories}}\n' }),
        });
        run.context.chat = makeQvinkChat({ length: 20, summarisedThrough: 9 });
        run.context.setExtensionPrompt('qvink_memory_short', 'Aster recalls:\n...', 0, 2);

        expect((await run.assembler.plan({})).fidelity.approximate).toBe(true);
    });

    it('does not claim a comparison when qvink is not injecting', async () => {
        const plan = await harness().turn(40);

        expect(plan.fidelity).toMatchObject({ compared: false, match: null });
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

    it('reports an empty plan rather than throwing on a chat with no summaries', async () => {
        const run = harness();
        run.context.chat = [{ name: 'Wren', is_user: true, mes: 'hello', extra: {} }];

        const plan = await run.assembler.plan({ promptTokens: 10 });

        expect(plan).toMatchObject({ scenes: 0, included: 0, chars: 0, tokens: 0, oldest: null });
    });
});
