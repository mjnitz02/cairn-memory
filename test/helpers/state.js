import { expect } from 'vitest';
import { writeState } from '../../src/store/chat-store.js';

/** Store a world state on `chat[index]` as the queue would, having read `read` messages. */
export function putState(chat, index, value, { read = 2, changed = [] } = {}) {
    expect(writeState(chat, index, { value, read, changed, prompt: 'h:1', at: 'T' })).toBe(true);
}
