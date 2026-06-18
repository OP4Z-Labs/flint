// Tests for the template-source registry seam.
//
// The registry must (a) expose the three built-in variants unchanged, and
// (b) merge in an external pack's templates on demand without disturbing the
// built-ins. These are the invariants the additive enhancement depends on.

import { describe, expect, it } from 'vitest';
import {
  BUILTIN_VARIANTS,
  isBuiltinVariant,
  TemplateRegistry,
} from '../../src/util/registry.js';
import { validatePack } from '../../src/util/pack.js';

const PACK = validatePack(
  {
    flintPackFormat: 1,
    name: '@op4z/csk',
    version: '0.1.0',
    core: ['_core/edge'],
    vars: [],
    templates: [
      { id: 'spa-onepager', title: 'One-pager', path: 't/spa', rendering: 'spa', bindings: { kv: true, d1: false } },
      { id: 'multipage-business', title: 'Multi-page', path: 't/mp', rendering: 'ssg', bindings: { r2: true, d1: true } },
    ],
  },
  '/pack/root',
);

describe('builtins', () => {
  it('exposes exactly the three built-in variants', () => {
    expect(BUILTIN_VARIANTS).toEqual(['static-spa', 'pages-functions', 'pages-fullstack']);
  });

  it('isBuiltinVariant narrows correctly', () => {
    expect(isBuiltinVariant('static-spa')).toBe(true);
    expect(isBuiltinVariant('spa-onepager')).toBe(false);
  });
});

describe('TemplateRegistry.builtinsOnly', () => {
  it('lists the built-in variants in order, all source=builtin', () => {
    const reg = TemplateRegistry.builtinsOnly();
    const ids = reg.list().map((e) => e.id);
    expect(ids).toEqual(['static-spa', 'pages-functions', 'pages-fullstack']);
    expect(reg.list().every((e) => e.source === 'builtin')).toBe(true);
  });

  it('require() throws listing valid ids on a miss', () => {
    const reg = TemplateRegistry.builtinsOnly();
    expect(() => reg.require('nope')).toThrow(/available: static-spa, pages-functions, pages-fullstack/);
  });

  it('built-in binding advisories match the variant tiers', () => {
    const reg = TemplateRegistry.builtinsOnly();
    expect(reg.require('static-spa').bindings).toEqual({});
    expect(reg.require('pages-functions').bindings).toEqual({ kv: true });
    expect(reg.require('pages-fullstack').bindings).toEqual({ kv: true, r2: true });
  });
});

describe('TemplateRegistry.withPack', () => {
  it('includes built-ins AND every pack template', () => {
    const reg = TemplateRegistry.withPack(PACK);
    const ids = reg.list().map((e) => e.id);
    expect(ids).toContain('static-spa');
    expect(ids).toContain('spa-onepager');
    expect(ids).toContain('multipage-business');
  });

  it('pack entries carry source=pack and resolve back to pack + template', () => {
    const reg = TemplateRegistry.withPack(PACK);
    const entry = reg.require('multipage-business');
    expect(entry.source).toBe('pack');
    expect(entry.pack?.name).toBe('@op4z/csk');
    expect(entry.template?.rendering).toBe('ssg');
    expect(entry.bindings).toEqual({ kv: undefined, r2: true, d1: true });
  });

  it('does not disturb the built-in entries', () => {
    const reg = TemplateRegistry.withPack(PACK);
    expect(reg.require('static-spa').source).toBe('builtin');
  });

  it('namespaces a pack template whose id collides with a built-in', () => {
    const collidingPack = validatePack(
      {
        flintPackFormat: 1,
        name: '@op4z/csk',
        version: '0.1.0',
        core: [],
        vars: [],
        templates: [
          { id: 'static-spa', title: 'Colliding', path: 't/x', rendering: 'spa', bindings: {} },
        ],
      },
      '/x',
    );
    const reg = TemplateRegistry.withPack(collidingPack);
    // Built-in static-spa stays reachable...
    expect(reg.require('static-spa').source).toBe('builtin');
    // ...and the pack's colliding template is reachable under a namespaced id.
    expect(reg.require('csk:static-spa').source).toBe('pack');
  });
});
