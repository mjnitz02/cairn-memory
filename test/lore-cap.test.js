import { describe, expect, it } from 'vitest';
import { DEFAULT_LORE_CAP, createLoreCap } from '../src/prompt/lore-cap.js';
import { DEFAULT_SETTINGS, migrateSettings } from '../src/store/schema.js';
import { makeWorldInfoModule } from './mocks/world-info.js';

/**
 * The lorebook cap (docs/decisions.md D-0069).
 *
 * Cairn writes ST's own `world_info_budget_cap` rather than keeping a private
 * number, because the reserve reads that export live (`prompt/reserves.js`,
 * D-0016) and ST's scan obeys nothing else. So the thing worth testing is that
 * the write lands where the reserve will read it, and that every way it can fail
 * leaves the lorebook with the budget it already had.
 */
function setup({ budgetCap = 0, ...rest } = {}) {
    const worldInfo = makeWorldInfoModule({ budgetCap, ...rest });
    const doc = {
        fields: new Map(),
        getElementById(id) {
            return this.fields.get(id) ?? null;
        },
    };
    doc.fields.set('world_info_budget_cap', { value: '0' });
    doc.fields.set('world_info_budget_cap_counter', { value: '0' });
    const loreCap = createLoreCap({ load: async () => worldInfo, doc });
    return { worldInfo, doc, loreCap };
}

describe('the lorebook cap', () => {
    it('writes the cap where the reserve reads it', async () => {
        const { worldInfo, loreCap } = setup();

        await loreCap.apply(3_500);

        expect(worldInfo.world_info_budget_cap).toBe(3_500);
        expect(loreCap.applied).toBe(3_500);
    });

    it('leaves ST alone when the value is already there', async () => {
        // The bootstrap applies it on every load. Writing it each time would save
        // settings on every page load for no change at all.
        const { worldInfo, loreCap } = setup({ budgetCap: 3_500 });

        await loreCap.apply(3_500);

        expect(worldInfo.saves).toBe(0);
        expect(loreCap.applied).toBe(3_500);
    });

    it('takes 0 as "no cap", which is what ST means by it', async () => {
        const { worldInfo, loreCap } = setup({ budgetCap: 3_500 });

        await loreCap.apply(0);

        expect(worldInfo.world_info_budget_cap).toBe(0);
    });

    it('brings ST\'s own field up to date, so its panel does not lie', async () => {
        // world-info.js:989 — ST sets that field from the stored value on load and
        // never again, so a write behind it leaves the number on screen stale.
        const { doc, loreCap } = setup();

        await loreCap.apply(3_500);

        expect(doc.getElementById('world_info_budget_cap').value).toBe('3500');
        expect(doc.getElementById('world_info_budget_cap_counter').value).toBe('3500');
    });

    it('refuses a value that is not a number, rather than capping at nothing', async () => {
        const { worldInfo, loreCap } = setup({ budgetCap: 3_500 });

        for (const bad of [undefined, null, NaN, 'lots', {}]) {
            await loreCap.apply(bad);
            expect(worldInfo.world_info_budget_cap).toBe(3_500);
        }
    });

    it('clamps a negative cap to no cap instead of writing one', async () => {
        const { worldInfo, loreCap } = setup({ budgetCap: 3_500 });

        await loreCap.apply(-200);

        expect(worldInfo.world_info_budget_cap).toBe(0);
    });

    it('rounds a fractional cap down to whole tokens', async () => {
        const { worldInfo, loreCap } = setup();

        await loreCap.apply(3_500.9);

        expect(worldInfo.world_info_budget_cap).toBe(3_500);
    });

    it('leaves the lorebook as it was when ST cannot be reached', async () => {
        // CLAUDE.md §4.17: a failed import degrades to ST's own behaviour, which
        // is the budget it already had — never to a cap of zero tokens.
        const loreCap = createLoreCap({
            load: async () => { throw new Error('no world-info module'); },
            doc: null,
        });

        await expect(loreCap.apply(3_500)).resolves.toBeNull();
        expect(loreCap.applied).toBeNull();
    });

    it('works with no document at all, as it would outside a browser', async () => {
        const worldInfo = makeWorldInfoModule({});
        const loreCap = createLoreCap({ load: async () => worldInfo, doc: undefined });

        await loreCap.apply(3_500);

        expect(worldInfo.world_info_budget_cap).toBe(3_500);
    });
});

describe('the lorebook cap as a setting', () => {
    it('ships with a cap, because ST ships without one', async () => {
        expect(DEFAULT_SETTINGS.loreCap).toBe(DEFAULT_LORE_CAP);
        expect(DEFAULT_LORE_CAP).toBe(3_500);
    });

    it('reaches an install that predates it, without a version bump', () => {
        // Adding a key with a default needs no migration (store/schema.js).
        const older = migrateSettings({ version: 1, enabled: true, holdWorldInfo: false });

        expect(older.loreCap).toBe(DEFAULT_LORE_CAP);
        expect(older.holdWorldInfo).toBe(false);
    });

    it('keeps a cap the user chose', () => {
        expect(migrateSettings({ version: 1, loreCap: 0 }).loreCap).toBe(0);
        expect(migrateSettings({ version: 1, loreCap: 6_000 }).loreCap).toBe(6_000);
    });
});
