// Unit coverage for the manifest module. The manifest schema is load-bearing
// for v1.0's rescaffold work — these tests lock the wire format.

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  backfillManifest,
  classifyAll,
  classifyFile,
  createEmptyManifest,
  manifestPath,
  MANIFEST_FILENAME,
  MANIFEST_SCHEMA_URL,
  MANIFEST_SCHEMA_VERSION,
  readManifest,
  recordFile,
  recordHistory,
  sha256OfFile,
  sha256OfString,
  writeManifest,
} from '../../src/util/manifest.js';
import { ManifestTracker } from '../../src/util/manifest-tracker.js';

const TEST_FLINT_VERSION = '0.9.0';
const TEST_VARIANT = 'pages-fullstack';

describe('manifest schema', () => {
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'flint-manifest-'));
  });
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it('exposes a stable schema version constant', () => {
    expect(MANIFEST_SCHEMA_VERSION).toBe(1);
    expect(MANIFEST_FILENAME).toBe('flint.manifest.json');
    expect(MANIFEST_SCHEMA_URL).toContain('manifest.schema.v1');
  });

  it('createEmptyManifest returns a well-formed v1 doc', () => {
    const m = createEmptyManifest({
      flintVersion: TEST_FLINT_VERSION,
      variant: TEST_VARIANT,
    });
    expect(m.version).toBe(1);
    expect(m.flintVersion).toBe(TEST_FLINT_VERSION);
    expect(m.variant).toBe(TEST_VARIANT);
    expect(m.history).toEqual([]);
    expect(m.files).toEqual({});
    expect(m.vars).toEqual({});
    expect(m.createdAt).toBe(m.updatedAt);
  });

  it('sha256OfString produces stable, lowercase, 64-char hex', () => {
    const sha = sha256OfString('hello');
    expect(sha).toBe('2cf24dba5fb0a30e26e83b2ac5b9e29e1b161e5c1fa7425e73043362938b9824');
    expect(sha).toMatch(/^[0-9a-f]{64}$/);
  });

  it('recordFile sets a fresh entry for a new path', () => {
    const m = createEmptyManifest({
      flintVersion: TEST_FLINT_VERSION,
      variant: TEST_VARIANT,
    });
    recordFile(m, {
      relPath: 'wrangler.toml',
      templateSource: 'pages-fullstack/wrangler.toml.tmpl',
      flintVersion: TEST_FLINT_VERSION,
      contents: 'name = "test"',
    });
    expect(m.files['wrangler.toml']).toBeDefined();
    expect(m.files['wrangler.toml']!.sha256).toBe(sha256OfString('name = "test"'));
    expect(m.files['wrangler.toml']!.modified).toBe(false);
    expect(m.files['wrangler.toml']!.ejected).toBe(false);
    expect(m.files['wrangler.toml']!.templateVersion).toBe(TEST_FLINT_VERSION);
  });

  it('recordFile preserves ejected: true across re-records', () => {
    const m = createEmptyManifest({
      flintVersion: TEST_FLINT_VERSION,
      variant: TEST_VARIANT,
    });
    recordFile(m, {
      relPath: 'x',
      templateSource: 's',
      flintVersion: TEST_FLINT_VERSION,
      contents: 'a',
    });
    // Mark as ejected.
    m.files['x']!.ejected = true;
    // Re-record (e.g. user re-ran init). Ejected flag must survive.
    recordFile(m, {
      relPath: 'x',
      templateSource: 's',
      flintVersion: '0.9.1',
      contents: 'b',
    });
    expect(m.files['x']!.ejected).toBe(true);
    // Sha is updated to match the new content but templateVersion is unchanged
    // (we keep what the user has chosen to own).
    expect(m.files['x']!.sha256).toBe(sha256OfString('b'));
  });

  it('writeManifest + readManifest round-trip identical data', () => {
    const m = createEmptyManifest({
      flintVersion: TEST_FLINT_VERSION,
      variant: TEST_VARIANT,
    });
    recordFile(m, {
      relPath: 'wrangler.toml',
      templateSource: 'pages-fullstack/wrangler.toml.tmpl',
      flintVersion: TEST_FLINT_VERSION,
      contents: 'name = "x"',
    });
    recordHistory(m, {
      command: 'init',
      flintVersion: TEST_FLINT_VERSION,
      at: '2026-05-14T20:00:00.000Z',
      files: 1,
    });
    writeManifest(dir, m);
    const back = readManifest(dir);
    expect(back).toEqual(m);
  });

  it('readManifest returns null for unsupported schema versions', () => {
    writeFileSync(
      manifestPath(dir),
      JSON.stringify({ version: 99 }),
      'utf8',
    );
    expect(readManifest(dir)).toBeNull();
  });

  it('readManifest returns null for malformed JSON', () => {
    writeFileSync(manifestPath(dir), '{ not json', 'utf8');
    expect(readManifest(dir)).toBeNull();
  });

  it('sha256OfFile returns null for missing files', () => {
    expect(sha256OfFile(join(dir, 'nope.txt'))).toBeNull();
  });

  it('sha256OfFile + sha256OfString agree on identical content', () => {
    const p = join(dir, 'x.txt');
    writeFileSync(p, 'hello world', 'utf8');
    expect(sha256OfFile(p)).toBe(sha256OfString('hello world'));
  });
});

describe('classifyFile / classifyAll', () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'flint-classify-'));
  });
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it('classifies an unchanged file as unmodified', () => {
    const m = createEmptyManifest({
      flintVersion: TEST_FLINT_VERSION,
      variant: TEST_VARIANT,
    });
    writeFileSync(join(dir, 'a.txt'), 'hello', 'utf8');
    recordFile(m, {
      relPath: 'a.txt',
      templateSource: 'x/a.tmpl',
      flintVersion: TEST_FLINT_VERSION,
      contents: 'hello',
    });
    const state = classifyFile(dir, 'a.txt', m.files['a.txt']!);
    expect(state.kind).toBe('unmodified');
  });

  it('classifies a content-changed file as modified', () => {
    const m = createEmptyManifest({
      flintVersion: TEST_FLINT_VERSION,
      variant: TEST_VARIANT,
    });
    writeFileSync(join(dir, 'a.txt'), 'hello', 'utf8');
    recordFile(m, {
      relPath: 'a.txt',
      templateSource: 'x/a.tmpl',
      flintVersion: TEST_FLINT_VERSION,
      contents: 'goodbye',
    });
    const state = classifyFile(dir, 'a.txt', m.files['a.txt']!);
    expect(state.kind).toBe('modified');
  });

  it('classifies a missing file as missing', () => {
    const m = createEmptyManifest({
      flintVersion: TEST_FLINT_VERSION,
      variant: TEST_VARIANT,
    });
    recordFile(m, {
      relPath: 'gone.txt',
      templateSource: 'x/gone.tmpl',
      flintVersion: TEST_FLINT_VERSION,
      contents: 'hello',
    });
    const state = classifyFile(dir, 'gone.txt', m.files['gone.txt']!);
    expect(state.kind).toBe('missing');
  });

  it('classifies an ejected file as ejected regardless of disk state', () => {
    const m = createEmptyManifest({
      flintVersion: TEST_FLINT_VERSION,
      variant: TEST_VARIANT,
    });
    writeFileSync(join(dir, 'a.txt'), 'whatever', 'utf8');
    recordFile(m, {
      relPath: 'a.txt',
      templateSource: 'x/a.tmpl',
      flintVersion: TEST_FLINT_VERSION,
      contents: 'hello',
    });
    m.files['a.txt']!.ejected = true;
    const state = classifyFile(dir, 'a.txt', m.files['a.txt']!);
    expect(state.kind).toBe('ejected');
  });

  it('classifyAll returns entries sorted by relPath', () => {
    const m = createEmptyManifest({
      flintVersion: TEST_FLINT_VERSION,
      variant: TEST_VARIANT,
    });
    for (const f of ['z.txt', 'a.txt', 'm.txt']) {
      recordFile(m, {
        relPath: f,
        templateSource: 't',
        flintVersion: TEST_FLINT_VERSION,
        contents: 'x',
      });
    }
    const classified = classifyAll(dir, m);
    expect(classified.map((c) => c.relPath)).toEqual(['a.txt', 'm.txt', 'z.txt']);
  });
});

describe('backfillManifest', () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'flint-backfill-'));
  });
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it('builds entries for every existing candidate path with modified: true', () => {
    writeFileSync(join(dir, 'wrangler.toml'), 'name = "app"', 'utf8');
    writeFileSync(join(dir, '.gitignore'), '.dev.vars\n', 'utf8');
    const m = backfillManifest(dir, {
      candidatePaths: ['wrangler.toml', '.gitignore', 'does-not-exist'],
      templateSources: {
        'wrangler.toml': 'pages-fullstack/wrangler.toml.tmpl',
        '.gitignore': '_skeleton/gitignore',
      },
      flintVersion: TEST_FLINT_VERSION,
      variant: 'pages-fullstack',
      vars: { appName: 'app' },
    });
    expect(m.files['wrangler.toml']).toBeDefined();
    expect(m.files['wrangler.toml']!.modified).toBe(true);
    expect(m.files['wrangler.toml']!.templateVersion).toBe('0.0.0-backfill');
    expect(m.files['.gitignore']).toBeDefined();
    expect(m.files['does-not-exist']).toBeUndefined();
    expect(m.vars.appName).toBe('app');
    expect(m.history[0]!.command).toBe('backfill');
  });
});

describe('ManifestTracker', () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'flint-tracker-'));
  });
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it('writes a fresh manifest on first record', () => {
    const t = new ManifestTracker(dir, {
      command: 'init',
      flintVersion: TEST_FLINT_VERSION,
      variant: TEST_VARIANT,
      vars: { appName: 'thing' },
    });
    t.record({
      relPath: 'wrangler.toml',
      templateSource: 'pages-fullstack/wrangler.toml.tmpl',
      contents: 'name = "thing"',
    });
    t.flush();
    const m = readManifest(dir);
    expect(m).not.toBeNull();
    expect(m!.files['wrangler.toml']).toBeDefined();
    expect(m!.history.length).toBe(1);
    expect(m!.history[0]!.command).toBe('init');
    expect(m!.vars.appName).toBe('thing');
  });

  it('preserves history across two tracker invocations', () => {
    const t1 = new ManifestTracker(dir, {
      command: 'init',
      flintVersion: TEST_FLINT_VERSION,
      variant: TEST_VARIANT,
      vars: { appName: 'a' },
    });
    t1.record({
      relPath: 'a',
      templateSource: 't',
      contents: '1',
    });
    t1.flush();

    const t2 = new ManifestTracker(dir, {
      command: 'add pwa',
      flintVersion: TEST_FLINT_VERSION,
      variant: TEST_VARIANT,
    });
    t2.record({
      relPath: 'b',
      templateSource: 't',
      contents: '2',
    });
    t2.flush();

    const m = readManifest(dir);
    expect(m!.history.length).toBe(2);
    expect(m!.history.map((h) => h.command)).toEqual(['init', 'add pwa']);
    expect(Object.keys(m!.files).sort()).toEqual(['a', 'b']);
  });

  it('does not overwrite existing vars on second tracker invocation', () => {
    const t1 = new ManifestTracker(dir, {
      command: 'init',
      flintVersion: TEST_FLINT_VERSION,
      variant: TEST_VARIANT,
      vars: { appName: 'original' },
    });
    t1.flush();

    const t2 = new ManifestTracker(dir, {
      command: 'add pwa',
      flintVersion: TEST_FLINT_VERSION,
      variant: TEST_VARIANT,
      vars: { appName: 'changed-by-add' },
    });
    t2.flush();

    const m = readManifest(dir);
    // Sticky: first invocation's vars win.
    expect(m!.vars.appName).toBe('original');
  });
});
