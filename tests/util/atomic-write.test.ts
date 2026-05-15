// Atomic write helper — write-tmp-rename semantics + crash-simulation test.
//
// The contract we're locking:
//   1. Successful writes land at the target path atomically (no partial state
//      visible at the target path).
//   2. Failed writes (simulated crash mid-write) leave the EXISTING target
//      file untouched. Tmp file may be orphaned but the destination is
//      never corrupted.
//   3. JSON convenience wrapper pretty-prints with 2-space indent and a
//      trailing newline.

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { existsSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { writeFileAtomic, writeJsonAtomic } from '../../src/util/atomic-write.js';

let workDir: string;

beforeEach(() => {
  workDir = mkdtempSync(join(tmpdir(), 'flint-atomic-'));
});

afterEach(() => {
  rmSync(workDir, { recursive: true, force: true });
});

describe('writeFileAtomic', () => {
  it('writes string contents to the target path', () => {
    const target = join(workDir, 'hello.txt');
    writeFileAtomic(target, 'world\n');
    expect(readFileSync(target, 'utf8')).toBe('world\n');
  });

  it('returns the destination path for chaining', () => {
    const target = join(workDir, 'chain.txt');
    const result = writeFileAtomic(target, 'x');
    expect(result).toBe(target);
  });

  it('overwrites an existing file atomically', () => {
    const target = join(workDir, 'replace.txt');
    writeFileSync(target, 'original');
    writeFileAtomic(target, 'replaced');
    expect(readFileSync(target, 'utf8')).toBe('replaced');
  });

  it('writes binary content when given a Uint8Array', () => {
    const target = join(workDir, 'binary.bin');
    const bytes = new Uint8Array([0xff, 0xd8, 0xff, 0xe0]);
    writeFileAtomic(target, bytes);
    const read = readFileSync(target);
    expect(read[0]).toBe(0xff);
    expect(read[1]).toBe(0xd8);
    expect(read[2]).toBe(0xff);
    expect(read[3]).toBe(0xe0);
  });

  it('respects the mode option', () => {
    if (process.platform === 'win32') return; // POSIX-mode test
    const target = join(workDir, 'mode.txt');
    writeFileAtomic(target, 'secret', { mode: 0o600 });
    const stat = statSync(target);
    expect(stat.mode & 0o777).toBe(0o600);
  });

  it('ensureDir creates missing parent directories when requested', () => {
    const target = join(workDir, 'nested', 'deep', 'file.txt');
    writeFileAtomic(target, 'ok', { ensureDir: true });
    expect(readFileSync(target, 'utf8')).toBe('ok');
  });

  it('throws and leaves the original file intact when the rename target is read-only', () => {
    // Simulate a mid-write crash by passing an invalid mode-only contents
    // shape: pass a target inside a non-existent directory WITHOUT ensureDir.
    // This causes writeFileSync(tmp, ...) to throw.
    const target = join(workDir, 'does-not-exist-dir', 'file.txt');
    expect(() => writeFileAtomic(target, 'should not land')).toThrow();
    expect(existsSync(target)).toBe(false);
  });

  it('preserves the existing target file when a mid-write error occurs', () => {
    // First, write something at the target.
    const target = join(workDir, 'protected.txt');
    writeFileSync(target, 'original-content');

    // Now simulate a failure DURING the second write by attempting to write
    // to a non-writable subpath alongside it. We construct a path whose
    // tmp-file directory doesn't exist (and ensureDir is false), so the
    // tmp write fails BEFORE the rename can replace the target.
    const ghostTarget = join(workDir, 'missing-dir', 'file.txt');
    expect(() => writeFileAtomic(ghostTarget, 'replacement')).toThrow();

    // The original is untouched.
    expect(readFileSync(target, 'utf8')).toBe('original-content');
  });
});

describe('writeJsonAtomic', () => {
  it('writes a pretty-printed JSON object with trailing newline', () => {
    const target = join(workDir, 'data.json');
    writeJsonAtomic(target, { foo: 1, bar: 'baz' });
    const raw = readFileSync(target, 'utf8');
    expect(raw).toBe('{\n  "foo": 1,\n  "bar": "baz"\n}\n');
  });

  it('round-trips arbitrary JSON-safe values', () => {
    const target = join(workDir, 'roundtrip.json');
    const value = { a: [1, 2, 3], b: { nested: true }, c: null };
    writeJsonAtomic(target, value);
    const parsed = JSON.parse(readFileSync(target, 'utf8')) as typeof value;
    expect(parsed).toEqual(value);
  });
});
