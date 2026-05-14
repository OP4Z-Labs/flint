// Cross-repo Cloudflare credentials cache. Source of truth at
// `~/.config/flint/credentials` (or `$FLINT_CONFIG_HOME/credentials` for
// tests/CI), mode 0600. Per-project `.dev.vars` is hydrated from here.
//
// File shape (JSON):
//   {
//     "token": "<CF API token>",
//     "accountId": "<32-char hex>",
//     "accountName": "<human-readable>",
//     "createdAt": "<ISO 8601>"
//   }
//
// Rotation history sits in `credentials.rotated/<timestamp>.json` for 30
// days — only used as recovery; nothing reads it automatically.

import {
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  writeFileSync,
} from 'node:fs';
import { credentialsPath, flintConfigDir, rotatedCredentialsDir } from '../util/paths.js';
import { join } from 'node:path';

export interface Credentials {
  token: string;
  accountId: string;
  accountName: string;
  createdAt: string;
}

const FILE_MODE_PRIVATE = 0o600;
const DIR_MODE_PRIVATE = 0o700;

/** Returns the cached credentials, or null if none have been written yet. */
export function readCredentials(): Credentials | null {
  const path = credentialsPath();
  if (!existsSync(path)) return null;
  try {
    const raw = readFileSync(path, 'utf8');
    const parsed = JSON.parse(raw) as Partial<Credentials>;
    if (
      typeof parsed.token !== 'string' ||
      typeof parsed.accountId !== 'string' ||
      typeof parsed.accountName !== 'string' ||
      typeof parsed.createdAt !== 'string'
    ) {
      return null;
    }
    return parsed as Credentials;
  } catch {
    return null;
  }
}

/** Persist credentials atomically (write+rename) with mode 0600. */
export function writeCredentials(creds: Credentials): void {
  const dir = flintConfigDir();
  if (!existsSync(dir)) {
    mkdirSync(dir, { recursive: true, mode: DIR_MODE_PRIVATE });
  }
  const path = credentialsPath();
  const tmp = `${path}.tmp`;
  writeFileSync(tmp, JSON.stringify(creds, null, 2) + '\n', {
    encoding: 'utf8',
    mode: FILE_MODE_PRIVATE,
  });
  // Rename is atomic on POSIX; on Windows, renameSync replaces too.
  renameSync(tmp, path);
}

/**
 * Archive the existing credentials file before overwriting (rotate path).
 * Returns the snapshot path if a snapshot was made, or null if there was
 * nothing to archive.
 */
export function archiveCurrentCredentials(): string | null {
  const current = readCredentials();
  if (!current) return null;
  const dir = rotatedCredentialsDir();
  if (!existsSync(dir)) {
    mkdirSync(dir, { recursive: true, mode: DIR_MODE_PRIVATE });
  }
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const snapshotPath = join(dir, `${stamp}.json`);
  writeFileSync(snapshotPath, JSON.stringify(current, null, 2) + '\n', {
    encoding: 'utf8',
    mode: FILE_MODE_PRIVATE,
  });
  return snapshotPath;
}
