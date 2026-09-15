import { describe, expect, it } from 'vitest';
import { createSeeSaw } from '../src/pipeline/scheduler.js';

describe('the see-saw threshold', () => {
    it('keeps the raw window behind it on the first turn', () => {
        const seeSaw = createSeeSaw({ rawWindow: 10, step: 10 });

        expect(seeSaw.advance(31)).toMatchObject({ summarisedThrough: 20, stepped: true });
    });

    it('holds still until a full step has accumulated', () => {
        const seeSaw = createSeeSaw({ rawWindow: 10, step: 10 });
        seeSaw.advance(31);

        for (let length = 32; length < 41; length++) {
            expect(seeSaw.advance(length)).toMatchObject({ summarisedThrough: 20, stepped: false });
        }
        expect(seeSaw.advance(41)).toMatchObject({ summarisedThrough: 30, stepped: true });
    });

    /**
     * The invariant D-0019 turns on: growth is stepwise, so the set the block is
     * rendered from is *identical* between steps. Under qvink's own default the
     * trigger is 0 — advance every turn — and the set moves every single message,
     * which is the regime D-0018 measured at 13%.
     */
    it('changes the included set on one turn in ten, not on every turn', () => {
        const stepped = createSeeSaw({ rawWindow: 10, step: 10 });
        const everyTurn = createSeeSaw({ rawWindow: 10, step: 0 });
        let steppedMoves = 0;
        let everyTurnMoves = 0;

        for (let length = 31; length <= 130; length++) {
            if (stepped.advance(length).stepped) steppedMoves++;
            if (everyTurn.advance(length).stepped) everyTurnMoves++;
        }

        expect(steppedMoves).toBe(10);
        expect(everyTurnMoves).toBe(100);
    });

    it('follows the chat back down when a branch or swipe shortens it', () => {
        const seeSaw = createSeeSaw({ rawWindow: 10, step: 10 });
        seeSaw.advance(51);
        expect(seeSaw.summarisedThrough).toBe(40);

        // Injecting summaries for messages that no longer exist is quiet
        // wrongness, not an error — so this must not wait for a step.
        expect(seeSaw.advance(36)).toMatchObject({ summarisedThrough: 25, stepped: true, reason: 'rollback' });
    });

    it('never points past the end of a chat shorter than the raw window', () => {
        const seeSaw = createSeeSaw({ rawWindow: 10, step: 10 });

        expect(seeSaw.advance(4).summarisedThrough).toBe(-1);
        expect(seeSaw.advance(0).summarisedThrough).toBe(-1);
    });

    it('starts over on a new chat', () => {
        const seeSaw = createSeeSaw({ rawWindow: 10, step: 10 });
        seeSaw.advance(101);
        seeSaw.reset();

        expect(seeSaw.summarisedThrough).toBeNull();
        expect(seeSaw.advance(31)).toMatchObject({ summarisedThrough: 20, reason: 'first-turn' });
    });
});
