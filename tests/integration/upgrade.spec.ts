// Integration coverage for `flint upgrade`. The flow exercises:
//
//   - --check on a clean (unmodified) repo
//   - --check on a modified repo
//   - --check on a backfilled repo (no manifest present)
//   - --diff on modified files
//   - --apply with non-TTY input — only the unmodified files auto-update;
//     modified files require interactive choices we can't drive in spawn,
//     so we cover that path with --dry-run instead.
//
// Note: we run init first to get a real manifest in place, then mutate
// specific files to simulate drift.

import { afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { existsSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  CLI_ENTRY,
  createTempRepo,
  readRepoFile,
  runFlint,
  type TempRepo,
} from './_harness.js';

function setupInitRepo(): TempRepo {
  const repo = createTempRepo({ seedPackageJson: true });
  const res = runFlint(
    ['init', '--variant', 'pages-functions', '--name', 'upgrade-test', '--yes'],
    { cwd: repo.dir },
  );
  if (res.status !== 0) {
    throw new Error(`init failed:\n${res.stdout}\n${res.stderr}`);
  }
  return repo;
}

describe('flint upgrade (integration)', () => {
  let repo: TempRepo;

  beforeAll(() => {
    if (!existsSync(CLI_ENTRY)) {
      throw new Error(`Build artifact missing: ${CLI_ENTRY}. Run npm run build.`);
    }
  });

  beforeEach(() => {
    repo = setupInitRepo();
  });

  afterEach(() => {
    repo.cleanup();
  });

  it('--check on a freshly scaffolded repo reports no drift', () => {
    const res = runFlint(['upgrade', '--check'], { cwd: repo.dir });
    expect(res.status).toBe(0);
    const combined = `${res.stdout}\n${res.stderr}`;
    expect(combined).toContain('in sync');
    expect(combined).toContain('unmodified:');
    // No modified / ejected / missing entries.
    expect(combined).toMatch(/modified:\s+0/);
    expect(combined).toMatch(/missing:\s+0/);
  });

  it('--check reports modified files when a tracked file is edited', () => {
    const wrangler = readRepoFile(repo, 'wrangler.toml');
    writeFileSync(
      join(repo.dir, 'wrangler.toml'),
      wrangler + '\n# user edit\n',
      'utf8',
    );
    const res = runFlint(['upgrade', '--check'], { cwd: repo.dir });
    // Exit code 1 means drift detected.
    expect(res.status).toBe(1);
    const combined = `${res.stdout}\n${res.stderr}`;
    expect(combined).toMatch(/\[modified\s*\]\s+wrangler\.toml/);
  });

  it('--check reports missing files when a tracked file is deleted', () => {
    rmSync(join(repo.dir, 'functions/_shared/auth.ts'), { force: true });
    const res = runFlint(['upgrade', '--check'], { cwd: repo.dir });
    expect(res.status).toBe(1);
    const combined = `${res.stdout}\n${res.stderr}`;
    expect(combined).toMatch(/\[missing\s*\]\s+functions\/_shared\/auth\.ts/);
  });

  it('--diff prints a unified diff for a modified file', () => {
    const wrangler = readRepoFile(repo, 'wrangler.toml');
    writeFileSync(
      join(repo.dir, 'wrangler.toml'),
      wrangler.replace('compatibility_date', '# changed\ncompatibility_date'),
      'utf8',
    );
    const res = runFlint(['upgrade', '--diff'], { cwd: repo.dir });
    expect(res.status).toBe(0);
    const combined = `${res.stdout}\n${res.stderr}`;
    expect(combined).toContain('# wrangler.toml');
    expect(combined).toMatch(/^@@\s/m);
  });

  it('backfills a manifest when none exists', () => {
    // Simulate a v0.5 scaffold by deleting the manifest after init.
    rmSync(join(repo.dir, 'flint.manifest.json'), { force: true });
    const res = runFlint(['upgrade', '--check'], { cwd: repo.dir });
    // Backfill flags everything as modified → exit 1.
    expect(res.status).toBe(1);
    const combined = `${res.stdout}\n${res.stderr}`;
    expect(combined.toLowerCase()).toContain('backfill');
    expect(existsSync(join(repo.dir, 'flint.manifest.json'))).toBe(true);
    // The backfilled manifest should classify every entry as "modified"
    // (conservative default).
    expect(combined).toMatch(/\[modified/);
  });

  it('--dry-run does not modify files or the manifest', () => {
    const manifestBefore = readRepoFile(repo, 'flint.manifest.json');
    const res = runFlint(['upgrade', '--dry-run'], { cwd: repo.dir });
    expect(res.status).toBe(0);
    const manifestAfter = readRepoFile(repo, 'flint.manifest.json');
    expect(manifestAfter).toBe(manifestBefore);
  });
});
