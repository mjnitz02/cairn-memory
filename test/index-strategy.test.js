import { describe, expect, it } from 'vitest';
import {
    INDEX_MAX_TOKENS, INDEX_PROMPT, MAX_BATCH, indexBatch, parseIndexReply,
} from '../src/memory/index-strategy.js';
import {
    DEFAULT_KIND, KINDS, MAX_SLOT_CHARS, MAX_WHO, MAX_WHO_CHARS,
} from '../src/memory/index-record.js';
import { hashString } from '../src/util/hash.js';
import { badIndexOutputs } from './mocks/llm.js';

/** What the model meant to send, in the reply's own shape. */
const MEANT = [
    {
        n: 1,
        kind: 'major',
        who: ['Wren', 'Aster'],
        what: 'Aster admitted she had crewed with Wren\'s brother',
        changed: 'Aster knew Wren\'s brother',
        because: 'Wren asked her outright',
    },
    {
        n: 2,
        kind: 'description',
        who: ['Aster', 'Wren'],
        what: 'Aster and Wren waited in the ferry terminal',
        changed: '',
        because: 'the last crossing was posted delayed',
    },
    {
        n: 3,
        kind: 'filler',
        who: ['Wren'],
        what: 'Wren read the chalk board over the ticket window',
        changed: '',
        because: '',
    },
];

const SUMMARIES = [
    'Wren asked Aster whether she had known her brother, who drowned in the spring flood.',
    'Aster led Wren to the ferry terminal, where the last crossing was posted as delayed.',
    'Wren read the board over the ticket window while they waited.',
];

const ok = (content, count = SUMMARIES.length) => {
    const parsed = parseIndexReply(content, { count });
    expect(parsed.ok).toBe(true);
    return parsed;
};
const indexes = (parsed) => parsed.records.map((record) => record.n);

describe('building an index pass', () => {
    it('numbers the summaries and stores the prompt it used', () => {
        const request = indexBatch.build({ summaries: SUMMARIES });
        const [{ role, content }] = request.messages;

        expect(role).toBe('user');
        SUMMARIES.forEach((summary, i) => expect(content).toContain(`${i + 1}. ${summary}`));
        expect(request.maxTokens).toBe(INDEX_MAX_TOKENS);
        expect(request.prompt).toBe(hashString(INDEX_PROMPT));
        expect(request.count).toBe(SUMMARIES.length);
    });

    it('takes a scene object as readily as a string', () => {
        const content = indexBatch.build({ summaries: [{ text: SUMMARIES[0] }] }).messages[0].content;
        expect(content).toContain(`1. ${SUMMARIES[0]}`);
    });

    it('refuses an empty batch and one past MAX_BATCH', () => {
        expect(() => indexBatch.build({ summaries: [] })).toThrow(RangeError);
        expect(() => indexBatch.build({ summaries: undefined })).toThrow(RangeError);
        expect(() => indexBatch.build({ summaries: Array(MAX_BATCH + 1).fill('a summary') })).toThrow(RangeError);
        expect(() => indexBatch.build({ summaries: Array(MAX_BATCH).fill('a summary') })).not.toThrow();
    });

    it('names every kind and every cap the parser enforces, so the model is not guessing', () => {
        const content = indexBatch.build({ summaries: SUMMARIES }).messages[0].content;

        for (const kind of KINDS) expect(content).toContain(`- ${kind} — `);
        expect(content).toContain(`at most ${MAX_WHO} names`);
        expect(content).toContain(`at most ${MAX_WHO_CHARS} characters`);
        expect(content).toContain(`at most ${MAX_SLOT_CHARS} characters`);
    });

    it('tells the model not to judge, which is the whole of D-0072', () => {
        expect(INDEX_PROMPT).toContain('IMPORTANT:');
        expect(INDEX_PROMPT).toContain('do not judge whether the summary matters');
        // Skipping a summary is the failure that cannot be recovered downstream.
        expect(INDEX_PROMPT).toContain('a summary you skip is a summary that can never be picked');
    });

    it('carries the tiebreaker at the end, derived from the ranking (DESIGN.md §12)', () => {
        const content = indexBatch.build({ summaries: SUMMARIES }).messages[0].content;
        expect(content).toContain(`${KINDS[KINDS.length - 1]} over ${KINDS[1]}`);
        expect(content).toContain('an empty changed over a guessed one');
    });

    it('shows a filled changed beside an empty one, and says why', () => {
        // The include/exclude pair DESIGN.md §12 asks for: the distinction the slot turns
        // on is what survives the scene, and mood is named as excluded (D-0043).
        expect(INDEX_PROMPT).toContain('Record 1 gets a changed and record 2 does not');
        expect(INDEX_PROMPT).toContain('how Wren felt');
    });

    it('applies ST macros to the template and never to the chat\'s own text', () => {
        const content = indexBatch.build({
            summaries: ['Wren typed {{user}} into the terminal.'],
            expand: (text) => text.replaceAll('{{user}}', 'Wren'),
        }).messages[0].content;

        expect(content).toContain('Wren typed {{user}} into the terminal.');
    });
});

describe('parsing an index reply', () => {
    it('reads the records the model meant to send', () => {
        const parsed = ok(JSON.stringify({ records: MEANT }));

        expect(parsed.records).toEqual(MEANT);
        expect(parsed.dropped).toEqual([]);
    });

    it('returns them oldest first however they arrived', () => {
        expect(indexes(ok(badIndexOutputs.shuffled(MEANT)))).toEqual([1, 2, 3]);
    });

    it('rejects a reply with no records, unlike the canon pass', () => {
        // There is no real answer to "describe each of these" that describes none.
        expect(parseIndexReply(badIndexOutputs.nullRecords())).toEqual({ ok: false, reason: 'format' });
        expect(parseIndexReply(badIndexOutputs.wrongWrapper(MEANT))).toEqual({ ok: false, reason: 'format' });
    });

    it('reads a bare array, the wrapper forgotten', () => {
        expect(indexes(ok(badIndexOutputs.bareArray(MEANT)))).toEqual([1, 2, 3]);
    });

    it('keeps the first answer when the model answers twice about one summary', () => {
        const parsed = ok(badIndexOutputs.duplicateIndex(MEANT));

        expect(indexes(parsed)).toEqual([1]);
        expect(parsed.records[0].what).toBe(MEANT[0].what);
        expect(parsed.dropped).toEqual([{ slot: 'n', reason: 'duplicate-index', n: 1 }]);
    });

    it('drops a record numbered past the batch', () => {
        const parsed = ok(badIndexOutputs.outOfBatch(MEANT));

        expect(parsed.records).toEqual([]);
        expect(parsed.dropped).toEqual(Array(3).fill({ slot: 'n', reason: 'out-of-batch' }));
    });

    it('drops a record with no number at all, since order is not an answer', () => {
        const parsed = ok(badIndexOutputs.noIndex(MEANT));

        expect(parsed.records).toEqual([]);
        expect(parsed.dropped).toEqual(Array(3).fill({ slot: 'n', reason: 'no-index' }));
    });

    it('reports a short batch as what came back, and leaves the decision to the caller', () => {
        const parsed = ok(badIndexOutputs.short(MEANT));

        expect(indexes(parsed)).toEqual([1]);
        expect(parsed.dropped).toEqual([]);
    });

    it('keeps a record whose kind it invented, labelled filler and counted (D-0070)', () => {
        const parsed = ok(badIndexOutputs.unknownKind(MEANT));

        expect(parsed.records[0].kind).toBe(DEFAULT_KIND);
        expect(parsed.records[0].what).toBe(MEANT[0].what);
        expect(parsed.dropped).toEqual([{ slot: 'kind', reason: 'unknown-kind', n: 1 }]);
    });

    it('takes a shouted kind as the kind it is', () => {
        const parsed = ok(badIndexOutputs.shoutedKind(MEANT));

        expect(parsed.records.map((record) => record.kind)).toEqual(MEANT.map((record) => record.kind));
        expect(parsed.dropped).toEqual([]);
    });

    it('takes null and missing slots as empty', () => {
        for (const content of [badIndexOutputs.nullSlots(MEANT), badIndexOutputs.missingSlots(MEANT)]) {
            const parsed = ok(content);
            expect(parsed.records).toHaveLength(3);
            expect(parsed.records.every((record) => record.changed === '' && record.because === '')).toBe(true);
            expect(parsed.dropped).toEqual([]);
        }
    });

    it('drops a record whose what is the summary written back out', () => {
        const parsed = ok(badIndexOutputs.overlong(MEANT));

        expect(indexes(parsed)).toEqual([2, 3]);
        expect(parsed.dropped).toEqual([{ slot: 'what', reason: 'too-long', n: 1 }]);
    });

    it('caps the names and counts what it left off', () => {
        const parsed = ok(badIndexOutputs.manyNames(MEANT));

        expect(parsed.records[0].who).toHaveLength(MAX_WHO);
        expect(parsed.dropped).toEqual(Array(2).fill({ slot: 'who', reason: 'too-many-names', n: 1 }));
    });

    it('stores no names when who arrives as a string', () => {
        const parsed = ok(badIndexOutputs.whoAsString(MEANT));

        expect(parsed.records[0].who).toEqual([]);
        expect(parsed.dropped).toEqual([{ slot: 'who', reason: 'not-a-list', n: 1 }]);
    });

    it('reports a model that judged as a short batch, not as a failure', () => {
        // The prompt forbids it, and this is what it looks like when it happens anyway:
        // the description and filler records are simply not there (D-0072).
        const parsed = ok(badIndexOutputs.judged(MEANT));

        expect(indexes(parsed)).toEqual([1]);
    });

    it('stores a mood written into changed, because the parser is not the judge', () => {
        // The prompt's job, not the parser's: a schema check cannot tell a lasting change
        // from a passing one, and pretending otherwise would drop good records too.
        const parsed = ok(badIndexOutputs.mood(MEANT));
        expect(parsed.records[0].changed).toContain('no longer sure');
    });
});

describe('parsing an index reply — the mess suite (CLAUDE.md §3.12)', () => {
    it('reads through a fence, a preamble and a sign-off', () => {
        for (const shape of ['fenced', 'preambleAndSignOff']) {
            expect(indexes(ok(badIndexOutputs[shape](MEANT)))).toEqual([1, 2, 3]);
        }
    });

    it('reads through leaked reasoning, closed or orphaned', () => {
        for (const shape of ['leakedReasoning', 'orphanThinkClose']) {
            expect(indexes(ok(badIndexOutputs[shape](MEANT)))).toEqual([1, 2, 3]);
        }
    });

    it('rejects a truncated reply rather than storing half a batch', () => {
        expect(parseIndexReply(badIndexOutputs.truncated(MEANT))).toEqual({ ok: false, reason: 'truncated' });
        expect(parseIndexReply(badIndexOutputs.unterminatedReasoning())).toEqual({ ok: false, reason: 'truncated' });
    });

    it('names a refusal as a refusal and an empty reply as empty', () => {
        expect(parseIndexReply(badIndexOutputs.refusal())).toEqual({ ok: false, reason: 'refusal' });
        expect(parseIndexReply(badIndexOutputs.empty())).toEqual({ ok: false, reason: 'empty' });
        expect(parseIndexReply(undefined)).toEqual({ ok: false, reason: 'empty' });
    });

    it('rejects prose in place of records', () => {
        expect(parseIndexReply(badIndexOutputs.prose())).toEqual({ ok: false, reason: 'format' });
    });

    it('has a case for every shape in the catalogue', () => {
        // CLAUDE.md §3.12: the mock is only worth something if every shape is tested.
        const covered = new Set([
            'fenced', 'preambleAndSignOff', 'leakedReasoning', 'orphanThinkClose',
            'unterminatedReasoning', 'truncated', 'refusal', 'prose', 'bareArray',
            'wrongWrapper', 'nullRecords', 'duplicateIndex', 'outOfBatch', 'shuffled',
            'noIndex', 'short', 'unknownKind', 'shoutedKind', 'nullSlots', 'missingSlots',
            'overlong', 'manyNames', 'whoAsString', 'judged', 'mood', 'empty',
        ]);
        expect([...Object.keys(badIndexOutputs)].filter((shape) => !covered.has(shape))).toEqual([]);
    });
});
