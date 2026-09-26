import { describe, expect, it } from 'vitest';
import { STORE_VERSION } from '../src/store/schema.js';
import {
    MIN_SUMMARY_TOKENS, hashRange, readCanon, readIndex, readRange, readScene, readState,
    summarisable, writeCanon, writeIndex, writeScene, writeState,
} from '../src/store/chat-store.js';
import { hashString } from '../src/util/hash.js';
import { STORE_V1, STORE_V1_MES, storeV1Message } from './fixtures/store-v1.js';
import { STORE_V2, STORE_V2_MES, storeV2Chat } from './fixtures/store-v2.js';
import { STORE_V3, STORE_V3_CANON, storeV3Chat } from './fixtures/store-v3.js';
import { STORE_V4, STORE_V4_CANON, storeV4Chat } from './fixtures/store-v4.js';
import { STORE_V4_CANON_UNCITED } from './fixtures/store-v4-uncited.js';
import { makeQvinkChat } from './mocks/qvink.js';

const IGNORE = Symbol.for('ignore');

/** A record `validRecord` accepts (memory/index-record.js), for the store's own tests. */
const RECORD = Object.freeze({
    kind: 'major',
    who: Object.freeze(['Aster', 'Wren']),
    what: 'Aster promised to get Wren across before the feast day',
    changed: 'Wren has a crossing promised',
    because: 'the ferry was posted delayed',
});

describe('the v1 store fixture', () => {
    it('reads as a valid scene with no state', () => {
        const message = storeV1Message();
        const { status, scene } = readScene(message);

        expect(status).toBe('valid');
        expect(scene).toEqual(STORE_V1.scene);
        expect(readState([message], 0)).toEqual({ status: 'none', state: null });
    });

    it('is upgraded to the current version by the next write, keeping its scene', () => {
        const message = storeV1Message();
        const chat = [message];
        writeState(chat, 0, { value: { weather: 'Dusk, clearing' }, read: 1, changed: ['weather'], prompt: 'h:1', at: 'T' });

        expect(message.extra.cairn.v).toBe(STORE_VERSION);
        expect(message.extra.cairn.scene).toEqual(STORE_V1.scene);
        expect(readScene(message).status).toBe('valid');
        expect(readState(chat, 0).status).toBe('valid');
    });
});

describe('the v2 store fixture', () => {
    it('reads as a valid scene and a valid state', () => {
        const chat = storeV2Chat();

        expect(readScene(chat[1])).toEqual({ status: 'valid', scene: STORE_V2.scene });
        expect(readState(chat, 1)).toEqual({ status: 'valid', state: STORE_V2.state });
    });

    it('reports no canon, so a v2 store is already a v3 one', () => {
        const chat = storeV2Chat();

        expect(readCanon(chat[1])).toEqual({ status: 'none', canon: null });
    });

    it('is upgraded to the current version by the next write, keeping its scene and state', () => {
        const chat = storeV2Chat();
        writeCanon(chat, 1, { facts: [], covers: [0, 1], prompt: 'h:1', at: 'T' });

        expect(chat[1].extra.cairn.v).toBe(STORE_VERSION);
        expect(readScene(chat[1])).toEqual({ status: 'valid', scene: STORE_V2.scene });
        expect(readState(chat, 1)).toEqual({ status: 'valid', state: STORE_V2.state });
    });
});

describe('the v3 store fixture', () => {
    it('reads as a canon batch behind the raw window and a state on the newest message', () => {
        const chat = storeV3Chat();

        expect(readCanon(chat[1])).toEqual({ status: 'valid', canon: STORE_V3_CANON.canon });
        expect(readScene(chat[1])).toEqual({ status: 'valid', scene: STORE_V3_CANON.scene });
        expect(readCanon(chat[3])).toEqual({ status: 'none', canon: null });
        expect(readState(chat, 3)).toEqual({ status: 'valid', state: STORE_V3.state });
    });

    it('reads with no index record, which is what a v3 chat is', () => {
        const chat = storeV3Chat();

        expect(readIndex(chat[1])).toEqual({ status: 'none', index: null });
        expect(readIndex(chat[3])).toEqual({ status: 'none', index: null });
    });

    it('upgrades to v4 on the next write, keeping every key it already had', () => {
        // The migration is not written back on its own: the next write stores the
        // current shape and nothing is lost on the way (schema.js).
        const chat = storeV3Chat();
        expect(chat[1].extra.cairn.v).toBe(3);

        expect(writeIndex(chat, 1, { record: RECORD, prompt: 'h:index', at: 'T' })).toBe(true);

        expect(chat[1].extra.cairn.v).toBe(STORE_VERSION);
        expect(readScene(chat[1])).toEqual({ status: 'valid', scene: STORE_V3_CANON.scene });
        expect(readCanon(chat[1])).toEqual({ status: 'valid', canon: STORE_V3_CANON.canon });
        expect(readIndex(chat[1]).status).toBe('valid');
    });
});

describe('the v4 store fixture', () => {
    it('reads all four tiers, the index record beside the summary it came from', () => {
        const chat = storeV4Chat();

        expect(readScene(chat[1])).toEqual({ status: 'valid', scene: STORE_V4_CANON.scene });
        expect(readIndex(chat[1])).toEqual({ status: 'valid', index: STORE_V4_CANON.index });
        expect(readCanon(chat[1])).toEqual({ status: 'valid', canon: STORE_V4_CANON.canon });
        expect(readIndex(chat[3])).toEqual({ status: 'valid', index: STORE_V4.index });
        expect(readState(chat, 3)).toEqual({ status: 'valid', state: STORE_V4.state });
    });

    it('is the exact shape the writers produce today', () => {
        // If this fails the stored shape moved: bump STORE_VERSION, keep this
        // fixture as the old shape, and ship a migration (CLAUDE.md §8.32).
        const chat = storeV4Chat();
        delete chat[1].extra.cairn;
        delete chat[3].extra.cairn;
        const { scene: canonScene, index: canonIndex, canon } = STORE_V4_CANON;
        const { scene, index, state } = STORE_V4;
        writeScene(chat[1], { text: canonScene.text, prompt: canonScene.prompt, at: canonScene.at });
        writeIndex(chat, 1, {
            record: structuredClone(canonIndex.record), prompt: canonIndex.prompt, at: canonIndex.at,
        });
        writeCanon(chat, 1, {
            facts: structuredClone(canon.facts), covers: [...canon.covers], slots: canon.slots,
            prompt: canon.prompt, at: canon.at,
        });
        writeScene(chat[3], { text: scene.text, prompt: scene.prompt, at: scene.at });
        writeIndex(chat, 3, { record: structuredClone(index.record), prompt: index.prompt, at: index.at });
        writeState(chat, 3, {
            value: structuredClone(state.value), read: state.read, changed: [...state.changed], prompt: state.prompt, at: state.at,
        });

        expect(chat[1].extra.cairn).toEqual(STORE_V4_CANON);
        expect(chat[3].extra.cairn).toEqual(STORE_V4);
        expect(STORE_VERSION).toBe(4);
    });

    it('holds the hash of the summary, not of the message', () => {
        // What makes a resummarise invalidate the record (chat-store.js).
        const chat = storeV4Chat();

        expect(STORE_V4_CANON.index.hash).toBe(hashString(STORE_V4_CANON.scene.text));
        expect(STORE_V4_CANON.index.hash).not.toBe(hashString(chat[1].mes));
    });
});

describe('reading a scene back', () => {
    it('reports none when Cairn has never written a scene to the message', () => {
        expect(readScene({ mes: 'x', extra: {} })).toEqual({ status: 'none', scene: null });
        // The state tier reaches the newest message before any summary does.
        expect(readScene({ mes: 'x', extra: { cairn: { v: 2, state: STORE_V2.state } } })).toEqual({ status: 'none', scene: null });
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

    it('keeps a state already on the message', () => {
        const chat = storeV2Chat();
        writeScene(chat[1], { text: 'New.', prompt: 'h:00000000000001', at: 'T' });

        expect(chat[1].extra.cairn.state).toEqual(STORE_V2.state);
        expect(readState(chat, 1).status).toBe('valid');
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

/** A chat of alternating turns, long enough for ranges to fall anywhere in it. */
function plainChat(length = 6) {
    return makeQvinkChat({ length }).map(({ name, is_user, is_system, mes }) => ({ name, is_user, is_system, mes, extra: {} }));
}

function stateOn(chat, index, read, value = { location: 'The pier' }) {
    expect(writeState(chat, index, { value, read, changed: ['location'], prompt: 'h:1', at: 'T' })).toBe(true);
}

describe('the range a state read', () => {
    it('is the visible messages ending at the state, oldest first', () => {
        const chat = plainChat(6);
        chat[3].is_system = true;

        expect(readRange(chat, 5, 3)).toEqual([chat[2], chat[4], chat[5]]);
    });

    it('does not exist when the state message is hidden or the chat is too short', () => {
        const chat = plainChat(4);

        expect(readRange(chat, 1, 3)).toBeNull();
        chat[3].is_system = true;
        expect(readRange(chat, 3, 1)).toBeNull();
        expect(readRange(chat, 9, 1)).toBeNull();
        expect(readRange(chat, 3, 0)).toBeNull();
    });

    it('hashes as `name: mes` lines, so a rename counts as a change', () => {
        const chat = plainChat(2);

        expect(hashRange(chat)).toBe(hashString(`Wren: ${chat[0].mes}\nAster: ${chat[1].mes}`));
    });
});

describe('reading a state back', () => {
    it('reports none when there is no state, and future for a newer Cairn', () => {
        const chat = plainChat(2);
        expect(readState(chat, 1)).toEqual({ status: 'none', state: null });
        expect(readState(chat, 7)).toEqual({ status: 'none', state: null });

        chat[1].extra.cairn = { v: STORE_VERSION + 1, state: STORE_V2.state };
        expect(readState(chat, 1)).toEqual({ status: 'future', state: null });
    });

    it('rejects a malformed state rather than trusting part of it', () => {
        const broken = [
            null,
            'junk',
            { ...STORE_V2.state, value: null },
            { ...STORE_V2.state, value: ['location'] },
            { ...STORE_V2.state, read: 0 },
            { ...STORE_V2.state, read: 1.5 },
            { ...STORE_V2.state, hash: 7 },
            { ...STORE_V2.state, changed: 'location' },
            { ...STORE_V2.state, changed: [3] },
            { ...STORE_V2.state, prompt: undefined },
            { ...STORE_V2.state, at: undefined },
        ];

        for (const state of broken) {
            const chat = storeV2Chat();
            chat[1].extra.cairn.state = state;
            expect(readState(chat, 1).status, JSON.stringify(state)).toBe('invalid');
        }
    });

    /** Decision 7: any change inside the range the state read makes it stale. */
    it.each([
        ['an edit to its own message', (chat) => { chat[5].mes += ' Then she laughed.'; }],
        ['an edit to an earlier message it read', (chat) => { chat[4].mes += ' Then she laughed.'; }],
        ['hiding a message it read', (chat) => { chat[4].is_system = true; }],
        ['unhiding a message inside its range', (chat) => { chat[4].is_system = false; }, (chat) => { chat[4].is_system = true; }],
        ['deleting a message it read', (chat) => { chat.splice(4, 1); }, undefined, 4],
        ['hiding its own message', (chat) => { chat[5].is_system = true; }],
        ['renaming a speaker it read', (chat) => { chat[4].name = 'Rook'; }],
    ])('is stale after %s', (_, change, before = () => {}, index = 5) => {
        const chat = plainChat(6);
        before(chat);
        stateOn(chat, 5, 2);
        change(chat);

        expect(readState(chat, index)).toEqual({ status: 'stale', state: null });
    });

    it('stays valid after an edit outside its range', () => {
        const chat = plainChat(6);
        stateOn(chat, 5, 2);
        chat[3].mes += ' Then she laughed.';
        chat[0].is_system = true;

        expect(readState(chat, 5).status).toBe('valid');
    });

    it('stays valid when a message after it is edited, deleted or added: no cascade', () => {
        const chat = plainChat(6);
        stateOn(chat, 3, 2);
        chat[4].mes += ' Then she laughed.';
        chat.splice(5, 1);
        chat.push({ name: 'Aster', is_user: false, mes: 'A new reply.', extra: {} });

        expect(readState(chat, 3).status).toBe('valid');
    });

    it('stays valid when an earlier message outside its range is deleted, since it counts back from itself', () => {
        const chat = plainChat(6);
        stateOn(chat, 5, 2);
        chat.splice(1, 1);

        expect(readState(chat, 4).status).toBe('valid');
    });

    /** A new swipe keeps `extra` and replaces `mes` (public/script.js:6671-6684). */
    it('is stale on a new swipe of its message, and valid again when swiped back', () => {
        const chat = storeV2Chat();
        const reply = chat[1];
        reply.swipes.push('');
        reply.swipe_id = 1;
        reply.mes = '';

        expect(readState(chat, 1).status).toBe('stale');

        reply.mes = 'A different reply.';
        expect(readState(chat, 1).status).toBe('stale');

        reply.swipe_id = 0;
        reply.mes = STORE_V2_MES;
        expect(readState(chat, 1).status).toBe('valid');
    });
});

describe('writing a state', () => {
    it('hashes the range as it is at write time', () => {
        const chat = plainChat(4);
        stateOn(chat, 3, 3);

        expect(chat[3].extra.cairn.state.hash).toBe(hashRange(chat.slice(1)));
        expect(chat[3].extra.cairn.state.read).toBe(3);
    });

    it('refuses what would corrupt the store', () => {
        const refused = [
            [plainChat(2), 1, { value: null, read: 1, changed: [], prompt: 'h:1' }],
            [plainChat(2), 1, { value: {}, read: 3, changed: [], prompt: 'h:1' }],
            [plainChat(2), 1, { value: {}, read: 1, changed: 'weather', prompt: 'h:1' }],
            [plainChat(2), 1, { value: {}, read: 1, changed: [], prompt: 5 }],
            [plainChat(2), 4, { value: {}, read: 1, changed: [], prompt: 'h:1' }],
        ];
        const hidden = plainChat(2);
        hidden[1].is_system = true;
        refused.push([hidden, 1, { value: {}, read: 1, changed: [], prompt: 'h:1' }]);

        for (const [chat, index, state] of refused) {
            expect(writeState(chat, index, state), JSON.stringify(state)).toBe(false);
            expect(chat.every((message) => message.extra.cairn === undefined)).toBe(true);
        }
    });

    it('refuses to overwrite a store from a newer Cairn', () => {
        const chat = plainChat(2);
        const future = { v: STORE_VERSION + 1, state: { value: {} } };
        chat[1].extra.cairn = future;

        expect(writeState(chat, 1, { value: {}, read: 1, changed: [], prompt: 'h:1', at: 'T' })).toBe(false);
        expect(chat[1].extra.cairn).toBe(future);
    });

    it('replaces the previous state on the same message and keeps the scene', () => {
        const chat = storeV2Chat();
        writeState(chat, 1, { value: { weather: 'Night, clear' }, read: 1, changed: ['weather'], prompt: 'h:1', at: 'T' });

        expect(chat[1].extra.cairn.scene).toEqual(STORE_V2.scene);
        expect(chat[1].extra.cairn.state.value).toEqual({ weather: 'Night, clear' });
        expect(readState(chat, 1).status).toBe('valid');
    });

    it('writes in place and never clones a message', () => {
        const chat = makeQvinkChat({ length: 3 });
        const messages = [...chat];
        const extras = chat.map((message) => message.extra);
        chat[1].extra[IGNORE] = true;
        chat[2].extra[IGNORE] = true;

        expect(writeState(chat, 2, { value: {}, read: 2, changed: [], prompt: 'h:1', at: 'T' })).toBe(true);

        expect(chat).toEqual(messages);
        chat.forEach((message, i) => {
            expect(message).toBe(messages[i]);
            expect(message.extra).toBe(extras[i]);
        });
        expect(chat[1].extra[IGNORE]).toBe(true);
        expect(chat[2].extra[IGNORE]).toBe(true);
    });
});

describe('reading a canon batch back', () => {
    it('reports none when Cairn has never written one to the message', () => {
        expect(readCanon({ mes: 'x', extra: {} })).toEqual({ status: 'none', canon: null });
        expect(readCanon({ mes: 'x', extra: { cairn: { v: 3, state: STORE_V3.state } } })).toEqual({ status: 'none', canon: null });
        expect(readCanon({ mes: 'x' })).toEqual({ status: 'none', canon: null });
        expect(readCanon(null)).toEqual({ status: 'none', canon: null });
    });

    it('keeps a batch valid after its messages are edited (docs/p4-plan.md decision 2)', () => {
        // A scene and a state cache text and go stale when it changes. A canon fact
        // says something *happened*, and no edit unmakes that.
        const chat = storeV3Chat();
        chat[0].mes = 'Something else entirely.';
        chat[1].mes = `${chat[1].mes} Then the fog closed in.`;

        expect(readScene(chat[1]).status).toBe('stale');
        expect(readCanon(chat[1])).toEqual({ status: 'valid', canon: STORE_V3_CANON.canon });
    });

    it('takes an empty batch, which records a pass that found nothing durable', () => {
        const chat = storeV3Chat();
        writeCanon(chat, 1, { facts: [], covers: [0, 1], prompt: 'h:1', at: 'T' });

        expect(readCanon(chat[1])).toEqual({
            status: 'valid', canon: { facts: [], covers: [0, 1], prompt: 'h:1', at: 'T' },
        });
    });

    it('rejects a malformed batch rather than trusting part of it', () => {
        const { canon } = STORE_V3_CANON;
        const broken = [
            { ...canon, facts: null },
            { ...canon, facts: {} },
            { ...canon, facts: [{ text: 'A fact.' }] },
            { ...canon, facts: [{ text: '', entities: [] }] },
            { ...canon, facts: [{ text: 42, entities: [] }] },
            { ...canon, facts: [{ text: 'A fact.', entities: 'Wren' }] },
            { ...canon, facts: [{ text: 'A fact.', entities: [7] }] },
            { ...canon, facts: [{ text: 'A fact.', entities: [''] }] },
            { ...canon, covers: [0] },
            { ...canon, covers: [0, 1, 2] },
            { ...canon, covers: [1, 0] },
            { ...canon, covers: ['0', '1'] },
            { ...canon, covers: [0.5, 1] },
            { ...canon, prompt: undefined },
            { ...canon, at: 7 },
        ];

        for (const batch of broken) {
            const chat = storeV3Chat();
            chat[1].extra.cairn = { v: 3, canon: batch };
            expect(readCanon(chat[1]).status, JSON.stringify(batch)).toBe('invalid');
        }
    });

    it('leaves a batch from a newer Cairn alone rather than misreading it', () => {
        const chat = storeV3Chat();
        chat[1].extra.cairn = { ...STORE_V3_CANON, v: STORE_VERSION + 1 };

        expect(readCanon(chat[1])).toEqual({ status: 'future', canon: null });
    });
});

describe('writing a canon batch', () => {
    it('keeps the scene and state already on the message', () => {
        const chat = storeV3Chat();
        writeCanon(chat, 3, { facts: [{ text: 'They crossed at first light.', entities: [] }], covers: [2, 3], prompt: 'h:1', at: 'T' });

        expect(readScene(chat[3])).toEqual({ status: 'valid', scene: STORE_V3.scene });
        expect(readState(chat, 3)).toEqual({ status: 'valid', state: STORE_V3.state });
        expect(readCanon(chat[3]).canon.facts).toHaveLength(1);
    });

    it('copies the facts it is given, so a later edit to the caller\'s array cannot reach the store', () => {
        const chat = storeV3Chat();
        const facts = [{ text: 'A durable fact.', entities: ['Wren'], from: [1] }];
        const covers = [0, 1];
        writeCanon(chat, 1, { facts, covers, slots: 3, prompt: 'h:1', at: 'T' });

        facts.push({ text: 'Added afterwards.', entities: [] });
        facts[0].entities.push('Aster');
        facts[0].from.push(3);
        covers[1] = 99;

        expect(readCanon(chat[1]).canon).toEqual({
            facts: [{ text: 'A durable fact.', entities: ['Wren'], from: [1] }],
            covers: [0, 1], slots: 3, prompt: 'h:1', at: 'T',
        });
    });

    it('reads a batch written before a fact cited anything, and writes no empty slots key', () => {
        // Both fields are optional inside v4 (test/fixtures/store-v4-uncited.js): a
        // batch from before the pick is a readable batch, not an invalid one.
        const chat = storeV3Chat();
        chat[1].extra.cairn = { v: 4, ...structuredClone({ canon: STORE_V4_CANON_UNCITED }) };

        expect(readCanon(chat[1])).toEqual({ status: 'valid', canon: STORE_V4_CANON_UNCITED });

        const fresh = storeV3Chat();
        writeCanon(fresh, 1, { facts: [{ text: 'A fact.', entities: [], from: [1] }], covers: [0, 1], prompt: 'h:1', at: 'T' });
        expect(readCanon(fresh[1]).canon).not.toHaveProperty('slots');
    });

    it('refuses what would corrupt the store, writing nothing', () => {
        const good = { facts: [], covers: [0, 1], prompt: 'h:1', at: 'T' };
        const refused = [
            { ...good, facts: null },
            { ...good, facts: [{ text: 'A fact.' }] },
            { ...good, facts: [{ text: '', entities: [] }] },
            { ...good, covers: [1, 0] },
            { ...good, covers: [0, 1, 2] },
            { ...good, prompt: 7 },
        ];

        for (const batch of refused) {
            const chat = storeV3Chat();
            const before = structuredClone(chat[1].extra.cairn);
            expect(writeCanon(chat, 1, batch), JSON.stringify(batch)).toBe(false);
            expect(chat[1].extra.cairn).toEqual(before);
        }
    });

    it('refuses a message that is not there', () => {
        const chat = storeV3Chat();

        expect(writeCanon(chat, 9, { facts: [], covers: [0, 1], prompt: 'h:1', at: 'T' })).toBe(false);
        expect(writeCanon(chat, -1, { facts: [], covers: [0, 1], prompt: 'h:1', at: 'T' })).toBe(false);
    });

    it('refuses to overwrite a store from a newer Cairn', () => {
        const chat = storeV3Chat();
        const future = { v: STORE_VERSION + 1, canon: { facts: [] } };
        chat[1].extra.cairn = future;

        expect(writeCanon(chat, 1, { facts: [], covers: [0, 1], prompt: 'h:1', at: 'T' })).toBe(false);
        expect(chat[1].extra.cairn).toBe(future);
    });

    it('mutates the message in place, never a copy (DESIGN.md §9)', () => {
        const chat = storeV3Chat();
        const messages = [...chat];
        const extras = chat.map((message) => message.extra);

        expect(writeCanon(chat, 1, { facts: [], covers: [0, 1], prompt: 'h:1', at: 'T' })).toBe(true);

        chat.forEach((message, i) => {
            expect(message).toBe(messages[i]);
            expect(message.extra).toBe(extras[i]);
        });
    });
});

describe('reading an index record back', () => {
    const summarised = (scene = { text: 'Aster promised a crossing.', prompt: 'h:p', at: 'T' }) => {
        const chat = [{ name: 'Aster', mes: 'Aster said she would get her across before the feast day.', extra: {} }];
        writeScene(chat[0], scene);
        return chat;
    };

    it('reports none when Cairn has never written one', () => {
        expect(readIndex({ mes: 'x', extra: {} })).toEqual({ status: 'none', index: null });
        expect(readIndex({ mes: 'x', extra: { cairn: { v: 4, scene: STORE_V4.scene } } }))
            .toEqual({ status: 'none', index: null });
        expect(readIndex(null)).toEqual({ status: 'none', index: null });
    });

    it('reports a future store rather than reading it', () => {
        const message = { mes: 'x', extra: { cairn: { v: STORE_VERSION + 1, index: STORE_V4.index } } };
        expect(readIndex(message)).toEqual({ status: 'future', index: null });
    });

    it('reports invalid for a record missing a field the reader needs', () => {
        const chat = summarised();
        for (const missing of ['record', 'hash', 'prompt', 'at']) {
            const entry = { ...structuredClone(STORE_V4.index) };
            delete entry[missing];
            chat[0].extra.cairn = { ...chat[0].extra.cairn, index: entry };
            expect(readIndex(chat[0]).status, missing).toBe('invalid');
        }
    });

    it('reports invalid for a record the strategy could not have produced', () => {
        const chat = summarised();
        const broken = [
            { ...RECORD, what: '' },
            { ...RECORD, who: 'Aster, Wren' },
            { ...RECORD, who: ['Aster', ''] },
            { ...RECORD, changed: null },
            { ...RECORD, kind: '' },
        ];
        for (const record of broken) {
            chat[0].extra.cairn = { ...chat[0].extra.cairn, index: { ...STORE_V4.index, record } };
            expect(readIndex(chat[0]).status, JSON.stringify(record)).toBe('invalid');
        }
    });

    it('goes stale when the summary it was derived from is resummarised', () => {
        const chat = summarised();
        expect(writeIndex(chat, 0, { record: RECORD, prompt: 'h:index' })).toBe(true);
        expect(readIndex(chat[0]).status).toBe('valid');

        // The same message, a different summary: the record describes text that is gone.
        writeScene(chat[0], { text: 'Aster showed Wren a boat.', prompt: 'h:p', at: 'T2' });

        expect(readIndex(chat[0]).status).toBe('stale');
    });

    it('goes stale when the message itself is edited, through the scene', () => {
        const chat = summarised();
        writeIndex(chat, 0, { record: RECORD, prompt: 'h:index' });

        chat[0].mes = 'Aster said nothing at all and went back to the boat.';

        expect(readScene(chat[0]).status).toBe('stale');
        expect(readIndex(chat[0]).status).toBe('stale');
    });

    it('goes stale when the summary is gone entirely', () => {
        const chat = summarised();
        writeIndex(chat, 0, { record: RECORD, prompt: 'h:index' });
        delete chat[0].extra.cairn.scene;

        expect(readIndex(chat[0]).status).toBe('stale');
    });
});

describe('writing an index record', () => {
    const summarised = () => {
        const chat = [{ name: 'Aster', mes: 'Aster said she would get her across before the feast day.', extra: {} }];
        writeScene(chat[0], { text: 'Aster promised a crossing.', prompt: 'h:p', at: 'T' });
        return chat;
    };

    it('stores the record, the summary hash and the prompt, and reads back valid', () => {
        const chat = summarised();

        expect(writeIndex(chat, 0, { record: RECORD, prompt: 'h:index', at: 'T2' })).toBe(true);

        expect(chat[0].extra.cairn.index).toEqual({
            record: { ...RECORD, who: ['Aster', 'Wren'] },
            hash: hashString('Aster promised a crossing.'),
            prompt: 'h:index',
            at: 'T2',
        });
        expect(readIndex(chat[0])).toEqual({ status: 'valid', index: chat[0].extra.cairn.index });
    });

    it('refuses a message with no summary, since there is nothing to have indexed', () => {
        const chat = [{ name: 'Aster', mes: 'Aster said nothing.', extra: {} }];

        expect(writeIndex(chat, 0, { record: RECORD, prompt: 'h:index' })).toBe(false);
        expect(chat[0].extra.cairn).toBeUndefined();
    });

    it('refuses a record the reader would call invalid', () => {
        const chat = summarised();

        expect(writeIndex(chat, 0, { record: { ...RECORD, what: '' }, prompt: 'h:i' })).toBe(false);
        expect(writeIndex(chat, 0, { record: { ...RECORD, changed: undefined }, prompt: 'h:i' })).toBe(false);
        expect(writeIndex(chat, 0, { record: null, prompt: 'h:i' })).toBe(false);
        expect(writeIndex(chat, 0, { record: RECORD, prompt: undefined })).toBe(false);
        expect(chat[0].extra.cairn.index).toBeUndefined();
    });

    it('refuses a missing message and a future store', () => {
        const chat = summarised();
        expect(writeIndex(chat, 9, { record: RECORD, prompt: 'h:i' })).toBe(false);
        expect(writeIndex(undefined, 0, { record: RECORD, prompt: 'h:i' })).toBe(false);

        chat[0].extra.cairn = { ...chat[0].extra.cairn, v: STORE_VERSION + 1 };
        expect(writeIndex(chat, 0, { record: RECORD, prompt: 'h:i' })).toBe(false);
    });

    it('keeps the other tiers and copies the names out of the caller\'s array', () => {
        const chat = storeV4Chat();
        const who = ['Aster'];

        expect(writeIndex(chat, 1, { record: { ...RECORD, who }, prompt: 'h:index', at: 'T' })).toBe(true);
        who.push('Wren');

        expect(chat[1].extra.cairn.index.record.who).toEqual(['Aster']);
        expect(readScene(chat[1]).status).toBe('valid');
        expect(readCanon(chat[1]).status).toBe('valid');
    });

    it('mutates the message in place and never clones the chat (DESIGN.md §9)', () => {
        const chat = storeV4Chat();
        const messages = [...chat];
        const extras = chat.map((message) => message.extra);

        expect(writeIndex(chat, 1, { record: RECORD, prompt: 'h:index', at: 'T' })).toBe(true);

        chat.forEach((message, i) => {
            expect(message).toBe(messages[i]);
            expect(message.extra).toBe(extras[i]);
        });
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
