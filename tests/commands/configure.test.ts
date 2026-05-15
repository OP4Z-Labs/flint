// Integration-flavored tests for `runConfigure`.
//
// The bulk of `runConfigure` is interactive (inquirer prompts) and shells
// out to wrangler, so we can't drive the full happy path from a unit
// test. What we CAN test — and what protects the CI / offline ergonomics
// guarantee — is the pre-flight behavior: when `--dry-run` is set, no
// network calls (specifically `GET /user/tokens/verify`) should fire.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runConfigure } from '../../src/commands/configure.js';
import { setupTempHome, type TempHome } from '../util/tmp-home.js';

describe('runConfigure --dry-run', () => {
  let home: TempHome;
  let tmpRepo: string;
  let originalCwd: string;
  let fetchSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    // Sandbox the credentials home so any lingering ~/.config/flint
    // creds don't leak into the test.
    home = setupTempHome();

    // Throwaway working directory containing a minimal wrangler.toml —
    // enough for readWranglerToml to succeed.
    tmpRepo = mkdtempSync(join(tmpdir(), 'flint-configure-'));
    writeFileSync(
      join(tmpRepo, 'wrangler.toml'),
      [
        'name = "flint-dry-run-smoke"',
        'compatibility_date = "2026-05-14"',
        'pages_build_output_dir = "dist"',
        '',
      ].join('\n'),
      'utf8',
    );
    originalCwd = process.cwd();
    process.chdir(tmpRepo);

    // Credentials path B: env vars (CI fallback). We do NOT write a creds
    // file because `loadCredentialsOrExit` checks env vars only after the
    // file lookup misses, and the file misses because home is empty.
    process.env.CLOUDFLARE_API_TOKEN = 'test_dry_run_token';
    process.env.CLOUDFLARE_ACCOUNT_ID = 'test_account_id_0000';

    // Spy on global fetch so we can assert it's never called. Wired as a
    // mock that throws so any accidental network call surfaces loudly.
    fetchSpy = vi.spyOn(globalThis, 'fetch' as never) as never;
    (fetchSpy as unknown as ReturnType<typeof vi.fn>).mockImplementation(() => {
      throw new Error('fetch() called during --dry-run; should not happen');
    });
  });

  afterEach(() => {
    vi.restoreAllMocks();
    process.chdir(originalCwd);
    rmSync(tmpRepo, { recursive: true, force: true });
    home.cleanup();
    delete process.env.CLOUDFLARE_API_TOKEN;
    delete process.env.CLOUDFLARE_ACCOUNT_ID;
  });

  it('does not call the Cloudflare API verify endpoint when --dry-run is set', async () => {
    // Skip every resource stage so we never reach the inquirer prompts
    // (which would block in CI). The token-verify call sits in the
    // pre-flight before any of these skip flags get a chance to apply,
    // so this exercises exactly the network-skip guard.
    await runConfigure({
      dryRun: true,
      skipPagesProject: true,
      skipKv: true,
      skipR2: true,
      skipSecrets: true,
    });

    // Strictest assertion possible: fetch was never invoked.
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('does hit the Cloudflare API verify endpoint when --dry-run is NOT set', async () => {
    // Counter-test: confirm the pre-flight network probe still fires on
    // a real run. We answer the fetch call with a 200 active-token body
    // so verifyTokenOrExit returns cleanly, then skip every stage.
    (fetchSpy as unknown as ReturnType<typeof vi.fn>).mockReset();
    (fetchSpy as unknown as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
      ok: true,
      status: 200,
      json: async () => ({
        success: true,
        errors: [],
        messages: [],
        result: { id: 'tok_test', status: 'active', expires_on: null },
      }),
    } as Response);

    await runConfigure({
      dryRun: false,
      skipPagesProject: true,
      skipKv: true,
      skipR2: true,
      skipSecrets: true,
    });

    // The verify endpoint must have been reached exactly once.
    expect(fetchSpy).toHaveBeenCalledTimes(1);
    const url = (fetchSpy as unknown as ReturnType<typeof vi.fn>).mock.calls[0]?.[0];
    expect(String(url)).toContain('/user/tokens/verify');
  });
});
