import { describe, expect, it } from 'vitest';
import { renderCanonView, renderSnapshot, renderSummaries } from '../src/ui/inspector.js';

/**
 * The inspector's rows, as plain strings. `createInspector` is the part that needs a
 * DOM; these two build the text, and the text is what a run is read from until the disk
 * log is opened (docs/p5-plan.md §3).
 */

const memory = (overrides = {}) => ({
    writing: true, handover: 'ready', tokens: 2_400, cap: 6_000, floor: 1_800,
    included: 40, scenes: 60, oldest: 4, newest: 49, source: 'cairn',
    stepped: false, stepReason: 'held', stepWaiting: false, summarisedThrough: 49,
    rawWindow: 8, evicted: 0, rebuilt: false, slack: 900, stepTokens: 300, recoupled: false,
    change: { stabilityPercent: 96, divergencePercent: 88 },
    ...overrides,
});

const snapshot = (overrides = {}) => ({
    stability: { stabilityPercent: 96, commonPrefix: 9_600, currentLength: 10_000 },
    promptTokens: 12_000, maxContext: 32_768, contextPercent: 37, api: 'textgenerationwebui',
    summary: { tokens: 2_400, count: 1, writers: 1, byOwner: [{ owner: 'cairn', tokens: 2_400 }] },
    inventory: [], worldInfo: { entries: [], tokens: 0 },
    ...overrides,
    memory: memory(overrides.memory),
});

const rowFor = (html, label) => html.match(new RegExp(`${label}[\\s\\S]{0,400}?</div>`))?.[0] ?? '';

describe('the block\'s two fidelities', () => {
    it('is not shown at all while the block holds one fidelity', () => {
        // A chat with no records renders what it always did, and a row of zeroes
        // would suggest the tier was doing something (docs/decisions.md D-0075).
        const html = renderSnapshot(snapshot({ memory: { blockCompact: 0, compactMissing: 0 } }));

        expect(html).not.toContain('Fidelity');
    });

    it('says how many are held in full and how many shortened', () => {
        const html = renderSnapshot(snapshot({
            memory: { blockFull: 43, blockCompact: 39, compactCap: 998, sceneCap: 6_362 },
        }));

        expect(rowFor(html, 'Fidelity')).toContain('43 in full, 39 shortened');
        expect(rowFor(html, 'Fidelity')).toContain('tail 998 of 6,362 tokens');
    });

    it('calls out a demotion on a turn that was not rebuilding, which is the invariant', () => {
        // A demotion rewrites the block's head, so one on an ordinary turn means the
        // held split leaked (docs/decisions.md D-0078).
        const bad = renderSnapshot(snapshot({
            memory: { blockFull: 43, blockCompact: 39, demoted: 6, rebuilt: false },
        }));
        const good = renderSnapshot(snapshot({
            memory: { blockFull: 43, blockCompact: 39, demoted: 6, rebuilt: true },
        }));

        expect(rowFor(bad, 'Fidelity')).toContain('on a turn that was not rebuilding');
        expect(rowFor(good, 'Fidelity')).toContain('6 shortened this turn');
        expect(rowFor(good, 'Fidelity')).not.toContain('not rebuilding');
    });

    it('reports a summary dropped only for want of a short version', () => {
        const html = renderSnapshot(snapshot({ memory: { blockCompact: 39, compactMissing: 2 } }));

        expect(rowFor(html, 'Fidelity')).toContain('2 dropped for want of a short version');
    });
});

describe('the index the pick reads', () => {
    it('is not shown before any record exists', () => {
        expect(renderSnapshot(snapshot({ memory: { indexRecords: 0 } }))).not.toContain('>Index<');
    });

    it('shows the tally and the four-way split, commonest first', () => {
        const html = renderSnapshot(snapshot({
            memory: { indexRecords: 59, scenes: 60, indexKinds: { description: 30, major: 20, filler: 8, cast: 1 } },
        }));

        expect(rowFor(html, '>Index<')).toContain('59 records of 60 summaries');
        expect(rowFor(html, '>Index<')).toContain('30 description, 20 major, 8 filler, 1 cast');
    });
});

describe('canon at the head of the block', () => {
    const withCanon = (overrides = {}) => snapshot({
        memory: {
            canonFacts: 10, canonAdmitted: 10, canonTokens: 288, canonCap: 1_591,
            canonCapApplied: 1_591, canonSpilled: 0, canonFull: false,
            canonSlots: 10, canonPicked: 10, canonLostSources: 0, ...overrides,
        },
    });

    it('says how many slots the pick filled, not only how many facts there are', () => {
        expect(rowFor(renderSnapshot(withCanon()), 'Canon')).toContain('10 of 10 slots filled');
        expect(rowFor(renderSnapshot(withCanon({ canonPicked: 6 })), 'Canon')).toContain('6 of 10 slots filled');
    });

    it('says when facts lost the summaries behind them, because canon is chosen again', () => {
        const html = renderSnapshot(withCanon({ canonLostSources: 2 }));

        expect(rowFor(html, 'Canon')).toContain('2 lost the summary behind it');
    });

    it('distinguishes the block being full from the slots being unfilled', () => {
        // Two different kinds of full, and only the cap one is a problem (D-0079).
        expect(rowFor(renderSnapshot(withCanon({ canonFull: true })), 'Canon'))
            .toContain('over the block\'s room');
        expect(rowFor(renderSnapshot(withCanon({ canonPicked: 4 })), 'Canon'))
            .not.toContain('over the block\'s room');
    });
});

describe('the examples latch', () => {
    it('says nothing until it flips, because until then nothing has changed', () => {
        expect(renderSnapshot(snapshot({ memory: { examplesStripped: false } })))
            .not.toContain('Example dialogue');
    });

    it('names the one turn it costs a cache miss on', () => {
        const flipped = renderSnapshot(snapshot({ memory: { examplesStripped: true, examplesLatched: true } }));
        const after = renderSnapshot(snapshot({ memory: { examplesStripped: true, examplesLatched: false } }));

        expect(rowFor(flipped, 'Example dialogue')).toContain('one cache miss');
        expect(rowFor(after, 'Example dialogue')).toContain('summaries stand in for it now');
        expect(rowFor(after, 'Example dialogue')).not.toContain('cache miss');
    });
});

describe('the index queue', () => {
    const queue = (overrides = {}) => ({
        gate: 'ready', inFlight: null, pending: null, waiting: 0, givenUp: false,
        calls: 6, records: 85, dropped: 0, missed: 0, failures: 0, lastReason: null,
        tokensIn: 18_000, tokensOut: 6_400, ...overrides,
    });
    const status = (index) => ({
        gate: 'ready', calls: 0, written: 0, failures: 0, ms: 0, tokensIn: 0, tokensOut: 0,
        promptDefault: true, pending: 0, failed: [], givenUp: [], index,
    });
    const summaryLine = (html, section) =>
        html.match(new RegExp(`<summary>${section}: (.*?)</summary>`, 's'))?.[1] ?? '';

    it('says when every summary has a record', () => {
        expect(summaryLine(renderSummaries(status(queue())), 'Index')).toBe('every summary has a record');
    });

    it('names the batch it would send next', () => {
        const html = renderSummaries(status(queue({ waiting: 23, pending: { from: 12, to: 26, summaries: 15 } })));

        expect(summaryLine(html, 'Index')).toContain('23 summaries waiting');
        expect(summaryLine(html, 'Index')).toContain('#12–#26');
    });

    it('reports what was written, unanswered and dropped, not what was claimed', () => {
        const html = renderSummaries(status(queue({ records: 80, missed: 5, dropped: 3 })));

        expect(html).toContain('80 records from 6 batches');
        expect(html).toContain('3 slots dropped');
        expect(html).toContain('5 unanswered');
    });

    it('shows a shut gate rather than an idle queue', () => {
        expect(summaryLine(renderSummaries(status(queue({ gate: 'not-writing' }))), 'Index'))
            .toContain('qvink is still writing');
        expect(summaryLine(renderSummaries(status(queue({ gate: 'no-profile' }))), 'Index'))
            .not.toBe('every summary has a record');
    });

    it('is not shown at all before the queue has run', () => {
        expect(renderSummaries(status(null))).not.toContain('Index:');
    });
});

describe('the canon queue', () => {
    const pick = (overrides = {}) => ({
        gate: 'ready', inFlight: null, pending: null, reason: 'covered', givenUp: false,
        calls: 2, picked: 10, duplicates: 1, refused: 0, failures: 0, lastReason: null,
        ms: 9_000, tokensIn: 10_600, tokensOut: 800, ...overrides,
    });
    const status = (canon) => ({
        gate: 'ready', calls: 0, written: 0, failures: 0, ms: 0, tokensIn: 0, tokensOut: 0,
        promptDefault: true, pending: 0, failed: [], givenUp: [], canon,
    });
    const summaryLine = (html) => html.match(/<summary>Canon: (.*?)<\/summary>/s)?.[1] ?? '';

    it('names the pick it would make, with the index it would read', () => {
        const html = renderSummaries(status(pick({
            reason: 'new-records', pending: { covers: [4, 108], records: 59, slots: 10 },
        })));

        expect(summaryLine(html)).toContain('59 records');
        expect(summaryLine(html)).toContain('#4–#108');
        expect(summaryLine(html)).toContain('10 slots');
    });

    it('distinguishes "chosen and up to date" from "nothing to choose from"', () => {
        expect(summaryLine(renderSummaries(status(pick({ reason: 'covered' })))))
            .toBe('chosen, and up to date with the index');
        expect(summaryLine(renderSummaries(status(pick({ reason: 'too-few' })))))
            .toContain('too few records to rank');
    });

    it('counts in the pick\'s vocabulary, not the promotion pass\'s', () => {
        expect(renderSummaries(status(pick()))).toContain('10 facts from 2 picks');
        expect(renderSummaries(status(pick()))).toContain('1 repeated');
    });
});

describe('canon as text (docs/decisions.md D-0085)', () => {
    const view = (over = {}) => ({ inPrompt: ['Her brother is dead.'], spilled: [], waiting: [], slots: 10, ...over });

    it('lists what the prompt carries, open, against the slots asked for', () => {
        const html = renderCanonView(view());
        expect(html).toContain('<details class="cairn-details" open>');
        expect(html).toContain('Canon in the prompt (1 of 10 lines)');
        expect(html).toContain('<li>Her brother is dead.</li>');
        expect(html).not.toContain('next rebuild');
    });

    it('says what is waiting for a rebuild and what the cap left out', () => {
        const html = renderCanonView(view({ spilled: ['The lamp is broken.'], waiting: ['Aster owns a boat.'] }));
        expect(html).toContain('Left out for want of room');
        expect(html).toContain('<li>The lamp is broken.</li>');
        expect(html).toContain('goes in at the next rebuild');
        expect(html).toContain('<li>Aster owns a boat.</li>');
    });

    it('escapes a fact, which is model-written text', () => {
        expect(renderCanonView(view({ inPrompt: ['<img src=x onerror=alert(1)>'] }))).toContain('&lt;img src=x');
    });

    it('says there is no canon yet, and nothing at all while canon is off', () => {
        expect(renderCanonView(view({ inPrompt: [] }))).toContain('No canon yet');
        expect(renderCanonView(null)).toBe('');
    });
});
