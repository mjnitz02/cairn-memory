import { describe, expect, it } from 'vitest';
import { createContext, extension_prompt_types, makeChat, makeMessage, world_info_position } from './mocks/sillytavern.js';
import { badOutputs, createRequestService } from './mocks/llm.js';

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

    it('propagates transport errors', async () => {
        const service = createRequestService({ responses: [new Error('502 Bad Gateway')] });
        await expect(service.sendRequest('p1', 'x', 64)).rejects.toThrow('502 Bad Gateway');
    });

    it('offers the malformed shapes parsers must survive', () => {
        const payload = { promote: [] };
        expect(badOutputs.fencedJson(payload)).toMatch(/^```json/);
        expect(badOutputs.preambleAndFence(payload)).toContain('```json');
        expect(badOutputs.truncated({ a: 'x'.repeat(100) })).not.toContain('}');
        expect(badOutputs.leakedReasoning('body')).toContain('<think>');
        expect(badOutputs.empty()).toBe('');
    });
});
