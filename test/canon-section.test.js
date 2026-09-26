import { describe, expect, it } from 'vitest';
import { canonTexts } from '../src/ui/canon-section.js';
import { STORE_VERSION } from '../src/store/schema.js';
import { cairnCanonStore } from './mocks/cairn.js';
import { makeQvinkChat } from './mocks/qvink.js';
import { storeV3Chat, STORE_V3_CANON } from './fixtures/store-v3.js';

describe('the facts shown under a message', () => {
    it('lists what that pass promoted, in the order it promoted them', () => {
        const chat = storeV3Chat();

        expect(canonTexts(chat).get(1)).toBe(
            STORE_V3_CANON.canon.facts.map((fact) => `• ${fact.text}`).join('\n'),
        );
        expect(canonTexts(chat).has(3)).toBe(false);
    });

    it('shows a repeat the fold hides, because this is what that pass wrote', () => {
        // The block renders a fact once (memory/canon.js); the chat shows each batch
        // as it stands, which is what the reader is checking.
        const chat = makeQvinkChat({ length: 12 });
        chat[3].extra.cairn = cairnCanonStore(['Her brother is dead.'], [0, 3]);
        chat[7].extra.cairn = cairnCanonStore(['Her brother is dead!'], [4, 7]);

        expect(canonTexts(chat).get(3)).toBe('• Her brother is dead.');
        expect(canonTexts(chat).get(7)).toBe('• Her brother is dead!');
    });

    it('shows nothing for a pass that promoted nothing', () => {
        const chat = makeQvinkChat({ length: 12 });
        chat[3].extra.cairn = cairnCanonStore([], [0, 3]);

        expect(canonTexts(chat).size).toBe(0);
    });

    it('shows nothing for a malformed batch or one from a newer Cairn', () => {
        const chat = makeQvinkChat({ length: 12 });
        chat[3].extra.cairn = { v: STORE_VERSION, canon: { facts: 'x', covers: [0, 3], prompt: 'h:1', at: 'T' } };
        chat[7].extra.cairn = { ...cairnCanonStore(['Newer.'], [4, 7]), v: STORE_VERSION + 1 };

        expect(canonTexts(chat).size).toBe(0);
    });

    it('shows nothing for a chat that has never had a pass', () => {
        expect(canonTexts(makeQvinkChat({ length: 12 })).size).toBe(0);
        expect(canonTexts([]).size).toBe(0);
        expect(canonTexts(null).size).toBe(0);
    });
});
