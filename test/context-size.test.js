import { describe, expect, it, vi } from 'vitest';
import { createMaxPromptTokens, estimateMaxPromptTokens } from '../src/util/context-size.js';
import { createContext } from './mocks/sillytavern.js';

describe('the prompt budget', () => {
    it('uses ST own answer when script.js gives it', async () => {
        const maxPromptTokens = createMaxPromptTokens({
            load: async () => ({ getMaxPromptTokens: () => 21_888 }),
        });

        expect(await maxPromptTokens(createContext())).toBe(21_888);
    });

    it('imports script.js once, not once a turn', async () => {
        const load = vi.fn(async () => ({ getMaxPromptTokens: () => 21_888 }));
        const maxPromptTokens = createMaxPromptTokens({ load });
        const context = createContext();

        await maxPromptTokens(context);
        await maxPromptTokens(context);
        await maxPromptTokens(context);

        expect(load).toHaveBeenCalledTimes(1);
    });

    /**
     * Cairn never breaks the chat (CLAUDE.md §4.17). A budget we cannot read is
     * a worse budget, not a failed generation — and the fallback reserves a
     * generous share, because overestimating the reserve costs a few summaries
     * and underestimating it overflows the request.
     */
    it('estimates from the context window when the import fails', async () => {
        const maxPromptTokens = createMaxPromptTokens({
            load: async () => { throw new Error('not in a browser'); },
        });
        const context = createContext();

        expect(await maxPromptTokens(context)).toBe(estimateMaxPromptTokens(context));
        expect(await maxPromptTokens(context)).toBeLessThan(context.maxContext);
    });

    it('estimates when ST stops exporting it', async () => {
        const maxPromptTokens = createMaxPromptTokens({ load: async () => ({}) });

        expect(await maxPromptTokens(createContext())).toBe(7_168);
    });

    it('estimates when ST own answer throws or is nonsense', async () => {
        const context = createContext();
        const throwing = createMaxPromptTokens({
            load: async () => ({ getMaxPromptTokens: () => { throw new Error('no api'); } }),
        });
        const zero = createMaxPromptTokens({
            load: async () => ({ getMaxPromptTokens: () => 0 }),
        });

        expect(await throwing(context)).toBe(7_168);
        expect(await zero(context)).toBe(7_168);
    });

    it('is zero rather than NaN with no context window to work from', () => {
        expect(estimateMaxPromptTokens({})).toBe(0);
        expect(estimateMaxPromptTokens(null)).toBe(0);
    });
});
