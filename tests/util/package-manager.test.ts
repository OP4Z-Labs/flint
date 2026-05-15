// Unit coverage for package-manager detection. `npm_config_user_agent` is
// set by the package manager itself when it invokes a child process; we
// parse the leading token from it to choose between npm / pnpm / bun.
//
// We restore the original env var in `afterEach` so the test that asserts
// "no UA → null" doesn't bleed into the next file.

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  detectFromUserAgent,
  installCommand,
  isPackageManager,
  resolvePackageManager,
} from '../../src/util/package-manager.js';

describe('isPackageManager', () => {
  it('accepts the three supported managers', () => {
    expect(isPackageManager('npm')).toBe(true);
    expect(isPackageManager('pnpm')).toBe(true);
    expect(isPackageManager('bun')).toBe(true);
  });
  it('rejects unsupported values', () => {
    expect(isPackageManager('yarn')).toBe(false);
    expect(isPackageManager('')).toBe(false);
    expect(isPackageManager('NPM')).toBe(false);
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

  it('returns null for yarn (not a v0.5 target)', () => {
    process.env.npm_config_user_agent = 'yarn/1.22.22 npm/? node/v20.10.0 linux x64';
    expect(detectFromUserAgent()).toBeNull();
  });
});

describe('resolvePackageManager', () => {
  it('honours an explicit override even when the UA says otherwise', () => {
    process.env.npm_config_user_agent = 'npm/10.2.4 node/v20.10.0';
    expect(resolvePackageManager('bun')).toBe('bun');
  });

  it('throws on an unrecognised explicit override', () => {
    expect(() => resolvePackageManager('cargo')).toThrow(/Unknown package manager "cargo"/);
  });

  it('falls back to npm when no signal is available', () => {
    const prev = process.env.npm_config_user_agent;
    delete process.env.npm_config_user_agent;
    try {
      expect(resolvePackageManager(undefined)).toBe('npm');
    } finally {
      if (prev !== undefined) process.env.npm_config_user_agent = prev;
    }
  });
});

describe('installCommand', () => {
  it('maps each PM to its install command', () => {
    expect(installCommand('npm')).toEqual(['npm', ['install']]);
    expect(installCommand('pnpm')).toEqual(['pnpm', ['install']]);
    expect(installCommand('bun')).toEqual(['bun', ['install']]);
  });
});
