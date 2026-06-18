// Guards the zod-dependency fix: pages-functions / pages-fullstack scaffolds
// vendor `functions/_shared/schemas.ts`, which imports `zod`. Before this fix
// the skeleton package.json.tmpl declared no `zod`, so a fresh scaffold had an
// unmet import. This test pins both halves of the contract: (a) zod is a
// declared dependency, and (b) the templates that import it still exist.

import { describe, expect, it } from 'vitest';
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { renderString } from '../../src/util/template.js';

const here = dirname(fileURLToPath(import.meta.url));
const TEMPLATES_DIR = resolve(here, '..', '..', 'templates');
const SKELETON_PKG = join(TEMPLATES_DIR, '_skeleton', 'package.json.tmpl');

const CANONICAL_VARS = {
  appName: 'myapp',
  appNameLower: 'myapp',
  compatDate: '2026-05-14',
  cookieName: 'myapp_admin',
  tokenMessage: 'myapp-admin-session-v1',
  flintVersion: '1.0.1',
};

function findFilesImportingZod(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir)) {
    const abs = join(dir, entry);
    if (statSync(abs).isDirectory()) {
      out.push(...findFilesImportingZod(abs));
    } else if (/\.(ts|tsx)(\.tmpl)?$/.test(entry)) {
      const raw = readFileSync(abs, 'utf8');
      if (/from\s+['"]zod['"]/.test(raw) || /import\s+.*\bz\b.*['"]zod['"]/.test(raw)) {
        out.push(abs);
      }
    }
  }
  return out;
}

describe('zod dependency wiring', () => {
  it('the skeleton package.json declares zod ^4.x as a runtime dependency', () => {
    expect(existsSync(SKELETON_PKG)).toBe(true);
    const rendered = renderString(readFileSync(SKELETON_PKG, 'utf8'), CANONICAL_VARS);
    const pkg = JSON.parse(rendered) as {
      dependencies?: Record<string, string>;
      devDependencies?: Record<string, string>;
    };
    expect(pkg.dependencies).toBeDefined();
    expect(pkg.dependencies!.zod).toBeDefined();
    // Must be a v4 range so the scaffold matches the function-template imports.
    expect(pkg.dependencies!.zod).toMatch(/4/);
    // zod is a runtime dep, not a devDependency.
    expect(pkg.devDependencies?.zod).toBeUndefined();
  });

  it('at least one bundled function template actually imports zod (sanity)', () => {
    const importers = findFilesImportingZod(TEMPLATES_DIR);
    expect(importers.length).toBeGreaterThan(0);
  });
});
