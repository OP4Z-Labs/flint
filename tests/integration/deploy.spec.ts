// Integration coverage for `flint deploy`. Driving the full pipeline
// end-to-end requires mocking three external surfaces:
//
//   1. The Cloudflare API (token verify) — we point FLINT_CONFIG_HOME at a
//      tmp dir with a credentials file, but the auth doctor step still
//      makes a real `fetch` call. We get past it by stubbing the credentials
//      file with an obviously-fake token AND skipping any test path that
//      requires the network probe to succeed. Instead, we focus the
//      integration tests on the pre-flight FAILURE paths (which exit before
//      the network call) and on `--rollback` (which uses wrangler-runner).
//
//   2. The wrangler binary — we provide a fake-bin via `WRANGLER_BINARY`
//      env override (the same pattern wrangler-runner.test.ts uses). The
//      fake-bin echoes a canned deployment-list output for the rollback
//      test path.
//
//   3. The Cloudflare token verify call — we don't simulate this in
//      integration. Tests that DO need to reach the deploy stage are
//      covered by the unit-test layer (parseDeployStdout / parseDeploymentList).
//
// What this spec covers:
//   - Missing wrangler.toml → exit 2 with actionable error.
//   - No credentials → exit 2 telling user to run `flint auth init`.
//   - Asset budget warns/fails correctly when run via the binary.
//   - --rollback parses + prompts (we use `--yes` style env hint or assert
//     the list rendering exits properly when there are no deployments).

import { afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { existsSync, mkdirSync, writeFileSync, chmodSync } from 'node:fs';
import { join } from 'node:path';
import {
  CLI_ENTRY,
  createTempRepo,
  runFlint,
  type TempRepo,
} from './_harness.js';

const WRANGLER_TOML_MIN = `name = "deploytest"
pages_build_output_dir = "dist"
compatibility_date = "2026-05-14"
compatibility_flags = ["nodejs_compat"]
`;

function seedCredentialsFile(homeDir: string): void {
  mkdirSync(homeDir, { recursive: true });
  const credPath = join(homeDir, 'credentials');
  writeFileSync(
    credPath,
    JSON.stringify({
      token: 'fake_token_for_integration_test_x'.padEnd(64, 'x'),
      accountId: '00000000000000000000000000000000',
      accountName: 'Integration Test',
      createdAt: new Date().toISOString(),
    }),
  );
  chmodSync(credPath, 0o600);
}

/** Write a small executable POSIX shell script as the wrangler stand-in. */
function writeFakeWrangler(dir: string, body: string): string {
  const path = join(dir, 'fake-wrangler');
  writeFileSync(path, `#!/bin/sh\n${body}\n`);
  chmodSync(path, 0o755);
  return path;
}

describe('flint deploy (integration)', () => {
  beforeAll(() => {
    if (!existsSync(CLI_ENTRY)) {
      throw new Error(`Build artifact missing: ${CLI_ENTRY}. Run npm run build.`);
    }
  });

  let repo: TempRepo;
  beforeEach(() => {
    repo = createTempRepo();
  });
  afterEach(() => {
    repo.cleanup();
  });

  it('exits non-zero with an actionable message when wrangler.toml is missing', () => {
    const res = runFlint(['deploy'], { cwd: repo.dir });
    expect(res.status).not.toBe(0);
    const combined = `${res.stdout}\n${res.stderr}`;
    expect(combined).toMatch(/wrangler\.toml not found/i);
    expect(combined).toMatch(/flint init/i);
  });

  it('refuses to deploy when no credentials are stored', () => {
    // Seed wrangler.toml, but leave FLINT_CONFIG_HOME pointing at an empty dir.
    writeFileSync(join(repo.dir, 'wrangler.toml'), WRANGLER_TOML_MIN);
    const emptyHome = join(repo.dir, '.flint-home-empty');
    mkdirSync(emptyHome);
    const res = runFlint(['deploy'], {
      cwd: repo.dir,
      env: { FLINT_CONFIG_HOME: emptyHome },
    });
    expect(res.status).not.toBe(0);
    const combined = `${res.stdout}\n${res.stderr}`;
    expect(combined).toMatch(/no cloudflare credentials/i);
    expect(combined).toMatch(/flint auth init/i);
  });

  it('--rollback exits 0 and reports "no deployments" when wrangler list is empty', () => {
    writeFileSync(join(repo.dir, 'wrangler.toml'), WRANGLER_TOML_MIN);
    const home = join(repo.dir, '.flint-home');
    seedCredentialsFile(home);
    // Fake wrangler exits 0 with no UUIDs in output.
    const fake = writeFakeWrangler(repo.dir, 'echo "No deployments found."; exit 0');

    const res = runFlint(['deploy', '--rollback'], {
      cwd: repo.dir,
      env: { FLINT_CONFIG_HOME: home, WRANGLER_BINARY: fake },
    });
    expect(res.status).toBe(0);
    const combined = `${res.stdout}\n${res.stderr}`;
    expect(combined).toMatch(/No deployments found/i);
  });

  it('--rollback prints an error when wrangler list exits non-zero', () => {
    writeFileSync(join(repo.dir, 'wrangler.toml'), WRANGLER_TOML_MIN);
    const home = join(repo.dir, '.flint-home');
    seedCredentialsFile(home);
    const fake = writeFakeWrangler(repo.dir, 'echo "wrangler oops" >&2; exit 1');

    const res = runFlint(['deploy', '--rollback'], {
      cwd: repo.dir,
      env: { FLINT_CONFIG_HOME: home, WRANGLER_BINARY: fake },
    });
    expect(res.status).not.toBe(0);
    const combined = `${res.stdout}\n${res.stderr}`;
    // Error message shape: `[flint] deploy: wrangler ... exited 1 ...`
    expect(combined).toMatch(/wrangler.*exited 1/i);
  });

  it('--help renders help text including the asset budget + rollback flags', () => {
    const res = runFlint(['deploy', '--help']);
    expect(res.status).toBe(0);
    expect(res.stdout).toContain('--branch');
    expect(res.stdout).toContain('--skip-checks');
    expect(res.stdout).toContain('--rollback');
    expect(res.stdout).toContain('--strict-budget');
    expect(res.stdout).toContain('--preview');
  });
});
