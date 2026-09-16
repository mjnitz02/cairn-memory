import { describe, expect, it } from 'vitest';
import { createContext, extension_prompt_types, makeChat, makeMessage, openChat, receiveMessage, world_info_position } from './mocks/sillytavern.js';
import { badOutputs, createRequestService, deferred } from './mocks/llm.js';

/**
 * Guards the mocks themselves. A mock that has drifted from ST is worse than no
 * mock, because it makes broken code pass (CLAUDE.md §3.11).
 */
describe('SillyTavern mock', () => {
    it('matches ST enum values we depend on', () => {
        expect(extension_prompt_types.NONE).toBe(-1);
        expect(extension_prompt_types.IN_PROMPT).toBe(0);
        expect(extension_prompt_types.IN_CHAT).toBe(1);
        expect(world_info_position.outlet).toBe(7);
    });

    it('gives every message its own extra bag', () => {
        const a = makeMessage();
        const b = makeMessage();
        a.extra.cairn = { state: 'x' };
        expect(b.extra).toEqual({});
    });

    it('builds an alternating synthetic chat', () => {
        const chat = makeChat(4);
        expect(chat).toHaveLength(4);
        expect(chat.map(m => m.is_user)).toEqual([true, false, true, false]);
    });

    it('records setExtensionPrompt in the shape ST stores', () => {
        const context = createContext();
        context.setExtensionPrompt('cairn_state', 'the state', extension_prompt_types.IN_CHAT, 2);

        expect(context.extensionPrompts.cairn_state).toEqual({
            value: 'the state',
            position: extension_prompt_types.IN_CHAT,
            depth: 2,
            scan: false,
            role: 0,
            filter: null,
        });
    });

    it('awaits every event handler before emit resolves', async () => {
        const context = createContext();
        const seen = [];
        context.eventSource.on('test', async () => {
            await Promise.resolve();
            seen.push('first');
        });
        context.eventSource.on('test', () => seen.push('second'));

        await context.eventSource.emit('test');
        expect(seen).toEqual(['first', 'second']);
    });

    it('emits MESSAGE_RECEIVED with the new message\'s index, after it is in the chat', async () => {
        const context = createContext({ chat: makeChat(4) });
        const seen = [];
        context.eventSource.on(context.eventTypes.MESSAGE_RECEIVED, (index, type) => {
            seen.push({ index, type, present: Boolean(context.chat[index]) });
        });

        await receiveMessage(context, makeMessage({ mes: 'reply' }));

        expect(seen).toEqual([{ index: 4, type: 'normal', present: true }]);
    });

    it('opens a chat by refilling the same array, as getChat does', async () => {
        const context = createContext({ chat: makeChat(4) });
        const array = context.chat;
        const ids = [];
        context.eventSource.on(context.eventTypes.CHAT_CHANGED, (id) => ids.push(id));

        await openChat(context, { chatId: 'other', messages: makeChat(2) });

        expect(context.chat).toBe(array);
        expect(context.chat).toHaveLength(2);
        expect(ids).toEqual(['other']);
    });

    it('exposes connection profiles where ConnectionManagerRequestService reads them', () => {
        const context = createContext({ profiles: [{ id: 'p1', name: 'GLM (memory)' }] });
        expect(context.extensionSettings.connectionManager.profiles[0].id).toBe('p1');
    });
});

describe('memory-model mock', () => {
    it('returns ExtractedData and records the call', async () => {
        const service = createRequestService({ responses: ['a summary'] });
        const result = await service.sendRequest('p1', 'summarise this', 256);

        expect(result).toEqual({ content: 'a summary', reasoning: '' });
        expect(service.calls[0]).toMatchObject({ profileId: 'p1', maxTokens: 256 });
    });

    it('throws on an unexpected extra call rather than returning junk', async () => {
        const service = createRequestService({ responses: ['one'] });
        await service.sendRequest('p1', 'first', 64);
        await expect(service.sendRequest('p1', 'second', 64)).rejects.toThrow(/no queued response/);
    });

    it('wraps transport errors the way ST does', async () => {
        const service = createRequestService({ responses: [new Error('502 Bad Gateway')] });
        const failure = await service.sendRequest('p1', 'x', 64).catch((err) => err);

        expect(failure.message).toBe('API request failed');
        expect(failure.cause.message).toBe('502 Bad Gateway');
    });

    it('holds a deferred reply until the test settles it', async () => {
        const reply = deferred();
        const service = createRequestService({ responses: [reply.promise] });
        let settled = false;
        const request = service.sendRequest('p1', 'x', 64).then((result) => { settled = true; return result; });

        await Promise.resolve();
        expect(settled).toBe(false);
        reply.resolve('late');
        expect(await request).toEqual({ content: 'late', reasoning: '' });
    });

    it('rejects with an AbortError once the signal fires, as fetch does', async () => {
        const controller = new AbortController();
        const service = createRequestService({ responses: [deferred().promise] });
        const request = service.sendRequest('p1', 'x', 64, { signal: controller.signal }).catch((err) => err);

        controller.abort();
        const failure = await request;
        expect(failure.message).toBe('API request failed');
        expect(failure.cause.name).toBe('AbortError');
    });

    it('offers the malformed shapes parsers must survive', () => {
        const summary = 'Aster told Wren the ferry was cancelled. Wren admitted she had read the letter.';
        expect(badOutputs.fenced(summary)).toMatch(/^```/);
        expect(badOutputs.preambleAndFence(summary)).toContain('```text');
        expect(badOutputs.truncated(summary)).not.toMatch(/[.!?]$/);
        expect(badOutputs.bulleted(summary).split('\n')).toHaveLength(2);
        expect(badOutputs.leakedReasoning(summary)).toContain('<think>');
        expect(badOutputs.overlong(summary).length).toBeGreaterThan(500);
        expect(badOutputs.empty()).toBe('');
    });
});
