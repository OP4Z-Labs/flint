// Integration coverage for every `--help` surface.
//
// Smoke checklist mapping (from .agent/SMOKE-2026-05-14.md):
//   - Step 11: `flint --help`, `flint auth --help`, `flint init --help`,
//              `flint configure --help`, `flint add --help` — all print
//              correctly with no crashes; long-form flags documented.
//
// Why this matters: a regression where `--help` crashes (broken option
// definition, malformed action signature, missing command in cli.ts) is
// invisible to direct-import unit tests. Commander only walks its
// option/command graph when it dispatches, so spawning the bin with
// `--help` is the cheapest way to assert the dispatch graph is intact.
//
// We also assert on the presence of key option names — that catches
// rename / delete regressions on options users depend on in scripts.

import { beforeAll, describe, expect, it } from 'vitest';
import { existsSync } from 'node:fs';
import { CLI_ENTRY, runFlint } from './_harness.js';

interface HelpCase {
  /** Args passed to `flint`. */
  args: string[];
  /** Substrings that must appear in stdout (after NO_COLOR strip). */
  mustInclude: string[];
}

// Each case is one help surface. Keeping the assertions targeted (a few
// substrings per surface) rather than full-stdout snapshots so harmless
// commander version bumps don't churn the test file.
const HELP_CASES: ReadonlyArray<HelpCase> = [
  {
    args: ['--help'],
    mustInclude: [
      'Usage: flint',
      'Flint',
      'auth',
      'init',
      'configure',
      'add',
      'upgrade',
      'config',
    ],
  },
  {
    args: ['auth', '--help'],
    mustInclude: ['Usage: flint auth', 'init', 'status', 'doctor', 'rotate', 'purge'],
  },
  {
    args: ['init', '--help'],
    mustInclude: [
      'Usage: flint init',
      '--variant',
      '--name',
      '--no-ci',
      '--force',
      '-y, --yes',
    ],
  },
  {
    args: ['configure', '--help'],
    mustInclude: [
      'Usage: flint configure',
      '--dry-run',
      '--no-pages-project',
      '--no-kv',
      '--no-r2',
      '--no-secrets',
      '--secrets',
    ],
  },
  {
    args: ['add', '--help'],
    mustInclude: ['Usage: flint add', 'kv', 'r2', 'secret', 'pwa', 'auth', 'rate-limit'],
  },
  {
    args: ['upgrade', '--help'],
    mustInclude: ['Usage: flint upgrade', '--check', '--diff', '--apply', '--dry-run'],
  },
  {
    args: ['config', '--help'],
    mustInclude: ['Usage: flint config', '--telemetry'],
  },
  {
    args: ['add', 'kv', '--help'],
    mustInclude: ['--no-provision', '--force', '-y, --yes'],
  },
  {
    args: ['add', 'r2', '--help'],
    mustInclude: ['--no-provision', '--force', '-y, --yes'],
  },
  {
    args: ['add', 'secret', '--help'],
    mustInclude: [
      '--description',
      '--no-provision',
      '--write-to-dev-vars',
      '-y, --yes',
    ],
  },
];

describe('flint --help surfaces (integration)', () => {
  beforeAll(() => {
    if (!existsSync(CLI_ENTRY)) {
      throw new Error(`Build artifact missing: ${CLI_ENTRY}. Run npm run build.`);
    }
  });

  for (const { args, mustInclude } of HELP_CASES) {
    const label = `flint ${args.join(' ')}`;
    it(`smoke 11: \`${label}\` prints help without crashing`, () => {
      const res = runFlint(args);
      // Commander exits 0 on --help (unlike some CLIs).
      expect(
        res.status,
        `${label} crashed.\nstdout:\n${res.stdout}\nstderr:\n${res.stderr}`,
      ).toBe(0);
      // Commander writes help to stdout (not stderr). Some bug reports
      // suggest otherwise on subcommands, so check both to keep the test
      // resilient to commander internals churn.
      const combined = `${res.stdout}\n${res.stderr}`;
      for (const needle of mustInclude) {
        expect(combined, `${label} stdout missing: ${needle}`).toContain(needle);
      }
    });
  }

  it('smoke 11: flint --version prints the package.json version', () => {
    const res = runFlint(['--version']);
    expect(res.status).toBe(0);
    // Version bumped per milestone: 0.1.0 → 0.2.0 (cleanup) → 0.5.0 (v0.5) → 0.9.0 (v0.9).
    expect(res.stdout.trim()).toBe('0.9.0');
  });

  it('flint with no args prints help text and exits non-zero (commander default)', () => {
    // Commander exits 1 with a help banner when no command is supplied
    // and no default action is set. This is the expected behavior — we
    // assert on it so a regression to "silently exit 0" is loud.
    const res = runFlint([]);
    expect(res.status).not.toBe(0);
    const combined = `${res.stdout}\n${res.stderr}`;
    expect(combined.toLowerCase()).toMatch(/usage:|help/);
  });
});
