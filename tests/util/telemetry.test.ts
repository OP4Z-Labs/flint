// Unit coverage for the telemetry module. The event payload shape is a
// public-ish API (v0.9 ships it to local logs; v1.0 ships it to a remote
// endpoint), so we lock it explicitly.

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  buildEventPayload,
  emitEvent,
  readTelemetryPrefs,
  setTelemetryEnabled,
  telemetryPath,
  telemetryLogPath,
  writeTelemetryPrefs,
} from '../../src/util/telemetry.js';

describe('telemetry payload shape (locked public contract)', () => {
  it('emits required fields: event, flintVersion, os, node, ts', () => {
    const payload = buildEventPayload({ event: 'init' });
    expect(payload.event).toBe('init');
    expect(typeof payload.flintVersion).toBe('string');
    expect(typeof payload.os).toBe('string');
    expect(typeof payload.node).toBe('string');
    expect(typeof payload.ts).toBe('string');
    // ts must be ISO 8601.
    expect(payload.ts as string).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}.\d{3}Z$/);
  });

  it('includes variant when provided', () => {
    const payload = buildEventPayload({ event: 'create-app', variant: 'pages-fullstack' });
    expect(payload.variant).toBe('pages-fullstack');
  });

  it('includes errorType when provided, but never a message', () => {
    const payload = buildEventPayload({ event: 'deploy', errorType: 'ENOENT' });
    expect(payload.errorType).toBe('ENOENT');
    // No "message" field, even by accident.
    expect(payload).not.toHaveProperty('message');
  });

  it('does not include PII fields', () => {
    const payload = buildEventPayload({ event: 'init' });
    // Forbidden field names — locked.
    expect(payload).not.toHaveProperty('path');
    expect(payload).not.toHaveProperty('cwd');
    expect(payload).not.toHaveProperty('user');
    expect(payload).not.toHaveProperty('email');
    expect(payload).not.toHaveProperty('hostname');
    expect(payload).not.toHaveProperty('token');
    expect(payload).not.toHaveProperty('accountId');
  });
});

describe('telemetry preferences I/O', () => {
  let home: string;
  let prevHome: string | undefined;

  beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), 'flint-telem-'));
    prevHome = process.env.FLINT_CONFIG_HOME;
    process.env.FLINT_CONFIG_HOME = home;
  });
  afterEach(() => {
    if (prevHome === undefined) delete process.env.FLINT_CONFIG_HOME;
    else process.env.FLINT_CONFIG_HOME = prevHome;
    rmSync(home, { recursive: true, force: true });
  });

  it('returns null when prefs have never been written', () => {
    expect(readTelemetryPrefs()).toBeNull();
  });

  it('round-trips a saved preference', () => {
    writeTelemetryPrefs({
      enabled: true,
      installed: '2026-05-14T00:00:00.000Z',
      sink: 'log',
    });
    const back = readTelemetryPrefs();
    expect(back).not.toBeNull();
    expect(back!.enabled).toBe(true);
    expect(back!.installed).toBe('2026-05-14T00:00:00.000Z');
    expect(back!.sink).toBe('log');
  });

  it('setTelemetryEnabled toggles enabled flag', () => {
    setTelemetryEnabled(true);
    expect(readTelemetryPrefs()!.enabled).toBe(true);
    setTelemetryEnabled(false);
    expect(readTelemetryPrefs()!.enabled).toBe(false);
  });

  it('emitEvent is a silent no-op when telemetry is disabled', () => {
    setTelemetryEnabled(false);
    emitEvent({ event: 'init' });
    expect(existsSync(telemetryLogPath())).toBe(false);
  });

  it('emitEvent writes JSONL to the log file when enabled', () => {
    setTelemetryEnabled(true);
    emitEvent({ event: 'init', variant: 'pages-fullstack' });
    expect(existsSync(telemetryLogPath())).toBe(true);
    const log = readFileSync(telemetryLogPath(), 'utf8');
    expect(log.trim().endsWith('}')).toBe(true);
    const parsed = JSON.parse(log.trim());
    expect(parsed.event).toBe('init');
    expect(parsed.variant).toBe('pages-fullstack');
  });

  it('emitEvent never throws even when filesystem is unwritable', () => {
    setTelemetryEnabled(true);
    // Point the config dir at a path the process cannot create. Should NOT
    // raise; telemetry must never break user commands.
    const prev = process.env.FLINT_CONFIG_HOME;
    process.env.FLINT_CONFIG_HOME = '/proc/forbidden-flint-path';
    expect(() => emitEvent({ event: 'init' })).not.toThrow();
    process.env.FLINT_CONFIG_HOME = prev;
  });

  it('writeTelemetryPrefs creates the config dir if missing', () => {
    expect(existsSync(home + '/sub')).toBe(false);
    process.env.FLINT_CONFIG_HOME = home + '/sub';
    writeTelemetryPrefs({
      enabled: false,
      installed: '2026-05-14T00:00:00.000Z',
      sink: 'log',
    });
    expect(existsSync(telemetryPath())).toBe(true);
  });
});
