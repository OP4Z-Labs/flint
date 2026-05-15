// OS keychain backing for Flint credentials (v0.9, opt-in via `auth init --keychain`).
//
// We don't take a hard dependency on a native module like `keytar`:
//   - keytar requires platform-specific binaries that fail to install on
//     headless CI / minimal containers, breaking the default install path.
//   - Cloudflare credentials don't need keychain-grade protection for the
//     dev-loop case (they sit alongside .dev.vars at mode 0600 already).
//   - Users who DO want keychain backing typically have keytar installed
//     for other tools (1Password CLI, vault, etc.).
//
// Approach: when `--keychain` is passed, we attempt a runtime dynamic-import
// of `keytar`. If it loads, we write to it. If not, we log a clear "keychain
// not available, falling back to .dev.vars" warning and continue with the
// default storage path. The user is never surprised.
//
// Storage layout in the keychain:
//   - Service name:  "flint"
//   - Account name:  "cloudflare-api-token"  (the actual token value)
//                    "cloudflare-account-id" (the account id)
//                    "cloudflare-account-name" (the account name)
//
// A small hint file at `~/.config/flint/storage-mode` records the user's
// chosen mode so `auth status` and `auth purge` know where to look without
// re-prompting.

import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { flintConfigDir } from './paths.js';
import { writeFileAtomic } from './atomic-write.js';

export type StorageMode = 'dev-vars' | 'keychain';

const HINT_FILE = 'storage-mode';

const KEYCHAIN_SERVICE = 'flint';
const KEY_TOKEN = 'cloudflare-api-token';
const KEY_ACCOUNT_ID = 'cloudflare-account-id';
const KEY_ACCOUNT_NAME = 'cloudflare-account-name';
const KEY_CREATED_AT = 'cloudflare-created-at';

/** Read the persisted storage mode. Defaults to "dev-vars" when absent. */
export function getStorageMode(): StorageMode {
  const path = join(flintConfigDir(), HINT_FILE);
  if (!existsSync(path)) return 'dev-vars';
  try {
    const raw = readFileSync(path, 'utf8').trim();
    return raw === 'keychain' ? 'keychain' : 'dev-vars';
  } catch {
    return 'dev-vars';
  }
}

/** Persist the storage mode preference for future invocations. */
export function setStorageMode(mode: StorageMode): void {
  const path = join(flintConfigDir(), HINT_FILE);
  // The config dir is created lazily; if it doesn't exist yet, the caller's
  // writeCredentials path will create it. We still try a no-op to record.
  try {
    if (!existsSync(flintConfigDir())) return;
    writeFileAtomic(path, mode + '\n', { mode: 0o600 });
  } catch {
    // Non-fatal.
  }
}

interface KeytarLike {
  setPassword: (service: string, account: string, password: string) => Promise<void>;
  getPassword: (service: string, account: string) => Promise<string | null>;
  deletePassword: (service: string, account: string) => Promise<boolean>;
}

/**
 * Attempt to load keytar at runtime. Returns null if not installed or if it
 * fails to initialize (e.g. headless Linux with no libsecret backend).
 * The dynamic-import path means a fresh `npm install flint` doesn't drag in
 * native bindings.
 */
async function tryLoadKeytar(): Promise<KeytarLike | null> {
  if (process.env.FLINT_KEYCHAIN_DISABLED === '1') {
    return null;
  }
  if (process.env.FLINT_KEYCHAIN_FAKE === '1') {
    return getFakeKeychain();
  }
  try {
    const mod = (await import('keytar' as string).catch(() => null)) as
      | { default?: KeytarLike }
      | KeytarLike
      | null;
    if (!mod) return null;
    const candidate = ('default' in mod && mod.default ? mod.default : mod) as KeytarLike;
    if (
      typeof candidate.setPassword !== 'function' ||
      typeof candidate.getPassword !== 'function' ||
      typeof candidate.deletePassword !== 'function'
    ) {
      return null;
    }
    // Probe: write and immediately read a sentinel. If the keychain backend
    // is missing (no libsecret on Linux, locked Keychain on Mac), this fails.
    await candidate.setPassword(KEYCHAIN_SERVICE, '__flint_probe__', 'ok');
    const probe = await candidate.getPassword(KEYCHAIN_SERVICE, '__flint_probe__');
    await candidate.deletePassword(KEYCHAIN_SERVICE, '__flint_probe__');
    if (probe !== 'ok') return null;
    return candidate;
  } catch {
    return null;
  }
}

/** A purely-in-memory keychain used for tests. Activated by FLINT_KEYCHAIN_FAKE=1. */
const FAKE_STORE = new Map<string, string>();
function fakeKey(service: string, account: string): string {
  return `${service}:${account}`;
}
function getFakeKeychain(): KeytarLike {
  return {
    async setPassword(service, account, password): Promise<void> {
      FAKE_STORE.set(fakeKey(service, account), password);
    },
    async getPassword(service, account): Promise<string | null> {
      return FAKE_STORE.get(fakeKey(service, account)) ?? null;
    },
    async deletePassword(service, account): Promise<boolean> {
      return FAKE_STORE.delete(fakeKey(service, account));
    },
  };
}

export interface KeychainCredentials {
  token: string;
  accountId: string;
  accountName: string;
  createdAt: string;
}

/**
 * Write credentials to the OS keychain. Returns true on success, false if
 * keytar isn't available (caller should fall back to .dev.vars).
 */
export async function writeKeychainCredentials(
  creds: KeychainCredentials,
): Promise<boolean> {
  const k = await tryLoadKeytar();
  if (!k) return false;
  await k.setPassword(KEYCHAIN_SERVICE, KEY_TOKEN, creds.token);
  await k.setPassword(KEYCHAIN_SERVICE, KEY_ACCOUNT_ID, creds.accountId);
  await k.setPassword(KEYCHAIN_SERVICE, KEY_ACCOUNT_NAME, creds.accountName);
  await k.setPassword(KEYCHAIN_SERVICE, KEY_CREATED_AT, creds.createdAt);
  return true;
}

/** Read credentials from the OS keychain. Returns null if missing or unavailable. */
export async function readKeychainCredentials(): Promise<KeychainCredentials | null> {
  const k = await tryLoadKeytar();
  if (!k) return null;
  const token = await k.getPassword(KEYCHAIN_SERVICE, KEY_TOKEN);
  if (!token) return null;
  const accountId = (await k.getPassword(KEYCHAIN_SERVICE, KEY_ACCOUNT_ID)) ?? '';
  const accountName =
    (await k.getPassword(KEYCHAIN_SERVICE, KEY_ACCOUNT_NAME)) ?? '(unknown)';
  const createdAt =
    (await k.getPassword(KEYCHAIN_SERVICE, KEY_CREATED_AT)) ?? new Date(0).toISOString();
  return { token, accountId, accountName, createdAt };
}

/** Delete every Flint keychain entry. Returns true if anything was removed. */
export async function tryClearKeychain(): Promise<boolean> {
  const k = await tryLoadKeytar();
  if (!k) return false;
  let removed = false;
  for (const key of [KEY_TOKEN, KEY_ACCOUNT_ID, KEY_ACCOUNT_NAME, KEY_CREATED_AT]) {
    const r = await k.deletePassword(KEYCHAIN_SERVICE, key);
    if (r) removed = true;
  }
  return removed;
}

/** Probe-only: returns true if a working keychain backend is detected. */
export async function isKeychainAvailable(): Promise<boolean> {
  const k = await tryLoadKeytar();
  return k !== null;
}
