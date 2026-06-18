// Integration coverage for `flint create-app <dir> --pack <dir> --template <id>`.
//
// Builds a LOCAL pack fixture on disk (pack.json + a _core tree + a template
// tree, with {{var}} placeholders) and spawns the real built binary against it.
// Asserts the generated tree, the var derivations (kebab/snakeCookie), the
// recorded manifest (variant = template id, vars persisted), and that the
// built-in --variant path is unaffected by the new --pack surface.

import { afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { CLI_ENTRY, createTempRepo, runFlint, type TempRepo } from './_harness.js';

interface PackFixture {
  dir: string;
  cleanup: () => void;
}

/**
 * Lay down a minimal-but-real pack:
 *   pack.json
 *   _core/edge/_headers
 *   templates/onepager/wrangler.toml.tmpl   (uses {{appName}} / {{siteSlug}})
 *   templates/onepager/index.html.tmpl
 *   templates/dbpager/wrangler.toml.tmpl    (d1=true template)
 */
function buildPackFixture(): PackFixture {
  const dir = mkdtempSync(join(tmpdir(), 'flint-pack-fixture-'));
  const manifest = {
    flintPackFormat: 1,
    name: '@op4z/testkit',
    version: '0.1.0',
    description: 'Test pack fixture.',
    core: ['_core/edge'],
    vars: [
      { name: 'siteName', prompt: 'Business name', required: true },
      { name: 'siteSlug', from: 'siteName', transform: 'kebab' },
      { name: 'appName', from: 'siteSlug', transform: 'lower' },
      { name: 'compatDate', default: '2026-05-01' },
      { name: 'cookieName', from: 'siteSlug', transform: 'snakeCookie' },
    ],
    templates: [
      {
        id: 'onepager',
        title: 'One pager',
        description: 'spa',
        path: 'templates/onepager',
        rendering: 'spa',
        bindings: { kv: true, r2: false, d1: false },
        includesCore: ['edge'],
      },
      {
        id: 'dbpager',
        title: 'DB pager',
        path: 'templates/dbpager',
        rendering: 'ssg',
        bindings: { kv: false, r2: false, d1: true },
      },
    ],
  };
  writeFileSync(join(dir, 'pack.json'), JSON.stringify(manifest, null, 2), 'utf8');

  mkdirSync(join(dir, '_core/edge'), { recursive: true });
  writeFileSync(join(dir, '_core/edge/_headers'), '/*\n  X-Frame-Options: DENY\n', 'utf8');

  mkdirSync(join(dir, 'templates/onepager'), { recursive: true });
  writeFileSync(
    join(dir, 'templates/onepager/wrangler.toml.tmpl'),
    [
      '# pack template',
      'name = "{{appName}}"',
      'compatibility_date = "{{compatDate}}"',
      '',
      '[[kv_namespaces]]',
      'binding = "CONTENT_KV"',
      'id = "REPLACE_WITH_KV_NAMESPACE_ID"',
      '',
    ].join('\n'),
    'utf8',
  );
  writeFileSync(
    join(dir, 'templates/onepager/index.html.tmpl'),
    '<!doctype html><title>{{siteName}}</title><body>{{siteSlug}} / {{cookieName}}</body>\n',
    'utf8',
  );

  mkdirSync(join(dir, 'templates/dbpager'), { recursive: true });
  writeFileSync(
    join(dir, 'templates/dbpager/wrangler.toml.tmpl'),
    ['# pack template (ssg)', 'name = "{{appName}}"', 'compatibility_date = "{{compatDate}}"', ''].join('\n'),
    'utf8',
  );

  return { dir, cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}

describe('flint create-app --pack (integration)', () => {
  let target: TempRepo;
  let pack: PackFixture;

  beforeAll(() => {
    if (!existsSync(CLI_ENTRY)) {
      throw new Error(`Build artifact missing: ${CLI_ENTRY}. Run npm run build.`);
    }
  });

  beforeEach(() => {
    target = createTempRepo();
    pack = buildPackFixture();
  });

  afterEach(() => {
    target.cleanup();
    pack.cleanup();
  });

  it('stamps core + template trees and derives vars', () => {
    const res = runFlint(
      [
        'create-app',
        'site',
        '--pack',
        pack.dir,
        '--template',
        'onepager',
        '--var',
        'siteName=Acme Cafe',
        '--yes',
      ],
      { cwd: target.dir },
    );
    expect(res.status, `create-app --pack failed:\n${res.stdout}\n${res.stderr}`).toBe(0);

    const root = join(target.dir, 'site');
    // Core tree stamped.
    expect(existsSync(join(root, '_headers'))).toBe(true);
    // Template tree stamped + rendered (.tmpl suffix stripped).
    expect(existsSync(join(root, 'wrangler.toml'))).toBe(true);
    expect(existsSync(join(root, 'index.html'))).toBe(true);

    const wrangler = readFileSync(join(root, 'wrangler.toml'), 'utf8');
    expect(wrangler).toContain('name = "acme-cafe"'); // appName = lower(kebab(siteName))
    expect(wrangler).toContain('compatibility_date = "2026-05-01"'); // default
    expect(wrangler).not.toMatch(/\{\{/); // no unrendered placeholders

    const html = readFileSync(join(root, 'index.html'), 'utf8');
    expect(html).toContain('Acme Cafe'); // siteName passthrough
    expect(html).toContain('acme-cafe'); // siteSlug = kebab(siteName)
    expect(html).toContain('acme_cafe_admin'); // cookieName = snakeCookie(siteSlug)
  });

  it('records a manifest with variant = template id and vars persisted', () => {
    const res = runFlint(
      ['create-app', 'site', '--pack', pack.dir, '--template', 'onepager', '--var', 'siteName=Acme Cafe', '--yes'],
      { cwd: target.dir },
    );
    expect(res.status).toBe(0);

    const manifest = JSON.parse(readFileSync(join(target.dir, 'site/flint.manifest.json'), 'utf8'));
    expect(manifest.variant).toBe('onepager');
    expect(manifest.vars.siteName).toBe('Acme Cafe');
    expect(manifest.vars.siteSlug).toBe('acme-cafe');
    expect(manifest.files['wrangler.toml']).toBeDefined();
    expect(manifest.files['_headers']).toBeDefined();
    expect(manifest.files['index.html']).toBeDefined();
    expect(manifest.history[0].command).toMatch(/--pack/);
  });

  it('appends a [[d1_databases]] block when the template declares bindings.d1', () => {
    const res = runFlint(
      ['create-app', 'dbsite', '--pack', pack.dir, '--template', 'dbpager', '--var', 'siteName=Data Co', '--yes'],
      { cwd: target.dir },
    );
    expect(res.status, `create-app --pack failed:\n${res.stdout}\n${res.stderr}`).toBe(0);
    const wrangler = readFileSync(join(target.dir, 'dbsite/wrangler.toml'), 'utf8');
    expect(wrangler).toContain('[[d1_databases]]');
    expect(wrangler).toContain('binding = "DB"');
    expect(wrangler).toContain('REPLACE_WITH_D1_DATABASE_ID');
  });

  it('errors clearly on an unknown template id', () => {
    const res = runFlint(
      ['create-app', 'site', '--pack', pack.dir, '--template', 'nope', '--var', 'siteName=X', '--yes'],
      { cwd: target.dir },
    );
    expect(res.status).not.toBe(0);
    expect(`${res.stdout}\n${res.stderr}`).toMatch(/available templates: onepager, dbpager/);
  });

  it('errors clearly when a required var is missing in --yes mode', () => {
    const res = runFlint(
      ['create-app', 'site', '--pack', pack.dir, '--template', 'onepager', '--yes'],
      { cwd: target.dir },
    );
    expect(res.status).not.toBe(0);
    expect(`${res.stdout}\n${res.stderr}`).toMatch(/required variable "siteName"/);
  });

  it('errors clearly when --pack points at a directory with no pack.json', () => {
    const res = runFlint(
      ['create-app', 'site', '--pack', target.dir, '--template', 'x', '--yes'],
      { cwd: target.dir },
    );
    expect(res.status).not.toBe(0);
    expect(`${res.stdout}\n${res.stderr}`).toMatch(/no pack.json/);
  });

  it('leaves the built-in --variant path unaffected (no --pack)', () => {
    const res = runFlint(
      ['create-app', 'plain', '--variant', 'static-spa', '--no-install', '--no-git', '--yes'],
      { cwd: target.dir },
    );
    expect(res.status, `built-in create-app failed:\n${res.stdout}\n${res.stderr}`).toBe(0);
    const manifest = JSON.parse(readFileSync(join(target.dir, 'plain/flint.manifest.json'), 'utf8'));
    expect(manifest.variant).toBe('static-spa');
  });
});
