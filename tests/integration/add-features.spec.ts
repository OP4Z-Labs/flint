// Integration coverage for the v0.9 add subcommands:
//   - flint add pwa
//   - flint add auth
//   - flint add rate-limit
//
// Pattern: scaffold a real init first (so the project has wrangler.toml +
// vite.config + manifest), then run the add subcommand, then assert on the
// resulting file tree + manifest.

import { afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { existsSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  CLI_ENTRY,
  createTempRepo,
  readRepoFile,
  repoFileExists,
  runFlint,
  type TempRepo,
} from './_harness.js';

function setupInitRepo(variant: 'pages-functions' | 'pages-fullstack' = 'pages-fullstack'): TempRepo {
  const repo = createTempRepo({ seedPackageJson: true });
  const res = runFlint(
    ['init', '--variant', variant, '--name', 'add-test-app', '--yes'],
    { cwd: repo.dir },
  );
  if (res.status !== 0) {
    throw new Error(`init failed:\n${res.stdout}\n${res.stderr}`);
  }
  return repo;
}

describe('flint add pwa (integration)', () => {
  let repo: TempRepo;
  beforeAll(() => {
    if (!existsSync(CLI_ENTRY)) {
      throw new Error(`Build artifact missing: ${CLI_ENTRY}. Run npm run build.`);
    }
  });
  beforeEach(() => {
    repo = setupInitRepo('pages-fullstack');
  });
  afterEach(() => repo.cleanup());

  it('detects an existing VitePWA reference and bails out idempotently', () => {
    // pages-fullstack ships a vite.config.ts that already references VitePWA.
    const res = runFlint(['add', 'pwa', '--yes'], { cwd: repo.dir });
    expect(res.status).toBe(0);
    const combined = `${res.stdout}\n${res.stderr}`;
    expect(combined.toLowerCase()).toMatch(/already references vite-plugin-pwa|skipping/i);
  });

  it('patches a non-PWA vite.config.ts to add VitePWA', () => {
    // Overwrite vite.config.ts with a minimal one that has no PWA reference.
    writeFileSync(
      join(repo.dir, 'vite.config.ts'),
      [
        "import { defineConfig } from 'vite'",
        "import react from '@vitejs/plugin-react'",
        '',
        'export default defineConfig({',
        '  plugins: [react()],',
        '})',
        '',
      ].join('\n'),
      'utf8',
    );
    const res = runFlint(['add', 'pwa', '--yes', '--force'], { cwd: repo.dir });
    expect(res.status).toBe(0);
    const patched = readRepoFile(repo, 'vite.config.ts');
    expect(patched).toContain("vite-plugin-pwa");
    expect(patched).toContain('VitePWA');
  });

  it('manifest records the vite.config.ts entry under "add pwa"', () => {
    // Replace vite.config.ts with non-PWA and run add pwa.
    writeFileSync(
      join(repo.dir, 'vite.config.ts'),
      "import { defineConfig } from 'vite'\nexport default defineConfig({ plugins: [] })\n",
      'utf8',
    );
    runFlint(['add', 'pwa', '--yes', '--force'], { cwd: repo.dir });
    const manifest = JSON.parse(readRepoFile(repo, 'flint.manifest.json'));
    expect(manifest.files['vite.config.ts']).toBeDefined();
    expect(manifest.history.some((h: { command: string }) => h.command.includes('pwa'))).toBe(true);
  });
});

describe('flint add auth (integration)', () => {
  let repo: TempRepo;
  beforeEach(() => {
    repo = setupInitRepo('pages-functions');
  });
  afterEach(() => repo.cleanup());

  it('writes functions/_shared/auth.ts when not present', () => {
    // pages-functions ships auth.ts already; delete it first.
    const target = join(repo.dir, 'functions/_shared/auth.ts');
    rmSync(target, { force: true });

    const res = runFlint(['add', 'auth', '--yes'], { cwd: repo.dir });
    expect(res.status).toBe(0);
    expect(repoFileExists(repo, 'functions/_shared/auth.ts')).toBe(true);
    const contents = readRepoFile(repo, 'functions/_shared/auth.ts');
    expect(contents).toContain('verifyAuth');
    expect(contents).toContain('hmac');
  });

  it('skips when auth.ts already exists and --force was not passed (--yes mode)', () => {
    // auth.ts is already there from init. With --yes (non-interactive) and
    // no --force, we expect a clean skip.
    const before = readRepoFile(repo, 'functions/_shared/auth.ts');
    const res = runFlint(['add', 'auth', '--yes'], { cwd: repo.dir });
    expect(res.status).toBe(0);
    const after = readRepoFile(repo, 'functions/_shared/auth.ts');
    expect(after).toBe(before);
  });

  it('adds ADMIN_PASSWORD + COOKIE_SECRET to .dev.vars.example', () => {
    // Replace .dev.vars.example with a minimal one that has only CF entries.
    writeFileSync(
      join(repo.dir, '.dev.vars.example'),
      'CLOUDFLARE_API_TOKEN=\n',
      'utf8',
    );
    runFlint(['add', 'auth', '--yes', '--force'], { cwd: repo.dir });
    const example = readRepoFile(repo, '.dev.vars.example');
    expect(example).toContain('ADMIN_PASSWORD=');
    expect(example).toContain('COOKIE_SECRET=');
    // Original entry is preserved.
    expect(example).toContain('CLOUDFLARE_API_TOKEN=');
  });
});

describe('flint add rate-limit (integration)', () => {
  let repo: TempRepo;
  beforeEach(() => {
    repo = setupInitRepo('pages-functions');
  });
  afterEach(() => repo.cleanup());

  it('writes functions/_shared/ratelimit.ts when KV binding exists', () => {
    // pages-functions already declares CONTENT_KV — the rate-limit add
    // should find a binding and proceed.
    const target = join(repo.dir, 'functions/_shared/ratelimit.ts');
    rmSync(target, { force: true });
    const res = runFlint(['add', 'rate-limit', '--yes'], { cwd: repo.dir });
    expect(res.status).toBe(0);
    expect(repoFileExists(repo, 'functions/_shared/ratelimit.ts')).toBe(true);
    const contents = readRepoFile(repo, 'functions/_shared/ratelimit.ts');
    expect(contents).toContain('checkRateLimit');
  });

  it('records a manifest entry for the rate-limit file', () => {
    rmSync(join(repo.dir, 'functions/_shared/ratelimit.ts'), { force: true });
    runFlint(['add', 'rate-limit', '--yes'], { cwd: repo.dir });
    const manifest = JSON.parse(readRepoFile(repo, 'flint.manifest.json'));
    expect(manifest.files['functions/_shared/ratelimit.ts']).toBeDefined();
    expect(
      manifest.history.some((h: { command: string }) => h.command.includes('rate-limit')),
    ).toBe(true);
  });
});
