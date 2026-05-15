// Integration test harness. Spawns the real built `flint` binary
// (`dist/cli.js`) against an isolated temp directory and returns the raw
// child-process result.
//
// Why spawn-the-bin instead of importing the command modules directly:
//   - Unit tests already cover the programmatic API (see tests/commands/
//     and tests/cloudflare/). Those run via direct imports and bypass the
//     commander dispatch, version reader, and ESM entry-point guard.
//   - The 2026-05-14 smoke run caught a class of bug that ONLY shows up
//     when the binary is invoked through its shebang/symlink (Cadence's
//     symlink-resolution no-op). Integration tests close that gap.
//   - `node dist/cli.js` exercises the same code path the published `bin`
//     entry will take, minus the npm-install / global symlink dance.
//
// Why we don't run `npm link` from inside tests:
//   - That mutates the global node prefix, which is shared with the
//     developer and CI runner. Tests must not have global side effects.
//   - Pointing directly at `dist/cli.js` from the repo gives us the same
//     coverage without the linkage cost.
//
// Templates dir resolution:
//   - `src/commands/init.ts` resolves `templates/<variant>` relative to
//     `dist/commands/init.js` → `../../templates/<variant>`. As long as
//     `dist/` and `templates/` sit at the same repo root level, the
//     spawned bin finds them.

import { spawnSync, type SpawnSyncReturns } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync, existsSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

/** Absolute path to this repo's built CLI entry. */
export const CLI_ENTRY = resolve(
  dirname(fileURLToPath(import.meta.url)),
  '..',
  '..',
  'dist',
  'cli.js',
);

export interface FlintRunResult {
  stdout: string;
  stderr: string;
  status: number | null;
  /** Raw spawnSync result for callers needing more detail. */
  raw: SpawnSyncReturns<string>;
}

export interface FlintRunOptions {
  /** Working directory for the spawn. Defaults to CWD (rarely what you want). */
  cwd?: string;
  /** Extra env vars merged over `process.env`. */
  env?: Record<string, string | undefined>;
  /** Timeout in ms. Default 30s — most subcommands return in well under 1s. */
  timeoutMs?: number;
  /** Optional stdin to feed the child. Default: none (and stdin closed). */
  input?: string;
}

/**
 * Spawn the built Flint CLI with the given args. Returns the child's stdout,
 * stderr, and exit status. Never throws on non-zero exit — the caller is
 * expected to assert on `status` explicitly.
 */
export function runFlint(args: string[], opts: FlintRunOptions = {}): FlintRunResult {
  if (!existsSync(CLI_ENTRY)) {
    throw new Error(
      `Integration test prerequisite missing: ${CLI_ENTRY} does not exist. ` +
        'Run `npm run build` first.',
    );
  }
  const env: NodeJS.ProcessEnv = { ...process.env };
  // Force every credentials lookup into the temp home so a developer's real
  // ~/.config/flint/credentials never participates in an integration test.
  if (!('FLINT_CONFIG_HOME' in (opts.env ?? {}))) {
    // Caller didn't override — point at a per-process scratch path that
    // each test's beforeEach will overwrite anyway. We just want to make
    // sure FLINT_CONFIG_HOME is set to *something* by default so the auth
    // flow never reaches the real XDG location.
    env.FLINT_CONFIG_HOME = join(tmpdir(), 'flint-integration-default-home');
  }
  // Disable color escape codes so stdout/stderr substring assertions stay
  // stable across CI environments that may or may not set NO_COLOR.
  env.NO_COLOR = '1';
  for (const [k, v] of Object.entries(opts.env ?? {})) {
    if (v === undefined) {
      delete env[k];
    } else {
      env[k] = v;
    }
  }
  const result = spawnSync(process.execPath, [CLI_ENTRY, ...args], {
    cwd: opts.cwd,
    env,
    encoding: 'utf8',
    timeout: opts.timeoutMs ?? 30_000,
    input: opts.input,
    // Inherit nothing for stdin/stdout/stderr — we want them captured.
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  return {
    stdout: result.stdout ?? '',
    stderr: result.stderr ?? '',
    status: result.status,
    raw: result,
  };
}

export interface TempRepo {
  /** Absolute path to the temp repo root. */
  dir: string;
  /** Delete the temp repo. Safe to call multiple times. */
  cleanup: () => void;
}

/**
 * Create a throwaway directory representing a target repo for an
 * integration test. Optionally seeds a minimal `package.json` so commands
 * that read it (e.g. init's script merge) have something to chew on.
 */
export function createTempRepo(opts: { seedPackageJson?: boolean } = {}): TempRepo {
  const dir = mkdtempSync(join(tmpdir(), 'flint-integration-'));
  if (opts.seedPackageJson) {
    writeFileSync(
      join(dir, 'package.json'),
      JSON.stringify(
        {
          name: 'flint-integration-target',
          version: '0.0.0',
          private: true,
          type: 'module',
          scripts: {},
        },
        null,
        2,
      ) + '\n',
      'utf8',
    );
  }
  return {
    dir,
    cleanup: () => {
      rmSync(dir, { recursive: true, force: true });
    },
  };
}

/** Convenience: read a file from a TempRepo as UTF-8 text. */
export function readRepoFile(repo: TempRepo, relPath: string): string {
  return readFileSync(join(repo.dir, relPath), 'utf8');
}

/** Convenience: write a file into a TempRepo. Creates parent dirs implicitly only at one level. */
export function writeRepoFile(repo: TempRepo, relPath: string, contents: string): void {
  writeFileSync(join(repo.dir, relPath), contents, 'utf8');
}

/** Convenience: assertion-friendly existence check inside a TempRepo. */
export function repoFileExists(repo: TempRepo, relPath: string): boolean {
  return existsSync(join(repo.dir, relPath));
}
