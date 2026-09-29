import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createSummarizer } from '../src/pipeline/summarizer.js';
import { IMPORTED_PROMPT, adoptionPlan } from '../src/pipeline/adopt.js';
import { pendingScenes, redoScenes } from '../src/memory/scenes.js';
import { INDEX_PROMPT } from '../src/memory/index-strategy.js';
import { canonFor } from '../src/memory/canon.js';
import { readCanon, readIndex, readScene } from '../src/store/chat-store.js';
import { adoptionMessage, adoptionRefusal, doneText, progressText } from '../src/ui/adopt-panel.js';
import { resetToasts } from '../src/util/log.js';
import { createRequestService, deferred } from './mocks/llm.js';
import { cairnCanonStore, cairnIndexStore, cairnSummary, makeMixedChat } from './mocks/cairn.js';
import { createContext } from './mocks/sillytavern.js';

/**
 * Adopting a chat (docs/decisions.md D-0090): Qvink's summaries imported, the rest
 * summarised, then the index and canon built a step at a time with the canon carried
 * forward — every write through the queue's own jobs.
 */

const MEMORY = { id: 'memory-profile', name: 'GLM (memory)' };
const ROLEPLAY = { id: 'roleplay-profile', name: 'Local (roleplay)' };
const SLOTS = 3;
const EVERY = 8;

/** Qvink summarised 0-17 and Cairn nothing, so 18 waits and 19 is the last message. */
const chat = () => makeMixedChat({ length: 20, qvinkThrough: 17, cairnThrough: -1 });

const summary = (index) => `Wren and Aster settled matter ${index} before the tide turned, and agreed to wait for the ferry.`;
const record = (n) => ({
    n, kind: 'filler', who: ['Wren'], what: `Wren settled matter ${n}`, changed: '', because: '', background: '',
    line: `Wren settled matter ${n} before the tide turned.`,
});
const indexReply = (count) => JSON.stringify({ records: Array.from({ length: count }, (_, i) => record(i + 1)) });
const canonReply = (step) => JSON.stringify({
    canon: Array.from({ length: SLOTS }, (_, i) => ({ fact: `Fact ${i + 1} as of step ${step}.`, entities: ['Wren'], from: [i + 1] })),
});

/** The replies an adoption of `chat()` asks for, in order: the summary, then an index and a pick per step. */
function replies(steps, sizes) {
    return [summary(18), ...Array.from({ length: steps }, (_, i) => [indexReply(sizes[i]), canonReply(i + 1)]).flat()];
}

function harness({ responses = [], settings = {}, live = chat(), onCall } = {}) {
    const service = createRequestService({ responses });
    const context = createContext({ chat: live, profiles: [MEMORY, ROLEPLAY], selectedProfile: ROLEPLAY.id, requestService: service });
    const summarizer = createSummarizer(() => context, {
        settings: () => ({ memoryProfileId: MEMORY.id, worldState: false, step: EVERY, canonSlots: SLOTS, ...settings }),
        memory: () => ({ writing: true }),
        onCall,
    });
    return { context, service, summarizer };
}

const isIndex = (call) => call.prompt[0].content.startsWith(INDEX_PROMPT.slice(0, 60));
const isPick = (call) => call.prompt[0].content.startsWith('You are choosing the permanent spine');

beforeEach(() => {
    vi.stubGlobal('toastr', { warning: vi.fn() });
    vi.spyOn(console, 'warn').mockImplementation(() => {});
});
afterEach(() => {
    resetToasts();
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
});

describe('what an adoption would do', () => {
    it('counts the imports, the summaries and the steps before making a call', () => {
        const live = chat();
        const plan = adoptionPlan(live, { every: EVERY, pending: pendingScenes(live) });

        expect(plan.imports.length).toBeGreaterThan(0);
        expect(plan.summaries).toBe(1);
        expect(plan.steps).toBe(Math.ceil((plan.imports.length + 1) / EVERY));
        expect(plan.calls).toBe(plan.summaries + 2 * plan.steps);
    });

    it('says it in the confirmation, and words a refusal as the panel does', () => {
        const text = adoptionMessage({ imports: [1, 2], summaries: 3, every: 8, steps: 2, calls: 7 });
        expect(text).toContain('<b>2</b> summaries from Qvink');
        expect(text).toContain('About <b>7</b> calls');
        expect(adoptionRefusal('qvink-summarising')).toBe('Cairn can\'t adopt this chat: Qvink\'s Auto Summarize is on.');
        expect(progressText({ phase: 'replay', step: 2, of: 3, through: 15 })).toContain('Step 2 of 3');
    });
});

describe('adopting a chat', () => {
    function expected() {
        const live = chat();
        const plan = adoptionPlan(live, { every: EVERY, pending: pendingScenes(live) });
        const total = plan.imports.length + plan.summaries;
        const sizes = Array.from({ length: plan.steps }, (_, i) => Math.min(EVERY, total - i * EVERY));
        return { plan, sizes };
    }

    it('imports, summarises, then indexes and picks a step at a time, carrying the canon forward', async () => {
        const { plan, sizes } = expected();
        const { context, service, summarizer } = harness({ responses: replies(plan.steps, sizes) });
        summarizer.start();

        const result = await summarizer.adopt();

        expect(result).toMatchObject({ ok: true, imported: plan.imports.length, summarised: 1, steps: plan.steps, cancelled: false });
        expect(service.calls).toHaveLength(plan.calls);
        for (const index of plan.imports) expect(readScene(context.chat[index]).scene.prompt).toBe(IMPORTED_PROMPT);
        // Every summary got its record, and each step's pick is stored as history.
        const summarised = context.chat.filter((message) => readScene(message).status === 'valid');
        expect(summarised.every((message) => readIndex(message).status === 'valid')).toBe(true);
        expect(context.chat.filter((message) => readCanon(message).status === 'valid')).toHaveLength(plan.steps);

        const picks = service.calls.filter(isPick).map((call) => call.prompt[0].content);
        expect(picks[0]).not.toContain('The canon as it stood');
        for (const later of picks.slice(1)) {
            expect(later).toContain('The canon as it stood before the newest rows were added');
            expect(later).toMatch(/- Fact 1 as of step \d\. \(rows 1\)/);
        }
        expect(canonFor(context.chat, { readCanon, readIndex }).facts[0].text).toBe(`Fact 1 as of step ${plan.steps}.`);
        expect(service.calls.filter(isIndex)).toHaveLength(plan.steps);
    });

    it('logs every call it makes, a failed one with its reason (D-0093)', async () => {
        const { plan } = expected();
        const size = plan.imports.length;
        const steps = Math.ceil(size / EVERY);
        const sizes = Array.from({ length: steps }, (_, i) => Math.min(EVERY, size - i * EVERY));
        const lines = [];
        const { service, summarizer } = harness({
            onCall: (entry) => lines.push(entry),
            responses: ['', ...Array.from({ length: steps }, (_, i) => [indexReply(sizes[i]), canonReply(i + 1)]).flat()],
        });
        summarizer.start();

        await summarizer.adopt();

        expect(lines).toHaveLength(service.calls.length);
        expect(lines.every((line) => line.kind === 'call' && line.during === 'adopt')).toBe(true);
        expect(lines[0]).toMatchObject({ job: 'summary', message: 18, outcome: 'failed', attempt: 1 });
        expect(lines[0].reason).toEqual(expect.any(String));
        expect(lines[0].ms).toEqual(expect.any(Number));
        expect(lines.slice(1).map((line) => line.job)).toEqual(Array.from({ length: steps }, () => ['index', 'canon']).flat());
        expect(lines.slice(1).every((line) => line.outcome === 'written')).toBe(true);
    });

    it('holds the queue while it runs, and lets it go when it is done', async () => {
        const { plan, sizes } = expected();
        const { service, summarizer } = harness({ responses: replies(plan.steps, sizes) });
        summarizer.start();

        const running = summarizer.adopt();
        expect(summarizer.adopting).toBe(true);
        await summarizer.drain('a reply');
        await running;

        expect(summarizer.adopting).toBe(false);
        expect(service.calls).toHaveLength(plan.calls);
    });

    it('stops between calls when cancelled, and keeps what it wrote', async () => {
        const first = deferred();
        const { context, service, summarizer } = harness({ responses: [first.promise] });
        summarizer.start();

        const running = summarizer.adopt();
        await new Promise((resolve) => setTimeout(resolve, 0));
        summarizer.cancelAdoption();
        first.resolve(summary(18));
        const result = await running;

        expect(result).toMatchObject({ ok: true, cancelled: true, steps: 0 });
        expect(service.calls).toHaveLength(1);
        expect(readScene(context.chat[18]).status).toBe('valid');
    });

    it('refuses while Qvink is still summarising, and while Cairn is off', () => {
        const { context, summarizer } = harness();
        expect(summarizer.adoptionPreview()).toEqual({ ok: false, reason: 'disabled' });
        summarizer.start();
        context.extensionSettings.disabledExtensions = [];
        context.extensionSettings.qvink_memory = { auto_summarize: true };
        context.extensionPrompts.qvink_memory_short = { value: '', position: -1 };
        expect(summarizer.adoptionPreview()).toEqual({ ok: false, reason: 'qvink-summarising' });
    });
});

/**
 * A redo (D-0092): an old chat carrying Qvink's summaries, then Cairn's with their index
 * records and an old canon pick — all of it done again, and none of the old canon carried.
 */
describe('redoing a chat from scratch', () => {
    const OLD_FACT = 'An old fact from a pick before the redo.';

    function redoChat() {
        const live = makeMixedChat({ length: 20, qvinkThrough: 9, cairnThrough: 17 });
        for (let index = 10; index <= 17; index++) {
            live[index].extra.cairn = cairnIndexStore(live[index], cairnSummary(index));
        }
        live[15].extra.cairn.canon = cairnCanonStore([{ text: OLD_FACT, from: [12] }], [10, 15]).canon;
        live[3].extra.qvink_memory.exclude = true;
        return live;
    }

    function expected(live) {
        const plan = adoptionPlan(live, { every: EVERY, pending: redoScenes(live), redo: true });
        const sizes = Array.from({ length: plan.steps }, (_, i) => Math.min(EVERY, plan.summaries - i * EVERY));
        const responses = [
            ...redoScenes(live).map(summary),
            ...Array.from({ length: plan.steps }, (_, i) => [indexReply(sizes[i]), canonReply(i + 1)]).flat(),
        ];
        return { plan, responses };
    }

    it('summarises every message but the last and any Qvink excluded, and imports nothing', () => {
        const live = redoChat();
        const redo = redoScenes(live);

        expect(redo).not.toContain(3);
        expect(redo).not.toContain(19);
        expect(redo).toEqual(expect.arrayContaining([0, 9, 10, 17, 18]));
        expect(adoptionPlan(live, { every: EVERY, pending: redo, redo: true })).toMatchObject({
            imports: [], summaries: redo.length, redo: true,
        });
    });

    it('replaces every summary, clears the old canon, and never carries it into a pick', async () => {
        const live = redoChat();
        const { plan, responses } = expected(live);
        const lines = [];
        const { context, service, summarizer } = harness({ live, responses, onCall: (entry) => lines.push(entry) });
        summarizer.start();

        expect(summarizer.adoptionPreview({ redo: true })).toMatchObject({ ok: true, redo: true, calls: plan.calls });
        const result = await summarizer.adopt({ redo: true });

        expect(result).toMatchObject({ ok: true, imported: 0, summarised: plan.summaries, steps: plan.steps, cancelled: false });
        expect(result.cleared).toBeGreaterThanOrEqual(8);
        expect(service.calls).toHaveLength(plan.calls);
        expect(lines).toHaveLength(plan.calls);
        expect(lines.every((line) => line.during === 'redo' && line.outcome === 'written')).toBe(true);
        for (const index of redoScenes(context.chat)) {
            expect(readScene(context.chat[index]).scene.text).toBe(summary(index));
            expect(readIndex(context.chat[index]).status).toBe('valid');
        }

        const picks = service.calls.filter(isPick).map((call) => call.prompt[0].content);
        expect(picks[0]).not.toContain('The canon as it stood');
        expect(picks.join('\n')).not.toContain(OLD_FACT);
        const batches = context.chat.map(readCanon).filter((read) => read.status === 'valid');
        expect(batches).toHaveLength(plan.steps);
        expect(batches.flatMap((read) => read.canon.facts).map((fact) => fact.text)).not.toContain(OLD_FACT);
    });

    it('says what it will do, and what it did', () => {
        const text = adoptionMessage({ redo: true, imports: [], summaries: 18, every: 8, steps: 3, calls: 24 });
        expect(text).toContain('all <b>18</b> messages again');
        expect(text).toContain('About <b>24</b> calls');
        expect(progressText({ phase: 'clear', cleared: 8 })).toBe('Cleared the index and canon from 8 messages.');
        expect(doneText({ cleared: 8, imported: 0, summarised: 18, steps: 3, cancelled: false }))
            .toBe('Done: 8 cleared, 18 summarised, 3 steps.');
    });
});
