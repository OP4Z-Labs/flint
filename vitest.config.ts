import { defineConfig } from 'vitest/config';

// Vitest config for Flint's own tests. The CLI is pure Node, so the test
// environment is `node` (no jsdom). Tests live under `tests/` and never
// touch real `~/.config/flint/credentials` or real `.gitignore` files —
// see tests/util/tmp-home.ts for the sandbox helpers.
export default defineConfig({
  test: {
    environment: 'node',
    globals: true,
    include: ['tests/**/*.test.ts'],
    coverage: {
      provider: 'v8',
      reporter: ['text', 'html'],
      include: ['src/**'],
      exclude: ['src/cli.ts', '**/*.d.ts'],
    },
  },
});
