import { describe, expect, it } from 'vitest';
import { renderStateSection } from '../src/ui/state-section.js';

/** The inspector's World state section (docs/how-it-works.md), as plain strings. */

const idle = (overrides = {}) => ({
    gate: 'ready', tracker: null, inFlight: null, pending: false, failed: null, givenUp: false,
    calls: 4, written: 4, failures: 0, lastReason: null, dropped: 0, ms: 27_600, tokensIn: 4_800, tokensOut: 320,
    ...overrides,
});

const placed = (overrides = {}) => ({
    injected: true, reason: 'injected', tracker: null, index: 9, depth: 1, chars: 64, tokens: 14,
    changed: false, changeKinds: ['location'], text: '[Current scene]\nLocation: The <ferry> & pier',
    ...overrides,
});

const summaryLine = (html) => html.match(/<summary>(.*?)<\/summary>/s)[1];

describe('the World state section', () => {
    it('draws nothing before the queue or a generation has reported', () => {
        expect(renderStateSection(null, null)).toBe('');
    });

    it('says what the queue is doing', () => {
        expect(summaryLine(renderStateSection(idle(), null))).toBe('World state: up to date');
        expect(summaryLine(renderStateSection(idle({ pending: true }), null))).toBe('World state: waiting');
        expect(summaryLine(renderStateSection(idle({ inFlight: 11 }), null))).toBe('World state: writing through message #11');
        expect(summaryLine(renderStateSection(idle({ gate: null }), null))).toBe('World state: not started');
        expect(summaryLine(renderStateSection(idle({ gate: 'off' }), null))).toBe('World state: off');
        expect(summaryLine(renderStateSection(idle({ gate: 'no-profile' }), null))).toContain('no memory connection chosen');
        expect(summaryLine(renderStateSection(idle({ gate: 'wtracker-loaded', tracker: 'WTrackerLite' }), null)))
            .toBe('World state: waiting — WTrackerLite is loaded');
    });

    it('shows the injected state, escaped, with its depth, size and last change', () => {
        const html = renderStateSection(idle(), placed());

        expect(html).toContain('[Current scene]\nLocation: The &lt;ferry&gt; &amp; pier');
        expect(html).not.toContain('<ferry>');
        expect(html).toContain('1 from the end');
        expect(html).toContain('64 chars, 14 tokens');
        expect(html).toContain('<b>location</b>');
        expect(html).not.toContain('behind the chat');
    });

    it('says when the state sits deeper than it should, because the queue is behind', () => {
        expect(renderStateSection(idle(), placed({ depth: 3 }))).toContain('behind the chat');
    });

    it('says why no state is in the prompt', () => {
        const why = (overrides) => renderStateSection(idle(), placed({ injected: false, text: '', ...overrides }));

        expect(why({ reason: 'off' })).toContain('World state is switched off');
        expect(why({ reason: 'none-yet' })).toContain('no state written yet');
        expect(why({ reason: 'wtracker-loaded', tracker: 'WTracker' })).toContain('WTracker is loaded');
        expect(why({ reason: 'behind-step', index: 9 })).toContain('on message #9, is older than the memory step');
    });

    it('warns when the queue gave up, and counts failures and dropped fields', () => {
        const html = renderStateSection(idle({
            givenUp: true, failures: 3, lastReason: 'no-json', dropped: 2, failed: { index: 12, attempts: 3, reason: 'no-json' },
        }), placed());

        expect(html).toContain('gave up updating the world state through message\n        #12');
        expect(summaryLine(html)).toContain('gave up');
        expect(html).toContain('3 failed');
        expect(html).toContain('2 fields dropped');
    });
});
