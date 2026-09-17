import { describe, expect, it } from 'vitest';
import {
    WTRACKERS,
    jobStillCurrent,
    newestState,
    pendingStateJob,
    stateForPrompt,
    wtrackerLoaded,
} from '../src/memory/state.js';
import { STATE_MAX_EARLIER, STATE_MAX_MESSAGES, statePatch } from '../src/memory/state-strategy.js';
import { sceneHistory } from '../src/memory/scenes.js';
import { readState, writeState } from '../src/store/chat-store.js';
import { cairnSummary, makeMixedChat } from './mocks/cairn.js';
import { createContext, makeChat, makeCoreChat, makeMessage, newSwipe, swipeTo } from './mocks/sillytavern.js';

const IGNORE = Symbol.for('ignore');

/** Synthetic states, the shape of test/fixtures/store-v2.js. */
const PIER = Object.freeze({ location: 'The ferry terminal, outer pier', weather: 'Drizzle' });
const DECK = Object.freeze({ location: 'The ferry, upper deck', weather: 'Clearing' });
const CABIN = Object.freeze({ location: 'The ferry, a cabin below deck' });

/** A state on `chat[index]` that read `read` visible messages, as the queue will write it. */
function putState(chat, index, value, read = 2) {
    expect(writeState(chat, index, { value, read, changed: [], prompt: 'h:1', at: 'T' })).toBe(true);
}

/** Wren and Aster alternating, states on the replies at 1 and 3 (each read its exchange). */
function playedChat(turns = 6) {
    const chat = makeChat(turns);
    putState(chat, 1, PIER);
    putState(chat, 3, DECK);
    return chat;
}

describe('the newest valid state wins', () => {
    it('is null in a chat with no state', () => {
        expect(newestState(makeChat(6))).toBeNull();
        expect(newestState([])).toBeNull();
        expect(newestState(undefined)).toBeNull();
    });

    it('walks back past messages with no state to the newest one', () => {
        const found = newestState(playedChat());

        expect(found.index).toBe(3);
        expect(found.state.value).toEqual(DECK);
    });

    it('stops at `through`', () => {
        expect(newestState(playedChat(), 2).index).toBe(1);
        expect(newestState(playedChat(), 0)).toBeNull();
    });

    it('falls back to the previous state when the newest one is edited', () => {
        const chat = playedChat();
        chat[3].mes = 'Aster answers differently.';

        expect(newestState(chat).index).toBe(1);
    });

    it('does not cascade: editing an older state\'s range leaves the newer one standing', () => {
        const chat = playedChat();
        chat[0].mes = 'Wren says something else entirely.';

        expect(readState(chat, 1).status).toBe('stale');
        expect(newestState(chat).index).toBe(3);
        expect(newestState(chat, 2)).toBeNull();
    });

    it('goes stale when a message in its range is hidden, and comes back when it is unhidden', () => {
        const chat = playedChat();
        chat[2].is_system = true;
        expect(newestState(chat).index).toBe(1);

        chat[2].is_system = false;
        expect(newestState(chat).index).toBe(3);
    });

    it('goes stale when a message in its range is deleted, and not when one after it is', () => {
        const deletedInside = playedChat();
        deletedInside.splice(2, 1);
        expect(newestState(deletedInside).index).toBe(1);

        const deletedAfter = playedChat();
        deletedAfter.splice(4, 1);
        expect(newestState(deletedAfter).index).toBe(3);
    });

    it('survives a branch, which copies the messages it keeps (public/scripts/bookmarks.js:173)', () => {
        const branch = structuredClone(playedChat().slice(0, 3));

        expect(newestState(branch).index).toBe(1);
        expect(newestState(branch).state.value).toEqual(PIER);
    });

    it('skips a stored value the schema rejects, since it could be neither rendered nor patched', () => {
        const chat = playedChat();
        chat[3].extra.cairn.state.value = { location: 'x'.repeat(500) };

        expect(readState(chat, 3).status).toBe('valid');
        expect(newestState(chat).index).toBe(1);
    });

    it('skips a newer Cairn\'s store rather than reading it', () => {
        const chat = playedChat();
        chat[3].extra.cairn.v = 99;

        expect(newestState(chat).index).toBe(1);
    });

    it('never mutates the chat', () => {
        const chat = playedChat();
        const before = JSON.stringify(chat);
        newestState(chat);

        expect(JSON.stringify(chat)).toBe(before);
    });
});

describe('the state for a prompt', () => {
    it('sits one message deep in normal play: the reply it read, then the user\'s new message', () => {
        const chat = playedChat(5);

        expect(stateForPrompt(chat, makeCoreChat(chat))).toMatchObject({ index: 3, depth: 1 });
    });

    it('is at depth 0 when the prompt ends on the message it read', () => {
        const chat = playedChat(4);

        expect(stateForPrompt(chat, makeCoreChat(chat))).toMatchObject({ index: 3, depth: 0 });
    });

    it('is not taken from a reply the swipe popped (public/script.js:4498), even while it is still valid', () => {
        const chat = playedChat(4);
        const found = stateForPrompt(chat, makeCoreChat(chat, { type: 'swipe' }));

        expect(readState(chat, 3).status).toBe('valid');
        expect(found).toMatchObject({ index: 1, depth: 1 });
    });

    it('counts depth in prompt messages, so hidden ones below the state do not add to it', () => {
        const chat = playedChat(4);
        chat.push(makeMessage({ name: 'Wren', isUser: true, mes: 'An aside, later hidden.' }));
        chat.push(makeMessage({ name: 'Wren', isUser: true, mes: 'Wren speaks.' }));
        chat[4].is_system = true;

        expect(stateForPrompt(chat, makeCoreChat(chat))).toMatchObject({ index: 3, depth: 1 });
    });

    it('still finds a message the blanking flagged, since the flag is set on the shared extra', () => {
        const chat = playedChat(6);
        const core = makeCoreChat(chat);
        chat[1].extra[IGNORE] = true;
        chat[3].mes = 'Edited, so the state at 1 is the newest valid one.';

        expect(stateForPrompt(chat, core)).toMatchObject({ index: 1, depth: 4 });
    });

    it('matches by extra identity, not by the coreChat index, which counts the filtered array', () => {
        const chat = playedChat(6);
        chat.unshift(makeMessage({ name: 'Wren', isUser: true, mes: 'A hidden opening line.' }));
        chat[0].is_system = true;
        const core = makeCoreChat(chat);

        expect(core[3].index).toBe(3);
        expect(stateForPrompt(chat, core)).toMatchObject({ index: 4, depth: 2 });
    });

    it('passes over prompt entries with no extra or none from this chat', () => {
        const chat = playedChat(4);
        const core = makeCoreChat(chat);
        core.push({ name: 'Wren', is_user: true, mes: 'No extra at all.' }, { ...makeMessage(), index: 5 });

        expect(stateForPrompt(chat, core)).toMatchObject({ index: 3, depth: 2 });
    });

    it('is null when no message in the prompt carries a valid state', () => {
        const chat = makeChat(4);

        expect(stateForPrompt(chat, makeCoreChat(chat))).toBeNull();
        expect(stateForPrompt(chat, [])).toBeNull();
    });

    it('rolls back on a new swipe and forward again on swiping back', () => {
        const chat = playedChat(4);

        newSwipe(chat[3], 'Aster answers another way.');
        expect(chat[3].extra.cairn.state.value).toEqual(DECK);
        expect(stateForPrompt(chat, makeCoreChat(chat))).toMatchObject({ index: 1 });

        putState(chat, 3, CABIN);
        expect(stateForPrompt(chat, makeCoreChat(chat)).state.value).toEqual(CABIN);

        swipeTo(chat[3], 0);
        expect(stateForPrompt(chat, makeCoreChat(chat)).state.value).toEqual(DECK);
        swipeTo(chat[3], 1);
        expect(stateForPrompt(chat, makeCoreChat(chat)).state.value).toEqual(CABIN);
    });

    it('reads without writing: the prompt keeps its length, entries and extras', () => {
        const chat = playedChat(6);
        const core = makeCoreChat(chat);
        const entries = [...core];
        const extras = core.map((entry) => entry.extra);
        const before = JSON.stringify(chat);

        stateForPrompt(chat, core);

        expect(core).toHaveLength(entries.length);
        core.forEach((entry, at) => {
            expect(entry).toBe(entries[at]);
            expect(entry.extra).toBe(extras[at]);
        });
        expect(JSON.stringify(chat)).toBe(before);
    });
});

describe('the pending state job', () => {
    it('is null for an empty chat, or one whose messages are all hidden', () => {
        expect(pendingStateJob([])).toBeNull();
        const chat = makeChat(2);
        chat.forEach((message) => { message.is_system = true; });
        expect(pendingStateJob(chat)).toBeNull();
    });

    it('is null when the newest message already carries a valid state', () => {
        expect(pendingStateJob(playedChat(4))).toBeNull();
    });

    it('cold-starts from {} on a short chat, reading every message', () => {
        const chat = makeChat(3);
        const job = pendingStateJob(chat);

        expect(job).toMatchObject({ index: 2, read: 3, state: {}, baseIndex: null, earlier: [] });
        expect(job.message).toBe(chat[2]);
        job.messages.forEach((message, at) => expect(message).toBe(chat[at]));
    });

    it('reads everything after the newest state, the last message included', () => {
        const chat = playedChat(6);
        const job = pendingStateJob(chat);

        expect(job).toMatchObject({ index: 5, read: 2, state: DECK, baseIndex: 3, earlier: [] });
        expect(job.messages).toEqual([chat[4], chat[5]]);
    });

    it('rereads from the previous state when the newest one went stale', () => {
        const chat = playedChat(4);
        chat[3].mes = 'Aster answers differently.';

        expect(pendingStateJob(chat)).toMatchObject({ index: 3, read: 2, state: PIER, baseIndex: 1 });
    });

    it('skips hidden messages, in the range and at the end', () => {
        const chat = playedChat(8);
        chat[5].is_system = true;
        chat[7].is_system = true;
        const job = pendingStateJob(chat);

        expect(job).toMatchObject({ index: 6, read: 2, baseIndex: 3 });
        expect(job.messages).toEqual([chat[4], chat[6]]);
    });

    it(`reads only the newest ${STATE_MAX_MESSAGES}, with the scenes just before them as background`, () => {
        const chat = makeMixedChat({ length: 20, qvinkThrough: 5, cairnThrough: 12 });
        const job = pendingStateJob(chat);
        const first = 20 - STATE_MAX_MESSAGES;

        expect(job).toMatchObject({ index: 19, read: STATE_MAX_MESSAGES, state: {}, baseIndex: null });
        expect(job.messages).toEqual(chat.slice(first));
        expect(job.earlier).toHaveLength(STATE_MAX_EARLIER);
        expect(job.earlier).toEqual(sceneHistory(chat, first).map((scene) => scene.text));
        expect(job.earlier.at(-1)).toBe(cairnSummary(12));
    });

    it('keeps the old state as the base when catching up past the limit', () => {
        const chat = makeChat(12);
        putState(chat, 1, PIER);
        const job = pendingStateJob(chat);

        expect(job).toMatchObject({ read: STATE_MAX_MESSAGES, state: PIER, baseIndex: 1, earlier: [] });
    });

    it('leaves a newer Cairn\'s store on the newest message alone', () => {
        const chat = playedChat(4);
        chat[3].mes = 'Edited, so there is work to do.';
        chat[3].extra.cairn.v = 99;

        expect(pendingStateJob(chat)).toBeNull();
    });

    it('stores exactly the range it read: once written, the job is done', () => {
        const chat = makeMixedChat({ length: 20, qvinkThrough: 5, cairnThrough: 12, hidden: [16] });
        const job = pendingStateJob(chat);
        putState(chat, job.index, CABIN, job.read);

        expect(chat[job.index].extra.cairn.state.hash).toBe(job.hash);
        expect(newestState(chat).index).toBe(job.index);
        expect(pendingStateJob(chat)).toBeNull();
    });

    it('is a request the strategy accepts, in every shape', () => {
        const shapes = [
            makeChat(1),
            playedChat(6),
            makeMixedChat({ length: 40, qvinkThrough: 10, cairnThrough: 30, hidden: [35] }),
        ];
        for (const chat of shapes) {
            const job = pendingStateJob(chat);
            expect(() => statePatch.build(job)).not.toThrow();
        }
    });

    it('never mutates the chat', () => {
        const chat = makeMixedChat({ length: 20, qvinkThrough: 5, cairnThrough: 12 });
        const before = JSON.stringify(chat);
        pendingStateJob(chat);

        expect(JSON.stringify(chat)).toBe(before);
    });
});

describe('before a job\'s state is written', () => {
    it('gives the index when nothing it read has changed', () => {
        const chat = playedChat(6);
        expect(jobStillCurrent(chat, pendingStateJob(chat))).toBe(5);
    });

    it('still writes when a message arrives after the range, or one before it is deleted', () => {
        const chat = playedChat(6);
        const job = pendingStateJob(chat);
        chat.push(makeMessage({ name: 'Wren', isUser: true, mes: 'Wren sends the next turn.' }));
        expect(jobStillCurrent(chat, job)).toBe(5);

        chat.splice(0, 1);
        expect(jobStillCurrent(chat, job)).toBe(4);
    });

    it.each([
        ['an edit in the range', (chat) => { chat[4].mes = 'Wren says something else.'; }],
        ['a hide in the range', (chat) => { chat[4].is_system = true; }],
        ['a deletion in the range', (chat) => { chat.splice(4, 1); }],
        ['a new swipe on the message', (chat) => { newSwipe(chat[5], 'Aster answers another way.'); }],
        ['a continue on the message (public/script.js:6701)', (chat) => { chat[5].mes += ' And more.'; }],
        ['the message deleted', (chat) => { chat.pop(); }],
    ])('discards the reply after %s', (_, change) => {
        const chat = playedChat(6);
        const job = pendingStateJob(chat);
        change(chat);

        expect(jobStillCurrent(chat, job)).toBe(-1);
    });

    it('discards the reply after a chat switch', () => {
        const job = pendingStateJob(playedChat(6));

        expect(jobStillCurrent(playedChat(6), job)).toBe(-1);
        expect(jobStillCurrent([], job)).toBe(-1);
    });
});

describe('standing aside for WTracker', () => {
    const scope = {};

    it('is quiet when neither is installed, whatever their leftover settings say', () => {
        const context = createContext();
        context.extensionSettings.WTrackerLite = { autoMode: 'responses' };

        expect(wtrackerLoaded(context, { scope })).toBeNull();
    });

    it.each(WTRACKERS.map((tracker) => [tracker.name, tracker]))('names %s when it is installed and enabled', (name, tracker) => {
        const context = createContext({ extensions: [tracker.extension] });

        expect(wtrackerLoaded(context, { scope })).toBe(name);
    });

    it('ignores an installed but disabled one, which ST never loads (public/scripts/extensions.js:626)', () => {
        const context = createContext({ extensions: WTRACKERS.map((tracker) => tracker.extension) });
        context.extensionSettings.disabledExtensions.push(...WTRACKERS.map((tracker) => tracker.extension));

        expect(wtrackerLoaded(context, { scope })).toBeNull();
    });

    it('sees one installed under another folder name by its interceptor', () => {
        const context = createContext();

        expect(wtrackerLoaded(context, { scope: { wtrackerliteGenerateInterceptor: () => {} } })).toBe('WTrackerLite');
        expect(wtrackerLoaded(context, { scope: { wtrackerGenerateInterceptor: 'not a function' } })).toBeNull();
    });

    it('looks for them under their own folders, not qvink\'s', () => {
        expect(WTRACKERS.map((tracker) => tracker.extension)).toEqual([
            'third-party/SillyTavern-WTrackerLite',
            'third-party/SillyTavern-WTracker',
        ]);
    });
});
