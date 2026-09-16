import { beforeEach, describe, expect, it } from 'vitest';
import { createInjector } from '../src/prompt/injector.js';
import { createContext } from './mocks/sillytavern.js';
import { createWorldInfoEngine, makeBook } from './mocks/world-info.js';

/**
 * The turn-4 dropout, reproduced (docs/decisions.md D-0023).
 *
 * Nine turns on Esin: the same 29 entries every turn except turn 4, where the
 * two-message scan window seeded no recursion, the whole 4,232-token lore block
 * vanished, and turns 4 and 5 cost 14.9% and 11.4% prefix stability — two full
 * rebuilds, the worst event in the run.
 *
 * `SEEDED` mentions the one keyword the cascade starts from; `BARREN` is a
 * perfectly ordinary line of chat that happens to mention none of them.
 */
const SEEDED = 'Wren warms her hands at the hearth and says nothing.';
const BARREN = 'Wren nods, and lets the silence sit between them.';

function setup({ hold = true } = {}) {
    const context = createContext();
    const book = makeBook();
    const injector = createInjector(() => context);
    injector.setHoldEnabled(hold);
    injector.start();

    const engine = createWorldInfoEngine({
        book,
        eventSource: context.eventSource,
        eventTypes: context.eventTypes,
        interceptors: [injector.intercept],
    });

    return { context, book, injector, engine };
}

describe('the World Info holder', () => {
    let harness;
    beforeEach(() => {
        harness = setup();
    });

    it('activates the whole cascade from a single seeded keyword', async () => {
        const { entries, block } = await harness.engine.generate({ window: SEEDED });

        // Recursion closes over the reference graph, as D-0022 measured.
        expect(entries).toHaveLength(6);
        expect(block).toContain('Orrery');
    });

    it('survives a dropout turn with a byte-identical block', async () => {
        const seeded = await harness.engine.generate({ window: SEEDED });
        const dropout = await harness.engine.generate({ window: BARREN });
        const after = await harness.engine.generate({ window: BARREN });

        expect(dropout.block).toBe(seeded.block);
        expect(after.block).toBe(seeded.block);
        expect(dropout.entries).toHaveLength(6);
    });

    it('collapses on the same turn when the holder is off', async () => {
        // The control. Without this the test above could pass for any reason.
        const control = setup({ hold: false });

        const seeded = await control.engine.generate({ window: SEEDED });
        const dropout = await control.engine.generate({ window: BARREN });

        expect(seeded.entries).toHaveLength(6);
        expect(dropout.entries).toHaveLength(0);
        expect(dropout.block).toBe('');
    });

    it('re-forces every turn, because ST clears the forced set after each scan', async () => {
        // world-info.js:5275 — resetExternalEffects() runs at the end of every
        // checkWorldInfo, so a holder that pushed once would hold for one turn.
        await harness.engine.generate({ window: SEEDED });

        for (let turn = 0; turn < 5; turn++) {
            const { entries } = await harness.engine.generate({ window: BARREN });
            expect(entries).toHaveLength(6);
        }
    });

    it('keeps prompt order stable across a dropout', async () => {
        const order = (result) => result.entries.map((entry) => entry.uid);

        const seeded = await harness.engine.generate({ window: SEEDED });
        const dropout = await harness.engine.generate({ window: BARREN });

        expect(order(dropout)).toEqual(order(seeded));
    });

    it('holds the scanned entry, not a stub, so content survives', async () => {
        // world-info.js:4888 substitutes our object for the book's own, so a
        // {world, uid} stub would evict the content it was meant to preserve.
        await harness.engine.generate({ window: SEEDED });

        for (const entry of harness.injector.remembered.entries()) {
            expect(entry.content).toBeTruthy();
        }
    });

    it('adds entries that activate later without dropping the ones already held', async () => {
        const { book, engine, injector } = harness;
        book.push({
            ...book[0],
            uid: 99,
            key: ['tallow'],
            content: 'Tallow candles are rationed after the Weft raised the tithe.',
            order: 100,
            comment: 'tallow',
        });

        await engine.generate({ window: SEEDED });
        expect(injector.remembered.size).toBe(6);

        const { entries } = await engine.generate({ window: 'She counts the tallow by hand.' });
        expect(entries).toHaveLength(7);
        expect(injector.remembered.size).toBe(7);
    });
});

describe('the holder and the rest of ST', () => {
    it('releases a book when it is edited, so the author sees their change', async () => {
        // A held object is a snapshot and the book's own entry never reaches the
        // scan again while we force ours (world-info.js:4160 → src/prompt/lorebook.js).
        const { context, book, engine, injector } = setup();

        await engine.generate({ window: SEEDED });
        book[0].content = 'The hearth at Calder Row went out last winter.';

        const stale = await engine.generate({ window: BARREN });
        expect(stale.block).toContain('never goes out');

        await context.eventSource.emit(context.eventTypes.WORLDINFO_UPDATED, "Wren's Lorebook", {});
        expect(injector.remembered.size).toBe(0);

        const fresh = await engine.generate({ window: SEEDED });
        expect(fresh.block).toContain('went out last winter');
    });

    it('leaves other books held when one is edited', async () => {
        const { context, injector } = setup();
        injector.remembered.observe([
            { world: 'A', uid: 1, content: 'a' },
            { world: 'B', uid: 1, content: 'b' },
        ]);

        await context.eventSource.emit(context.eventTypes.WORLDINFO_UPDATED, 'A', {});

        expect(injector.remembered.size).toBe(1);
        expect(injector.remembered.has('B.1')).toBe(true);
    });

    it('learns nothing from a dry run and forces nothing into one', async () => {
        // Interceptors are skipped on dry runs (script.js:4562) and
        // WORLD_INFO_ACTIVATED is not emitted (:900), so neither can pollute us.
        const { engine, injector } = setup();

        await engine.generate({ window: SEEDED, dryRun: true });
        expect(injector.remembered.size).toBe(0);
    });

    it('leaves a quiet prompt alone', async () => {
        // A quiet prompt is someone else's utility call, not the turn whose
        // prefix we are protecting.
        const { engine, injector } = setup();

        await engine.generate({ window: SEEDED });
        const quiet = await engine.generate({ window: BARREN, type: 'quiet' });

        expect(injector.remembered.size).toBe(6);
        expect(quiet.entries).toHaveLength(0);
    });

    it('forgets everything on a chat change', async () => {
        const { engine, injector } = setup();

        await engine.generate({ window: SEEDED });
        injector.reset();

        const { entries } = await engine.generate({ window: BARREN });
        expect(entries).toHaveLength(0);
    });

    it('stops listening when stopped', async () => {
        const { context, engine, injector } = setup();

        injector.stop();
        await engine.generate({ window: SEEDED });

        expect(injector.remembered.size).toBe(0);
        expect(context.eventSource.listenerCount('world_info_activated')).toBe(0);
    });

    it('start and stop are idempotent', () => {
        const { context, injector } = setup();

        injector.start();
        expect(context.eventSource.listenerCount('world_info_activated')).toBe(1);

        injector.stop();
        injector.stop();
        expect(context.eventSource.listenerCount('world_info_activated')).toBe(0);
    });

    it('never lets a failure escape into the generate path', async () => {
        // CLAUDE.md §4.17 — degrading means ST scans as it always did.
        const injector = createInjector(() => {
            throw new Error('context exploded');
        });
        injector.remembered.observe([{ world: 'A', uid: 1, content: 'a' }]);

        await expect(injector.intercept([], 4096, () => {}, undefined)).resolves.toBeUndefined();
    });

    it('does not touch the chat array it is handed', async () => {
        // DESIGN.md §9 — the no-clone rule, satisfied by not touching it at all.
        const { injector } = setup();
        const chat = [{ mes: 'one', extra: {} }];
        const before = JSON.stringify(chat);

        injector.remembered.observe([{ world: 'A', uid: 1, content: 'a' }]);
        await injector.intercept(chat, 4096, () => {}, undefined);

        expect(JSON.stringify(chat)).toBe(before);
        expect(chat[0].extra).toBe(chat[0].extra);
    });
});

describe('the holder when Cairn is switched off', () => {
    it('stops forcing, not just listening', async () => {
        // ST holds the interceptor off globalThis for the life of the page
        // (extensions.js:2035), so `stop()` has to be honoured at call time.
        const { engine, injector } = setup();

        await engine.generate({ window: SEEDED });
        injector.stop();

        const { entries } = await engine.generate({ window: BARREN });
        expect(entries).toHaveLength(0);
    });

    it('drops the held set, so switching back on does not restore stale lore', async () => {
        const { engine, injector } = setup();

        await engine.generate({ window: SEEDED });
        injector.stop();
        injector.start();

        expect(injector.remembered.size).toBe(0);
    });

    it('holds nothing while the setting is off', async () => {
        const { engine, injector } = setup();

        await engine.generate({ window: SEEDED });
        injector.setHoldEnabled(false);

        const { entries } = await engine.generate({ window: BARREN });
        expect(entries).toHaveLength(0);
        // Still learning, so turning it back on needs no warm-up turn.
        expect(injector.remembered.size).toBe(6);
    });
});

/**
 * P1 step 3 — the handover (docs/decisions.md D-0027).
 *
 * The injector is the only thing that writes, so these are the tests that say
 * what lands in someone else's prompt: the block goes where the plan says, the
 * messages it speaks for stop being sent, and both come back off together.
 */
const IGNORE = Symbol.for('ignore');

/** The plan the assembler hands over. Placement mirrors qvink's (its index.js:153). */
function makePlan({ text = 'BLOCK', blank = [], writing = true } = {}) {
    return {
        text,
        blank,
        writing,
        placement: { position: 0, depth: 2, role: 0, scan: false },
        report: {},
    };
}

function withMemory({ chat, plan = makePlan() } = {}) {
    const context = createContext({ chat });
    const calls = [];
    const memory = {
        plan: async () => {
            calls.push(true);
            return typeof plan === 'function' ? plan() : plan;
        },
    };
    const injector = createInjector(() => context, { memory });
    injector.start();
    return { context, injector, calls };
}

/**
 * ST's `coreChat` (public/script.js:4496-4528): system messages filtered out,
 * then each entry rebuilt as `{...chatItem, index}` — a fresh object that shares
 * `extra` by reference, carrying an index that counts the *filtered* array.
 */
function asCoreChat(chat) {
    return chat.filter((message) => !message.is_system)
        .map((message, index) => ({ ...message, index }));
}

function summarised(count, { system = [] } = {}) {
    return Array.from({ length: count }, (_, i) => ({
        name: i % 2 ? 'Aster' : 'Wren',
        is_user: i % 2 === 0,
        is_system: system.includes(i),
        mes: `line ${i}`,
        extra: { qvink_memory: { memory: `summary ${i}` } },
    }));
}

describe('writing the memory block', () => {
    it('parks the block where the plan says to', async () => {
        const { context, injector } = withMemory({ chat: summarised(4) });

        await injector.intercept([], 4096, () => {}, undefined);

        expect(context.extensionPrompts.cairn_memory).toMatchObject({
            value: 'BLOCK', position: 0, depth: 2, role: 0, scan: false,
        });
    });

    it('holds back exactly the messages the block speaks for', async () => {
        const chat = summarised(6);
        const { injector } = withMemory({ chat, plan: makePlan({ blank: [0, 1, 2] }) });

        await injector.intercept(asCoreChat(chat), 4096, () => {}, undefined);

        expect(chat.map((message) => Boolean(message.extra[IGNORE]))).toEqual([
            true, true, true, false, false, false,
        ]);
    });

    it('blanks by the live chat index, not the index coreChat carries', async () => {
        // A system message earlier in the chat shifts every coreChat index after
        // it. Following coreChat's own `index` here would blank the wrong
        // messages, and the prompt would look entirely plausible either way.
        const chat = summarised(6, { system: [1] });
        const core = asCoreChat(chat);
        const { injector } = withMemory({ chat, plan: makePlan({ blank: [4] }) });

        await injector.intercept(core, 4096, () => {}, undefined);

        expect(chat[4].extra[IGNORE]).toBe(true);
        // ...and the entry ST will actually render sees it, because `extra` is
        // shared by reference (public/script.js:4525).
        expect(core.find((entry) => entry.mes === 'line 4').extra[IGNORE]).toBe(true);
        expect(core.filter((entry) => entry.extra[IGNORE]).length).toBe(1);
    });

    it('mutates in place and never clones a message', async () => {
        // DESIGN.md §9: structuredClone drops Symbol-keyed flags with no error,
        // which is how WTrackerLite silently undid qvink's blanking.
        const chat = summarised(3);
        const identities = chat.map((message) => message.extra);
        const { injector } = withMemory({ chat, plan: makePlan({ blank: [0] }) });

        await injector.intercept(asCoreChat(chat), 4096, () => {}, undefined);

        expect(chat.map((message) => message.extra)).toEqual(identities);
    });

    it('clears a flag from a turn that no longer covers that message', async () => {
        const chat = summarised(4);
        let blanked = [0, 3];
        const { injector } = withMemory({ chat, plan: () => makePlan({ blank: blanked }) });

        await injector.intercept(asCoreChat(chat), 4096, () => {}, undefined);
        blanked = [0];
        await injector.intercept(asCoreChat(chat), 4096, () => {}, undefined);

        expect(chat[3].extra[IGNORE]).toBeUndefined();
        expect(chat[0].extra[IGNORE]).toBe(true);
    });

    it('leaves a flag it did not set alone', async () => {
        // `Symbol.for('ignore')` is shared: /hide and any other extension use the
        // same key. Clearing theirs would put their message back in the prompt.
        const chat = summarised(4);
        chat[3].extra[IGNORE] = true;
        const { injector } = withMemory({ chat, plan: makePlan({ blank: [0] }) });

        await injector.intercept(asCoreChat(chat), 4096, () => {}, undefined);

        expect(chat[3].extra[IGNORE]).toBe(true);
    });

    it('leaves nothing behind in the saved chat', async () => {
        // The flag lives on the real message, so the one thing that must be true
        // is that it cannot reach the file: JSON.stringify drops Symbol keys.
        const chat = summarised(2);
        const { injector } = withMemory({ chat, plan: makePlan({ blank: [0, 1] }) });

        await injector.intercept(asCoreChat(chat), 4096, () => {}, undefined);

        expect(JSON.stringify(chat)).not.toContain('ignore');
    });
});

describe('when the handover gate is shut', () => {
    it('writes nothing and holds nothing back', async () => {
        const chat = summarised(3);
        const { context, injector } = withMemory({ chat, plan: makePlan({ writing: false }) });

        await injector.intercept(asCoreChat(chat), 4096, () => {}, undefined);

        expect(context.extensionPrompts.cairn_memory).toBeUndefined();
        expect(chat.some((message) => message.extra[IGNORE])).toBe(false);
    });

    it('takes back a block it had already parked', async () => {
        const chat = summarised(3);
        let writing = true;
        const { context, injector } = withMemory({
            chat,
            plan: () => makePlan({ blank: [0], writing }),
        });

        await injector.intercept(asCoreChat(chat), 4096, () => {}, undefined);
        writing = false;
        await injector.intercept(asCoreChat(chat), 4096, () => {}, undefined);

        expect(context.extensionPrompts.cairn_memory.value).toBe('');
        expect(chat[0].extra[IGNORE]).toBeUndefined();
    });

    it('leaves a quiet prompt alone entirely', async () => {
        const chat = summarised(3);
        const { context, injector, calls } = withMemory({ chat, plan: makePlan({ blank: [0] }) });

        await injector.intercept(asCoreChat(chat), 4096, () => {}, 'quiet');

        expect(calls).toHaveLength(0);
        expect(context.extensionPrompts.cairn_memory).toBeUndefined();
    });
});

describe('the memory block when Cairn is switched off', () => {
    it('releases the injection and the held-back messages on stop', async () => {
        const chat = summarised(3);
        const { context, injector } = withMemory({ chat, plan: makePlan({ blank: [0, 1] }) });

        await injector.intercept(asCoreChat(chat), 4096, () => {}, undefined);
        injector.stop();

        expect(context.extensionPrompts.cairn_memory.value).toBe('');
        expect(chat.some((message) => message.extra[IGNORE])).toBe(false);
    });

    it('releases them on a chat change too — another chat is not ours to blank', async () => {
        const chat = summarised(3);
        const { context, injector } = withMemory({ chat, plan: makePlan({ blank: [0] }) });

        await injector.intercept(asCoreChat(chat), 4096, () => {}, undefined);
        injector.reset();

        expect(context.extensionPrompts.cairn_memory.value).toBe('');
        expect(chat[0].extra[IGNORE]).toBeUndefined();
    });

    it('keeps last turn state rather than half of it when planning fails', async () => {
        // CLAUDE.md §4.17. A stale block is a stale sentence; a cleared block with
        // the messages still held back is a prompt with a hole in it.
        const chat = summarised(3);
        let fail = false;
        const { context, injector } = withMemory({
            chat,
            plan: () => {
                if (fail) throw new Error('assembler exploded');
                return makePlan({ blank: [0] });
            },
        });

        await injector.intercept(asCoreChat(chat), 4096, () => {}, undefined);
        fail = true;
        await expect(injector.intercept(asCoreChat(chat), 4096, () => {}, undefined)).resolves.toBeUndefined();

        expect(context.extensionPrompts.cairn_memory.value).toBe('BLOCK');
        expect(chat[0].extra[IGNORE]).toBe(true);
    });
});
