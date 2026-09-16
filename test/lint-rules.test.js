import { describe, expect, it } from 'vitest';
import { ESLint } from 'eslint';

/**
 * The mechanical half of plan §6's no-clone invariant (CLAUDE.md §9.35). A test
 * of the rule itself, so deleting it from eslint.config.mjs fails the gate.
 */
describe('the no-clone lint rule', () => {
    const eslint = new ESLint();

    async function messagesFor(filePath, code) {
        const [result] = await eslint.lintText(code, { filePath });
        return result.messages.map((message) => message.ruleId);
    }

    it('bans structuredClone in shipped code', async () => {
        expect(await messagesFor('src/probe.js', 'export const copy = (m) => structuredClone(m);\n'))
            .toContain('no-restricted-globals');
        expect(await messagesFor('index.js', 'export const copy = (m) => structuredClone(m);\n'))
            .toContain('no-restricted-globals');
    });

    it('leaves tests free to snapshot with it', async () => {
        expect(await messagesFor('test/probe.test.js', 'export const copy = (m) => structuredClone(m);\n'))
            .not.toContain('no-restricted-globals');
    });
});
