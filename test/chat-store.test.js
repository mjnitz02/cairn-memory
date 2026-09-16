import { describe, expect, it } from 'vitest';
import { STORE_VERSION } from '../src/store/schema.js';
import { MIN_SUMMARY_TOKENS, readScene, summarisable, writeScene } from '../src/store/chat-store.js';
import { hashString } from '../src/util/hash.js';
import { STORE_V1, STORE_V1_MES, storeV1Message } from './fixtures/store-v1.js';
import { makeQvinkChat } from './mocks/qvink.js';

const IGNORE = Symbol.for('ignore');

describe('the v1 store fixture', () => {
    it('reads as a valid scene', () => {
        const { status, scene } = readScene(storeV1Message());

        expect(status).toBe('valid');
        expect(scene).toEqual(STORE_V1.scene);
    });

    it('is the exact shape the writer produces today', () => {
        // If this fails the stored shape moved: bump STORE_VERSION, keep this
        // fixture as the old shape, and ship a migration (CLAUDE.md §8.32).
        const message = storeV1Message();
        delete message.extra.cairn;
        writeScene(message, { text: STORE_V1.scene.text, prompt: STORE_V1.scene.prompt, at: STORE_V1.scene.at });

        expect(message.extra.cairn).toEqual(STORE_V1);
        expect(STORE_VERSION).toBe(1);
    });
});

describe('reading a scene back', () => {
    it('reports none when Cairn has never written to the message', () => {
        expect(readScene({ mes: 'x', extra: {} })).toEqual({ status: 'none', scene: null });
        expect(readScene({ mes: 'x' })).toEqual({ status: 'none', scene: null });
        expect(readScene(null)).toEqual({ status: 'none', scene: null });
    });

    it('treats an edited message as stale, so its scene is neither injected nor blanked', () => {
        const message = storeV1Message();
        message.mes = `${STORE_V1_MES} Then she laughed.`;

        expect(readScene(message)).toEqual({ status: 'stale', scene: null });
    });

    it('rejects a malformed store rather than trusting part of it', () => {
        const broken = [
            'junk',
            { v: 1 },
            { v: 1, scene: null },
            { v: 1, scene: { ...STORE_V1.scene, text: '' } },
            { v: 1, scene: { ...STORE_V1.scene, text: 42 } },
            { v: 1, scene: { ...STORE_V1.scene, hash: 7 } },
            { v: 1, scene: { ...STORE_V1.scene, prompt: undefined } },
            { scene: STORE_V1.scene },
            { v: 0, scene: STORE_V1.scene },
        ];

        for (const cairn of broken) {
            const message = storeV1Message();
            message.extra.cairn = cairn;
            expect(readScene(message).status, JSON.stringify(cairn)).toBe('invalid');
        }
    });

    it('leaves a store from a newer Cairn alone rather than misreading it', () => {
        const message = storeV1Message();
        message.extra.cairn = { ...STORE_V1, v: STORE_VERSION + 1 };

        expect(readScene(message)).toEqual({ status: 'future', scene: null });
    });
});

describe('writing a scene', () => {
    it('hashes the message as it is at write time', () => {
        const message = { name: 'Aster', mes: 'The fog came in.', extra: {} };
        writeScene(message, { text: 'Fog arrived.', prompt: 'h:00000000000001', at: 'T' });

        expect(message.extra.cairn.scene.hash).toBe(hashString('The fog came in.'));
        expect(readScene(message).status).toBe('valid');
    });

    it('keeps other keys under extra.cairn, which later tiers will share', () => {
        const message = storeV1Message();
        message.extra.cairn.state = { location: 'dock' };
        writeScene(message, { text: 'New.', prompt: 'h:00000000000001', at: 'T' });

        expect(message.extra.cairn.state).toEqual({ location: 'dock' });
        expect(message.extra.cairn.scene.text).toBe('New.');
    });

    it('refuses to overwrite a store from a newer Cairn', () => {
        const message = storeV1Message();
        const future = { v: STORE_VERSION + 1, scene: { text: 'later' } };
        message.extra.cairn = future;

        expect(writeScene(message, { text: 'Older.', prompt: 'h:1', at: 'T' })).toBe(false);
        expect(message.extra.cairn).toBe(future);
    });

    it('refuses an empty summary', () => {
        const message = { mes: 'The fog came in.', extra: {} };

        expect(writeScene(message, { text: '', prompt: 'h:1', at: 'T' })).toBe(false);
        expect(message.extra.cairn).toBeUndefined();
    });

    /**
     * DESIGN.md §9 and plan §6: a clone drops Symbol-keyed flags with no error.
     * The writer assigns onto the live message, so the chat array, each message
     * and each `extra` bag keep their identity, and nobody else's keys move.
     */
    it('writes in place and never clones a message', () => {
        const chat = makeQvinkChat({ length: 3 });
        const messages = [...chat];
        const extras = chat.map((message) => message.extra);
        chat[1].extra[IGNORE] = true;
        chat[2].extra[IGNORE] = true;

        expect(writeScene(chat[1], { text: 'A scene.', prompt: 'h:1', at: 'T' })).toBe(true);

        expect(chat).toEqual(messages);
        chat.forEach((message, i) => {
            expect(message).toBe(messages[i]);
            expect(message.extra).toBe(extras[i]);
        });
        expect(chat[1].extra[IGNORE]).toBe(true);
        expect(chat[2].extra[IGNORE]).toBe(true);
        expect(chat[1].extra.qvink_memory.memory).toBe(makeQvinkChat({ length: 3 })[1].extra.qvink_memory.memory);
    });
});

/**
 * Which messages get a summary (plan §1). Shapes from the corpus: a user turn
 * carries `is_system: false`, a character reply has no `is_system` key at all,
 * and ST hides a message by setting `is_system` (public/scripts/chats.js:157).
 */
describe('which messages are summarisable', () => {
    const long = 'x'.repeat(MIN_SUMMARY_TOKENS * 4);

    it('takes user turns and character replies alike', () => {
        expect(summarisable({ is_user: true, is_system: false, mes: long })).toBe(true);
        expect(summarisable({ is_user: false, mes: long })).toBe(true);
    });

    it('skips hidden and system messages', () => {
        expect(summarisable({ is_user: false, is_system: true, mes: long })).toBe(false);
    });

    it('skips a message under the length threshold, and takes one exactly at it', () => {
        expect(MIN_SUMMARY_TOKENS).toBe(50);
        expect(summarisable({ is_user: true, is_system: false, mes: long.slice(4) })).toBe(false);
        expect(summarisable({ is_user: true, is_system: false, mes: long })).toBe(true);
    });

    it('skips anything that is not a message', () => {
        expect(summarisable(null)).toBe(false);
        expect(summarisable({ is_user: true })).toBe(false);
    });
});
