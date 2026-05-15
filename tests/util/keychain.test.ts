// Unit coverage for the OS keychain backing. We test against the
// in-memory fake (FLINT_KEYCHAIN_FAKE=1) so the suite is portable across
// platforms without real libsecret / Keychain access. The contract we
// care about is the API shape — the real backend is a thin pass-through.

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  getStorageMode,
  isKeychainAvailable,
  readKeychainCredentials,
  setStorageMode,
  tryClearKeychain,
  writeKeychainCredentials,
} from '../../src/util/keychain.js';

const CREDS = {
  token: 'tok-1234567890abcdef',
  accountId: 'acct-abc',
  accountName: 'Test Account',
  createdAt: '2026-05-14T00:00:00.000Z',
};

describe('keychain (with FLINT_KEYCHAIN_FAKE=1)', () => {
  let prevFake: string | undefined;
  let prevDisabled: string | undefined;
  let prevHome: string | undefined;
  let home: string;

  beforeEach(() => {
    prevFake = process.env.FLINT_KEYCHAIN_FAKE;
    prevDisabled = process.env.FLINT_KEYCHAIN_DISABLED;
    prevHome = process.env.FLINT_CONFIG_HOME;
    process.env.FLINT_KEYCHAIN_FAKE = '1';
    delete process.env.FLINT_KEYCHAIN_DISABLED;
    home = mkdtempSync(join(tmpdir(), 'flint-kc-'));
    process.env.FLINT_CONFIG_HOME = home;
  });
  afterEach(async () => {
    // Cleanly purge between tests so the in-memory store doesn't leak.
    await tryClearKeychain();
    if (prevFake === undefined) delete process.env.FLINT_KEYCHAIN_FAKE;
    else process.env.FLINT_KEYCHAIN_FAKE = prevFake;
    if (prevDisabled === undefined) delete process.env.FLINT_KEYCHAIN_DISABLED;
    else process.env.FLINT_KEYCHAIN_DISABLED = prevDisabled;
    if (prevHome === undefined) delete process.env.FLINT_CONFIG_HOME;
    else process.env.FLINT_CONFIG_HOME = prevHome;
    rmSync(home, { recursive: true, force: true });
  });

  it('isKeychainAvailable is true when fake backend is active', async () => {
    expect(await isKeychainAvailable()).toBe(true);
  });

  it('write + read round-trip preserves all fields', async () => {
    const ok = await writeKeychainCredentials(CREDS);
    expect(ok).toBe(true);
    const back = await readKeychainCredentials();
    expect(back).not.toBeNull();
    expect(back).toEqual(CREDS);
  });

  it('read returns null after clearing', async () => {
    await writeKeychainCredentials(CREDS);
    await tryClearKeychain();
    expect(await readKeychainCredentials()).toBeNull();
  });

  it('tryClearKeychain returns true when something was removed', async () => {
    await writeKeychainCredentials(CREDS);
    expect(await tryClearKeychain()).toBe(true);
  });
});

describe('keychain fallback (FLINT_KEYCHAIN_DISABLED=1)', () => {
  let prevFake: string | undefined;
  let prevDisabled: string | undefined;
  beforeEach(() => {
    prevFake = process.env.FLINT_KEYCHAIN_FAKE;
    prevDisabled = process.env.FLINT_KEYCHAIN_DISABLED;
    process.env.FLINT_KEYCHAIN_DISABLED = '1';
    delete process.env.FLINT_KEYCHAIN_FAKE;
  });
  afterEach(() => {
    if (prevFake === undefined) delete process.env.FLINT_KEYCHAIN_FAKE;
    else process.env.FLINT_KEYCHAIN_FAKE = prevFake;
    if (prevDisabled === undefined) delete process.env.FLINT_KEYCHAIN_DISABLED;
    else process.env.FLINT_KEYCHAIN_DISABLED = prevDisabled;
  });

  it('isKeychainAvailable returns false when disabled', async () => {
    expect(await isKeychainAvailable()).toBe(false);
  });

  it('write returns false when no backend is available', async () => {
    expect(await writeKeychainCredentials(CREDS)).toBe(false);
  });

  it('read returns null when no backend is available', async () => {
    expect(await readKeychainCredentials()).toBeNull();
  });
});

describe('storage-mode hint file', () => {
  let prevHome: string | undefined;
  let home: string;

  beforeEach(() => {
    prevHome = process.env.FLINT_CONFIG_HOME;
    home = mkdtempSync(join(tmpdir(), 'flint-sm-'));
    process.env.FLINT_CONFIG_HOME = home;
  });
  afterEach(() => {
    if (prevHome === undefined) delete process.env.FLINT_CONFIG_HOME;
    else process.env.FLINT_CONFIG_HOME = prevHome;
    rmSync(home, { recursive: true, force: true });
  });

  it('defaults to "dev-vars" when never written', () => {
    expect(getStorageMode()).toBe('dev-vars');
  });

  it('round-trips a "keychain" preference', () => {
    setStorageMode('keychain');
    expect(getStorageMode()).toBe('keychain');
  });

  it('round-trips back to "dev-vars" when toggled', () => {
    setStorageMode('keychain');
    setStorageMode('dev-vars');
    expect(getStorageMode()).toBe('dev-vars');
  });
});
