import { describe, expect, it } from 'vitest';
import { ESLint } from 'eslint';

const eslint = new ESLint();

async function messagesFor(filePath, code) {
    const [result] = await eslint.lintText(code, { filePath });
    return result.messages.map((message) => message.ruleId);
}

/**
 * The mechanical half of plan §6's no-clone invariant (CLAUDE.md §9.35). A test
 * of the rule itself, so deleting it from eslint.config.mjs fails the gate.
 */
describe('the no-clone lint rule', () => {
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

/** D-0079's lesson, made mechanical: the store reaching up into the layers above it. */
describe('the store-layer import rule', () => {
    it('bans a store module importing from the layers above it', async () => {
        for (const from of ['../memory/canon.js', '../pipeline/budgeter.js', '../settings.js']) {
            expect(await messagesFor('src/store/chat-store.js', `import { x } from '${from}';\nexport { x };\n`))
                .toContain('no-restricted-imports');
        }
    });

    it('lets it import its own layer and util', async () => {
        const code = "import { a } from './schema.js';\nimport { b } from '../util/hash.js';\nexport { a, b };\n";
        expect(await messagesFor('src/store/chat-store.js', code)).not.toContain('no-restricted-imports');
    });
});
