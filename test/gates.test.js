import { describe, expect, it } from 'vitest';
import { assessCompaction, assessStateUpdates, assessSummarizing } from '../src/pipeline/gates.js';
import { QVINK_EXTENSION } from '../src/memory/scenes.js';
import { WTRACKERS } from '../src/memory/state.js';
import { createRequestService } from './mocks/llm.js';
import { createContext } from './mocks/sillytavern.js';

const MEMORY = { id: 'memory-profile', name: 'GLM (memory)' };
const ROLEPLAY = { id: 'roleplay-profile', name: 'Local (roleplay)' };

const context = (overrides = {}) => createContext({ profiles: [MEMORY, ROLEPLAY], requestService: createRequestService(), ...overrides });

describe('whether Cairn may summarise', () => {
    it('is ready with a memory profile, a single-character chat and a quiet qvink', () => {
        expect(assessSummarizing(context(), { memoryProfileId: MEMORY.id })).toEqual({ ready: true, reason: 'ready', sameProfile: false });
    });

    it('never calls a model without a memory profile (D-0006)', () => {
        expect(assessSummarizing(context(), { memoryProfileId: '' }).reason).toBe('no-profile');
        expect(assessSummarizing(context(), {}).reason).toBe('no-profile');
    });

    it('stays out of group chats and away from no chat at all (DESIGN.md §3.5)', () => {
        const group = context();
        group.groupId = 'a-group';
        const none = context();
        none.chatId = undefined;

        expect(assessSummarizing(group, { memoryProfileId: MEMORY.id }).reason).toBe('group-chat');
        expect(assessSummarizing(none, { memoryProfileId: MEMORY.id }).reason).toBe('no-chat');
    });

    it('needs Connection Manager, which sendRequest itself refuses without (extensions/shared.js:427)', () => {
        const disabled = context();
        disabled.extensionSettings.disabledExtensions.push('connection-manager');
        const absent = context({ requestService: null });

        expect(assessSummarizing(disabled, { memoryProfileId: MEMORY.id }).reason).toBe('no-connection-manager');
        expect(assessSummarizing(absent, { memoryProfileId: MEMORY.id }).reason).toBe('no-connection-manager');
    });

    it('notices a memory profile that has since been deleted', () => {
        expect(assessSummarizing(context(), { memoryProfileId: 'gone' }).reason).toBe('profile-missing');
    });

    it('waits while qvink is still summarising the same messages', () => {
        const busy = context({ extensions: [QVINK_EXTENSION] });
        busy.extensionSettings.qvink_memory = { auto_summarize: true };

        expect(assessSummarizing(busy, { memoryProfileId: MEMORY.id }).reason).toBe('qvink-summarising');
    });

    it('does not wait on a disabled or uninstalled qvink\'s leftover Auto Summarize', () => {
        // ST keeps an extension's settings after it is disabled or removed.
        const disabled = context({ extensions: [QVINK_EXTENSION] });
        disabled.extensionSettings.disabledExtensions.push(QVINK_EXTENSION);
        const uninstalled = context();
        for (const leftover of [disabled, uninstalled]) leftover.extensionSettings.qvink_memory = { auto_summarize: true };

        expect(assessSummarizing(disabled, { memoryProfileId: MEMORY.id }).reason).toBe('ready');
        expect(assessSummarizing(uninstalled, { memoryProfileId: MEMORY.id }).reason).toBe('ready');
    });

    it('flags a memory profile that is the chat\'s own', () => {
        const same = context({ selectedProfile: MEMORY.id });

        expect(assessSummarizing(same, { memoryProfileId: MEMORY.id })).toEqual({ ready: true, reason: 'ready', sameProfile: true });
    });
});

describe('whether Cairn may update the world state', () => {
    const settings = { memoryProfileId: MEMORY.id };

    it('is ready with a memory profile and a single-character chat', () => {
        expect(assessStateUpdates(context(), settings)).toEqual({ ready: true, reason: 'ready', sameProfile: false, tracker: null });
    });

    it('needs what summaries need, for the same reasons', () => {
        const group = context();
        group.groupId = 'a-group';
        const absent = context({ requestService: null });

        expect(assessStateUpdates(context(), {}).reason).toBe('no-profile');
        expect(assessStateUpdates(group, settings).reason).toBe('group-chat');
        expect(assessStateUpdates(absent, settings).reason).toBe('no-connection-manager');
        expect(assessStateUpdates(context(), { memoryProfileId: 'gone' }).reason).toBe('profile-missing');
    });

    it('says it is off before anything else, and on unless switched off', () => {
        expect(assessStateUpdates(context(), { worldState: false }).reason).toBe('off');
        expect(assessStateUpdates(context(), { ...settings, worldState: true }).ready).toBe(true);
    });

    it('does not wait on qvink, which keeps no state', () => {
        const busy = context({ extensions: [QVINK_EXTENSION] });
        busy.extensionSettings.qvink_memory = { auto_summarize: true };

        expect(assessStateUpdates(busy, settings).ready).toBe(true);
    });

    it('stands aside while WTracker or WTrackerLite is loaded, and names it (D-0046)', () => {
        for (const tracker of WTRACKERS) {
            const loaded = context({ extensions: [tracker.extension] });
            expect(assessStateUpdates(loaded, settings)).toEqual({
                ready: false, reason: 'wtracker-loaded', sameProfile: false, tracker: tracker.name,
            });
        }
    });

    it('flags a memory profile that is the chat\'s own', () => {
        expect(assessStateUpdates(context({ selectedProfile: MEMORY.id }), settings).sameProfile).toBe(true);
    });
});

/** docs/p4-plan.md decision 9: what a compaction pass needs, and the handover's say in it. */
describe('whether Cairn may run a compaction pass', () => {
    const ready = { memoryProfileId: MEMORY.id, keepCanon: true };

    it('is ready with a memory profile and Cairn writing the block', () => {
        expect(assessCompaction(context(), ready, { writing: true }))
            .toEqual({ ready: true, reason: 'ready', sameProfile: false });
    });

    it('shows the switch first when the user turned it off', () => {
        // Even where something else would also block it: `off` is the reason worth showing.
        expect(assessCompaction(context(), { memoryProfileId: '', keepCanon: false }, { writing: true }).reason).toBe('off');
    });

    /**
     * The one gate summaries and the state do not have. While qvink is injecting,
     * Cairn is measuring and nothing more (docs/decisions.md D-0020, D-0027), and a
     * canon section would put bytes in the block qvink's own render cannot match.
     */
    it('waits while qvink is still writing the block', () => {
        expect(assessCompaction(context(), ready, { writing: false }).reason).toBe('not-writing');
        expect(assessCompaction(context(), ready, { writing: true }).ready).toBe(true);
        // No verdict yet — the assembler has not planned a turn — is not a closed gate.
        expect(assessCompaction(context(), ready, {}).ready).toBe(true);
    });

    it('needs everything every memory call needs', () => {
        const group = context();
        group.groupId = 'a-group';

        expect(assessCompaction(context(), { keepCanon: true }, { writing: true }).reason).toBe('no-profile');
        expect(assessCompaction(group, ready, { writing: true }).reason).toBe('group-chat');
    });

    it('says when the memory profile is the one the chat is using', () => {
        const same = context({ selectedProfile: MEMORY.id });

        expect(assessCompaction(same, ready, { writing: true })).toMatchObject({ ready: true, sameProfile: true });
    });

    it('is on by default, so an unconfigured install still promotes', () => {
        expect(assessCompaction(context(), { memoryProfileId: MEMORY.id }, { writing: true }).ready).toBe(true);
    });
});
