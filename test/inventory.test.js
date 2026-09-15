import { describe, expect, it } from 'vitest';
import { buildInventory, classifySource, summarizeInventory } from '../src/prompt/inventory.js';
import { extension_prompt_types } from './mocks/sillytavern.js';

describe('classifySource', () => {
    it.each([
        ['cairn_state', 'cairn'],
        ['customWIOutlet_canon', 'wi-outlet'],
        ['customDepthWI_2_0', 'wi-depth'],
        ['qvink_memory_short', 'qvink'],
        ['1_memory', 'st-summary'],
        ['2_floating_prompt', 'authors-note'],
        ['DEPTH_PROMPT_0', 'depth-prompt'],
        ['__STORY_STRING__', 'story-string'],
        ['something_else', 'other'],
    ])('classifies %s as %s', (key, owner) => {
        expect(classifySource(key).owner).toBe(owner);
    });

    it('names the outlet so a lorebook entry is identifiable', () => {
        expect(classifySource('customWIOutlet_canon').label).toBe('Lorebook outlet: canon');
    });
});

describe('buildInventory', () => {
    const prompts = {
        qvink_memory_short: { value: 'short memory', position: extension_prompt_types.IN_CHAT, depth: 2, role: 0 },
        __STORY_STRING__: { value: 'the story string', position: extension_prompt_types.IN_PROMPT, depth: 0, role: 0 },
        customDepthWI_0_0: { value: 'a lorebook entry', position: extension_prompt_types.IN_CHAT, depth: 0, role: 0 },
        cleared: { value: '', position: extension_prompt_types.IN_CHAT, depth: 0, role: 0 },
    };

    it('skips cleared injections — they are not writers', async () => {
        expect((await buildInventory(prompts)).map(e => e.key)).not.toContain('cleared');
    });

    it('orders by position, then deepest first within in-chat', async () => {
        expect((await buildInventory(prompts)).map(e => e.key)).toEqual([
            '__STORY_STRING__',   // in-prompt, earliest
            'qvink_memory_short', // in-chat @ depth 2
            'customDepthWI_0_0',  // in-chat @ depth 0, nearest the end
        ]);
    });

    it('names the placement rather than leaving a bare enum', async () => {
        const [first] = await buildInventory(prompts);
        expect(first.positionName).toBe('in-prompt');
    });

    it('survives an empty or missing prompt bag', async () => {
        expect(await buildInventory({})).toEqual([]);
        expect(await buildInventory(undefined)).toEqual([]);
    });

    it('marks chars/4 counts as estimates, and real tokenizer counts as not', async () => {
        // The two must not be compared with the prompt total interchangeably.
        const [estimated] = await buildInventory(prompts);
        expect(estimated.estimated).toBe(true);

        const [counted] = await buildInventory(prompts, { countTokens: async () => 42 });
        expect(counted).toMatchObject({ tokens: 42, estimated: false });
    });
});

describe('summarizeInventory', () => {
    it('counts distinct writers — more than one is the problem being solved', async () => {
        const summary = summarizeInventory(await buildInventory({
            qvink_memory_short: { value: 'a'.repeat(400), position: 1, depth: 2, role: 0 },
            qvink_memory_long: { value: 'b'.repeat(400), position: 0, depth: 0, role: 0 },
            cairn_state: { value: 'c'.repeat(100), position: 1, depth: 2, role: 0 },
        }));

        expect(summary.count).toBe(3);
        expect(summary.writers).toBe(2);
        expect(summary.byOwner[0].owner).toBe('qvink'); // ordered by weight
        expect(summary.tokens).toBe(summary.byOwner.reduce((t, o) => t + o.tokens, 0));
    });

    it('is empty-safe', () => {
        expect(summarizeInventory([])).toMatchObject({ count: 0, tokens: 0, writers: 0 });
    });
});
