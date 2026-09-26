/**
 * The lorebook cap (docs/decisions.md D-0069).
 *
 * SillyTavern already caps World Info absolutely — `world_info_budget_cap`,
 * `public/scripts/world-info.js:81` — and ships it at 0, meaning no cap, so the
 * percentage budget is all that ever binds. On the P4 run's book that was 21.6%
 * of the prompt against a 25% default: it had never bound either. The lorebook
 * was the second largest reserve, larger than the card, and nothing was holding
 * it to anything. Cairn sets the number ST left off; the trim in
 * `prompt/lorebook.js` decides *when* the held set is brought back under it.
 *
 * **Why Cairn writes ST's setting rather than keeping a cap of its own.** The
 * reserve is worked out from `world_info_budget_cap` as a live export
 * (`prompt/reserves.js`, D-0016). A private cap would trim what Cairn holds while
 * the reserve still counted ST's larger budget, so the reclaim would vanish into
 * the margin with nothing to see — the same failure the card and the examples
 * latch have to agree about (D-0068) — and ST would keep adding keyword hits past
 * it regardless, because the scan's budget is the only thing the scan obeys.
 *
 * **It persists, and that is the deal.** `updateWorldInfoSettings` ends in
 * `saveSettingsDebounced()` (`:819`, `:852`), and the setting is global rather
 * than per-chat, so unlike the examples latch there is no version of this that
 * lasts only for the session. It is therefore a setting the user owns and can
 * raise, lower or switch off, not something derived behind their back.
 */
import { warn } from '../util/log.js';

/** As `prompt/reserves.js` imports it, and for the same reasons. */
const ST_WORLD_INFO = '/scripts/world-info.js';

/**
 * Cairn's default, in tokens. Sized from the P4 run: the book weighed 4,982
 * tokens of a 23,040-token prompt, and 3,500 takes ~1,480 of that back for the
 * memory block while leaving the lorebook more room than the card has.
 */
export const DEFAULT_LORE_CAP = 3_500;

/**
 * @param {{load?: () => Promise<object>, doc?: object}} [options]
 *        `load` is injected in tests; there is no `/scripts/world-info.js`
 *        outside the browser.
 */
export function createLoreCap({ load = () => import(/* @vite-ignore */ ST_WORLD_INFO), doc = globalThis.document } = {}) {
    let applied = null;

    /**
     * @param {number} cap Tokens; 0 leaves ST's own budget alone, as ST's own 0 does.
     * @returns {Promise<number|null>} What was applied, or null when nothing was.
     */
    async function apply(cap) {
        // `Number(null)` and `Number('')` are both 0, and 0 here means *uncap the
        // lorebook* — so a missing setting or a blanked box would quietly undo the
        // cap rather than be refused. Only a real number counts as one.
        const raw = typeof cap === 'string' ? cap.trim() : cap;
        if (raw === '' || raw === null || raw === undefined || typeof raw === 'boolean') return applied;
        const wanted = Number(raw);
        if (!Number.isFinite(wanted)) return applied;

        try {
            const worldInfo = await load();
            const floored = Math.max(0, Math.floor(wanted));
            if (worldInfo.world_info_budget_cap === floored) {
                applied = floored;
                return applied;
            }
            worldInfo.updateWorldInfoSettings({ world_info_budget_cap: floored });
            // ST's own field would otherwise read whatever it last loaded
            // (world-info.js:989). Written, not triggered — `updateWorldInfoSettings`
            // has already saved, and the field's own handler would save again.
            const input = doc?.getElementById?.('world_info_budget_cap');
            if (input) input.value = String(floored);
            const counter = doc?.getElementById?.('world_info_budget_cap_counter');
            if (counter) counter.value = String(floored);
            applied = floored;
        } catch (err) {
            // The lorebook keeps whatever budget it had, which is ST's own
            // behaviour without Cairn installed (CLAUDE.md §4.17).
            warn('Could not set the World Info budget cap; the lorebook keeps its own budget.', err);
        }
        return applied;
    }

    return {
        apply,
        /** What Cairn last put there, for the inspector. Null until it has run. */
        get applied() {
            return applied;
        },
    };
}
