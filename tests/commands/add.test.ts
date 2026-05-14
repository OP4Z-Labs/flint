// Integration tests for the `flint add` subcommands. We exercise the
// wrangler.toml mutations and .dev.vars.example updates directly — the
// runtime provisioning path (which invokes wrangler) is covered by
// wrangler-runner.test.ts in isolation.
//
// The `add` command paths shell out interactively, so we drive them with
// --no-provision + --yes to keep things deterministic.

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  existsSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runAddKv, runAddR2, runAddSecret } from '../../src/commands/add.js';

const STARTER_TOML = `# starter wrangler.toml
name = "demoapp"
pages_build_output_dir = "dist"
compatibility_date = "2026-05-14"
compatibility_flags = ["nodejs_compat"]

[[kv_namespaces]]
binding = "CONTENT_KV"
id = "REPLACE_WITH_KV_NAMESPACE_ID"
preview_id = "REPLACE_WITH_KV_NAMESPACE_ID"
`;

interface RepoCtx {
  dir: string;
  origCwd: string;
  cleanup: () => void;
}

function setupRepo(): RepoCtx {
  const dir = mkdtempSync(join(tmpdir(), 'flint-add-'));
  writeFileSync(join(dir, 'wrangler.toml'), STARTER_TOML, 'utf8');
  const origCwd = process.cwd();
  process.chdir(dir);
  return {
    dir,
    origCwd,
    cleanup: () => {
      process.chdir(origCwd);
      rmSync(dir, { recursive: true, force: true });
    },
  };
}

describe('runAddKv', () => {
  let repo: RepoCtx;
  beforeEach(() => {
    repo = setupRepo();
  });
  afterEach(() => repo.cleanup());

  it('appends a [[kv_namespaces]] block for a new binding', async () => {
    await runAddKv({ binding: 'CACHE_KV', noProvision: true, force: false, yes: true });
    const toml = readFileSync(join(repo.dir, 'wrangler.toml'), 'utf8');
    expect(toml).toContain('binding = "CACHE_KV"');
    expect(toml).toContain('REPLACE_WITH_KV_NAMESPACE_ID');
  });

  it('preserves the original blocks + comments', async () => {
    await runAddKv({ binding: 'CACHE_KV', noProvision: true, force: false, yes: true });
    const toml = readFileSync(join(repo.dir, 'wrangler.toml'), 'utf8');
    expect(toml).toContain('# starter wrangler.toml');
    expect(toml).toContain('binding = "CONTENT_KV"');
  });

  it('skips silently in --yes mode when binding already exists and --force is off', async () => {
    await runAddKv({ binding: 'CONTENT_KV', noProvision: true, force: false, yes: true });
    const toml = readFileSync(join(repo.dir, 'wrangler.toml'), 'utf8');
    // Should NOT have duplicated the binding.
    const occurrences = (toml.match(/binding = "CONTENT_KV"/g) ?? []).length;
    expect(occurrences).toBe(1);
  });

  it('normalizes a lowercase binding to UPPER_SNAKE_CASE', async () => {
    await runAddKv({ binding: 'cache-kv', noProvision: true, force: false, yes: true });
    const toml = readFileSync(join(repo.dir, 'wrangler.toml'), 'utf8');
    expect(toml).toContain('binding = "CACHE_KV"');
  });
});

describe('runAddR2', () => {
  let repo: RepoCtx;
  beforeEach(() => {
    repo = setupRepo();
  });
  afterEach(() => repo.cleanup());

  it('appends an [[r2_buckets]] block with default bucket_name', async () => {
    await runAddR2({ binding: 'MEDIA', noProvision: true, force: false, yes: true });
    const toml = readFileSync(join(repo.dir, 'wrangler.toml'), 'utf8');
    expect(toml).toContain('[[r2_buckets]]');
    expect(toml).toContain('binding = "MEDIA"');
    expect(toml).toContain('bucket_name = "demoapp-media"');
  });

  it('uses the app name in the default bucket name', async () => {
    await runAddR2({ binding: 'BACKUPS', noProvision: true, force: false, yes: true });
    const toml = readFileSync(join(repo.dir, 'wrangler.toml'), 'utf8');
    expect(toml).toContain('bucket_name = "demoapp-backups"');
  });
});

describe('runAddSecret', () => {
  let repo: RepoCtx;
  beforeEach(() => {
    repo = setupRepo();
  });
  afterEach(() => repo.cleanup());

  it('creates .dev.vars.example with the documented stub', async () => {
    await runAddSecret({
      name: 'ADMIN_PASSWORD',
      description: 'Admin login password.',
      noProvision: true,
      writeToDevVars: false,
      yes: true,
    });
    const examplePath = join(repo.dir, '.dev.vars.example');
    expect(existsSync(examplePath)).toBe(true);
    const body = readFileSync(examplePath, 'utf8');
    expect(body).toContain('ADMIN_PASSWORD=');
    expect(body).toContain('Admin login password.');
  });

  it('does NOT write the secret to .dev.vars when writeToDevVars=false', async () => {
    await runAddSecret({
      name: 'COOKIE_SECRET',
      description: 'HMAC cookie seed.',
      noProvision: true,
      writeToDevVars: false,
      yes: true,
    });
    expect(existsSync(join(repo.dir, '.dev.vars'))).toBe(false);
  });

  it('appends to an existing .dev.vars.example without duplicating entries', async () => {
    const examplePath = join(repo.dir, '.dev.vars.example');
    writeFileSync(examplePath, 'OTHER=    # something else\n', 'utf8');
    await runAddSecret({
      name: 'ADMIN_PASSWORD',
      description: 'Admin login password.',
      noProvision: true,
      writeToDevVars: false,
      yes: true,
    });
    const body = readFileSync(examplePath, 'utf8');
    expect(body).toContain('OTHER=');
    expect(body).toContain('ADMIN_PASSWORD=');
    // Now repeat — the second call must NOT add a duplicate.
    await runAddSecret({
      name: 'ADMIN_PASSWORD',
      description: 'Admin login password.',
      noProvision: true,
      writeToDevVars: false,
      yes: true,
    });
    const body2 = readFileSync(examplePath, 'utf8');
    const occurrences = (body2.match(/^ADMIN_PASSWORD=/gm) ?? []).length;
    expect(occurrences).toBe(1);
  });

  it('normalizes a lowercase secret name to UPPER_SNAKE_CASE', async () => {
    await runAddSecret({
      name: 'admin-password',
      description: 'doc',
      noProvision: true,
      writeToDevVars: false,
      yes: true,
    });
    const body = readFileSync(join(repo.dir, '.dev.vars.example'), 'utf8');
    expect(body).toContain('ADMIN_PASSWORD=');
    expect(body).not.toMatch(/^admin-password=/m);
  });
});
