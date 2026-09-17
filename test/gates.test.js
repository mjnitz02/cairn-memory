import { describe, expect, it } from 'vitest';
import { assessStateUpdates, assessSummarizing } from '../src/pipeline/gates.js';
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

    it('stands aside while WTracker or WTrackerLite is loaded, and names it (decision 8)', () => {
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
