// Integration coverage for `flint configure --dry-run`.
//
// Smoke checklist mapping (from .agent/SMOKE-2026-05-14.md):
//   - Step 8: `flint configure --dry-run` — should print planned commands
//             without invoking wrangler OR hitting the Cloudflare API.
//
// The cleanup pass's fix (commit c144f34) gated the token-verify network
// call on `!opts.dryRun`, and added a unit test that mocks `fetch` to
// prove the call never fires (`tests/commands/configure.test.ts`).
//
// This integration test is the second pillar: spawn the actual built bin
// against a tmp repo and confirm
//   (a) the user-visible offline banner appears,
//   (b) the bin exits 0 even when env-var credentials WOULD fail a real
//       Cloudflare verify call (proving no verify happened),
//   (c) no "Token verification failed" or fetch-failure output appears.
//
// We can't strictly assert "fetch was never called" from a spawned bin
// without rigging undici/global-fetch interception in the child process.
// The (b) check above is the closest substitute: if --dry-run accepts a
// known-bad token, the network probe was definitely skipped.

import { afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { existsSync } from 'node:fs';
import {
  CLI_ENTRY,
  createTempRepo,
  runFlint,
  writeRepoFile,
  type TempRepo,
} from './_harness.js';

const STARTER_WRANGLER_TOML = `name = "flint-dry-run-smoke"
compatibility_date = "2026-05-14"
pages_build_output_dir = "dist"
`;

describe('flint configure --dry-run (integration)', () => {
  beforeAll(() => {
    if (!existsSync(CLI_ENTRY)) {
      throw new Error(`Build artifact missing: ${CLI_ENTRY}. Run npm run build.`);
    }
  });

  let repo: TempRepo;

  beforeEach(() => {
    repo = createTempRepo();
    writeRepoFile(repo, 'wrangler.toml', STARTER_WRANGLER_TOML);
  });

  afterEach(() => {
    repo.cleanup();
  });

  it('smoke 8: --dry-run prints the offline-mode banner', () => {
    const res = runFlint(
      [
        'configure',
        '--dry-run',
        '--no-pages-project',
        '--no-kv',
        '--no-r2',
        '--no-secrets',
      ],
      {
        cwd: repo.dir,
        env: {
          // Env-var credentials path. The token value is bogus on purpose —
          // a real verify call against Cloudflare would 401. --dry-run is
          // supposed to skip that call.
          CLOUDFLARE_API_TOKEN: 'integration_test_bogus_token',
          CLOUDFLARE_ACCOUNT_ID: 'integration_test_account_id',
        },
      },
    );

    expect(
      res.status,
      `expected exit 0, got ${res.status}\nstdout:\n${res.stdout}\nstderr:\n${res.stderr}`,
    ).toBe(0);

    // The exact banner text comes from src/commands/configure.ts.
    expect(res.stdout).toContain(
      '--dry-run: skipping Cloudflare token verify (no network probe).',
    );
  });

  it('smoke 8: --dry-run completes with exit 0 against a known-bad token (proves no verify call)', () => {
    // If the verify call were still firing, this bogus token would 401 and
    // verifyTokenOrExit would call process.exit(2). Reaching exit 0 is
    // direct proof that the cleanup-pass guard is wired correctly.
    const res = runFlint(
      [
        'configure',
        '--dry-run',
        '--no-pages-project',
        '--no-kv',
        '--no-r2',
        '--no-secrets',
      ],
      {
        cwd: repo.dir,
        env: {
          CLOUDFLARE_API_TOKEN: 'integration_test_bogus_token',
          CLOUDFLARE_ACCOUNT_ID: 'integration_test_account_id',
        },
      },
    );
    expect(res.status).toBe(0);
  });

  it('smoke 8: --dry-run emits the "no changes will be applied" notice', () => {
    const res = runFlint(
      [
        'configure',
        '--dry-run',
        '--no-pages-project',
        '--no-kv',
        '--no-r2',
        '--no-secrets',
      ],
      {
        cwd: repo.dir,
        env: {
          CLOUDFLARE_API_TOKEN: 'integration_test_bogus_token',
          CLOUDFLARE_ACCOUNT_ID: 'integration_test_account_id',
        },
      },
    );
    expect(res.status).toBe(0);
    // From src/commands/configure.ts: `log.warn('--dry-run: no changes will be applied.')`
    // log.warn() writes to stderr via console.warn, so check both streams.
    const combined = `${res.stdout}\n${res.stderr}`;
    expect(combined).toContain('--dry-run: no changes will be applied.');
  });

  it('smoke 8: --dry-run reports no fetch / verify failure on stdout or stderr', () => {
    const res = runFlint(
      [
        'configure',
        '--dry-run',
        '--no-pages-project',
        '--no-kv',
        '--no-r2',
        '--no-secrets',
      ],
      {
        cwd: repo.dir,
        env: {
          CLOUDFLARE_API_TOKEN: 'integration_test_bogus_token',
          CLOUDFLARE_ACCOUNT_ID: 'integration_test_account_id',
        },
      },
    );
    expect(res.status).toBe(0);
    const combined = `${res.stdout}\n${res.stderr}`.toLowerCase();
    // Any of these strings would indicate the verify network call still
    // fired (and failed). Their absence is our proxy for "no network call
    // happened during dry-run."
    expect(combined).not.toContain('token verification failed');
    expect(combined).not.toContain('invalid request headers');
    expect(combined).not.toContain('could not verify token with cloudflare');
    expect(combined).not.toContain('fetch failed');
  });

  it('exits non-zero when no credentials are available even in --dry-run mode', () => {
    // The cleanup fix gates the verify call on dry-run, but the token
    // must still be PRESENT (loadCredentialsOrExit runs unconditionally).
    // Otherwise dry-run users have nothing to dry-run against.
    const res = runFlint(
      [
        'configure',
        '--dry-run',
        '--no-pages-project',
        '--no-kv',
        '--no-r2',
        '--no-secrets',
      ],
      {
        cwd: repo.dir,
        env: {
          // Explicitly clear any env-var creds that might leak from the
          // developer's shell.
          CLOUDFLARE_API_TOKEN: undefined,
          CLOUDFLARE_ACCOUNT_ID: undefined,
          // FLINT_CONFIG_HOME is sandboxed by the harness, so no creds
          // file lookup will succeed either.
        },
      },
    );

    expect(res.status).not.toBe(0);
    const combined = `${res.stdout}\n${res.stderr}`;
    expect(combined).toMatch(/No Cloudflare API token found|flint auth init/);
  });
});
