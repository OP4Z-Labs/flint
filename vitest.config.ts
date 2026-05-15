import { defineConfig } from 'vitest/config';

// Vitest config for Flint's own tests. The CLI is pure Node, so the test
// environment is `node` (no jsdom). Tests live under `tests/` and never
// touch real `~/.config/flint/credentials` or real `.gitignore` files —
// see tests/util/tmp-home.ts for the sandbox helpers.
//
// Two test layers (both run by the default `vitest run`):
//   - Unit (`tests/**/*.test.ts` outside `tests/integration/`) — import the
//     command modules directly. Fast (~400ms for 100 tests).
//   - Integration (`tests/integration/**/*.spec.ts`) — spawn the real
//     built `dist/cli.js` against tmp-dir targets. Slower per-test (each
//     spawn costs ~50-150ms) but exercises the CLI entry path.
//
// Integration tests use `.spec.ts` suffix; unit tests use `.test.ts`. The
// suffix split lets `test:integration` script target the integration layer
// without re-running unit tests.
export default defineConfig({
  test: {
    environment: 'node',
    globals: true,
    include: ['tests/**/*.test.ts', 'tests/**/*.spec.ts'],
    // Integration tests spawn child processes; give them headroom over the
    // vitest 5s default. Unit tests don't approach this ceiling.
    testTimeout: 30_000,
    coverage: {
      provider: 'v8',
      reporter: ['text', 'html'],
      include: ['src/**'],
      exclude: ['src/cli.ts', '**/*.d.ts'],
    },
  },
});
