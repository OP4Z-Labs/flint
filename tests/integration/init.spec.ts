// Integration coverage for `flint init` — spawns the real built bin and
// asserts on the resulting tmp-repo filesystem state.
//
// Smoke checklist mapping (from .agent/SMOKE-2026-05-14.md):
//   - Step 1: Fresh Vite-scaffold target directory
//   - Step 2: `flint init --variant pages-functions --name <n>` writes
//             all expected files; .gitignore picks up `.dev.vars`
//   - Step 3: `.gitignore` enforcement appends `.dev.vars` without dup
//   - Step 4: Idempotency — re-running init without --force prompts;
//             with --yes (non-interactive) it skips existing files.
//
// Notes on the harness:
//   - We seed a minimal `package.json` so `mergeScriptsIntoPackageJson`
//     has something real to chew on. We don't seed a full Vite scaffold —
//     the smoke step explicitly skipped `npm install` ("brief").
//   - `--yes` is the non-interactive escape hatch. Without it, init would
//     prompt for variant / project-name / overwrite confirmations and
//     block forever in a non-TTY child process.

import { afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { existsSync } from 'node:fs';
import {
  CLI_ENTRY,
  createTempRepo,
  readRepoFile,
  repoFileExists,
  runFlint,
  writeRepoFile,
  type TempRepo,
} from './_harness.js';

// Files we expect `flint init --variant pages-functions` to write. From
// smoke step 2: "Wrote all 10 expected files in one pass" — enumerated
// here so a regression in the template tree fails this test loudly.
const EXPECTED_PAGES_FUNCTIONS_FILES = [
  'wrangler.toml',
  'public/_headers',
  'public/_routes.json',
  'functions/_shared/auth.ts',
  'functions/_shared/ratelimit.ts',
  'functions/_shared/response.ts',
  'functions/_shared/schemas.ts',
  'functions/_shared/storage.ts',
  'functions/api/health.ts',
  '.github/workflows/ci.yml',
];

// Files we expect from the pages-fullstack variant — superset of the above
// plus vite.config.ts. (Both variants share the functions tree; the
// fullstack variant adds vite.config customizations.)
const EXPECTED_PAGES_FULLSTACK_ADDITIONS = ['vite.config.ts'];

describe('flint init (integration)', () => {
  beforeAll(() => {
    // The harness errors with a helpful message if dist/cli.js is missing,
    // but assert here so a failing build is obvious in CI logs.
    if (!existsSync(CLI_ENTRY)) {
      throw new Error(`Build artifact missing: ${CLI_ENTRY}. Run npm run build.`);
    }
  });

  let repo: TempRepo;

  beforeEach(() => {
    repo = createTempRepo({ seedPackageJson: true });
  });

  afterEach(() => {
    repo.cleanup();
  });

  it('smoke 1-2: writes all pages-functions files for a fresh repo', () => {
    const res = runFlint(
      ['init', '--variant', 'pages-functions', '--name', 'flint-smoke', '--yes'],
      { cwd: repo.dir },
    );

    expect(res.status, `flint init failed:\nstdout:\n${res.stdout}\nstderr:\n${res.stderr}`).toBe(
      0,
    );

    for (const rel of EXPECTED_PAGES_FUNCTIONS_FILES) {
      expect(repoFileExists(repo, rel), `expected init to write ${rel}`).toBe(true);
    }

    // wrangler.toml should be templated with the project name.
    const wrangler = readRepoFile(repo, 'wrangler.toml');
    expect(wrangler).toContain('name = "flint-smoke"');
    expect(wrangler).toContain('pages_build_output_dir = "dist"');
    // The pages-functions variant ships a CONTENT_KV block (smoke step 5
    // depends on this for the dedup check).
    expect(wrangler).toContain('binding = "CONTENT_KV"');
  });

  it('smoke 1-2: pages-fullstack variant additionally writes vite.config.ts', () => {
    const res = runFlint(
      ['init', '--variant', 'pages-fullstack', '--name', 'flint-fs-smoke', '--yes'],
      { cwd: repo.dir },
    );

    expect(res.status, `flint init failed:\nstdout:\n${res.stdout}\nstderr:\n${res.stderr}`).toBe(
      0,
    );

    for (const rel of [
      ...EXPECTED_PAGES_FUNCTIONS_FILES,
      ...EXPECTED_PAGES_FULLSTACK_ADDITIONS,
    ]) {
      expect(repoFileExists(repo, rel), `expected init to write ${rel}`).toBe(true);
    }
  });

  it('smoke 2: writes .dev.vars.example with the documented stubs', () => {
    const res = runFlint(
      ['init', '--variant', 'pages-functions', '--name', 'flint-smoke', '--yes'],
      { cwd: repo.dir },
    );
    expect(res.status).toBe(0);

    expect(repoFileExists(repo, '.dev.vars.example')).toBe(true);
    const example = readRepoFile(repo, '.dev.vars.example');
    // Smoke step 2 confirms the 4 documented stub keys are present.
    expect(example).toContain('CLOUDFLARE_API_TOKEN=');
    expect(example).toContain('CLOUDFLARE_ACCOUNT_ID=');
    expect(example).toContain('ADMIN_PASSWORD=');
    expect(example).toContain('COOKIE_SECRET=');
  });

  it('smoke 2: merges flint scripts into package.json', () => {
    const res = runFlint(
      ['init', '--variant', 'pages-functions', '--name', 'flint-smoke', '--yes'],
      { cwd: repo.dir },
    );
    expect(res.status).toBe(0);

    const pkg = JSON.parse(readRepoFile(repo, 'package.json'));
    expect(pkg.scripts).toBeDefined();
    expect(pkg.scripts['dev:vite']).toBe('vite --port 5173');
    expect(pkg.scripts['dev:cf']).toBe('wrangler pages dev --proxy 5173 --port 8788');
    expect(pkg.scripts.deploy).toBe('npm run build && wrangler pages deploy');
    // The project-name interpolated scripts.
    expect(pkg.scripts.logs).toBe(
      'wrangler pages deployment tail --project-name=flint-smoke',
    );
  });

  it('smoke 3: appends .dev.vars to .gitignore when the file does not exist', () => {
    const res = runFlint(
      ['init', '--variant', 'pages-functions', '--name', 'flint-smoke', '--yes'],
      { cwd: repo.dir },
    );
    expect(res.status).toBe(0);

    expect(repoFileExists(repo, '.gitignore')).toBe(true);
    const gitignore = readRepoFile(repo, '.gitignore');
    expect(gitignore).toContain('.dev.vars');
  });

  it('smoke 3: appends .dev.vars to a pre-existing .gitignore without duplicating', () => {
    // Pre-seed a .gitignore like the Vite scaffold does.
    writeRepoFile(
      repo,
      '.gitignore',
      ['node_modules', 'dist', '.env', ''].join('\n'),
    );

    const res = runFlint(
      ['init', '--variant', 'pages-functions', '--name', 'flint-smoke', '--yes'],
      { cwd: repo.dir },
    );
    expect(res.status).toBe(0);

    const gitignore = readRepoFile(repo, '.gitignore');
    // Original entries preserved.
    expect(gitignore).toContain('node_modules');
    expect(gitignore).toContain('dist');
    // .dev.vars appended exactly once.
    const occurrences = (gitignore.match(/^\.dev\.vars$/gm) ?? []).length;
    expect(occurrences, `.dev.vars should appear exactly once`).toBe(1);
  });

  it('smoke 3: re-running init does NOT duplicate the .dev.vars gitignore entry', () => {
    runFlint(
      ['init', '--variant', 'pages-functions', '--name', 'flint-smoke', '--yes'],
      { cwd: repo.dir },
    );
    // Second run with --yes + --force to overwrite files unconditionally.
    runFlint(
      [
        'init',
        '--variant',
        'pages-functions',
        '--name',
        'flint-smoke',
        '--yes',
        '--force',
      ],
      { cwd: repo.dir },
    );

    const gitignore = readRepoFile(repo, '.gitignore');
    const occurrences = (gitignore.match(/^\.dev\.vars$/gm) ?? []).length;
    expect(occurrences, '.dev.vars duplicated after second init').toBe(1);
  });

  it('smoke 4: re-running init in --yes mode without --force preserves existing files', () => {
    // First run: full scaffold.
    const first = runFlint(
      ['init', '--variant', 'pages-functions', '--name', 'flint-smoke', '--yes'],
      { cwd: repo.dir },
    );
    expect(first.status).toBe(0);

    // Mutate wrangler.toml so we can detect whether the second run
    // overwrote it.
    const sentinel = '# SENTINEL_DO_NOT_OVERWRITE_ME_42\n';
    const original = readRepoFile(repo, 'wrangler.toml');
    writeRepoFile(repo, 'wrangler.toml', sentinel + original);

    // Second run: --yes (non-interactive) without --force. init logs
    // "Exists, skipping" for each existing file rather than overwriting.
    const second = runFlint(
      ['init', '--variant', 'pages-functions', '--name', 'flint-smoke', '--yes'],
      { cwd: repo.dir },
    );
    expect(second.status).toBe(0);

    const afterSecond = readRepoFile(repo, 'wrangler.toml');
    expect(afterSecond.startsWith(sentinel)).toBe(true);
    // stdout should mention skipping.
    expect(second.stdout.toLowerCase()).toMatch(/skipping|already exists|skipped \d+/);
  });

  it('smoke 4: re-running init with --force unconditionally overwrites', () => {
    const first = runFlint(
      ['init', '--variant', 'pages-functions', '--name', 'flint-smoke', '--yes'],
      { cwd: repo.dir },
    );
    expect(first.status).toBe(0);

    const sentinel = '# SENTINEL_DO_NOT_OVERWRITE_ME_42';
    const original = readRepoFile(repo, 'wrangler.toml');
    writeRepoFile(repo, 'wrangler.toml', sentinel + '\n' + original);

    const second = runFlint(
      [
        'init',
        '--variant',
        'pages-functions',
        '--name',
        'flint-smoke',
        '--yes',
        '--force',
      ],
      { cwd: repo.dir },
    );
    expect(second.status).toBe(0);

    const afterSecond = readRepoFile(repo, 'wrangler.toml');
    expect(afterSecond.includes(sentinel)).toBe(false);
  });

  it('rejects an unknown variant with a non-zero exit and an actionable message', () => {
    const res = runFlint(
      ['init', '--variant', 'not-a-variant', '--name', 'flint-smoke', '--yes'],
      { cwd: repo.dir },
    );
    expect(res.status).not.toBe(0);
    // Error message should name the unknown variant + list the valid ones.
    const combined = `${res.stdout}\n${res.stderr}`;
    expect(combined).toContain('not-a-variant');
    expect(combined).toMatch(/pages-functions/);
    expect(combined).toMatch(/pages-fullstack/);
  });
});
