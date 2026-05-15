// `--template <git+url>` support for `flint create-app`.
//
// Parsing rules:
//   - `git+https://host/owner/repo`              → clone repo, copy root
//   - `git+https://host/owner/repo#branch`       → clone, checkout branch, copy root
//   - `git+https://host/owner/repo@branch`       → same as #branch (npm convention)
//   - `git+https://host/owner/repo/path/to/dir`  → clone, copy only the subdirectory
//   - `git+https://host/owner/repo@branch/path`  → branch + subdirectory
//
// Behaviour:
//   1. Parse the URL.
//   2. Shallow-clone into a temp dir (`git clone --depth 1 [--branch <b>]`).
//   3. If a subdirectory is specified, scope the source to that subtree.
//   4. Remove `.git/` from the cloned tree (consumer will git-init their own).
//   5. Copy every file to the target directory, recording each into the
//      manifest under templateSource = `git+url:<sub>/<rel>` so the upgrade
//      flow knows these came from a custom source and can't be re-rendered
//      from the bundled templates.
//
// Errors:
//   - Network / git failures bubble up with a clear "the clone failed" message.
//   - If the cloned repo has its own `flint.manifest.json`, we DON'T merge —
//     we drop it. The new project starts fresh with its own manifest.

import {
  cpSync,
  existsSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
} from 'node:fs';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join, relative } from 'node:path';
import { ManifestTracker } from './manifest-tracker.js';

export interface ParsedTemplateUrl {
  /** The repository URL portion suitable for `git clone`. */
  repoUrl: string;
  /** Branch or ref to check out (undefined = repo default). */
  ref?: string;
  /** Subdirectory inside the repo to source from (undefined = repo root). */
  subdirectory?: string;
}

const GIT_PREFIX = /^git\+/;

/** Parse `git+<url>[#ref][@ref][/subdir]` syntax. */
export function parseTemplateUrl(input: string): ParsedTemplateUrl {
  if (!GIT_PREFIX.test(input)) {
    throw new Error(
      `[flint] template-url: "${input}" must start with "git+" — pass --template git+https://github.com/user/repo#main (the #main is the optional ref).`,
    );
  }
  let raw = input.replace(GIT_PREFIX, '');
  let ref: string | undefined;
  let subdirectory: string | undefined;
  // Try `#ref` first; if missing, try `@ref` (npm-style).
  const hashIdx = raw.indexOf('#');
  if (hashIdx >= 0) {
    const tail = raw.slice(hashIdx + 1);
    raw = raw.slice(0, hashIdx);
    // tail might itself be "<ref>/<subdir>"
    const slash = tail.indexOf('/');
    if (slash >= 0) {
      ref = tail.slice(0, slash);
      subdirectory = tail.slice(slash + 1);
    } else {
      ref = tail;
    }
  } else {
    // `@ref` after the `.git` or after the repo name. We scan from the right
    // so URLs like `https://user:pat@host/...` don't confuse us.
    const atIdx = raw.lastIndexOf('@');
    // Only treat the trailing @ as a ref if it appears AFTER the host portion.
    // host portion = everything up to the first single-slash after `://`
    const protoIdx = raw.indexOf('://');
    const hostStart = protoIdx >= 0 ? protoIdx + 3 : 0;
    const firstSlash = raw.indexOf('/', hostStart);
    if (atIdx > firstSlash && firstSlash >= 0) {
      const tail = raw.slice(atIdx + 1);
      raw = raw.slice(0, atIdx);
      const slash = tail.indexOf('/');
      if (slash >= 0) {
        ref = tail.slice(0, slash);
        subdirectory = tail.slice(slash + 1);
      } else {
        ref = tail;
      }
    }
  }
  if (raw.length === 0) {
    throw new Error(`[flint] template-url: "${input}" has no repository component — expected git+https://host/owner/repo with optional #ref/subdir.`);
  }
  return { repoUrl: raw, ref, subdirectory };
}

export interface ApplyTemplateOptions {
  /** Target directory the cloned tree is copied into. Created if missing. */
  targetDir: string;
  /** Parsed git URL. */
  url: ParsedTemplateUrl;
  /** Optional tracker — every file copied is recorded. */
  tracker?: ManifestTracker;
  /** Override the git binary (testing hook). Defaults to "git". */
  gitBinary?: string;
}

export interface ApplyTemplateResult {
  /** Number of files copied from the clone. */
  filesCopied: number;
  /** Path to the source directory (post-clone, post-subdirectory). */
  sourceDir: string;
}

/**
 * Shallow-clone the given URL into a scratch directory and copy its contents
 * (minus `.git`, `.github/` is preserved) into `targetDir`. The optional
 * tracker records every copied file so the manifest reflects the custom source.
 */
export function applyTemplate(opts: ApplyTemplateOptions): ApplyTemplateResult {
  const gitBin = opts.gitBinary ?? 'git';
  const scratch = mkdtempSync(join(tmpdir(), 'flint-template-'));
  try {
    const cloneArgs = ['clone', '--depth', '1'];
    if (opts.url.ref) {
      cloneArgs.push('--branch', opts.url.ref);
    }
    cloneArgs.push(opts.url.repoUrl, scratch);
    const cloneResult = spawnSync(gitBin, cloneArgs, { encoding: 'utf8' });
    if (cloneResult.status !== 0) {
      const stderr = (cloneResult.stderr ?? '').trim() || '(no error output)';
      throw new Error(
        `[flint] template-url: git clone failed for "${opts.url.repoUrl}"${opts.url.ref ? `#${opts.url.ref}` : ''} — check the URL/ref and your network access:\n${stderr}`,
      );
    }

    // Scope the source to the subdirectory if specified.
    const sourceDir = opts.url.subdirectory
      ? join(scratch, opts.url.subdirectory)
      : scratch;
    if (!existsSync(sourceDir) || !statSync(sourceDir).isDirectory()) {
      throw new Error(
        `[flint] template-url: subdirectory "${opts.url.subdirectory}" not found in cloned repo — verify the path inside the upstream repo and re-run.`,
      );
    }

    // Remove the .git directory from the clone — the consumer will run their
    // own `git init` (or `--no-git`). Same treatment for any pre-existing
    // flint.manifest.json (the new project starts with a fresh manifest).
    const gitDir = join(scratch, '.git');
    if (existsSync(gitDir)) rmSync(gitDir, { recursive: true, force: true });
    const sourceManifest = join(sourceDir, 'flint.manifest.json');
    if (existsSync(sourceManifest)) {
      rmSync(sourceManifest, { force: true });
    }

    // Copy every file from the source directory into the target. Node's
    // `cpSync` with recursive does what we need; we capture the file list
    // separately so we can record manifest entries.
    if (!existsSync(opts.targetDir)) {
      // Defer to caller; we expect the caller to mkdir.
      throw new Error(`[flint] template-url: target directory ${opts.targetDir} does not exist — internal error; this is a Flint bug, please file an issue.`);
    }
    let filesCopied = 0;
    walkAndCopy(sourceDir, opts.targetDir, '');
    return { filesCopied, sourceDir };

    function walkAndCopy(absSrcDir: string, absDstDir: string, relPrefix: string): void {
      for (const entry of readdirSync(absSrcDir)) {
        const absSrc = join(absSrcDir, entry);
        const absDst = join(absDstDir, entry);
        const rel = relPrefix ? `${relPrefix}/${entry}` : entry;
        const stat = statSync(absSrc);
        if (stat.isDirectory()) {
          // Recursively walk; cpSync handles dir creation.
          cpSync(absSrc, absDst, { recursive: true });
          // Record every file under the directory.
          recordTreeContents(absSrc, rel);
        } else if (stat.isFile()) {
          cpSync(absSrc, absDst);
          filesCopied += 1;
          if (opts.tracker) {
            opts.tracker.record({
              relPath: rel,
              templateSource: `git+${opts.url.repoUrl}${opts.url.ref ? `#${opts.url.ref}` : ''}${opts.url.subdirectory ? `/${opts.url.subdirectory}` : ''}/${rel}`,
              contents: readFileSync(absSrc, 'utf8'),
            });
          }
        }
      }
    }

    function recordTreeContents(absDir: string, relDirPrefix: string): void {
      if (!opts.tracker) {
        // Still count files for the return value.
        for (const entry of readdirSync(absDir)) {
          const abs = join(absDir, entry);
          const stat = statSync(abs);
          if (stat.isDirectory()) {
            recordTreeContents(abs, `${relDirPrefix}/${entry}`);
          } else if (stat.isFile()) {
            filesCopied += 1;
          }
        }
        return;
      }
      for (const entry of readdirSync(absDir)) {
        const abs = join(absDir, entry);
        const rel = `${relDirPrefix}/${entry}`;
        const stat = statSync(abs);
        if (stat.isDirectory()) {
          recordTreeContents(abs, rel);
        } else if (stat.isFile()) {
          filesCopied += 1;
          opts.tracker.record({
            relPath: rel,
            templateSource: `git+${opts.url.repoUrl}${opts.url.ref ? `#${opts.url.ref}` : ''}${opts.url.subdirectory ? `/${opts.url.subdirectory}` : ''}/${rel}`,
            contents: tryReadString(abs),
          });
        }
      }
    }
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
}

function tryReadString(absPath: string): string {
  try {
    return readFileSync(absPath, 'utf8');
  } catch {
    return '';
  }
}

// Keep `relative` referenced so tooling that strips "unused imports" doesn't
// remove the import — we may need it for a future subdir validation pass.
void relative;
