// Template smoke test — every `.tmpl` file under `templates/` must render
// successfully against the canonical variable set the init command provides.
//
// This is the cheapest way to catch a template that references a variable
// the init command does not actually produce (e.g. `{{appNme}}` typo).

import { describe, expect, it } from 'vitest';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { renderString } from '../../src/util/template.js';

const here = dirname(fileURLToPath(import.meta.url));
const TEMPLATES_DIR = resolve(here, '..', '..', 'templates');

const CANONICAL_VARS = {
  appName: 'myapp',
  appNameLower: 'myapp',
  compatDate: '2026-05-14',
  cookieName: 'myapp_admin',
  tokenMessage: 'myapp-admin-session-v1',
  flintVersion: '0.9.0',
};

function findTmplFiles(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir)) {
    const abs = join(dir, entry);
    const stat = statSync(abs);
    if (stat.isDirectory()) {
      out.push(...findTmplFiles(abs));
    } else if (entry.endsWith('.tmpl')) {
      out.push(abs);
    }
  }
  return out;
}

describe('template files', () => {
  const tmpls = findTmplFiles(TEMPLATES_DIR);

  it('finds at least one .tmpl file (sanity)', () => {
    expect(tmpls.length).toBeGreaterThan(0);
  });

  for (const path of tmpls) {
    const rel = path.replace(TEMPLATES_DIR + '/', '');
    it(`renders ${rel} cleanly with canonical vars`, () => {
      const raw = readFileSync(path, 'utf8');
      const out = renderString(raw, CANONICAL_VARS);
      // The rendered file must not still contain `{{...}}` placeholders.
      expect(out).not.toMatch(/\{\{[A-Za-z0-9_\s]+\}\}/);
    });
  }
});
