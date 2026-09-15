import { defineConfig } from 'vitest/config';

export default defineConfig({
    test: {
        // Everything under src/ that we test is pure logic — no DOM, no ST, no
        // network (CLAUDE.md §1.3), so a plain Node environment is enough.
        environment: 'node',
        include: ['test/**/*.test.js'],
    },
});
