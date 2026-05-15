// Unit coverage for `flint telemetry show / purge / export`.
//
// We sandbox `FLINT_CONFIG_HOME` so writes don't touch the user's real
// telemetry log. The transparency commands must work even when telemetry
// is disabled, and they must never throw on missing log files.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  runTelemetryShow,
  runTelemetryPurge,
  runTelemetryExport,
} from '../../src/commands/telemetry.js';
import { telemetryLogPath, telemetryPath, writeTelemetryPrefs } from '../../src/util/telemetry.js';

let workHome: string;
let stdoutSpy: ReturnType<typeof vi.spyOn>;
let originalConfigHome: string | undefined;
let captured: string[];

beforeEach(() => {
  workHome = mkdtempSync(join(tmpdir(), 'flint-telemetry-'));
  originalConfigHome = process.env.FLINT_CONFIG_HOME;
  process.env.FLINT_CONFIG_HOME = workHome;
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
  if (originalConfigHome === undefined) delete process.env.FLINT_CONFIG_HOME;
  else process.env.FLINT_CONFIG_HOME = originalConfigHome;
  rmSync(workHome, { recursive: true, force: true });
});

describe('telemetry show', () => {
  it('emits eventCount=0 when no log exists', () => {
    runTelemetryShow({ json: true });
    const json = JSON.parse(captured.join('')) as {
      ok: boolean;
      data: { eventCount: number; events: unknown[] };
    };
    expect(json.ok).toBe(true);
    expect(json.data.eventCount).toBe(0);
    expect(json.data.events).toEqual([]);
  });

  it('parses and returns events from the log', () => {
    // First persist prefs (enabled) so the log path is valid.
    writeTelemetryPrefs({
      enabled: true,
      installed: '2026-01-01T00:00:00.000Z',
      sink: 'log',
    });
    mkdirSync(workHome, { recursive: true });
    const logPath = telemetryLogPath();
    writeFileSync(
      logPath,
      JSON.stringify({ event: 'init', flintVersion: '1.0.0', os: 'linux', node: '20', ts: '2026-01-01T00:00:00.000Z' }) +
        '\n' +
        JSON.stringify({ event: 'deploy', flintVersion: '1.0.0', os: 'linux', node: '20', ts: '2026-01-01T00:00:01.000Z' }) +
        '\n',
    );

    runTelemetryShow({ json: true });
    const json = JSON.parse(captured.join('')) as {
      data: { eventCount: number; events: Array<{ event: string }> };
    };
    expect(json.data.eventCount).toBe(2);
    expect(json.data.events[0]?.event).toBe('init');
    expect(json.data.events[1]?.event).toBe('deploy');
  });

  it('exposes the prefs + log path in the result', () => {
    runTelemetryShow({ json: true });
    const json = JSON.parse(captured.join('')) as {
      data: { logPath: string; prefsPath: string };
    };
    expect(json.data.logPath).toBe(telemetryLogPath());
    expect(json.data.prefsPath).toBe(telemetryPath());
  });
});

describe('telemetry purge', () => {
  it('reports purged=false when no log exists', () => {
    runTelemetryPurge({ json: true });
    const json = JSON.parse(captured.join('')) as {
      data: { purged: boolean; priorBytes: number };
    };
    expect(json.data.purged).toBe(false);
    expect(json.data.priorBytes).toBe(0);
  });

  it('deletes the log file and returns prior size when one exists', () => {
    writeTelemetryPrefs({ enabled: true, installed: '2026-01-01T00:00:00.000Z', sink: 'log' });
    const logPath = telemetryLogPath();
    writeFileSync(logPath, '{"event":"x"}\n');
    expect(existsSync(logPath)).toBe(true);

    runTelemetryPurge({ json: true });
    const json = JSON.parse(captured.join('')) as {
      data: { purged: boolean; priorBytes: number };
    };
    expect(json.data.purged).toBe(true);
    expect(json.data.priorBytes).toBeGreaterThan(0);
    expect(existsSync(logPath)).toBe(false);
  });
});

describe('telemetry export', () => {
  it('refuses to export when no log exists', () => {
    const outPath = join(workHome, 'export.log');
    runTelemetryExport({ outPath, json: true });
    const json = JSON.parse(captured.join('')) as {
      data: { copied: boolean };
    };
    expect(json.data.copied).toBe(false);
    expect(existsSync(outPath)).toBe(false);
  });

  it('copies the log to the destination', () => {
    writeTelemetryPrefs({ enabled: true, installed: '2026-01-01T00:00:00.000Z', sink: 'log' });
    const logPath = telemetryLogPath();
    writeFileSync(logPath, '{"event":"init"}\n');

    const outPath = join(workHome, 'exported.log');
    runTelemetryExport({ outPath, json: true });
    expect(existsSync(outPath)).toBe(true);
    expect(readFileSync(outPath, 'utf8')).toBe('{"event":"init"}\n');
  });

  it('refuses to overwrite without --force', () => {
    writeTelemetryPrefs({ enabled: true, installed: '2026-01-01T00:00:00.000Z', sink: 'log' });
    writeFileSync(telemetryLogPath(), '{"event":"x"}\n');

    const outPath = join(workHome, 'existing.log');
    writeFileSync(outPath, 'pre-existing');

    runTelemetryExport({ outPath, json: true });
    const json = JSON.parse(captured.join('')) as { data: { copied: boolean } };
    expect(json.data.copied).toBe(false);
    expect(readFileSync(outPath, 'utf8')).toBe('pre-existing');
  });

  it('overwrites with --force', () => {
    writeTelemetryPrefs({ enabled: true, installed: '2026-01-01T00:00:00.000Z', sink: 'log' });
    writeFileSync(telemetryLogPath(), 'NEW\n');

    const outPath = join(workHome, 'existing.log');
    writeFileSync(outPath, 'pre-existing');

    runTelemetryExport({ outPath, force: true, json: true });
    expect(readFileSync(outPath, 'utf8')).toBe('NEW\n');
  });
});
