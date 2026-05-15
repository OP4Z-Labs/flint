// Unit coverage for `flint uninstall`.
//
// Manifest-aware deletion: the command must classify each tracked file as
// safe-to-delete (unmodified, matches recorded sha) or preserve (modified
// or ejected). Tests run against real temp dirs so the classify path is
// exercised end-to-end.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runUninstall } from '../../src/commands/uninstall.js';
import { writeManifest, createEmptyManifest, recordFile } from '../../src/util/manifest.js';

let workDir: string;
let originalCwd: string;
let stdoutSpy: ReturnType<typeof vi.spyOn>;
let captured: string[];

beforeEach(() => {
  workDir = mkdtempSync(join(tmpdir(), 'flint-uninstall-'));
  originalCwd = process.cwd();
  process.chdir(workDir);
  captured = [];
  stdoutSpy = vi.spyOn(process.stdout, 'write').mockImplementation(((
    chunk: string | Uint8Array,
  ) => {
    captured.push(typeof chunk === 'string' ? chunk : Buffer.from(chunk).toString('utf8'));
    return true;
  }) as typeof process.stdout.write);
});

afterEach(() => {
  stdoutSpy.mockRestore();
  process.chdir(originalCwd);
  rmSync(workDir, { recursive: true, force: true });
});

function readJson(): { ok: boolean; data: Record<string, unknown> } {
  return JSON.parse(captured.join('')) as { ok: boolean; data: Record<string, unknown> };
}

function seed(files: Array<{ path: string; contents: string; modify?: string }>): void {
  const manifest = createEmptyManifest({
    flintVersion: '1.0.0',
    variant: 'pages-functions',
    vars: {},
  });
  for (const f of files) {
    const abs = join(workDir, f.path);
    mkdirSync(join(workDir, ...f.path.split('/').slice(0, -1)), { recursive: true });
    writeFileSync(abs, f.contents);
    recordFile(manifest, {
      relPath: f.path,
      templateSource: `pages-functions/${f.path}.tmpl`,
      flintVersion: '1.0.0',
      contents: f.contents,
    });
    // If `modify` is provided, the on-disk file is rewritten AFTER recording
    // so classify reports `modified`.
    if (f.modify !== undefined) {
      writeFileSync(abs, f.modify);
    }
  }
  writeManifest(workDir, manifest);
}

describe('flint uninstall', () => {
  it('refuses when there is no manifest', async () => {
    await runUninstall({ json: true });
    const json = readJson();
    expect(json.ok).toBe(true);
    expect(json.data.deleted).toEqual([]);
  });

  it('deletes unmodified files but preserves modified ones', async () => {
    seed([
      { path: 'untouched.txt', contents: 'a' },
      { path: 'edited.txt', contents: 'orig', modify: 'edited' },
    ]);
    await runUninstall({ yes: true, json: true });

    const json = readJson() as { data: { deleted: string[]; preserved: Array<{ path: string }> } };
    expect(json.data.deleted).toContain('untouched.txt');
    expect(json.data.deleted).not.toContain('edited.txt');
    expect(json.data.preserved.map((p) => p.path)).toContain('edited.txt');

    expect(existsSync(join(workDir, 'untouched.txt'))).toBe(false);
    expect(existsSync(join(workDir, 'edited.txt'))).toBe(true);
  });

  it('with --include-modified deletes everything tracked', async () => {
    seed([
      { path: 'untouched.txt', contents: 'a' },
      { path: 'edited.txt', contents: 'orig', modify: 'edited' },
    ]);
    await runUninstall({ yes: true, includeModified: true, json: true });

    expect(existsSync(join(workDir, 'untouched.txt'))).toBe(false);
    expect(existsSync(join(workDir, 'edited.txt'))).toBe(false);
  });

  it('--dry-run reports what would happen but writes nothing', async () => {
    seed([{ path: 'untouched.txt', contents: 'a' }]);
    await runUninstall({ dryRun: true, yes: true, json: true });

    const json = readJson() as { data: { dryRun: boolean; wouldDelete: Array<unknown> } };
    expect(json.data.dryRun).toBe(true);
    expect(json.data.wouldDelete).toHaveLength(1);
    expect(existsSync(join(workDir, 'untouched.txt'))).toBe(true);
  });

  it('removes the manifest itself when files are deleted', async () => {
    seed([{ path: 'a.txt', contents: 'a' }]);
    expect(existsSync(join(workDir, 'flint.manifest.json'))).toBe(true);
    await runUninstall({ yes: true, json: true });
    expect(existsSync(join(workDir, 'flint.manifest.json'))).toBe(false);
  });
});
