import { describe, expect, it } from 'vitest';
import {
    DEFAULT_SUMMARY_PROMPT,
    MAX_SUMMARY_CHARS,
    SUMMARY_MAX_TOKENS,
    parseSummary,
    perMessage,
    resolveSummaryPrompt,
} from '../src/memory/scene-strategy.js';
import { hashString } from '../src/util/hash.js';
import { badOutputs } from './mocks/llm.js';
import { createContext } from './mocks/sillytavern.js';

/** docs/p2-plan.md §4, word for word — Matt's qvink prompt, proven in play. */
const PLAN_DEFAULT = `Summarize the following fictional message as a single paragraph of 2-3 sentences in past tense. Do not use bullet points or numbered lists.

Include: character names (not pronouns), actions taken, dialogue points, emotional shifts, decisions made, and new information revealed.

{{#if history}}
Recent summary context (for reference only, do not re-summarize):
{{history}}
{{/if}}

Message to summarize:
{{message}}`;

const INSTRUCTIONS = `Summarize the following fictional message as a single paragraph of 2-3 sentences in past tense. Do not use bullet points or numbered lists.

Include: character names (not pronouns), actions taken, dialogue points, emotional shifts, decisions made, and new information revealed.`;

/** Synthetic, and the length of a real one: the corpus median is ~350-500 characters. */
const SUMMARY = 'Aster told Wren the ferry would not run until the fog lifted, leaving them the evening to decide about the letter. '
    + 'Wren admitted she had already opened it and read the warning inside, and Aster, shaken, asked why she had waited. '
    + 'They agreed to take the lamp to the lighthouse at dawn and confront the keeper together, and Aster said, "Not a word to anyone."';

const MESSAGE = { name: 'Aster', is_user: false, mes: 'The kettle clicked off. "The ferry won\'t run tonight," Aster said.' };

describe('the default summary prompt', () => {
    it('is the prompt in docs/p2-plan.md §4, word for word', () => {
        expect(DEFAULT_SUMMARY_PROMPT).toBe(PLAN_DEFAULT);
    });

    it('is used when the setting is empty, so users who never edit it get improvements', () => {
        expect(resolveSummaryPrompt('')).toEqual({ template: DEFAULT_SUMMARY_PROMPT, edited: false, fallback: false });
        expect(resolveSummaryPrompt(undefined)).toEqual({ template: DEFAULT_SUMMARY_PROMPT, edited: false, fallback: false });
        expect(resolveSummaryPrompt('   \n')).toEqual({ template: DEFAULT_SUMMARY_PROMPT, edited: false, fallback: false });
    });

    it('takes an edited prompt as the user wrote it', () => {
        const edited = 'Be brief.\n{{message}}';

        expect(resolveSummaryPrompt(edited)).toEqual({ template: edited, edited: true, fallback: false });
    });

    it('falls back to the default when an edited prompt has no {{message}}', () => {
        // The warning is shown by the caller, once; here it is the flag it reads.
        expect(resolveSummaryPrompt('Summarise {{history}}')).toEqual({
            template: DEFAULT_SUMMARY_PROMPT, edited: true, fallback: true,
        });
    });
});

describe('building one summary request', () => {
    const context = createContext();
    const expand = (text) => context.substituteParams(text);

    it('sends the rendered prompt as one user message, with room for a reasoning model', () => {
        const request = perMessage.build({
            message: MESSAGE,
            history: ['Wren arrived at the dock.', 'Aster found the letter.'],
            template: '',
            expand,
        });

        expect(perMessage.id).toBe('per-message-v1');
        expect(request.maxTokens).toBe(SUMMARY_MAX_TOKENS);
        expect(SUMMARY_MAX_TOKENS).toBe(2048);
        expect(request.messages).toEqual([{
            role: 'user',
            content: `${INSTRUCTIONS}\n\nRecent summary context (for reference only, do not re-summarize):\n`
                + 'Wren arrived at the dock.\nAster found the letter.\n\n'
                + `Message to summarize:\nAster: ${MESSAGE.mes}`,
        }]);
    });

    it('leaves the history block out when there is no history yet', () => {
        const request = perMessage.build({ message: MESSAGE, history: [], template: '', expand });

        expect(request.messages[0].content).toBe(`${INSTRUCTIONS}\n\nMessage to summarize:\nAster: ${MESSAGE.mes}`);
    });

    it('records which template wrote the scene', () => {
        const edited = 'Be brief about {{char}}.\n{{message}}';

        expect(perMessage.build({ message: MESSAGE, history: [], template: '', expand }).prompt)
            .toBe(hashString(DEFAULT_SUMMARY_PROMPT));
        expect(perMessage.build({ message: MESSAGE, history: [], template: edited, expand }))
            .toMatchObject({ prompt: hashString(edited), fallback: false });
    });

    it('says when it fell back to the default', () => {
        const request = perMessage.build({ message: MESSAGE, history: [], template: 'no macro here', expand });

        expect(request).toMatchObject({ prompt: hashString(DEFAULT_SUMMARY_PROMPT), fallback: true });
        expect(request.messages[0].content).toContain('Message to summarize:');
    });

    it('sends a message containing {{user}} literally', () => {
        const message = { name: 'Wren', is_user: true, mes: 'I wrote {{user}} and {{char}} in my diary.' };
        const request = perMessage.build({ message, history: ['{{char}} was quiet.'], template: 'For {{char}}: {{message}} / {{history}}', expand });

        expect(request.messages[0].content).toBe('For Aster: Wren: I wrote {{user}} and {{char}} in my diary. / {{char}} was quiet.');
    });
});

/**
 * The parser against every bad output in the catalogue (CLAUDE.md §3.12). A
 * reply is either cleaned into the summary the model meant, or rejected with a
 * reason; nothing in between gets stored.
 */
describe('parsing a summary reply', () => {
    const expected = {
        fenced: { ok: true },
        preamble: { ok: true },
        preambleAndFence: { ok: true },
        signOff: { ok: true },
        labelled: { ok: true },
        leakedReasoning: { ok: true },
        orphanThinkClose: { ok: true },
        paragraphs: { ok: true },
        bulleted: { ok: true },
        truncated: { ok: false, reason: 'truncated' },
        unterminatedReasoning: { ok: false, reason: 'truncated' },
        refusal: { ok: false, reason: 'refusal' },
        json: { ok: false, reason: 'format' },
        overlong: { ok: false, reason: 'too-long' },
        empty: { ok: false, reason: 'empty' },
    };

    it('has a verdict for every entry in badOutputs', () => {
        expect(Object.keys(expected).sort()).toEqual(Object.keys(badOutputs).sort());
    });

    for (const [name, verdict] of Object.entries(expected)) {
        it(`${verdict.ok ? 'recovers' : 'rejects'} ${name}`, () => {
            const result = parseSummary(badOutputs[name](SUMMARY));

            if (verdict.ok) {
                expect(result).toEqual({ ok: true, text: SUMMARY });
            } else {
                expect(result).toEqual({ ok: false, reason: verdict.reason });
            }
        });
    }

    it('accepts a clean reply as it is', () => {
        expect(perMessage.parse(SUMMARY)).toEqual({ ok: true, text: SUMMARY });
    });

    it('takes a sentence that ends in a closing quote or bracket as finished', () => {
        for (const ending of ['."', '!”', '?’', '.)', '.]', '…', '.*']) {
            const text = `Aster left the dock${ending}`;
            expect(parseSummary(text), ending).toEqual({ ok: true, text });
        }
    });

    it('strips a Summary label however it is written', () => {
        for (const reply of [`Summary: ${SUMMARY}`, `Summary:\n${SUMMARY}`, `Summary:\n\n${SUMMARY}`, `**Summary**: ${SUMMARY}`]) {
            expect(parseSummary(reply), reply.slice(0, 12)).toEqual({ ok: true, text: SUMMARY });
        }
    });

    it('recognises refusals however the apostrophe is typed', () => {
        for (const refusal of [
            'I’m sorry, but I can’t continue with this.',
            'I cannot summarize this content.',
            'Sorry, I can\'t do that.',
            'I apologize, but this request goes against my guidelines.',
            'As an AI, I am unable to help with that.',
            'I won\'t write this.',
        ]) {
            expect(parseSummary(refusal), refusal).toEqual({ ok: false, reason: 'refusal' });
        }
    });

    it('stores a refusal it does not recognise — the known weakness in plan §4', () => {
        // Visible in the inspector, and an edit-and-retry replaces it.
        expect(parseSummary('This one will have to be skipped, unfortunately.').ok).toBe(true);
    });

    it('treats a missing or non-string reply as empty', () => {
        expect(parseSummary(undefined)).toEqual({ ok: false, reason: 'empty' });
        expect(parseSummary('<think>done thinking</think>\n   ')).toEqual({ ok: false, reason: 'empty' });
    });

    it('draws the length line at the limit, not before', () => {
        const atLimit = `${'a'.repeat(MAX_SUMMARY_CHARS - 1)}.`;

        expect(MAX_SUMMARY_CHARS).toBe(1500);
        expect(parseSummary(atLimit).ok).toBe(true);
        expect(parseSummary(`a${atLimit}`)).toEqual({ ok: false, reason: 'too-long' });
    });
});
