// Unit coverage for util/pack-upgrade.ts — the `flint upgrade --pack` re-render
// seam. Builds a tiny on-disk pack fixture and asserts that buildPackResolver:
//   - mints templateSource keys IDENTICAL to what create-app-pack records, so a
//     manifest entry's templateSource resolves to the current pack content;
//   - renders `.tmpl` files through the var engine and copies plain files
//     verbatim;
//   - returns the CURRENT pack content (reflecting an upstream edit), proving
//     the upgrade path can propagate pack fixes;
//   - returns null for non-pack sources, unknown sources, and files the pack no
//     longer ships.

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  mkdirSync,
  mkdtempSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { buildPackResolver } from '../../src/util/pack-upgrade.js';

interface Fixture {
  dir: string;
  cleanup: () => void;
}

/**
 * A minimal pack:
 *   pack.json (name @op4z/probe, core _core/edge → kit/edge, one template)
 *   _core/edge/response.ts            (plain file)
 *   templates/onepager/index.html.tmpl ({{siteName}} placeholder)
 *   templates/onepager/_core/edge/response.test.ts  (excluded by default)
 */
function buildFixture(): Fixture {
  const dir = mkdtempSync(join(tmpdir(), 'flint-packupg-'));
  const manifest = {
    flintPackFormat: 1,
    name: '@op4z/probe',
    version: '0.1.0',
    core: [{ from: '_core/edge', to: 'kit/edge' }],
    vars: [{ name: 'siteName', required: true }],
    templates: [
      {
        id: 'onepager',
        title: 'One pager',
        path: 'templates/onepager',
        rendering: 'spa',
        bindings: { kv: true },
      },
    ],
  };
  writeFileSync(join(dir, 'pack.json'), JSON.stringify(manifest, null, 2), 'utf8');

  mkdirSync(join(dir, '_core/edge'), { recursive: true });
  writeFileSync(join(dir, '_core/edge/response.ts'), 'export const v = 1;\n', 'utf8');
  // A co-located test file — DEFAULT_STAMP_EXCLUDES must skip it.
  writeFileSync(join(dir, '_core/edge/response.test.ts'), 'test("x", () => {});\n', 'utf8');

  mkdirSync(join(dir, 'templates/onepager'), { recursive: true });
  writeFileSync(
    join(dir, 'templates/onepager/index.html.tmpl'),
    '<title>{{siteName}}</title>\n',
    'utf8',
  );

  return { dir, cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}

describe('buildPackResolver', () => {
  let fx: Fixture;

  beforeEach(() => {
    fx = buildFixture();
  });
  afterEach(() => {
    fx.cleanup();
  });

  it('mints the same templateSource keys create-app-pack records', () => {
    const r = buildPackResolver(fx.dir, { siteName: 'Acme' });
    // core: `pack:<name>/core:<from>/<relpath>`
    expect(r.sources.has('pack:@op4z/probe/core:_core/edge/response.ts')).toBe(true);
    // template: `pack:<name>/template:<id>/<relpath>` (keeps the .tmpl suffix)
    expect(r.sources.has('pack:@op4z/probe/template:onepager/index.html.tmpl')).toBe(true);
  });

  it('excludes co-located test files (DEFAULT_STAMP_EXCLUDES)', () => {
    const r = buildPackResolver(fx.dir, { siteName: 'Acme' });
    expect(r.sources.has('pack:@op4z/probe/core:_core/edge/response.test.ts')).toBe(false);
  });

  it('renders .tmpl files through the var engine', () => {
    const r = buildPackResolver(fx.dir, { siteName: 'Acme Cafe' });
    const out = r.resolve('pack:@op4z/probe/template:onepager/index.html.tmpl');
    expect(out).toBe('<title>Acme Cafe</title>\n');
  });

  it('copies plain (non-.tmpl) files verbatim', () => {
    const r = buildPackResolver(fx.dir, { siteName: 'Acme' });
    expect(r.resolve('pack:@op4z/probe/core:_core/edge/response.ts')).toBe('export const v = 1;\n');
  });

  it('reflects an UPSTREAM pack edit (this is what upgrade propagates)', () => {
    // Simulate a kit fix landing in the pack after the site was scaffolded.
    writeFileSync(join(fx.dir, '_core/edge/response.ts'), 'export const v = 2; // fixed\n', 'utf8');
    const r = buildPackResolver(fx.dir, { siteName: 'Acme' });
    expect(r.resolve('pack:@op4z/probe/core:_core/edge/response.ts')).toBe(
      'export const v = 2; // fixed\n',
    );
  });

  it('returns null for a non-pack templateSource', () => {
    const r = buildPackResolver(fx.dir, { siteName: 'Acme' });
    expect(r.resolve('pages-functions/wrangler.toml.tmpl')).toBeNull();
    expect(r.resolve('git+https://example.com/x#main:foo.ts')).toBeNull();
  });

  it('returns null for a pack source the current pack no longer ships', () => {
    const r = buildPackResolver(fx.dir, { siteName: 'Acme' });
    expect(r.resolve('pack:@op4z/probe/core:_core/edge/removed.ts')).toBeNull();
  });

  it('injects the current flintVersion for .tmpl rendering', () => {
    // A template referencing {{flintVersion}} must resolve (not throw), proving
    // upgrade injects the upgrading version just like the built-in path does.
    writeFileSync(
      join(fx.dir, 'templates/onepager/banner.txt.tmpl'),
      'generated-by flint {{flintVersion}}\n',
      'utf8',
    );
    const r = buildPackResolver(fx.dir, { siteName: 'Acme' });
    const out = r.resolve('pack:@op4z/probe/template:onepager/banner.txt.tmpl');
    expect(out).toMatch(/^generated-by flint \d+\.\d+\.\d+/);
  });
});
