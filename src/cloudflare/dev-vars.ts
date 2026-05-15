// Per-repo `.dev.vars` writer + gitignore enforcement.
//
// The CLI guarantees two invariants on every write:
//
//   1. `.dev.vars` is listed in the repo's .gitignore (appends if missing).
//   2. `.dev.vars` is NOT currently tracked by git (hard-blocks the write
//      with an actionable error pointing to `git rm --cached .dev.vars`).
//
// This is the most security-sensitive surface in Flint v0.1 — a stray
// commit of a CF API token is irreversible (must rotate). The block is
// strict: there is no `--force` for "I really do want to commit my token".
//
// `git ls-files --error-unmatch` is the cheapest way to ask git "is this
// file tracked?", with `0` for yes, non-zero for no. We invert: a zero
// exit means we must refuse.

import {
  appendFileSync,
  existsSync,
  readFileSync,
} from 'node:fs';
import { spawnSync } from 'node:child_process';
import { join } from 'node:path';
import { DEV_VARS_FILENAME, DEV_VARS_EXAMPLE_FILENAME } from '../util/paths.js';
import { writeFileAtomic } from '../util/atomic-write.js';

export interface DevVarsEntry {
  /** Variable name, e.g. `CLOUDFLARE_API_TOKEN`. */
  key: string;
  /** Plaintext value. Empty string is allowed (treated as "documented stub"). */
  value: string;
  /** Optional comment shown directly above the line. */
  comment?: string;
}

export class DevVarsTrackedError extends Error {
  constructor(public readonly devVarsPath: string) {
    super(
      `Refusing to write secrets — ${devVarsPath} is tracked by git.\n` +
        `Run \`git rm --cached ${DEV_VARS_FILENAME}\` and recommit, then retry.\n` +
        `If a previous commit included the file, rotate the leaked secrets immediately.`,
    );
    this.name = 'DevVarsTrackedError';
  }
}

/** Returns true if `.dev.vars` is currently in the git index for `repoRoot`. */
export function isDevVarsTrackedByGit(repoRoot: string): boolean {
  const devVarsPath = join(repoRoot, DEV_VARS_FILENAME);
  if (!existsSync(join(repoRoot, '.git'))) return false; // not a git repo
  const res = spawnSync(
    'git',
    ['-C', repoRoot, 'ls-files', '--error-unmatch', DEV_VARS_FILENAME],
    { encoding: 'utf8' },
  );
  // status 0 means "yes, tracked"; non-zero (including command-not-found)
  // means "no". We want to be permissive only on the no-git case above; if
  // git ran and said tracked, we honor that regardless of the working-tree
  // state on devVarsPath.
  void devVarsPath; // referenced for readability only
  return res.status === 0;
}

/**
 * Ensure `.dev.vars` is in `repoRoot/.gitignore`. Creates the file if
 * missing. Idempotent — no duplicate lines on repeated calls.
 */
export function ensureGitignored(repoRoot: string): void {
  const giPath = join(repoRoot, '.gitignore');
  const target = DEV_VARS_FILENAME;
  if (!existsSync(giPath)) {
    writeFileAtomic(
      giPath,
      `# Cloudflare dev secrets — managed by Flint, never commit.\n${target}\n`,
    );
    return;
  }
  const contents = readFileSync(giPath, 'utf8');
  const lines = contents.split(/\r?\n/);
  // Match by exact-line OR a line that starts the pattern (e.g. ".dev.vars*"
  // would also match). We accept any line that, when trimmed of leading "!"
  // negation, equals the target or starts with target + a glob character.
  const alreadyPresent = lines.some((line) => {
    const t = line.replace(/^\s*!?/, '').trim();
    if (!t || t.startsWith('#')) return false;
    return t === target || t.startsWith(`${target}*`) || t.startsWith(`${target}/`);
  });
  if (alreadyPresent) return;
  const needsLeadingNewline = !contents.endsWith('\n') && contents.length > 0;
  const block =
    `${needsLeadingNewline ? '\n' : ''}` +
    `# Cloudflare dev secrets — managed by Flint, never commit.\n${target}\n`;
  appendFileSync(giPath, block, 'utf8');
}

/**
 * Render a `.dev.vars` body from entries. Order is preserved; comments are
 * emitted as `# <comment>` lines directly above their variable.
 */
export function renderDevVarsBody(entries: DevVarsEntry[]): string {
  const blocks: string[] = [
    '# Server-side env for Cloudflare Pages Functions.',
    '# Managed by Flint. NEVER commit this file.',
    '# Wrangler reads this for `wrangler pages dev` automatically; in',
    '# production, the same keys are configured via the Pages dashboard.',
    '',
  ];
  for (const entry of entries) {
    if (entry.comment) {
      for (const line of entry.comment.split('\n')) {
        blocks.push(`# ${line}`);
      }
    }
    blocks.push(`${entry.key}=${entry.value}`);
    blocks.push('');
  }
  return blocks.join('\n');
}

/**
 * Write `.dev.vars` to `repoRoot`, enforcing both invariants. Throws
 * `DevVarsTrackedError` if the file is already in the git index.
 */
export function writeDevVars(repoRoot: string, entries: DevVarsEntry[]): string {
  if (isDevVarsTrackedByGit(repoRoot)) {
    throw new DevVarsTrackedError(join(repoRoot, DEV_VARS_FILENAME));
  }
  ensureGitignored(repoRoot);
  const path = join(repoRoot, DEV_VARS_FILENAME);
  writeFileAtomic(path, renderDevVarsBody(entries), { mode: 0o600 });
  return path;
}

/**
 * Write `.dev.vars.example` — same entries but with values blanked out.
 * Safe to commit; serves as on-boarding docs for new contributors.
 */
export function writeDevVarsExample(
  repoRoot: string,
  entries: DevVarsEntry[],
): string {
  const stubs = entries.map((e) => ({ ...e, value: '' }));
  const path = join(repoRoot, DEV_VARS_EXAMPLE_FILENAME);
  writeFileAtomic(path, renderDevVarsBody(stubs));
  return path;
}
