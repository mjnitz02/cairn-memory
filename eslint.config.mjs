import js from '@eslint/js';
import globals from 'globals';

export default [
    {
        ignores: ['node_modules/**', 'coverage/**', '.claude/**'],
    },
    js.configs.recommended,
    {
        // The extension ships as browser ES modules loaded by SillyTavern.
        files: ['**/*.js'],
        languageOptions: {
            ecmaVersion: 'latest',
            sourceType: 'module',
            globals: {
                ...globals.browser,
                // Injected by SillyTavern at runtime (public/scripts/st-context.js:115).
                SillyTavern: 'readonly',
                toastr: 'readonly',
            },
        },
        rules: {
            'no-empty': ['error', { allowEmptyCatch: true }],
            'no-unused-vars': ['warn', { argsIgnorePattern: '^_', varsIgnorePattern: '^_' }],
            // CLAUDE.md §4.19: logging goes through util/log.js, never bare console.
            'no-console': 'error',
        },
    },
    {
        // DESIGN.md §9: a clone silently drops other extensions' Symbol-keyed flags.
        files: ['src/**/*.js', 'index.js'],
        rules: {
            'no-restricted-globals': ['error', {
                name: 'structuredClone',
                message: 'Never clone chat data (DESIGN.md §9). Mutate in place.',
            }],
        },
    },
    {
        // The logger is the one place allowed to touch console.
        files: ['src/util/log.js'],
        rules: { 'no-console': 'off' },
    },
    {
        // Tests and dev scripts run under Node, not the browser.
        files: ['test/**/*.js', 'scripts/**/*.mjs'],
        languageOptions: { globals: { ...globals.node } },
        rules: { 'no-console': 'off' },
    },
];
