// Thin adapter that invokes the user's local `wrangler` binary.
//
// Design notes:
//   - Flint is the CLI that wraps wrangler — it does NOT depend on wrangler
//     itself. `wrangler` is on the user's PATH (or in their repo's
//     `node_modules/.bin/`), and Flint defers to whatever version they
//     have. We probe with `wrangler --version` and warn on <4.x.
//   - Auth: we set `CLOUDFLARE_API_TOKEN` (and optionally `CLOUDFLARE_ACCOUNT_ID`)
//     in the child's environment from Flint's credentials cache, so wrangler
//     uses the token instead of its OAuth session.
//   - We use `spawnSync` from `node:child_process` (NOT the shell-string
//     form) to avoid quoting hazards. The first argument is the program
//     name; the rest are arguments passed as an array, so no shell
//     interpretation happens at all.

import { spawnSync, type SpawnSyncOptions } from 'node:child_process';
import { existsSync } from 'node:fs';

export interface WranglerRunOptions {
  /** Cloudflare API token — placed in env as CLOUDFLARE_API_TOKEN. */
  token?: string;
  /** Account id — placed in env as CLOUDFLARE_ACCOUNT_ID. */
  accountId?: string;
  /** Working directory for the child process. Defaults to cwd. */
  cwd?: string;
  /** Additional env overrides merged on top of process.env. */
  env?: NodeJS.ProcessEnv;
  /** Optional stdin payload (used by `secret put`). */
  stdin?: string;
}

export interface WranglerRunResult {
  status: number;
  stdout: string;
  stderr: string;
  /** Combined human-friendly view (stdout + stderr). */
  output: string;
}

/**
 * Resolve the wrangler binary path. Order:
 *   1. WRANGLER_BINARY env override (testing hook)
 *   2. `<cwd>/node_modules/.bin/wrangler` (the user's repo-local copy)
 *   3. plain `wrangler` (relies on PATH)
 *
 * We deliberately do NOT add `npx` as a fallback — `npx wrangler` is
 * dramatically slower and pulls a fresh dep tree if not cached, which
 * surprises users. If neither path 1 nor 2 nor 3 works, the caller should
 * tell the user to `npm install wrangler@^4` or add it to their PATH.
 */
export function resolveWranglerBin(cwd: string): string {
  if (process.env.WRANGLER_BINARY) return process.env.WRANGLER_BINARY;
  const local = `${cwd}/node_modules/.bin/wrangler`;
  if (existsSync(local)) return local;
  return 'wrangler';
}

/**
 * Invoke wrangler with the given arguments. Synchronous (spawnSync) — every
 * call site in v0.2 is one shot, no streaming output needed. The flint
 * shell prints a "Running: wrangler …" line beforehand so the user sees
 * intent even if wrangler is slow to start.
 */
export function runWrangler(args: string[], opts: WranglerRunOptions = {}): WranglerRunResult {
  const bin = resolveWranglerBin(opts.cwd ?? process.cwd());
  const env: NodeJS.ProcessEnv = { ...process.env, ...opts.env };
  if (opts.token) env.CLOUDFLARE_API_TOKEN = opts.token;
  if (opts.accountId) env.CLOUDFLARE_ACCOUNT_ID = opts.accountId;
  const spawnOpts: SpawnSyncOptions = {
    cwd: opts.cwd ?? process.cwd(),
    env,
    encoding: 'utf8',
    input: opts.stdin,
  };
  const res = spawnSync(bin, args, spawnOpts);
  const stdout = typeof res.stdout === 'string' ? res.stdout : '';
  const stderr = typeof res.stderr === 'string' ? res.stderr : '';
  if (res.error) {
    // ENOENT is the common path here — wrangler not installed.
    return {
      status: 127,
      stdout,
      stderr: `${res.error.message}\n${stderr}`,
      output: `${stdout}${stderr}\n${res.error.message}`,
    };
  }
  return {
    status: res.status ?? 1,
    stdout,
    stderr,
    output: `${stdout}${stderr}`,
  };
}

/**
 * Check that `wrangler` is on PATH (or in node_modules/.bin) and return its
 * version. Returns null if the binary is missing.
 */
export function getWranglerVersion(cwd: string): string | null {
  const res = runWrangler(['--version'], { cwd });
  if (res.status !== 0) return null;
  // Wrangler prints something like ` ⛅️ wrangler 4.90.0 ` plus update banners.
  // Extract the first thing that looks like a SemVer.
  const m = /\b(\d+\.\d+\.\d+)\b/.exec(res.output);
  return m ? m[1]! : null;
}

/** Parse a major version number from a "x.y.z" string. Null on malformed input. */
export function parseMajor(version: string | null): number | null {
  if (!version) return null;
  const m = /^(\d+)\./.exec(version);
  return m ? Number(m[1]) : null;
}
