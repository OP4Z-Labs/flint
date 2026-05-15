// Integration coverage for `flint auth purge` — the safety command added
// in v0.9 per the 2026-05-14 manual smoke. The flow:
//
//   1. Stash a fake credentials file + .dev.vars with a token
//   2. Run `flint auth purge --yes`
//   3. Both should be gone
//   4. Output should include the dashboard URL + revoke reminder

import { afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { CLI_ENTRY, createTempRepo, runFlint, type TempRepo } from './_harness.js';

const SAMPLE_CREDENTIALS = {
  token: 'tok-XXXXXXXXXXXXXXXXXXXXXXXXXXXXXX',
  accountId: 'acct-abc-123',
  accountName: 'Test Account',
  createdAt: '2026-05-14T00:00:00.000Z',
};

describe('flint auth purge (integration)', () => {
  let repo: TempRepo;
  let home: string;

  beforeAll(() => {
    if (!existsSync(CLI_ENTRY)) {
      throw new Error(`Build artifact missing: ${CLI_ENTRY}. Run npm run build.`);
    }
  });

  beforeEach(() => {
    repo = createTempRepo();
    home = mkdtempSync(join(tmpdir(), 'flint-purge-home-'));
    // Seed creds file.
    mkdirSync(home, { recursive: true });
    writeFileSync(
      join(home, 'credentials'),
      JSON.stringify(SAMPLE_CREDENTIALS, null, 2),
      { encoding: 'utf8', mode: 0o600 },
    );
    // Seed .dev.vars in the repo with a CF token.
    writeFileSync(
      join(repo.dir, '.dev.vars'),
      'CLOUDFLARE_API_TOKEN=tok-XXX\nCLOUDFLARE_ACCOUNT_ID=acct-abc-123\n',
      'utf8',
    );
  });

  afterEach(() => {
    repo.cleanup();
    rmSync(home, { recursive: true, force: true });
  });

  it('removes credentials file + .dev.vars and prints revoke reminder', () => {
    const res = runFlint(['auth', 'purge', '--yes'], {
      cwd: repo.dir,
      env: { FLINT_CONFIG_HOME: home },
    });
    expect(res.status, `purge failed:\n${res.stdout}\n${res.stderr}`).toBe(0);
    expect(existsSync(join(home, 'credentials'))).toBe(false);
    expect(existsSync(join(repo.dir, '.dev.vars'))).toBe(false);
    const combined = `${res.stdout}\n${res.stderr}`;
    // Dashboard URL must be prominent.
    expect(combined).toContain('https://dash.cloudflare.com/profile/api-tokens');
    // Reminder language.
    expect(combined.toLowerCase()).toMatch(/revoke/);
  });

  it('does not delete .dev.vars when it has no CLOUDFLARE_API_TOKEN', () => {
    // Replace seed with one that doesn't carry a CF token.
    writeFileSync(
      join(repo.dir, '.dev.vars'),
      'MY_APP_SECRET=hello\n',
      'utf8',
    );
    const res = runFlint(['auth', 'purge', '--yes'], {
      cwd: repo.dir,
      env: { FLINT_CONFIG_HOME: home },
    });
    expect(res.status).toBe(0);
    // Creds file gone, but the non-CF .dev.vars stays.
    expect(existsSync(join(home, 'credentials'))).toBe(false);
    expect(existsSync(join(repo.dir, '.dev.vars'))).toBe(true);
  });

  it('with --include-archive also wipes the rotated archive directory', () => {
    mkdirSync(join(home, 'credentials.rotated'), { recursive: true });
    writeFileSync(
      join(home, 'credentials.rotated', '2026-05-13.json'),
      JSON.stringify(SAMPLE_CREDENTIALS),
      'utf8',
    );
    const res = runFlint(['auth', 'purge', '--yes', '--include-archive'], {
      cwd: repo.dir,
      env: { FLINT_CONFIG_HOME: home },
    });
    expect(res.status).toBe(0);
    expect(existsSync(join(home, 'credentials.rotated'))).toBe(false);
  });

  it('exits cleanly when there is nothing to remove', () => {
    rmSync(join(home, 'credentials'), { force: true });
    rmSync(join(repo.dir, '.dev.vars'), { force: true });
    const res = runFlint(['auth', 'purge', '--yes'], {
      cwd: repo.dir,
      env: { FLINT_CONFIG_HOME: home },
    });
    expect(res.status).toBe(0);
    const combined = `${res.stdout}\n${res.stderr}`;
    expect(combined.toLowerCase()).toMatch(/nothing to remove|purge complete/);
  });
});
