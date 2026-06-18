// Tests for the template-pack loader + validator + variable resolver.
//
// These cover the contract `flint-pack-1` surface Flint must support so an
// external pack (the Client Site Kit) can plug in: schema validation, the
// from/transform var derivations, required enforcement, and on-disk loading.

import { afterEach, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  applyTransform,
  findTemplate,
  loadPack,
  PackValidationError,
  resolvePackVars,
  validatePack,
  type Pack,
} from '../../src/util/pack.js';

// A minimal-but-valid pack mirroring the real CSK manifest shape.
const VALID_MANIFEST = {
  $schema: '../../docs/contracts/pack.schema.json',
  flintPackFormat: 1,
  name: '@op4z/csk',
  version: '0.1.0',
  description: 'Client Site Kit test pack.',
  core: ['_core/edge', '_core/content'],
  vars: [
    { name: 'siteName', prompt: 'Business name', required: true },
    { name: 'siteSlug', from: 'siteName', transform: 'kebab' },
    { name: 'compatDate', default: '2026-05-01' },
    { name: 'cookieName', from: 'siteSlug', transform: 'snakeCookie' },
  ],
  templates: [
    {
      id: 'spa-onepager',
      title: 'One-page SPA',
      description: 'Single-scroll marketing site.',
      path: 'templates/spa-onepager',
      rendering: 'spa',
      bindings: { kv: true, r2: true, d1: false },
      includesCore: ['edge', 'content'],
    },
    {
      id: 'multipage-business',
      title: 'Multi-page business site',
      path: 'templates/multipage-business',
      rendering: 'ssg',
      bindings: { kv: true, r2: true, d1: false },
    },
  ],
};

describe('validatePack', () => {
  it('accepts a valid format-1 manifest and fills rootDir', () => {
    const pack = validatePack(VALID_MANIFEST, '/pack/root');
    expect(pack.name).toBe('@op4z/csk');
    expect(pack.rootDir).toBe('/pack/root');
    expect(pack.core).toEqual([
      { from: '_core/edge', to: '', exclude: [] },
      { from: '_core/content', to: '', exclude: [] },
    ]);
    expect(pack.templates).toHaveLength(2);
    expect(pack.templates[0]!.id).toBe('spa-onepager');
    expect(pack.templates[0]!.bindings).toEqual({ kv: true, r2: true, d1: false });
  });

  it('normalizes object-form core entries (to + exclude) alongside bare strings', () => {
    const pack = validatePack(
      {
        ...VALID_MANIFEST,
        core: ['_core/edge', { from: '_core/theme', to: 'kit/theme', exclude: ['**/samples.ts'] }],
      },
      '/pack/root',
    );
    expect(pack.core).toEqual([
      { from: '_core/edge', to: '', exclude: [] },
      { from: '_core/theme', to: 'kit/theme', exclude: ['**/samples.ts'] },
    ]);
  });

  it('rejects a core entry with an unknown key', () => {
    expect(() =>
      validatePack({ ...VALID_MANIFEST, core: [{ from: '_core/edge', dest: 'x' }] }, '/x'),
    ).toThrow(/unknown key/);
  });

  it('rejects a core entry that is neither a string nor a {from,...} object', () => {
    expect(() => validatePack({ ...VALID_MANIFEST, core: [123] }, '/x')).toThrow(
      PackValidationError,
    );
  });

  it('rejects an unsupported flintPackFormat', () => {
    expect(() => validatePack({ ...VALID_MANIFEST, flintPackFormat: 2 }, '/x')).toThrow(
      PackValidationError,
    );
    expect(() => validatePack({ ...VALID_MANIFEST, flintPackFormat: 2 }, '/x')).toThrow(
      /flintPackFormat/,
    );
  });

  it('rejects a missing required top-level field (templates)', () => {
    const { templates: _omit, ...rest } = VALID_MANIFEST;
    void _omit;
    expect(() => validatePack(rest, '/x')).toThrow(/templates/);
  });

  it('rejects an empty templates array (minItems 1)', () => {
    expect(() => validatePack({ ...VALID_MANIFEST, templates: [] }, '/x')).toThrow(
      /at least one template/,
    );
  });

  it('rejects an unknown top-level key (additionalProperties false)', () => {
    expect(() => validatePack({ ...VALID_MANIFEST, surprise: true }, '/x')).toThrow(
      /unknown top-level key "surprise"/,
    );
  });

  it('rejects an invalid var transform', () => {
    const bad = {
      ...VALID_MANIFEST,
      vars: [{ name: 'x', transform: 'uppercase' }],
    };
    expect(() => validatePack(bad, '/x')).toThrow(/transform/);
  });

  it('rejects an invalid template rendering', () => {
    const bad = {
      ...VALID_MANIFEST,
      templates: [
        { id: 'x', title: 'X', path: 'p', rendering: 'mpa', bindings: {} },
      ],
    };
    expect(() => validatePack(bad, '/x')).toThrow(/rendering/);
  });

  it('rejects a template missing bindings (required)', () => {
    const bad = {
      ...VALID_MANIFEST,
      templates: [{ id: 'x', title: 'X', path: 'p', rendering: 'spa' }],
    };
    expect(() => validatePack(bad, '/x')).toThrow(/bindings/);
  });

  it('rejects a non-boolean binding value', () => {
    const bad = {
      ...VALID_MANIFEST,
      templates: [
        { id: 'x', title: 'X', path: 'p', rendering: 'spa', bindings: { d1: 'yes' } },
      ],
    };
    expect(() => validatePack(bad, '/x')).toThrow(/bindings\.d1 must be a boolean/);
  });

  it('rejects duplicate template ids', () => {
    const bad = {
      ...VALID_MANIFEST,
      templates: [
        { id: 'dup', title: 'A', path: 'a', rendering: 'spa', bindings: {} },
        { id: 'dup', title: 'B', path: 'b', rendering: 'ssg', bindings: {} },
      ],
    };
    expect(() => validatePack(bad, '/x')).toThrow(/duplicate template id "dup"/);
  });
});

describe('applyTransform', () => {
  it('kebab lowercases and hyphenates', () => {
    expect(applyTransform('Acme Cafe & Bar', 'kebab')).toBe('acme-cafe-bar');
    expect(applyTransform('  Trimmed  Name  ', 'kebab')).toBe('trimmed-name');
  });

  it('snakeCookie produces a cookie-safe name with _admin suffix', () => {
    expect(applyTransform('acme-cafe', 'snakeCookie')).toBe('acme_cafe_admin');
    expect(applyTransform('Acme Cafe', 'snakeCookie')).toBe('acme_cafe_admin');
  });

  it('lower lowercases', () => {
    expect(applyTransform('MixedCase', 'lower')).toBe('mixedcase');
  });

  it('title capitalizes each word', () => {
    expect(applyTransform('acme cafe', 'title')).toBe('Acme Cafe');
  });
});

describe('resolvePackVars', () => {
  it('derives chained vars (siteSlug from siteName, cookieName from siteSlug)', () => {
    const pack = validatePack(VALID_MANIFEST, '/x');
    const vars = resolvePackVars({ pack, provided: { siteName: 'Acme Cafe' } });
    expect(vars.siteName).toBe('Acme Cafe');
    expect(vars.siteSlug).toBe('acme-cafe');
    expect(vars.cookieName).toBe('acme_cafe_admin');
    expect(vars.compatDate).toBe('2026-05-01'); // default
  });

  it('lets a provided value override a default', () => {
    const pack = validatePack(VALID_MANIFEST, '/x');
    const vars = resolvePackVars({
      pack,
      provided: { siteName: 'Acme', compatDate: '2027-01-01' },
    });
    expect(vars.compatDate).toBe('2027-01-01');
  });

  it('passes through extra provided vars the pack did not declare', () => {
    const pack = validatePack(VALID_MANIFEST, '/x');
    const vars = resolvePackVars({
      pack,
      provided: { siteName: 'Acme', appName: 'acme' },
    });
    expect(vars.appName).toBe('acme');
  });

  it('throws when a required var is neither provided nor derivable', () => {
    const pack = validatePack(VALID_MANIFEST, '/x');
    expect(() => resolvePackVars({ pack, provided: {} })).toThrow(/required variable "siteName"/);
  });

  it('applies a transform to a provided value when no `from` is set', () => {
    const pack: Pack = validatePack(
      {
        ...VALID_MANIFEST,
        vars: [{ name: 'slug', transform: 'kebab' }],
      },
      '/x',
    );
    const vars = resolvePackVars({ pack, provided: { slug: 'My Cool Site' } });
    expect(vars.slug).toBe('my-cool-site');
  });
});

describe('findTemplate', () => {
  it('returns the matching template', () => {
    const pack = validatePack(VALID_MANIFEST, '/x');
    expect(findTemplate(pack, 'multipage-business').rendering).toBe('ssg');
  });

  it('throws listing available ids on a miss', () => {
    const pack = validatePack(VALID_MANIFEST, '/x');
    expect(() => findTemplate(pack, 'nope')).toThrow(/available templates: spa-onepager, multipage-business/);
  });
});

describe('loadPack (on disk)', () => {
  let dir: string;
  afterEach(() => {
    if (dir) rmSync(dir, { recursive: true, force: true });
  });

  it('loads + validates a pack.json from a directory', () => {
    dir = mkdtempSync(join(tmpdir(), 'flint-pack-'));
    writeFileSync(join(dir, 'pack.json'), JSON.stringify(VALID_MANIFEST), 'utf8');
    const pack = loadPack(dir);
    expect(pack.name).toBe('@op4z/csk');
    expect(pack.rootDir).toBe(dir);
  });

  it('throws when the directory has no pack.json', () => {
    dir = mkdtempSync(join(tmpdir(), 'flint-pack-'));
    mkdirSync(join(dir, 'sub'));
    expect(() => loadPack(dir)).toThrow(/no pack.json/);
  });

  it('throws when the directory does not exist', () => {
    expect(() => loadPack('/definitely/not/here')).toThrow(/pack directory not found/);
  });

  it('throws PackValidationError on malformed JSON', () => {
    dir = mkdtempSync(join(tmpdir(), 'flint-pack-'));
    writeFileSync(join(dir, 'pack.json'), '{ not valid json', 'utf8');
    expect(() => loadPack(dir)).toThrow(PackValidationError);
  });
});
