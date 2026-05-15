// Atomic file writes — write-tmp-rename pattern.
//
// `writeFileSync(path, ...)` is non-atomic: a crash mid-write leaves the
// target file truncated or partially written. The standard fix is
// write-then-rename: write to `<path>.tmp.<pid>.<rand>`, fsync, then rename
// onto the target. Rename is atomic on POSIX; on Windows, renameSync replaces
// the destination atomically (NTFS semantics).
//
// Why a dedicated helper rather than inlining everywhere:
//   - Single place to evolve the strategy (e.g. add fsync if a corruption
//     bug ever surfaces).
//   - One place to lock the temp-file naming convention (and clean up stale
//     temps in the future).
//   - Makes the call sites in init / create-app / add / configure / upgrade
//     all read the same way, so a reviewer can trust the invariant.
//
// Used by EVERY Flint write — manifest, scaffolded files, secrets,
// wrangler.toml, telemetry log preferences, credentials.
//
// NB: `appendFileSync` callers (telemetry log) deliberately stay
// non-atomic — append-only logs don't suffer from partial-write corruption
// the same way config / scaffold writes do, and atomic append is its own
// can of worms.

import {
  existsSync,
  mkdirSync,
  renameSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { dirname } from 'node:path';
import { randomBytes } from 'node:crypto';

export interface AtomicWriteOptions {
  /** File permission bits to set on the destination (e.g. 0o600). */
  mode?: number;
  /** Encoding (default 'utf8'). Set explicitly to undefined for binary. */
  encoding?: BufferEncoding;
  /**
   * Create the parent directory recursively if it doesn't exist (default
   * false — most callers manage their own dirs and a silent mkdir hides
   * bugs).
   */
  ensureDir?: boolean;
  /**
   * Directory mode to use when `ensureDir` creates a new directory.
   * Defaults to 0o755.
   */
  dirMode?: number;
}

/**
 * Atomically write `contents` to `path`. Crashes mid-write leave the
 * destination file untouched (the tmp file may be left behind, but a future
 * write to the same path will overwrite it).
 *
 * Returns the destination path for chaining.
 */
export function writeFileAtomic(
  path: string,
  contents: string | Uint8Array,
  options: AtomicWriteOptions = {},
): string {
  const { mode, encoding = 'utf8', ensureDir = false, dirMode = 0o755 } = options;

  if (ensureDir) {
    const dir = dirname(path);
    if (!existsSync(dir)) {
      mkdirSync(dir, { recursive: true, mode: dirMode });
    }
  }

  // Use a unique tmp suffix per write to avoid collisions when two concurrent
  // Flint invocations write the same path. The randomness also doubles as a
  // hint to future reviewers that the tmp file is short-lived.
  const tmpSuffix = `.tmp.${process.pid}.${randomBytes(4).toString('hex')}`;
  const tmp = `${path}${tmpSuffix}`;

  try {
    if (typeof contents === 'string') {
      writeFileSync(tmp, contents, { encoding, ...(mode !== undefined ? { mode } : {}) });
    } else {
      writeFileSync(tmp, contents, mode !== undefined ? { mode } : undefined);
    }
    renameSync(tmp, path);
  } catch (err) {
    // Best-effort cleanup so we don't accumulate orphaned tmp files.
    try {
      if (existsSync(tmp)) unlinkSync(tmp);
    } catch {
      // ignore — original error is the one that matters
    }
    throw err;
  }

  return path;
}

/**
 * Convenience wrapper: write JSON with a trailing newline (the convention
 * across the codebase). Pretty-prints with 2-space indent.
 */
export function writeJsonAtomic(
  path: string,
  value: unknown,
  options: AtomicWriteOptions = {},
): string {
  return writeFileAtomic(path, JSON.stringify(value, null, 2) + '\n', options);
}
