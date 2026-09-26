import { describe, expect, it } from 'vitest';
import { createExamplesLatch, examplesSuperseded } from '../src/memory/examples.js';
import { CARD_FIELDS, CARD_FIELDS_STRIPPED, cardText, createReserves } from '../src/prompt/reserves.js';
import { RAW_WINDOW } from '../src/pipeline/scheduler.js';
import { createContext, makeCardFields, makePowerUser } from './mocks/sillytavern.js';
import { makeWorldInfoModule } from './mocks/world-info.js';
import { makeQvinkChat } from './mocks/qvink.js';
import { readScenes } from '../src/memory/scenes.js';

/**
 * The reclaim half of P5 (docs/decisions.md D-0068). Two invariants carry it, and
 * the second is the one that decides whether any of it is visible: **the flag and
 * the reserve have to agree.** `CARD_FIELDS` includes `mesExamples`, so a strip
 * the reserve does not know about hands 2,176 tokens to the margin, the cap does
 * not move, and the whole phase looks like it did nothing.
 */

/** The see-saw's threshold, derived rather than typed in (CLAUDE.md §9.35). */
const threshold = (length) => length - 1 - RAW_WINDOW;

const scenesFor = (length) => readScenes(makeQvinkChat({ length }));

describe('when example dialogue is superseded', () => {
    it('reads false until a message behind the window carries a summary', () => {
        expect(examplesSuperseded([], null)).toBe(false);
        expect(examplesSuperseded([], -1)).toBe(false);
        // A chat with summaries, but the see-saw has not reached them yet.
        expect(examplesSuperseded(scenesFor(40), -1)).toBe(false);
    });

    it('reads true once the see-saw has reached one', () => {
        expect(examplesSuperseded(scenesFor(40), threshold(40))).toBe(true);
    });

    it('ignores a summary that is still in front of the threshold', () => {
        const scenes = [{ index: 12, eligible: true }];
        expect(examplesSuperseded(scenes, 11)).toBe(false);
        expect(examplesSuperseded(scenes, 12)).toBe(true);
    });

    it('does not count a summary qvink excluded', () => {
        expect(examplesSuperseded([{ index: 0, eligible: false }], 5)).toBe(false);
    });

    /**
     * The monotonicity the latch exists for. An instantaneous test — "is the
     * block non-empty" — would un-latch on a turn a summarisation failed, and
     * flipping examples back and forth destroys the prefix every time.
     */
    it('never goes true then false as a chat is played forward', () => {
        let seen = false;
        for (let length = 2; length <= 120; length++) {
            const now = examplesSuperseded(scenesFor(length), threshold(length));
            expect(now || !seen, `turn ${length}`).toBe(true);
            seen ||= now;
        }
        expect(seen).toBe(true);
    });

    it('rolls back on a branch taken before the first summary', () => {
        expect(examplesSuperseded(scenesFor(60), threshold(60))).toBe(true);
        // A branch is the chat sliced (public/scripts/bookmarks.js:173), so the
        // threshold follows it down and nothing behind the window is summarised.
        expect(examplesSuperseded(scenesFor(4), threshold(4))).toBe(false);
    });
});

describe('writing the latch into SillyTavern', () => {
    const latched = (context) => createExamplesLatch(() => context);

    it('sets strip_examples once and reports the one turn it moved', () => {
        const context = createContext();
        const latch = latched(context);

        expect(latch.apply(false)).toEqual({ stripped: false, changed: false });
        expect(context.powerUserSettings.strip_examples).toBe(false);

        expect(latch.apply(true)).toEqual({ stripped: true, changed: true });
        expect(context.powerUserSettings.strip_examples).toBe(true);

        // Every later turn is the same flag, so it costs exactly one cache miss.
        for (let turn = 0; turn < 5; turn++) {
            expect(latch.apply(true)).toEqual({ stripped: true, changed: false });
        }
        expect(context.powerUserSettings.strip_examples).toBe(true);
    });

    it('reports no change when the user was already stripping', () => {
        const context = createContext({ powerUser: makePowerUser({ strip_examples: true }) });
        expect(latched(context).apply(true)).toEqual({ stripped: true, changed: false });
    });

    it('leaves pin_examples alone', () => {
        // Stripping already wins: public/script.js:4738-4739 blanks the array
        // before :4861 pins it, so clearing the other flag would mutate more of
        // the user's settings than it has to.
        const context = createContext({ powerUser: makePowerUser({ pin_examples: true }) });
        latched(context).apply(true);
        expect(context.powerUserSettings.pin_examples).toBe(true);
    });

    it('never persists: the write is for this session only', () => {
        const context = createContext();
        let saves = 0;
        context.saveSettingsDebounced = () => { saves++; };

        const latch = latched(context);
        latch.apply(true);
        latch.apply(false);

        // `strip_examples` is global. Persisting it would strip examples from the
        // next brand-new chat on turn two, which is the one place they earn their
        // tokens.
        expect(saves).toBe(0);
    });

    it('puts the user\'s own value back when the latch reads false', () => {
        const context = createContext({ powerUser: makePowerUser({ strip_examples: true }) });
        const latch = latched(context);

        latch.apply(true);
        latch.apply(false);
        expect(context.powerUserSettings.strip_examples).toBe(true);
    });

    it('restores on reset, so a chat switch does not strip the next chat', () => {
        const context = createContext();
        const latch = latched(context);

        latch.apply(true);
        expect(context.powerUserSettings.strip_examples).toBe(true);

        latch.reset();
        expect(context.powerUserSettings.strip_examples).toBe(false);
        expect(latch.stripping).toBe(false);
    });

    it('degrades to doing nothing when there are no power user settings', () => {
        const context = createContext();
        context.powerUserSettings = null;
        expect(latched(context).apply(true)).toEqual({ stripped: false, changed: false });
    });
});

describe('the card reserve and the latch agree', () => {
    const EXAMPLES = 'x'.repeat(8_704);
    const fields = makeCardFields({ description: 'y'.repeat(10_081), mesExamples: EXAMPLES });

    it('drops mesExamples from the fields exactly when stripping', () => {
        expect(CARD_FIELDS).toContain('mesExamples');
        expect(CARD_FIELDS_STRIPPED).not.toContain('mesExamples');
        // And nothing else moved: the two lists differ by that one field.
        expect(CARD_FIELDS_STRIPPED).toEqual(CARD_FIELDS.filter((f) => f !== 'mesExamples'));

        expect(cardText(fields, '')).toContain(EXAMPLES);
        expect(cardText(fields, '', { stripExamples: true })).not.toContain(EXAMPLES);
    });

    /**
     * The failure this whole test file exists to catch, stated as arithmetic: the
     * card reserve must fall by the examples' own tokens on the turn the flag
     * moves, or the reclaim disappears into the margin with nothing to see.
     */
    it('falls by the examples\' tokens, and by exactly that', async () => {
        const context = createContext({ cardFields: fields });
        const reserves = createReserves(() => context, { load: async () => makeWorldInfoModule() });

        const before = await reserves.read(23_040);
        const after = await reserves.read(23_040, { stripExamples: true });

        const examplesTokens = Math.ceil(EXAMPLES.length / 4);
        expect(before.card - after.card).toBe(examplesTokens);
        // The run's own number: 49% of the card, ~2,176 tokens (docs/p5-plan.md).
        expect(examplesTokens).toBe(2_176);
        expect(after.card).toBeLessThan(before.card);
    });

    it('leaves every other reserve untouched', async () => {
        const context = createContext({ cardFields: fields });
        const reserves = createReserves(() => context, { load: async () => makeWorldInfoModule() });

        const before = await reserves.read(23_040);
        const after = await reserves.read(23_040, { stripExamples: true });

        for (const key of ['lore', 'loreBound', 'window', 'windowNow', 'state']) {
            expect(after[key], key).toEqual(before[key]);
        }
    });

    it('costs the card nothing when the card has no examples', async () => {
        const context = createContext({ cardFields: makeCardFields({ description: 'z'.repeat(400) }) });
        const reserves = createReserves(() => context, { load: async () => makeWorldInfoModule() });

        const before = await reserves.read(23_040);
        const after = await reserves.read(23_040, { stripExamples: true });
        expect(after.card).toBe(before.card);
    });
});
