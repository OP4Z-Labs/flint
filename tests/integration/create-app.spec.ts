// Integration coverage for `flint create-app`. Spawns the real built bin
// against a tmp directory, then asserts on the scaffolded filesystem state.
//
// We invoke with `--no-install --no-git --yes` so the suite stays fast and
// deterministic:
//   - `--no-install` skips a real npm/pnpm/bun install (which can be
//     minutes-long on slow CI runners and pulls real network).
//   - `--no-git` skips `git init` (which would otherwise leave a `.git`
//     directory the test cleanup has to chase).
//   - `--yes` skips all prompts.
//
// Notes:
//   - The harness's tmp-repo helper pre-creates the parent directory; we
//     pass the app name as a relative path so it lands inside that parent.
//   - Each test does its own `cd` (via the runFlint `cwd` option) to keep
//     test isolation clean — no shared cwd across specs.

import { afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import {
  existsSync,
  readFileSync,
  mkdirSync as mkdirSyncFs,
  writeFileSync as writeFileSyncFs,
} from 'node:fs';
import { join } from 'node:path';
import {
  CLI_ENTRY,
  createTempRepo,
  runFlint,
  type TempRepo,
} from './_harness.js';

const SHARED_SKELETON_FILES = [
  'package.json',
  'tsconfig.json',
  'tsconfig.app.json',
  'tsconfig.node.json',
  'eslint.config.js',
  'vitest.config.ts',
  'index.html',
  'src/main.tsx',
  'src/App.tsx',
  'src/index.css',
  'src/test-setup.ts',
  'src/vite-env.d.ts',
  '.gitignore',
  '.dev.vars.example',
  'wrangler.toml',
  'public/_headers',
  'public/_routes.json',
  '.github/workflows/ci.yml',
];

describe('flint create-app (integration)', () => {
  beforeAll(() => {
    if (!existsSync(CLI_ENTRY)) {
      throw new Error(`Build artifact missing: ${CLI_ENTRY}. Run npm run build.`);
    }
  });

  let repo: TempRepo;

  beforeEach(() => {
    repo = createTempRepo();
  });
  afterEach(() => {
    repo.cleanup();
  });

  it('static-spa: scaffolds a complete Vite+React+TS app with all skeleton files', () => {
    const res = runFlint(
      ['create-app', 'myapp', '--variant', 'static-spa', '--no-install', '--no-git', '--yes'],
      { cwd: repo.dir },
    );
    expect(
      res.status,
      `create-app failed:\nstdout:\n${res.stdout}\nstderr:\n${res.stderr}`,
    ).toBe(0);

    const appDir = join(repo.dir, 'myapp');
    expect(existsSync(appDir)).toBe(true);
    for (const rel of SHARED_SKELETON_FILES) {
      expect(existsSync(join(appDir, rel)), `expected ${rel} in scaffold`).toBe(true);
    }

    // Critical static-spa characteristic: NO functions/ directory.
    expect(existsSync(join(appDir, 'functions'))).toBe(false);

    // wrangler.toml has no [[kv_namespaces]] or [[r2_buckets]] blocks
    // (static-spa parity stub).
    const wrangler = readFileSync(join(appDir, 'wrangler.toml'), 'utf8');
    expect(wrangler).toContain('name = "myapp"');
    expect(wrangler).not.toContain('[[kv_namespaces]]');
    expect(wrangler).not.toContain('[[r2_buckets]]');

    // _routes.json parity stub: include is empty, exclude is "/*".
    const routes = JSON.parse(readFileSync(join(appDir, 'public/_routes.json'), 'utf8')) as {
      include: string[];
      exclude: string[];
    };
    expect(routes.include).toEqual([]);
    expect(routes.exclude).toEqual(['/*']);
  });

  it('pages-functions: scaffolds skeleton + functions/_shared tree', () => {
    const res = runFlint(
      [
        'create-app',
        'myapi',
        '--variant',
        'pages-functions',
        '--no-install',
        '--no-git',
        '--yes',
      ],
      { cwd: repo.dir },
    );
    expect(res.status).toBe(0);

    const appDir = join(repo.dir, 'myapi');
    // Skeleton files still present.
    for (const rel of ['package.json', 'src/App.tsx', 'wrangler.toml']) {
      expect(existsSync(join(appDir, rel))).toBe(true);
    }
    // pages-functions adds functions/_shared/* + api/health.
    expect(existsSync(join(appDir, 'functions/_shared/auth.ts'))).toBe(true);
    expect(existsSync(join(appDir, 'functions/_shared/storage.ts'))).toBe(true);
    expect(existsSync(join(appDir, 'functions/api/health.ts'))).toBe(true);
    // KV declared, no R2.
    const wrangler = readFileSync(join(appDir, 'wrangler.toml'), 'utf8');
    expect(wrangler).toContain('[[kv_namespaces]]');
    expect(wrangler).not.toContain('[[r2_buckets]]');
  });

  it('pages-fullstack: scaffolds the superset (functions + R2 + PWA vite config)', () => {
    const res = runFlint(
      [
        'create-app',
        'fullapp',
        '--variant',
        'pages-fullstack',
        '--no-install',
        '--no-git',
        '--yes',
      ],
      { cwd: repo.dir },
    );
    expect(res.status).toBe(0);

    const appDir = join(repo.dir, 'fullapp');
    expect(existsSync(join(appDir, 'functions/_shared/auth.ts'))).toBe(true);
    // pages-fullstack-specific vite.config from the variant overlay.
    const viteConfig = readFileSync(join(appDir, 'vite.config.ts'), 'utf8');
    expect(viteConfig).toContain("'/api'");
    expect(viteConfig).toContain('navigateFallbackDenylist');
    const wrangler = readFileSync(join(appDir, 'wrangler.toml'), 'utf8');
    expect(wrangler).toContain('[[kv_namespaces]]');
    expect(wrangler).toContain('[[r2_buckets]]');
  });

  it('templates package.json with the chosen app name + interpolated scripts', () => {
    const res = runFlint(
      [
        'create-app',
        'mywidget',
        '--variant',
        'static-spa',
        '--no-install',
        '--no-git',
        '--yes',
      ],
      { cwd: repo.dir },
    );
    expect(res.status).toBe(0);

    const pkg = JSON.parse(
      readFileSync(join(repo.dir, 'mywidget/package.json'), 'utf8'),
    ) as { name?: string; scripts?: Record<string, string> };
    expect(pkg.name).toBe('mywidget');
    expect(pkg.scripts).toBeDefined();
    expect(pkg.scripts!.logs).toBe('wrangler pages deployment tail --project-name=mywidget');
    expect(pkg.scripts!.deployments).toBe(
      'wrangler pages deployment list --project-name=mywidget',
    );
    expect(pkg.scripts!.dev).toContain('concurrently');
  });

  it('--cf-project overrides the Pages project name in wrangler.toml + scripts', () => {
    const res = runFlint(
      [
        'create-app',
        'localdir',
        '--variant',
        'static-spa',
        '--cf-project',
        'remote-project-name',
        '--no-install',
        '--no-git',
        '--yes',
      ],
      { cwd: repo.dir },
    );
    expect(res.status).toBe(0);

    const wrangler = readFileSync(join(repo.dir, 'localdir/wrangler.toml'), 'utf8');
    expect(wrangler).toContain('name = "remote-project-name"');
    const pkg = JSON.parse(
      readFileSync(join(repo.dir, 'localdir/package.json'), 'utf8'),
    ) as { name?: string; scripts?: Record<string, string> };
    // package.json `name` matches the cf project name (used for npm + display id).
    expect(pkg.name).toBe('remote-project-name');
    expect(pkg.scripts!.logs).toBe(
      'wrangler pages deployment tail --project-name=remote-project-name',
    );
  });

  it('refuses to scaffold into a non-empty existing directory', () => {
    // Pre-populate the target.
    mkdirSyncFs(join(repo.dir, 'occupied'));
    writeFileSyncFs(join(repo.dir, 'occupied/file.txt'), 'hi');

    const res = runFlint(
      [
        'create-app',
        'occupied',
        '--variant',
        'static-spa',
        '--no-install',
        '--no-git',
        '--yes',
      ],
      { cwd: repo.dir },
    );
    expect(res.status).not.toBe(0);
    expect(`${res.stdout}\n${res.stderr}`).toMatch(/not empty/i);
  });

  it('rejects an unknown variant with an actionable message', () => {
    const res = runFlint(
      ['create-app', 'badvariant', '--variant', 'svelte', '--no-install', '--no-git', '--yes'],
      { cwd: repo.dir },
    );
    expect(res.status).not.toBe(0);
    const combined = `${res.stdout}\n${res.stderr}`;
    expect(combined).toContain('svelte');
    expect(combined).toMatch(/static-spa/);
  });

  it('rejects an unknown package manager with an actionable message', () => {
    const res = runFlint(
      [
        'create-app',
        'badpm',
        '--variant',
        'static-spa',
        '--pm',
        'cargo',
        '--no-install',
        '--no-git',
        '--yes',
      ],
      { cwd: repo.dir },
    );
    expect(res.status).not.toBe(0);
    expect(`${res.stdout}\n${res.stderr}`).toMatch(/Unknown package manager.*cargo/i);
  });

  it('honours --pm bun even when npm_config_user_agent suggests npm', () => {
    // The PM is only used to decide which install command would have run,
    // and to render a hint in "Next steps". With --no-install the install
    // doesn't run — but the next-steps text should still mention bun.
    const res = runFlint(
      [
        'create-app',
        'bunapp',
        '--variant',
        'static-spa',
        '--pm',
        'bun',
        '--no-install',
        '--no-git',
        '--yes',
      ],
      { cwd: repo.dir },
      // env override: pretend npm invoked us
    );
    expect(res.status).toBe(0);
    expect(res.stdout).toMatch(/Package manager:\s*bun/);
    expect(res.stdout).toContain('bun install');
  });

  it('the "what is next" summary lists the auth-init and configure follow-ups', () => {
    const res = runFlint(
      [
        'create-app',
        'nextapp',
        '--variant',
        'static-spa',
        '--no-install',
        '--no-git',
        '--yes',
      ],
      { cwd: repo.dir },
    );
    expect(res.status).toBe(0);
    expect(res.stdout).toContain('Next steps:');
    expect(res.stdout).toContain('flint auth init');
    expect(res.stdout).toContain('flint configure');
    expect(res.stdout).toContain('flint deploy');
  });

  it('--template stub: prints a warning and continues scaffolding', () => {
    const res = runFlint(
      [
        'create-app',
        'tplapp',
        '--variant',
        'static-spa',
        '--template',
        'git+https://example.com/my-template.git',
        '--no-install',
        '--no-git',
        '--yes',
      ],
      { cwd: repo.dir },
    );
    expect(res.status).toBe(0);
    // The warning goes through log.warn (console.warn → stderr).
    const combined = `${res.stdout}\n${res.stderr}`;
    expect(combined).toMatch(/--template is reserved for v0\.9/);
    expect(existsSync(join(repo.dir, 'tplapp/wrangler.toml'))).toBe(true);
  });
});
