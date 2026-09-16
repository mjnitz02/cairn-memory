import { describe, expect, it } from 'vitest';
import { hasMacro, renderTemplate } from '../src/util/template.js';
import { createContext } from './mocks/sillytavern.js';

describe('the summary prompt renderer', () => {
    it('fills {{message}} and {{history}}', () => {
        expect(renderTemplate('A {{history}} B {{message}}', { message: 'm', history: 'h' })).toBe('A h B m');
    });

    it('keeps an {{#if}} block when its macro has a value, and drops it when empty', () => {
        const template = 'Top.{{#if history}} Context: {{history}}.{{/if}} End: {{message}}';

        expect(renderTemplate(template, { message: 'm', history: 'h' })).toBe('Top. Context: h. End: m');
        expect(renderTemplate(template, { message: 'm', history: '' })).toBe('Top. End: m');
    });

    it('leaves no stray blank lines where a block tag had a line to itself', () => {
        const template = 'Intro.\n\n{{#if history}}\nContext:\n{{history}}\n{{/if}}\n\nMessage:\n{{message}}';

        expect(renderTemplate(template, { message: 'm', history: 'h1\nh2' }))
            .toBe('Intro.\n\nContext:\nh1\nh2\n\nMessage:\nm');
        expect(renderTemplate(template, { message: 'm', history: '' }))
            .toBe('Intro.\n\nMessage:\nm');
    });

    it('treats an {{#if}} on a macro it does not know as false', () => {
        expect(renderTemplate('a{{#if description}}b{{/if}}c', { message: 'm' })).toBe('ac');
    });

    /**
     * ST's macros run on the template *before* chat text goes in
     * (docs/p2-plan.md §4), so text a user typed is never expanded.
     */
    it('expands ST macros in the template but never in the chat text', () => {
        const context = createContext();
        const expand = (text) => context.substituteParams(text);

        const out = renderTemplate(
            'Summarise for {{char}} and {{user}}:\n{{message}}\n{{history}}',
            { message: 'Wren: I typed {{user}} and {{char}} on purpose.', history: 'Earlier, {{char}} said nothing.' },
            { expand },
        );

        expect(out).toBe('Summarise for Aster and Wren:\nWren: I typed {{user}} and {{char}} on purpose.\nEarlier, {{char}} said nothing.');
    });

    it('survives an expander that eats every macro it does not recognise', () => {
        const greedy = (text) => text.replace(/\{\{[^}]*\}\}/g, '');

        expect(renderTemplate('X {{message}} Y {{history}}', { message: 'm', history: 'h' }, { expand: greedy }))
            .toBe('X m Y h');
    });

    it('inserts chat text literally, including replacement patterns', () => {
        expect(renderTemplate('{{message}}', { message: 'costs $& and $1' })).toBe('costs $& and $1');
    });

    it('can tell whether a template asks for a macro at all', () => {
        expect(hasMacro('a {{message}} b', 'message')).toBe(true);
        expect(hasMacro('a {{#if message}}b{{/if}}', 'message')).toBe(false);
        expect(hasMacro('a {{messages}} b', 'message')).toBe(false);
    });
});
