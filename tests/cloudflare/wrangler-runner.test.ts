// Tests for the wrangler runner adapter.
//
// We can't realistically test against a real `wrangler` binary in unit
// tests (it would require Cloudflare API access). Instead, we:
//   - point WRANGLER_BINARY at a tiny fake script that echoes a known
//     payload to stdout
//   - assert the runner captures stdout + stderr + status correctly
//   - assert version extraction handles common output shapes
//   - assert resolveWranglerBin's precedence rules

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  getWranglerVersion,
  parseMajor,
  resolveWranglerBin,
  runWrangler,
} from '../../src/cloudflare/wrangler-runner.js';

interface FakeBin {
  dir: string;
  path: string;
  cleanup: () => void;
}

/** Writes a tiny shell script that prints `body` and exits with `status`. */
function fakeBin(body: string, status = 0): FakeBin {
  const dir = mkdtempSync(join(tmpdir(), 'flint-fake-'));
  const path = join(dir, 'wrangler');
  // Use printf to handle multi-line + newlines portably.
  writeFileSync(
    path,
    `#!/usr/bin/env bash\nprintf '%s' "${body.replace(/'/g, "'\\''")}"\nexit ${status}\n`,
    'utf8',
  );
  chmodSync(path, 0o755);
  return {
    dir,
    path,
    cleanup: () => rmSync(dir, { recursive: true, force: true }),
  };
}

describe('resolveWranglerBin', () => {
  const originalEnv = process.env.WRANGLER_BINARY;
  let tmp: ReturnType<typeof mkdtempSync>;

  beforeEach(() => {
    delete process.env.WRANGLER_BINARY;
    tmp = mkdtempSync(join(tmpdir(), 'flint-resolve-'));
  });
  afterEach(() => {
    if (originalEnv === undefined) delete process.env.WRANGLER_BINARY;
    else process.env.WRANGLER_BINARY = originalEnv;
    rmSync(tmp, { recursive: true, force: true });
  });

  it('honors WRANGLER_BINARY env override first', () => {
    process.env.WRANGLER_BINARY = '/custom/path/wrangler';
    expect(resolveWranglerBin(tmp)).toBe('/custom/path/wrangler');
  });

  it('finds node_modules/.bin/wrangler in cwd when present', () => {
    mkdirSync(join(tmp, 'node_modules', '.bin'), { recursive: true });
    writeFileSync(join(tmp, 'node_modules', '.bin', 'wrangler'), '#!/bin/sh\n', 'utf8');
    expect(resolveWranglerBin(tmp)).toBe(join(tmp, 'node_modules/.bin/wrangler'));
  });

  it('falls back to bare "wrangler" when nothing else is found', () => {
    expect(resolveWranglerBin(tmp)).toBe('wrangler');
  });
});

describe('runWrangler', () => {
  let bin: FakeBin;
  const originalEnv = process.env.WRANGLER_BINARY;

  afterEach(() => {
    bin?.cleanup();
    if (originalEnv === undefined) delete process.env.WRANGLER_BINARY;
    else process.env.WRANGLER_BINARY = originalEnv;
  });

  it('captures stdout from the fake wrangler', () => {
    bin = fakeBin('{"id":"abc123abc123abc1","title":"X"}');
    process.env.WRANGLER_BINARY = bin.path;
    const res = runWrangler(['kv', 'namespace', 'create', 'X']);
    expect(res.status).toBe(0);
    expect(res.stdout).toContain('abc123abc123abc1');
  });

  it('reports a non-zero status when wrangler exits non-zero', () => {
    bin = fakeBin('boom', 7);
    process.env.WRANGLER_BINARY = bin.path;
    const res = runWrangler(['kv', 'namespace', 'create', 'X']);
    expect(res.status).toBe(7);
  });

  it('returns status 127 with an error message when the binary is missing', () => {
    process.env.WRANGLER_BINARY = '/does/not/exist/wrangler-nope';
    const res = runWrangler(['--version']);
    expect(res.status).toBe(127);
    expect(res.stderr.length).toBeGreaterThan(0);
  });

  it('forwards CLOUDFLARE_API_TOKEN into the child env', () => {
    bin = fakeBin('TOKEN_LEN');
    process.env.WRANGLER_BINARY = bin.path;
    // Replace fake bin with one that prints the env var directly.
    writeFileSync(
      bin.path,
      `#!/usr/bin/env bash\nprintf '%s' "$CLOUDFLARE_API_TOKEN"\n`,
      'utf8',
    );
    chmodSync(bin.path, 0o755);
    const res = runWrangler(['--version'], { token: 'fake-cf-token-xyz' });
    expect(res.stdout).toBe('fake-cf-token-xyz');
  });
});

describe('getWranglerVersion', () => {
  let bin: FakeBin;
  const originalEnv = process.env.WRANGLER_BINARY;

  afterEach(() => {
    bin?.cleanup();
    if (originalEnv === undefined) delete process.env.WRANGLER_BINARY;
    else process.env.WRANGLER_BINARY = originalEnv;
  });

  it('parses the version from a typical wrangler --version line', () => {
    bin = fakeBin(' ⛅️ wrangler 4.90.0 ');
    process.env.WRANGLER_BINARY = bin.path;
    expect(getWranglerVersion(process.cwd())).toBe('4.90.0');
  });

  it('parses a bare semver', () => {
    bin = fakeBin('3.42.1');
    process.env.WRANGLER_BINARY = bin.path;
    expect(getWranglerVersion(process.cwd())).toBe('3.42.1');
  });

  it('returns null when wrangler exits non-zero', () => {
    bin = fakeBin('no go', 1);
    process.env.WRANGLER_BINARY = bin.path;
    expect(getWranglerVersion(process.cwd())).toBeNull();
  });
});

describe('parseMajor', () => {
  it('returns the major from a SemVer', () => {
    expect(parseMajor('4.90.0')).toBe(4);
    expect(parseMajor('10.0.0')).toBe(10);
  });

  it('returns null for null input', () => {
    expect(parseMajor(null)).toBeNull();
  });

  it('returns null for malformed input', () => {
    expect(parseMajor('not-a-version')).toBeNull();
  });
});
