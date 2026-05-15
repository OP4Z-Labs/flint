// Tighter, dedicated coverage for the static-spa variant. The
// create-app.spec.ts file checks the broad happy path across all three
// variants; this file zooms in on the specific Portfolio-parity rules:
//
//   - NO functions/ directory of any kind
//   - wrangler.toml is the minimal Pages config (no KV / no R2 blocks)
//   - public/_routes.json is the parity stub (include: [], exclude: ["/*"])
//   - public/_headers contains the hardened CSP from the polish-audit
//   - vite.config.ts is PWA-on with no Functions proxy
//   - .dev.vars.example documents only the two CF vars (no ADMIN_PASSWORD /
//     COOKIE_SECRET — those are Functions-variant-only)
//
// These rules are the load-bearing public-contract pieces for the
// Portfolio rescaffold work that ships in v1.0. A regression here would
// silently produce a wrong-shape scaffold; failing this spec catches it.

import { afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { CLI_ENTRY, createTempRepo, runFlint, type TempRepo } from './_harness.js';

describe('flint create-app static-spa (integration)', () => {
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

  function scaffold(): string {
    const res = runFlint(
      [
        'create-app',
        'spa',
        '--variant',
        'static-spa',
        '--no-install',
        '--no-git',
        '--yes',
      ],
      { cwd: repo.dir },
    );
    expect(res.status, `scaffold failed:\n${res.stdout}\n${res.stderr}`).toBe(0);
    return join(repo.dir, 'spa');
  }

  it('produces NO functions/ directory anywhere in the tree', () => {
    const appDir = scaffold();
    expect(existsSync(join(appDir, 'functions'))).toBe(false);
  });

  it('wrangler.toml has no KV or R2 binding blocks', () => {
    const appDir = scaffold();
    const wrangler = readFileSync(join(appDir, 'wrangler.toml'), 'utf8');
    expect(wrangler).not.toMatch(/\[\[kv_namespaces\]\]/);
    expect(wrangler).not.toMatch(/\[\[r2_buckets\]\]/);
    expect(wrangler).toContain('name = "spa"');
    expect(wrangler).toContain('pages_build_output_dir = "dist"');
    expect(wrangler).toContain('compatibility_flags = ["nodejs_compat"]');
  });

  it('public/_routes.json is the parity stub', () => {
    const appDir = scaffold();
    const routes = JSON.parse(
      readFileSync(join(appDir, 'public/_routes.json'), 'utf8'),
    ) as { include: string[]; exclude: string[] };
    expect(routes.include).toEqual([]);
    expect(routes.exclude).toEqual(['/*']);
  });

  it('public/_headers contains the hardened CSP block', () => {
    const appDir = scaffold();
    const headers = readFileSync(join(appDir, 'public/_headers'), 'utf8');
    expect(headers).toContain('Content-Security-Policy:');
    expect(headers).toContain("default-src 'self'");
    expect(headers).toContain("script-src 'self'");
    expect(headers).toContain('X-Frame-Options: DENY');
    expect(headers).toContain('X-Content-Type-Options: nosniff');
    expect(headers).toContain('Referrer-Policy: strict-origin-when-cross-origin');
    expect(headers).toContain('Permissions-Policy:');
  });

  it('vite.config.ts has VitePWA enabled and no /api proxy', () => {
    const appDir = scaffold();
    const vite = readFileSync(join(appDir, 'vite.config.ts'), 'utf8');
    expect(vite).toContain('VitePWA');
    expect(vite).toContain("registerType: 'autoUpdate'");
    // No proxy block — that's only for the pages-functions variants.
    expect(vite).not.toMatch(/proxy:\s*\{[\s\S]*'\/api'/);
  });

  it('.dev.vars.example documents only CF vars (no HMAC secrets)', () => {
    const appDir = scaffold();
    const example = readFileSync(join(appDir, '.dev.vars.example'), 'utf8');
    expect(example).toContain('CLOUDFLARE_API_TOKEN=');
    expect(example).toContain('CLOUDFLARE_ACCOUNT_ID=');
    // ADMIN_PASSWORD / COOKIE_SECRET are Functions-variant-only.
    expect(example).not.toContain('ADMIN_PASSWORD=');
    expect(example).not.toContain('COOKIE_SECRET=');
  });

  it('ships index.html, tsconfig, eslint, vitest configs + minimal React shell', () => {
    const appDir = scaffold();
    const requiredFiles = [
      'index.html',
      'tsconfig.json',
      'tsconfig.app.json',
      'tsconfig.node.json',
      'eslint.config.js',
      'vitest.config.ts',
      'src/main.tsx',
      'src/App.tsx',
      'src/index.css',
      'src/test-setup.ts',
      'src/vite-env.d.ts',
    ];
    for (const rel of requiredFiles) {
      expect(existsSync(join(appDir, rel)), `expected ${rel}`).toBe(true);
    }
  });
});
