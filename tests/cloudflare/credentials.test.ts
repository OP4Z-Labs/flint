// Credentials roundtrip: write → read; ensure mode 0600; rotation archive.
//
// Avoids any network — verifyToken / listAccounts are tested separately by
// stubbing global.fetch in tests/cloudflare/api.test.ts.

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { existsSync, mkdirSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import { setupTempHome, type TempHome } from '../util/tmp-home.js';
import {
  archiveCurrentCredentials,
  readCredentials,
  writeCredentials,
} from '../../src/cloudflare/credentials.js';

const SAMPLE = {
  token: 'cf_token_abcdef1234567890abcdef1234567890',
  accountId: 'acct123abc',
  accountName: 'My Account',
  createdAt: '2026-01-01T00:00:00.000Z',
};

describe('credentials', () => {
  let home: TempHome;

  beforeEach(() => {
    home = setupTempHome();
  });
  afterEach(() => home.cleanup());

  it('returns null when no credentials file exists', () => {
    expect(readCredentials()).toBeNull();
  });

  it('writes and reads back credentials losslessly', () => {
    writeCredentials(SAMPLE);
    const got = readCredentials();
    expect(got).toEqual(SAMPLE);
  });

  it('writes credentials with mode 0600 (POSIX only)', () => {
    if (process.platform === 'win32') return;
    writeCredentials(SAMPLE);
    const credPath = `${home.dir}/credentials`;
    const stat = statSync(credPath);
    // mode is uid + gid + mode bits; mask the bottom 9 bits.
    expect(stat.mode & 0o777).toBe(0o600);
  });

  it('returns null when the credentials file is corrupt JSON', () => {
    mkdirSync(home.dir, { recursive: true });
    writeFileSync(`${home.dir}/credentials`, 'not-json', 'utf8');
    expect(readCredentials()).toBeNull();
  });

  it('returns null when the credentials file is missing required fields', () => {
    mkdirSync(home.dir, { recursive: true });
    writeFileSync(`${home.dir}/credentials`, JSON.stringify({ token: 'x' }), 'utf8');
    expect(readCredentials()).toBeNull();
  });

  it('archives current credentials to credentials.rotated/<stamp>.json', () => {
    writeCredentials(SAMPLE);
    const snapshot = archiveCurrentCredentials();
    expect(snapshot).not.toBeNull();
    expect(existsSync(snapshot!)).toBe(true);
    const entries = readdirSync(`${home.dir}/credentials.rotated`);
    expect(entries.length).toBe(1);
    expect(entries[0]).toMatch(/\.json$/);
  });

  it('archive returns null when there is nothing to archive', () => {
    expect(archiveCurrentCredentials()).toBeNull();
  });
});
