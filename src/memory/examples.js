/**
 * The example-dialogue latch (docs/decisions.md D-0068).
 *
 * Example dialogue says how a character *would* speak in a situation that never
 * happened, and it does not move as the character develops. Real messages say how
 * they *do* speak. So once summaries stand in for messages, examples are strictly
 * dominated by the raw window and are worth ~2,176 tokens on the run's card — 49%
 * of the card reserve and 9.4% of the whole prompt. Before that, at turns two and
 * three, they anchor the character profoundly. The crossover is not a tuning
 * problem, and SillyTavern already ships the lever switched off
 * (`power_user.strip_examples`, `public/scripts/power-user.js:122`).
 *
 * **Latched, not instantaneous.** The trigger is "does any message behind the raw
 * window carry a summary", not "is the block non-empty right now": a summarisation
 * failure could empty the block for one turn, and flipping examples back and forth
 * destroys the prefix every time. Derived from the chat every turn and never
 * stored, so it is monotonic within a branch, rolls back on a branch or a swipe,
 * and survives a reload with no bookkeeping — the shape D-0045 already uses.
 *
 * Pure but for `apply`, which is the only place in Cairn that writes a
 * `power_user` setting.
 */
import { debug } from '../util/log.js';

/**
 * Has the chat passed the point where summaries stand in for messages?
 *
 * Read off the summaries on the messages rather than off the rendered block, so
 * eviction under budget pressure cannot un-latch it: an evicted summary is still
 * a summary that stands in for its message.
 *
 * @param {Array<{index: number, eligible: boolean}>} scenes From `readScenes`.
 * @param {number|null} summarisedThrough The see-saw's threshold.
 * @returns {boolean}
 */
export function examplesSuperseded(scenes, summarisedThrough) {
    if (!Number.isInteger(summarisedThrough) || summarisedThrough < 0) return false;
    return (scenes ?? []).some((scene) => scene?.eligible && scene.index <= summarisedThrough);
}

/**
 * Writes the latch into ST, and puts the user's own setting back when it reads
 * false again.
 *
 * **Deliberately not persisted.** ST's own control calls `saveSettingsDebounced`
 * (`public/scripts/power-user.js:3314-3337`) because a person chose it. This is
 * derived per chat, and `strip_examples` is *global* — persisting it would strip
 * examples from the next brand-new chat on turn two, which is the one place they
 * carry their weight. So the write lives for the session and the user's stored
 * value is untouched.
 *
 * `pin_examples` is left alone on purpose: ST blanks the array at
 * `public/script.js:4738-4739`, before it pins anything at `:4861`, so stripping
 * already wins and clearing the other flag would only mutate more than we must.
 *
 * One thing this cannot do: ST's setting is a three-way `<select>`
 * (`#example_messages_behavior`, normal / keep / strip), not a checkbox, so the
 * dropdown will still read whatever the user chose while Cairn is stripping. The
 * inspector says so in words instead (`ui/inspector.js`).
 *
 * @param {() => object} getContext Returns a fresh SillyTavern.getContext().
 */
export function createExamplesLatch(getContext) {
    /** The user's own value, kept from the first turn Cairn changed it. */
    let theirs = null;
    let applied = false;

    return {
        /**
         * @param {boolean} latched From `examplesSuperseded`.
         * @returns {{stripped: boolean, changed: boolean}} `changed` is the cache
         *          miss: true on the turn the flag actually moves, and on no other.
         */
        apply(latched) {
            const powerUser = getContext()?.powerUserSettings;
            if (!powerUser) return { stripped: false, changed: false };

            const want = Boolean(latched);
            if (want && !applied) {
                theirs = Boolean(powerUser.strip_examples);
                applied = true;
                powerUser.strip_examples = true;
                debug('Example dialogue is superseded by real messages; stripping it from the prompt.');
                return { stripped: true, changed: theirs !== true };
            }
            if (!want && applied) {
                applied = false;
                powerUser.strip_examples = theirs ?? false;
                const changed = powerUser.strip_examples !== true;
                theirs = null;
                return { stripped: Boolean(powerUser.strip_examples), changed };
            }

            return { stripped: applied || Boolean(powerUser.strip_examples), changed: false };
        },

        /**
         * A new chat is a new latch. The user's value goes back first — a chat
         * switch must not leave the next chat stripped because this one was.
         */
        reset() {
            if (applied) {
                const powerUser = getContext()?.powerUserSettings;
                if (powerUser) powerUser.strip_examples = theirs ?? false;
            }
            theirs = null;
            applied = false;
        },

        get stripping() {
            return applied;
        },
    };
}
