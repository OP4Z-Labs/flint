// Unit coverage for package-manager detection.
//
// v1.0 expanded the detector from "user-agent only" to a full multi-signal
// resolver: explicit flag → lockfile → user-agent → default. Lockfile
// detection makes `flint init` work right in pnpm/bun/yarn projects without
// requiring the user to pass --pm.
//
// We restore the original env var in afterEach so the test that asserts
// "no UA → null" doesn't bleed into the next file.

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  detectFromLockfiles,
  detectFromUserAgent,
  detectPackageManager,
  execCommand,
  installCommand,
  isPackageManager,
  packageManagerTier,
  resolvePackageManager,
  runScriptCommand,
} from '../../src/util/package-manager.js';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

describe('isPackageManager', () => {
  it('accepts all four supported managers', () => {
    expect(isPackageManager('npm')).toBe(true);
    expect(isPackageManager('pnpm')).toBe(true);
    expect(isPackageManager('bun')).toBe(true);
    expect(isPackageManager('yarn')).toBe(true);
  });
  it('rejects unsupported values', () => {
    expect(isPackageManager('')).toBe(false);
    expect(isPackageManager('NPM')).toBe(false);
    expect(isPackageManager('cargo')).toBe(false);
  });
});

describe('packageManagerTier', () => {
  it('classifies first-class PMs correctly', () => {
    expect(packageManagerTier('npm')).toBe('first-class');
    expect(packageManagerTier('pnpm')).toBe('first-class');
    expect(packageManagerTier('bun')).toBe('first-class');
  });
  it('classifies yarn as best-effort', () => {
    expect(packageManagerTier('yarn')).toBe('best-effort');
  });
});

describe('detectFromUserAgent', () => {
  let original: string | undefined;
  beforeEach(() => {
    original = process.env.npm_config_user_agent;
  });
  afterEach(() => {
    if (original === undefined) delete process.env.npm_config_user_agent;
    else process.env.npm_config_user_agent = original;
  });

  it('returns null when the env var is missing', () => {
    delete process.env.npm_config_user_agent;
    expect(detectFromUserAgent()).toBeNull();
  });

  it('detects npm from a real npm UA string', () => {
    process.env.npm_config_user_agent = 'npm/10.2.4 node/v20.10.0 linux x64 workspaces/false';
    expect(detectFromUserAgent()).toBe('npm');
  });

  it('detects pnpm from a real pnpm UA string', () => {
    process.env.npm_config_user_agent = 'pnpm/9.4.0 npm/? node/v20.10.0 linux x64';
    expect(detectFromUserAgent()).toBe('pnpm');
  });

  it('detects bun from a real bun UA string', () => {
    process.env.npm_config_user_agent = 'bun/1.1.13 npm/? node/v22.2.0 darwin arm64';
    expect(detectFromUserAgent()).toBe('bun');
  });

  it('detects yarn (best-effort tier in v1.0)', () => {
    process.env.npm_config_user_agent = 'yarn/1.22.22 npm/? node/v20.10.0 linux x64';
    expect(detectFromUserAgent()).toBe('yarn');
  });

  it('returns null for unrecognised PMs', () => {
    process.env.npm_config_user_agent = 'cargo/1.0.0 node/v20.10.0';
    expect(detectFromUserAgent()).toBeNull();
  });
});

describe('detectFromLockfiles', () => {
  let workDir: string;

  beforeEach(() => {
    workDir = mkdtempSync(join(tmpdir(), 'flint-pm-'));
  });
  afterEach(() => {
    rmSync(workDir, { recursive: true, force: true });
  });

  it('returns null when no lockfile is present', () => {
    expect(detectFromLockfiles(workDir)).toBeNull();
  });

  it('detects bun from bun.lockb', () => {
    writeFileSync(join(workDir, 'bun.lockb'), '');
    expect(detectFromLockfiles(workDir)).toBe('bun');
  });

  it('detects bun from bun.lock (text variant)', () => {
    writeFileSync(join(workDir, 'bun.lock'), '');
    expect(detectFromLockfiles(workDir)).toBe('bun');
  });

  it('detects pnpm from pnpm-lock.yaml', () => {
    writeFileSync(join(workDir, 'pnpm-lock.yaml'), '');
    expect(detectFromLockfiles(workDir)).toBe('pnpm');
  });

  it('detects yarn from yarn.lock', () => {
    writeFileSync(join(workDir, 'yarn.lock'), '');
    expect(detectFromLockfiles(workDir)).toBe('yarn');
  });

  it('detects npm from package-lock.json', () => {
    writeFileSync(join(workDir, 'package-lock.json'), '{}');
    expect(detectFromLockfiles(workDir)).toBe('npm');
  });

  it('prefers bun.lockb when multiple lockfiles coexist', () => {
    // Order in the implementation: bun → pnpm → yarn → npm. This protects
    // monorepo edge cases where a dev accidentally has both.
    writeFileSync(join(workDir, 'bun.lockb'), '');
    writeFileSync(join(workDir, 'package-lock.json'), '{}');
    expect(detectFromLockfiles(workDir)).toBe('bun');
  });
});

describe('detectPackageManager (combined)', () => {
  let workDir: string;
  let original: string | undefined;

  beforeEach(() => {
    workDir = mkdtempSync(join(tmpdir(), 'flint-pm-'));
    original = process.env.npm_config_user_agent;
    delete process.env.npm_config_user_agent;
  });
  afterEach(() => {
    rmSync(workDir, { recursive: true, force: true });
    if (original === undefined) delete process.env.npm_config_user_agent;
    else process.env.npm_config_user_agent = original;
  });

  it('reports source=lockfile when a lockfile is present', () => {
    writeFileSync(join(workDir, 'pnpm-lock.yaml'), '');
    const result = detectPackageManager(workDir);
    expect(result.name).toBe('pnpm');
    expect(result.source).toBe('lockfile');
    expect(result.tier).toBe('first-class');
  });

  it('reports source=user-agent when no lockfile but UA present', () => {
    process.env.npm_config_user_agent = 'bun/1.1.13 npm/? node/v22.2.0';
    const result = detectPackageManager(workDir);
    expect(result.name).toBe('bun');
    expect(result.source).toBe('user-agent');
  });

  it('reports source=default when nothing is detected', () => {
    const result = detectPackageManager(workDir);
    expect(result.name).toBe('npm');
    expect(result.source).toBe('default');
  });

  it('reports yarn as best-effort tier', () => {
    writeFileSync(join(workDir, 'yarn.lock'), '');
    const result = detectPackageManager(workDir);
    expect(result.name).toBe('yarn');
    expect(result.tier).toBe('best-effort');
  });
});

describe('resolvePackageManager', () => {
  it('honours an explicit override even when the UA says otherwise', () => {
    process.env.npm_config_user_agent = 'npm/10.2.4 node/v20.10.0';
    expect(resolvePackageManager('bun')).toBe('bun');
  });

  it('throws on an unrecognised explicit override', () => {
    expect(() => resolvePackageManager('cargo')).toThrow(/unknown PM "cargo"/);
  });

  it('falls back to npm when no signal is available', () => {
    const prev = process.env.npm_config_user_agent;
    delete process.env.npm_config_user_agent;
    try {
      // Pass a fresh empty dir as cwd so lockfile detection doesn't pick up
      // the Flint repo's own package-lock.json.
      const emptyDir = mkdtempSync(join(tmpdir(), 'flint-pm-empty-'));
      try {
        expect(resolvePackageManager(undefined, emptyDir)).toBe('npm');
      } finally {
        rmSync(emptyDir, { recursive: true, force: true });
      }
    } finally {
      if (prev !== undefined) process.env.npm_config_user_agent = prev;
    }
  });
});

// Windows resolves shims as `.cmd`; POSIX uses bare names.
const X = process.platform === 'win32' ? '.cmd' : '';

describe('installCommand', () => {
  it('maps each PM to its install command (platform-resolved bin)', () => {
    expect(installCommand('npm')).toEqual([`npm${X}`, ['install']]);
    expect(installCommand('pnpm')).toEqual([`pnpm${X}`, ['install']]);
    expect(installCommand('bun')).toEqual([`bun${X}`, ['install']]);
    expect(installCommand('yarn')).toEqual([`yarn${X}`, ['install']]);
  });
});

describe('runScriptCommand', () => {
  it('maps each PM to its run-script command (platform-resolved bin)', () => {
    expect(runScriptCommand('npm', 'build')).toEqual([`npm${X}`, ['run', 'build']]);
    expect(runScriptCommand('pnpm', 'build')).toEqual([`pnpm${X}`, ['run', 'build']]);
    expect(runScriptCommand('bun', 'build')).toEqual([`bun${X}`, ['run', 'build']]);
    expect(runScriptCommand('yarn', 'build')).toEqual([`yarn${X}`, ['run', 'build']]);
  });
});

describe('execCommand', () => {
  it('maps each PM to its exec-binary form (platform-resolved bin)', () => {
    expect(execCommand('npm', 'vitest', ['run'])).toEqual([`npx${X}`, ['--no-install', 'vitest', 'run']]);
    expect(execCommand('pnpm', 'vitest', ['run'])).toEqual([`pnpm${X}`, ['exec', 'vitest', 'run']]);
    expect(execCommand('bun', 'vitest', ['run'])).toEqual([`bunx${X}`, ['vitest', 'run']]);
    expect(execCommand('yarn', 'vitest', ['run'])).toEqual([`yarn${X}`, ['exec', 'vitest', 'run']]);
  });
});
