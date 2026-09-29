import { describe, expect, it } from 'vitest';
import { describeReply } from '../src/memory/model-reply.js';

/** Where a failed reply broke, for the call log (docs/decisions.md D-0094). */

describe('describeReply', () => {
    it('points at an unescaped quote inside a value', () => {
        const reply = '{"canon":[{"fact":"Aster said "never" and meant it.","from":[2]}]}';
        const detail = describeReply(reply);

        expect(detail.at).toBe(reply.indexOf('never'));
        expect(detail.error).toMatch(/JSON/);
        expect(detail.near).toContain('said "never"');
    });

    it('points at the end of a reply that was cut off, past any preamble', () => {
        const reply = 'Here are the records:\n```json\n{"records":[{"n":1,"what":"Wren crossed';
        const detail = describeReply(reply);

        expect(detail.at).toBe(reply.length);
        expect(detail.tail).toBe(reply.slice(-80));
    });

    it('reads the line and column form some engines report', () => {
        const reply = '{\n"records": [\n{"n": 1 "what": "x"}\n]}';
        const at = reply.indexOf('"what"');
        const original = JSON.parse;
        JSON.parse = () => { throw new SyntaxError('JSON.parse: expected \',\' at line 3 column 9 of the JSON data'); };
        try {
            expect(describeReply(reply).at).toBe(at);
        } finally {
            JSON.parse = original;
        }
    });

    it('has no error when the JSON parsed and only its shape was wrong', () => {
        expect(describeReply('{"records":5}')).toMatchObject({ error: null, at: null, near: '{"records":5}' });
    });

    it('says so when there is no JSON at all, and keeps the opening', () => {
        expect(describeReply('I cannot help with that.')).toMatchObject({ error: 'no JSON', at: null, near: 'I cannot help with that.' });
    });

    it('describes a reply whose thinking never closed from the raw text', () => {
        expect(describeReply('<think>the rows are').tail).toBe('<think>the rows are');
    });
});
