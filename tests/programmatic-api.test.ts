// Programmatic API smoke test.
//
// Locks the public-API surface: every name we promise to expose must exist
// and have the correct shape. Renaming or removing any of these is a major
// version change.
//
// This file is the SINGLE source of truth for "what does `import from
// @op4z/flint` get you?" — any addition to `src/index.ts` should add an
// assertion here.

import { describe, it, expect } from 'vitest';
import * as flint from '../src/index.js';

describe('programmatic API — public surface', () => {
  it('exports the top-level command runners', () => {
    expect(typeof flint.init).toBe('function');
    expect(typeof flint.createApp).toBe('function');
    expect(typeof flint.configure).toBe('function');
    expect(typeof flint.deploy).toBe('function');
    expect(typeof flint.upgrade).toBe('function');
    expect(typeof flint.config).toBe('function');
  });

  it('exports the add-resource runners', () => {
    expect(typeof flint.addKv).toBe('function');
    expect(typeof flint.addR2).toBe('function');
    expect(typeof flint.addSecret).toBe('function');
  });

  it('exports the add-feature runners', () => {
    expect(typeof flint.addPwa).toBe('function');
    expect(typeof flint.addAuth).toBe('function');
    expect(typeof flint.addRateLimit).toBe('function');
    expect(typeof flint.addFeature).toBe('function');
  });

  it('exports the auth runners', () => {
    expect(typeof flint.authInit).toBe('function');
    expect(typeof flint.authStatus).toBe('function');
    expect(typeof flint.authDoctor).toBe('function');
    expect(typeof flint.authRotate).toBe('function');
    expect(typeof flint.authPurge).toBe('function');
  });

  it('exports the atomic write helpers', () => {
    expect(typeof flint.writeFileAtomic).toBe('function');
    expect(typeof flint.writeJsonAtomic).toBe('function');
  });

  it('exports manifest types + helpers', () => {
    expect(typeof flint.readManifest).toBe('function');
    expect(typeof flint.writeManifest).toBe('function');
    expect(typeof flint.classifyAll).toBe('function');
    expect(typeof flint.classifyFile).toBe('function');
    expect(flint.MANIFEST_FILENAME).toBe('flint.manifest.json');
    expect(flint.MANIFEST_SCHEMA_VERSION).toBe(1);
    expect(typeof flint.MANIFEST_SCHEMA_URL).toBe('string');
  });

  it('exports telemetry helpers', () => {
    expect(typeof flint.buildEventPayload).toBe('function');
    expect(typeof flint.emitEvent).toBe('function');
    expect(typeof flint.readTelemetryPrefs).toBe('function');
    expect(typeof flint.setTelemetryEnabled).toBe('function');
    expect(typeof flint.telemetryPath).toBe('function');
    expect(typeof flint.telemetryLogPath).toBe('function');
  });

  it('exports the package version reader', () => {
    expect(typeof flint.version).toBe('function');
    const v = flint.version();
    expect(typeof v).toBe('string');
    expect(v).toMatch(/^\d+\.\d+\.\d+/);
  });
});

describe('programmatic API — addFeature dispatch', () => {
  it('rejects unknown feature names with an actionable error', async () => {
    // Cast to any so the runtime guard fires (TS prevents this at compile time).
    await expect(
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      (flint.addFeature as any)('nonsense'),
    ).rejects.toThrow(/unknown feature/i);
  });
});
