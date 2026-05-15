// Package-manager detection + cross-PM command translation.
//
// v1.0 expands v0.5's UA-string detection into a multi-signal resolver:
//
//   1. Explicit --pm flag (caller-supplied) — wins if present.
//   2. Lockfile in cwd (Phase D addition):
//      - bun.lockb / bun.lock → bun
//      - pnpm-lock.yaml      → pnpm
//      - yarn.lock           → yarn (best-effort)
//      - package-lock.json   → npm
//   3. `npm_config_user_agent` env var (signals which PM ran the current
//      Node process — used by every modern create-* CLI).
//   4. Default: npm.
//
// First-class PMs (full support across init/create-app/add): npm, pnpm, bun.
// Best-effort PMs (works for read/install paths but with documented caveats
// in docs/package-managers.md): yarn.

import { existsSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';

export type PackageManager = 'npm' | 'pnpm' | 'bun' | 'yarn';

const FIRST_CLASS: ReadonlyArray<PackageManager> = ['npm', 'pnpm', 'bun'];
const BEST_EFFORT: ReadonlyArray<PackageManager> = ['yarn'];
const ALL_PMS: ReadonlyArray<PackageManager> = [...FIRST_CLASS, ...BEST_EFFORT];

export type PackageManagerTier = 'first-class' | 'best-effort';

export interface PackageManagerDetection {
  name: PackageManager;
  tier: PackageManagerTier;
  /** Where the detection came from. */
  source: 'flag' | 'lockfile' | 'user-agent' | 'default';
  /** Best-effort version string from `<pm> --version`. Null if probe failed. */
  version: string | null;
}

/** Returns true if `value` is a known package manager (first-class or best-effort). */
export function isPackageManager(value: string): value is PackageManager {
  return (ALL_PMS as ReadonlyArray<string>).includes(value);
}

/**
 * Resolve the executable name for `spawnSync` on the current platform.
 *
 * On Windows, npm-installed shims are `.cmd` (or `.ps1`) files and Node's
 * `spawnSync` without `shell: true` will not auto-resolve a bare `npm` to
 * `npm.cmd`. We append the suffix explicitly to keep `shell: true` (which
 * is unsafe with user-supplied input) out of the codebase.
 *
 * POSIX returns the bare name unchanged.
 */
export function resolvePackageManagerBin(pm: PackageManager): string {
  if (process.platform === 'win32') return `${pm}.cmd`;
  return pm;
}

/** First-class vs best-effort tier classification. */
export function packageManagerTier(pm: PackageManager): PackageManagerTier {
  return FIRST_CLASS.includes(pm) ? 'first-class' : 'best-effort';
}

/** Probe `<pm> --version` to get a version string. Returns null on failure. */
export function probePackageManagerVersion(pm: PackageManager): string | null {
  try {
    const res = spawnSync(resolvePackageManagerBin(pm), ['--version'], { encoding: 'utf8' });
    if (res.status !== 0) return null;
    const out = (res.stdout + res.stderr).trim();
    // Most PMs print a single semver string. yarn 1.x prints just "1.22.22"
    // already; pnpm prints "9.4.0"; bun prints "1.1.13".
    const m = /(\d+\.\d+\.\d+(?:-[A-Za-z0-9.-]+)?)/.exec(out);
    return m ? m[1] : out;
  } catch {
    return null;
  }
}

/**
 * Detect the package manager from lockfiles in `cwd`. Returns null if no
 * known lockfile is present. Bun's `bun.lockb` (binary) and `bun.lock` (text)
 * are both recognised.
 */
export function detectFromLockfiles(cwd: string): PackageManager | null {
  if (existsSync(join(cwd, 'bun.lockb'))) return 'bun';
  if (existsSync(join(cwd, 'bun.lock'))) return 'bun';
  if (existsSync(join(cwd, 'pnpm-lock.yaml'))) return 'pnpm';
  if (existsSync(join(cwd, 'yarn.lock'))) return 'yarn';
  if (existsSync(join(cwd, 'package-lock.json'))) return 'npm';
  return null;
}

/**
 * Detect the package manager that invoked the current Node process via
 * `npm_config_user_agent`. Returns null if no recognisable signal is
 * present (e.g. the CLI is being run directly via node).
 */
export function detectFromUserAgent(): PackageManager | null {
  const ua = process.env.npm_config_user_agent;
  if (!ua) return null;
  // Format examples:
  //   npm/10.2.4 node/v20.10.0 linux x64 workspaces/false
  //   pnpm/9.4.0 npm/? node/v20.10.0 linux x64
  //   bun/1.1.13 npm/? node/v22.2.0 darwin arm64
  //   yarn/1.22.22 npm/? node/v20.10.0 linux x64
  const match = /^([a-z]+)\//.exec(ua);
  if (!match) return null;
  const head = match[1]!;
  if (isPackageManager(head)) return head;
  return null;
}

/**
 * Full detection — combines all the signals into a single PackageManagerDetection
 * record. Used by `flint doctor` and by callers that want a rich answer.
 */
export function detectPackageManager(cwd: string): PackageManagerDetection {
  const lockfile = detectFromLockfiles(cwd);
  if (lockfile) {
    return {
      name: lockfile,
      tier: packageManagerTier(lockfile),
      source: 'lockfile',
      version: probePackageManagerVersion(lockfile),
    };
  }
  const ua = detectFromUserAgent();
  if (ua) {
    return {
      name: ua,
      tier: packageManagerTier(ua),
      source: 'user-agent',
      version: probePackageManagerVersion(ua),
    };
  }
  return {
    name: 'npm',
    tier: 'first-class',
    source: 'default',
    version: probePackageManagerVersion('npm'),
  };
}

/**
 * Resolve the PM for a write-side operation (create-app / install). Accepts
 * an optional explicit override; falls back to lockfile → UA → default.
 */
export function resolvePackageManager(
  explicit: string | undefined,
  cwd: string = process.cwd(),
): PackageManager {
  if (explicit !== undefined) {
    if (!isPackageManager(explicit)) {
      throw new Error(
        `[flint] package-manager: unknown PM "${explicit}". Supported: ${ALL_PMS.join(', ')} — pass one of those to --pm.`,
      );
    }
    return explicit;
  }
  // No explicit flag — let detectPackageManager decide.
  return detectPackageManager(cwd).name;
}

/**
 * Tuple of (binary-name, args) for installing deps with the given package
 * manager. The binary name is platform-resolved — `npm.cmd` on Windows,
 * `npm` on POSIX — so it can be passed directly to `spawnSync` without
 * `shell: true`.
 */
export function installCommand(pm: PackageManager): readonly [string, string[]] {
  const bin = resolvePackageManagerBin(pm);
  switch (pm) {
    case 'npm':
      return [bin, ['install']];
    case 'pnpm':
      return [bin, ['install']];
    case 'bun':
      return [bin, ['install']];
    case 'yarn':
      // yarn 1.x: `yarn` alone does install. yarn 2+ uses `yarn install` too.
      return [bin, ['install']];
  }
}

/** Tuple of (binary-name, args) for running an npm script with the given PM. */
export function runScriptCommand(
  pm: PackageManager,
  script: string,
): readonly [string, string[]] {
  const bin = resolvePackageManagerBin(pm);
  switch (pm) {
    case 'npm':
      return [bin, ['run', script]];
    case 'pnpm':
      return [bin, ['run', script]];
    case 'bun':
      return [bin, ['run', script]];
    case 'yarn':
      // yarn 1.x lets you do `yarn <script>` for non-reserved names, but
      // `yarn run <script>` is universal.
      return [bin, ['run', script]];
  }
}

/**
 * Tuple of (binary-name, args) for invoking a binary from node_modules/.bin.
 * Returns platform-resolved binary names (npx.cmd on Windows, etc.) so the
 * caller can pass them directly to spawnSync.
 */
export function execCommand(
  pm: PackageManager,
  bin: string,
  binArgs: string[],
): readonly [string, string[]] {
  const winSuffix = process.platform === 'win32' ? '.cmd' : '';
  switch (pm) {
    case 'npm':
      return [`npx${winSuffix}`, ['--no-install', bin, ...binArgs]];
    case 'pnpm':
      return [`pnpm${winSuffix}`, ['exec', bin, ...binArgs]];
    case 'bun':
      return [`bunx${winSuffix}`, [bin, ...binArgs]];
    case 'yarn':
      return [`yarn${winSuffix}`, ['exec', bin, ...binArgs]];
  }
}

// statSync-touching helper used by Doctor + tests when they want to verify
// that the detected lockfile is an actual file (and not a directory of the
// same name on a weird mount).
export function lockfileExists(cwd: string, name: string): boolean {
  const path = join(cwd, name);
  try {
    return existsSync(path) && statSync(path).isFile();
  } catch {
    return false;
  }
}
