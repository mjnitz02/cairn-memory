import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { FIRST_TURN, isRebuild } from '../src/prompt/rebuild.js';

/**
 * D-0067's invariant: the rebuild turn is the only turn discontinuous work happens on,
 * and there is exactly one definition of which turn that is.
 *
 * This lands before anything in P5 depends on it (docs/p5-plan.md stage 2, item 4). The
 * failure it guards is not a crash — it is a second, slightly different rebuild
 * condition at a new call site, after which the block quietly starts changing on turns
 * it should not, which is invisible in play and is exactly what D-0019 was about.
 */
describe('the rebuild turn (docs/decisions.md D-0067)', () => {
    it('is an eviction or a cold first turn, and nothing else', () => {
        expect(isRebuild({ evicted: 1, stepReason: 'held' })).toBe(true);
        expect(isRebuild({ evicted: 0, stepReason: FIRST_TURN })).toBe(true);
        expect(isRebuild({ evicted: 4, stepReason: FIRST_TURN })).toBe(true);
        expect(isRebuild({ evicted: 0, stepReason: 'step' })).toBe(false);
        expect(isRebuild({ evicted: 0, stepReason: 'held' })).toBe(false);
    });

    it('does not count a branch or a swipe, which rolls the store back too', () => {
        // A rollback rewrites the head, but the records a re-derivation would read are
        // the ones that just went away; the fold gives that back for free (D-0045).
        expect(isRebuild({ evicted: 0, stepReason: 'rollback' })).toBe(false);
    });

    it('treats a missing or nonsense eviction count as no eviction', () => {
        expect(isRebuild({})).toBe(false);
        expect(isRebuild()).toBe(false);
        expect(isRebuild({ evicted: Number.NaN, stepReason: 'step' })).toBe(false);
        expect(isRebuild({ evicted: undefined, stepReason: 'step' })).toBe(false);
    });
});

describe('one definition of the rebuild turn', () => {
    /** Every shipped .js under src/, plus the entry point. */
    function shippedFiles(dir = 'src', found = ['index.js']) {
        for (const entry of readdirSync(dir, { withFileTypes: true })) {
            const path = join(dir, entry.name);
            if (entry.isDirectory()) shippedFiles(path, found);
            else if (entry.name.endsWith('.js')) found.push(path);
        }
        return found;
    }

    it('is written down once: no other module composes the condition itself', () => {
        // The mechanical half (CLAUDE.md §9.35). A line that reads both the eviction
        // count and the step reason is a second definition of the rebuild turn.
        const offenders = shippedFiles()
            .filter((path) => path !== join('src', 'prompt', 'rebuild.js'))
            .flatMap((path) => readFileSync(path, 'utf8')
                .split('\n')
                .map((line, i) => ({ path, line: i + 1, text: line }))
                .filter(({ text }) => !text.trimStart().startsWith('*') && !text.trimStart().startsWith('//'))
                .filter(({ text }) => /\bevicted\b/.test(text) && text.includes(FIRST_TURN)))
            .map(({ path, line }) => `${path}:${line}`);

        expect(offenders).toEqual([]);
    });

    it('is what the assembler puts in the report, so downstream reads a flag', () => {
        // prompt/injector.js gates the World Info trim on `report.rebuilt` (D-0069) and
        // must never recompute it. Stage 3's canon and index re-derivation join it here.
        const injector = readFileSync(join('src', 'prompt', 'injector.js'), 'utf8');
        expect(injector).toContain('plan?.report?.rebuilt');
        expect(injector).not.toContain(FIRST_TURN);

        const assembler = readFileSync(join('src', 'prompt', 'assembler.js'), 'utf8');
        expect(assembler).toContain('isRebuild({');
    });
});
