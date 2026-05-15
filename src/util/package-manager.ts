// Package-manager detection.
//
// Detection order:
//   1. Explicit --pm flag (caller-supplied)
//   2. `npm_config_user_agent` env var set by npm/pnpm/yarn/bun when they
//      run child processes. This is the canonical "which PM invoked us"
//      signal — used by create-vite, create-next-app, and shadcn-ui.
//   3. Default: npm
//
// We don't sniff lockfiles for create-app, because the target directory
// doesn't exist yet. For `flint init` (which runs INSIDE an existing repo)
// a lockfile-based detector would make sense — out of scope here.

export type PackageManager = 'npm' | 'pnpm' | 'bun';

const SUPPORTED: ReadonlyArray<PackageManager> = ['npm', 'pnpm', 'bun'];

/** Returns true if `value` is one of the supported package managers. */
export function isPackageManager(value: string): value is PackageManager {
  return (SUPPORTED as ReadonlyArray<string>).includes(value);
}

/**
 * Detect the package manager that invoked the current Node process via
 * `npm_config_user_agent`. Returns null if no recognisable signal is
 * present (e.g. the CLI is being run directly).
 */
export function detectFromUserAgent(): PackageManager | null {
  const ua = process.env.npm_config_user_agent;
  if (!ua) return null;
  // Format examples:
  //   npm/10.2.4 node/v20.10.0 linux x64 workspaces/false
  //   pnpm/9.4.0 npm/? node/v20.10.0 linux x64
  //   bun/1.1.13 npm/? node/v22.2.0 darwin arm64
  //   yarn/1.22.22 npm/? node/v20.10.0 linux x64
  // Match the leading "<pm>/" token.
  const match = /^([a-z]+)\//.exec(ua);
  if (!match) return null;
  const head = match[1]!;
  if (head === 'npm') return 'npm';
  if (head === 'pnpm') return 'pnpm';
  if (head === 'bun') return 'bun';
  // yarn falls through to the default — Flint doesn't target yarn for v0.5.
  return null;
}

/** Resolve the package manager from an explicit flag + auto-detect fallback. */
export function resolvePackageManager(explicit: string | undefined): PackageManager {
  if (explicit) {
    if (!isPackageManager(explicit)) {
      throw new Error(
        `Unknown package manager "${explicit}". Supported: ${SUPPORTED.join(', ')}.`,
      );
    }
    return explicit;
  }
  return detectFromUserAgent() ?? 'npm';
}

/** Tuple of (binary-name, args) for installing deps with the given package manager. */
export function installCommand(pm: PackageManager): readonly [string, string[]] {
  switch (pm) {
    case 'npm':
      return ['npm', ['install']];
    case 'pnpm':
      return ['pnpm', ['install']];
    case 'bun':
      return ['bun', ['install']];
  }
}
