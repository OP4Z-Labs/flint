// Coverage for v1.0's `[env.<name>]` parsing in wrangler-toml.
//
// `flint deploy --env staging` needs to validate that the named env exists
// in wrangler.toml before invoking wrangler. The parser pulls each env
// section into the `envs` map; the deploy command reads from there.

import { describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { readWranglerToml } from '../../src/cloudflare/wrangler-toml.js';

function writeToml(contents: string): { root: string; cleanup: () => void } {
  const root = mkdtempSync(join(tmpdir(), 'flint-envs-'));
  writeFileSync(join(root, 'wrangler.toml'), contents);
  return { root, cleanup: () => rmSync(root, { recursive: true, force: true }) };
}

describe('wrangler-toml envs parsing', () => {
  it('returns an empty envs map when no env sections are defined', () => {
    const { root, cleanup } = writeToml('name = "test"\npages_build_output_dir = "dist"\n');
    try {
      const doc = readWranglerToml(root);
      expect(doc.envs).toEqual({});
    } finally {
      cleanup();
    }
  });

  it('parses a single [env.<name>] section', () => {
    const { root, cleanup } = writeToml(`
name = "test"

[env.staging]
name = "test-staging"
`);
    try {
      const doc = readWranglerToml(root);
      expect(Object.keys(doc.envs)).toEqual(['staging']);
      expect(doc.envs.staging?.name).toBe('test-staging');
    } finally {
      cleanup();
    }
  });

  it('parses multiple env sections + per-env kv bindings', () => {
    const { root, cleanup } = writeToml(`
name = "app"

[env.staging]
name = "app-staging"

[[env.staging.kv_namespaces]]
binding = "STAGE_KV"
id = "stageid"

[env.production]
name = "app"
`);
    try {
      const doc = readWranglerToml(root);
      const envNames = Object.keys(doc.envs).sort();
      expect(envNames).toEqual(['production', 'staging']);
      expect(doc.envs.staging?.kv_namespaces).toHaveLength(1);
      expect(doc.envs.staging?.kv_namespaces[0]?.binding).toBe('STAGE_KV');
      expect(doc.envs.production?.kv_namespaces).toHaveLength(0);
    } finally {
      cleanup();
    }
  });

  it('omits envs that have no override fields', () => {
    // An `[env.foo]` table with no fields under it should still surface as
    // an empty WranglerEnv record so deploy knows the section is valid.
    const { root, cleanup } = writeToml(`
name = "app"

[env.foo]
`);
    try {
      const doc = readWranglerToml(root);
      expect(doc.envs.foo).toBeDefined();
      expect(doc.envs.foo?.name).toBeUndefined();
    } finally {
      cleanup();
    }
  });
});
