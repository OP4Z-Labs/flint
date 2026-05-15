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

  // ─── --accept-current (First-Flint-onboarding finisher) ───────────────────
  it('--accept-current after backfill locks in current content as baseline', () => {
    // Simulate the First-Flint-onboarding scenario: an existing app gets a
    // manifest via backfill (all entries sentinel-modified), then
    // --accept-current flips every sentinel to the real content hash.
    rmSync(join(repo.dir, 'flint.manifest.json'), { force: true });

    // Step 1: backfill via --check.
    const check1 = runFlint(['upgrade', '--check'], { cwd: repo.dir });
    expect(
      check1.status,
      `expected drift after backfill, got status=${check1.status}\nstdout:\n${check1.stdout}\nstderr:\n${check1.stderr}`,
    ).toBe(1);
    expect(existsSync(join(repo.dir, 'flint.manifest.json'))).toBe(true);

    // Capture a sample file to verify it isn't rewritten by --accept-current.
    const wranglerBefore = readRepoFile(repo, 'wrangler.toml');

    // Step 2: accept-current.
    const accept = runFlint(['upgrade', '--accept-current'], { cwd: repo.dir });
    expect(
      accept.status,
      `accept-current failed:\nstdout:\n${accept.stdout}\nstderr:\n${accept.stderr}`,
    ).toBe(0);
    const combined = `${accept.stdout}\n${accept.stderr}`;
    expect(combined).toContain('Baseline locked');
    expect(combined).toMatch(/accepted:\s+\d+/);

    // Step 3: file content must not have changed.
    expect(readRepoFile(repo, 'wrangler.toml')).toBe(wranglerBefore);

    // Step 4: subsequent --check exits 0 (no drift).
    const check2 = runFlint(['upgrade', '--check'], { cwd: repo.dir });
    expect(
      check2.status,
      `expected no drift after accept-current, got status=${check2.status}\nstdout:\n${check2.stdout}\nstderr:\n${check2.stderr}`,
    ).toBe(0);
    const combined2 = `${check2.stdout}\n${check2.stderr}`;
    expect(combined2).toContain('in sync');
    expect(combined2).toMatch(/modified:\s+0/);
  });

  it('--accept-current on a clean repo is a no-op (no modified entries)', () => {
    const manifestBefore = readRepoFile(repo, 'flint.manifest.json');
    const res = runFlint(['upgrade', '--accept-current'], { cwd: repo.dir });
    expect(res.status).toBe(0);
    const combined = `${res.stdout}\n${res.stderr}`;
    expect(combined).toMatch(/accepted:\s+0/);
    // No history entry should be added (manifest is byte-identical).
    expect(readRepoFile(repo, 'flint.manifest.json')).toBe(manifestBefore);
  });

  it('--accept-current emits a structured JSON envelope with --json', () => {
    rmSync(join(repo.dir, 'flint.manifest.json'), { force: true });
    runFlint(['upgrade', '--check'], { cwd: repo.dir }); // backfill
    const res = runFlint(['--json', 'upgrade', '--accept-current'], {
      cwd: repo.dir,
    });
    expect(
      res.status,
      `json accept-current failed:\nstdout:\n${res.stdout}\nstderr:\n${res.stderr}`,
    ).toBe(0);
    const payload = JSON.parse(res.stdout) as {
      command: string;
      ok: boolean;
      data: { mode: string; accepted: number; untouched: number };
    };
    expect(payload.command).toBe('upgrade');
    expect(payload.ok).toBe(true);
    expect(payload.data.mode).toBe('accept-current');
    expect(payload.data.accepted).toBeGreaterThan(0);
  });
});
