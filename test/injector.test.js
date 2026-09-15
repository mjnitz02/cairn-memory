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
