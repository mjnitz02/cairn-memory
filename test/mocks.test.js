import { describe, expect, it } from 'vitest';
import {
    assembleTextPrompt, continueReply, createContext, getExtensionPrompt, editMessage, extension_prompt_types, makeChat, makeCoreChat, makeMessage, newSwipe, openChat,
    receiveMessage, sendMessage, swipeReply, swipeTo, world_info_position,
} from './mocks/sillytavern.js';
import { badOutputs, badStateOutputs, createRequestService, deferred } from './mocks/llm.js';

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

    it('builds the interceptor\'s chat as ST does: filtered, popped on a swipe, extra shared (public/script.js:4496-4527)', () => {
        const chat = makeChat(4);
        chat[1].is_system = true;
        const core = makeCoreChat(chat);

        expect(core.map((entry) => entry.index)).toEqual([0, 1, 2]);
        expect(core[1]).not.toBe(chat[2]);
        expect(core[1].extra).toBe(chat[2].extra);
        expect(makeCoreChat(chat, { type: 'swipe' })).toHaveLength(2);
    });

    it('swipes as ST does: a new swipe keeps extra, swiping back restores a clone (:6676, :7015)', () => {
        const message = makeMessage({ mes: 'First reply.', extra: { cairn: { v: 2 } } });
        const extra = message.extra;

        newSwipe(message, 'Second reply.');
        expect(message.extra).toBe(extra);
        expect([message.mes, message.swipe_id, message.swipes]).toEqual(['Second reply.', 1, ['First reply.', 'Second reply.']]);

        message.extra.cairn.v = 3;
        swipeTo(message, 0);
        expect(message.mes).toBe('First reply.');
        expect(message.extra).not.toBe(extra);
        expect(message.extra.cairn.v).toBe(2);
        swipeTo(message, 1);
        expect(message.extra.cairn.v).toBe(3);
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

    it('places in-chat prompts by depth from the end, as doChatInject does (public/script.js:5628-5676)', () => {
        const context = createContext({ chat: makeChat(3) });
        const core = makeCoreChat(context.chat);
        const history = (prompt) => prompt.slice(prompt.indexOf('Wren: Wren says something at turn 0.'));

        context.setExtensionPrompt('b_depth0', 'Zero.', extension_prompt_types.IN_CHAT, 0);
        context.setExtensionPrompt('a_depth1', 'One.', extension_prompt_types.IN_CHAT, 1);
        context.setExtensionPrompt('c_user', 'As Wren.', extension_prompt_types.IN_CHAT, 1, false, 1);
        context.setExtensionPrompt('block', 'Block.', extension_prompt_types.IN_PROMPT, 0);

        const prompt = assembleTextPrompt(context, core);
        expect(prompt.startsWith('Story string.\n\nBlock.\n')).toBe(true);
        // System lands below user at the same depth: "most important go lower" (:5636).
        expect(history(prompt)).toBe('Wren: Wren says something at turn 0.\nAster: Aster answers at turn 1.\n'
            + 'Wren: As Wren.\nOne.\nWren: Wren says something at turn 2.\nZero.\n');
        expect(core).toHaveLength(3);
    });

    it('moves a depth-0 prompt above the last message on a continue (:5665), and blanks an ignored message (:5841)', () => {
        const context = createContext({ chat: makeChat(3) });
        context.chat[0].extra[Symbol.for('ignore')] = true;
        context.setExtensionPrompt('zero', 'Zero.', extension_prompt_types.IN_CHAT, 0);

        expect(assembleTextPrompt(context, makeCoreChat(context.chat), { isContinue: true, storyString: '' }))
            .toBe('Aster: Aster answers at turn 1.\nZero.\nWren: Wren says something at turn 2.\n');
    });

    it('collects a position as getExtensionPrompt does: sorted keys, trimmed, joined (:3301-3330)', () => {
        const prompts = {
            b: { value: ' second ', position: 0, depth: 0, role: 0 },
            a: { value: 'first', position: 0, depth: 0, role: 0 },
            c: { value: '', position: 0, depth: 0, role: 0 },
            d: { value: 'elsewhere', position: 1, depth: 0, role: 0 },
        };

        expect(getExtensionPrompt(prompts, 0)).toBe('\nfirst\nsecond\n');
        expect(getExtensionPrompt(prompts, 1, 0, '\n', 0, false)).toBe('elsewhere');
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

    it('emits each chat event with the text already changed, and the swipe or continue type (:5917, :6691, :6716, :8405)', async () => {
        const context = createContext({ chat: makeChat(4) });
        const seen = [];
        const { MESSAGE_SENT, MESSAGE_RECEIVED, MESSAGE_EDITED } = context.eventTypes;
        for (const event of [MESSAGE_SENT, MESSAGE_RECEIVED, MESSAGE_EDITED]) {
            context.eventSource.on(event, (index, type) => seen.push([event, index, type, context.chat[index].mes]));
        }
        const extra = context.chat[3].extra;

        await swipeReply(context, 'Another answer.');
        await continueReply(context, ' And more.');
        await editMessage(context, 1, 'Aster, edited.');
        await sendMessage(context, makeMessage({ name: 'Wren', isUser: true, mes: 'Wren again.' }));

        expect(seen).toEqual([
            ['message_received', 3, 'swipe', 'Another answer.'],
            ['message_received', 3, 'continue', 'Another answer. And more.'],
            ['message_edited', 1, undefined, 'Aster, edited.'],
            ['message_sent', 4, undefined, 'Wren again.'],
        ]);
        expect(context.chat[3].extra).toBe(extra);
        expect(context.chat[1].swipes[0]).toBe('Aster, edited.');
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

    it('offers the malformed state replies the patch parser must survive', () => {
        const state = { location: 'The waiting room', characters: { Aster: { outfit: 'Oilskin coat' }, Wren: { outfit: 'Wool coat, jeans' } } };
        const patch = { location: 'The outer pier', characters: { Wren: { outfit: 'Grey jumper, jeans' } } };

        for (const [name, output] of Object.entries(badStateOutputs)) {
            expect(typeof output(patch, state), name).toBe('string');
        }
        expect(badStateOutputs.fenced(patch)).toMatch(/^```json\n\{/);
        expect(() => JSON.parse(badStateOutputs.truncated(patch))).toThrow();
        expect(JSON.parse(badStateOutputs.fullState(patch, state))).toEqual({
            location: 'The outer pier',
            characters: { Aster: { outfit: 'Oilskin coat' }, Wren: { outfit: 'Grey jumper, jeans' } },
        });
        expect(Object.keys(JSON.parse(badStateOutputs.capitalisedKeys(patch)))).toEqual(['Location', 'Characters']);
        expect(Object.keys(JSON.parse(badStateOutputs.sixCharacters(patch)).characters)).toHaveLength(5);
        expect(badStateOutputs.overlong(patch).length).toBeGreaterThan(160);
    });
});
