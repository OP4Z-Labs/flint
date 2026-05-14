// Tests for the .dev.vars writer + gitignore enforcement.
//
// The git-tracking check is the most security-critical surface in v0.1.
// We exercise both branches: (a) git repo with .dev.vars tracked → throw,
// (b) git repo with .dev.vars not tracked → write succeeds.

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  DevVarsTrackedError,
  ensureGitignored,
  isDevVarsTrackedByGit,
  renderDevVarsBody,
  writeDevVars,
  writeDevVarsExample,
} from '../../src/cloudflare/dev-vars.js';

function setupRepo(): { dir: string; cleanup: () => void } {
  const dir = mkdtempSync(join(tmpdir(), 'flint-repo-'));
  const init = spawnSync('git', ['init', '--quiet'], { cwd: dir });
  if (init.status !== 0) throw new Error('git init failed in test setup');
  // Commits in tests need a configured identity; set per-repo so we don't
  // mutate the host user's global git config.
  spawnSync('git', ['-C', dir, 'config', 'user.email', 'test@flint.local'], { cwd: dir });
  spawnSync('git', ['-C', dir, 'config', 'user.name', 'Flint Test'], { cwd: dir });
  return {
    dir,
    cleanup: () => rmSync(dir, { recursive: true, force: true }),
  };
}

describe('renderDevVarsBody', () => {
  it('emits comments above their variable lines', () => {
    const body = renderDevVarsBody([
      { key: 'FOO', value: 'bar', comment: 'A test key.' },
    ]);
    expect(body).toContain('# A test key.');
    expect(body).toContain('FOO=bar');
  });

  it('handles multi-line comments', () => {
    const body = renderDevVarsBody([
      { key: 'X', value: '', comment: 'line one\nline two' },
    ]);
    expect(body).toContain('# line one');
    expect(body).toContain('# line two');
  });
});

describe('ensureGitignored', () => {
  let repo: ReturnType<typeof setupRepo>;
  beforeEach(() => {
    repo = setupRepo();
  });
  afterEach(() => repo.cleanup());

  it('creates .gitignore if missing', () => {
    ensureGitignored(repo.dir);
    const contents = readFileSync(join(repo.dir, '.gitignore'), 'utf8');
    expect(contents).toContain('.dev.vars');
  });

  it('appends to .gitignore when .dev.vars is missing', () => {
    writeFileSync(join(repo.dir, '.gitignore'), 'node_modules/\ndist/\n', 'utf8');
    ensureGitignored(repo.dir);
    const contents = readFileSync(join(repo.dir, '.gitignore'), 'utf8');
    expect(contents).toContain('node_modules/');
    expect(contents).toContain('.dev.vars');
  });

  it('is idempotent — does not duplicate entries', () => {
    writeFileSync(join(repo.dir, '.gitignore'), '.dev.vars\n', 'utf8');
    ensureGitignored(repo.dir);
    ensureGitignored(repo.dir);
    const contents = readFileSync(join(repo.dir, '.gitignore'), 'utf8');
    const matches = contents.match(/^\.dev\.vars$/gm);
    expect(matches?.length).toBe(1);
  });

  it('accepts glob patterns (.dev.vars*) as already-present', () => {
    writeFileSync(join(repo.dir, '.gitignore'), '.dev.vars*\n', 'utf8');
    ensureGitignored(repo.dir);
    const contents = readFileSync(join(repo.dir, '.gitignore'), 'utf8');
    // No new ".dev.vars" line should be added because the glob covers it.
    expect(contents.match(/^\.dev\.vars$/gm)).toBeNull();
  });
});

describe('isDevVarsTrackedByGit', () => {
  let repo: ReturnType<typeof setupRepo>;
  beforeEach(() => {
    repo = setupRepo();
  });
  afterEach(() => repo.cleanup());

  it('returns false in a clean repo', () => {
    expect(isDevVarsTrackedByGit(repo.dir)).toBe(false);
  });

  it('returns true when .dev.vars is in the index', () => {
    writeFileSync(join(repo.dir, '.dev.vars'), 'X=1\n', 'utf8');
    const add = spawnSync('git', ['-C', repo.dir, 'add', '-f', '.dev.vars']);
    if (add.status !== 0) throw new Error(`git add failed: ${add.stderr.toString()}`);
    expect(isDevVarsTrackedByGit(repo.dir)).toBe(true);
  });

  it('returns false outside a git repo', () => {
    const dir = mkdtempSync(join(tmpdir(), 'flint-no-git-'));
    try {
      expect(isDevVarsTrackedByGit(dir)).toBe(false);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('writeDevVars + writeDevVarsExample', () => {
  let repo: ReturnType<typeof setupRepo>;
  beforeEach(() => {
    repo = setupRepo();
  });
  afterEach(() => repo.cleanup());

  it('writes .dev.vars with the supplied entries', () => {
    const path = writeDevVars(repo.dir, [
      { key: 'CLOUDFLARE_API_TOKEN', value: 'cf_test', comment: 'test' },
    ]);
    expect(existsSync(path)).toBe(true);
    const body = readFileSync(path, 'utf8');
    expect(body).toContain('CLOUDFLARE_API_TOKEN=cf_test');
  });

  it('also ensures .dev.vars is in .gitignore as a side effect', () => {
    writeDevVars(repo.dir, [{ key: 'X', value: 'y' }]);
    const gi = readFileSync(join(repo.dir, '.gitignore'), 'utf8');
    expect(gi).toContain('.dev.vars');
  });

  it('throws DevVarsTrackedError when .dev.vars is already tracked', () => {
    writeFileSync(join(repo.dir, '.dev.vars'), 'OLD=1\n', 'utf8');
    spawnSync('git', ['-C', repo.dir, 'add', '-f', '.dev.vars']);
    expect(() =>
      writeDevVars(repo.dir, [{ key: 'X', value: 'y' }]),
    ).toThrow(DevVarsTrackedError);
  });

  it('writeDevVarsExample blanks the values', () => {
    const path = writeDevVarsExample(repo.dir, [
      { key: 'SECRET', value: 'real-value', comment: 'should be blanked' },
    ]);
    const body = readFileSync(path, 'utf8');
    expect(body).toContain('SECRET=');
    expect(body).not.toContain('real-value');
  });
});
