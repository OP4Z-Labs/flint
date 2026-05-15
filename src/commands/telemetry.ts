// `flint telemetry` — transparency commands.
//
// v0.9 introduced the local telemetry log as an opt-in default-off feature.
// v1.0 adds the user-facing transparency surface the brief calls for:
//
//   - `flint telemetry show`           dump the current event log
//   - `flint telemetry purge`          delete it
//   - `flint telemetry export <file>`  copy it to a file at <path>
//
// These commands work even when telemetry is DISABLED — the log may exist
// from a previous enabled session, and the user has a right to inspect /
// remove it regardless.

import { existsSync, readFileSync, rmSync, copyFileSync, statSync } from 'node:fs';
import { log } from '../util/logger.js';
import { telemetryLogPath, telemetryPath, readTelemetryPrefs } from '../util/telemetry.js';
import { formatResult, ok } from '../util/format-result.js';

export interface TelemetryCmdOptions {
  /** Emit a structured JSON result on stdout instead of human output. */
  json?: boolean;
}

export interface TelemetryExportOptions extends TelemetryCmdOptions {
  /** Destination file path. */
  outPath: string;
  /** Overwrite the destination if it already exists. */
  force?: boolean;
}

/** `flint telemetry show` — print the current local event log to stdout. */
export function runTelemetryShow(opts: TelemetryCmdOptions = {}): void {
  const json = opts.json === true;
  const logPath = telemetryLogPath();
  const prefs = readTelemetryPrefs();

  if (!existsSync(logPath)) {
    if (!json) {
      log.info('(no telemetry events recorded)');
      log.dim(`Log path: ${logPath}`);
      log.dim(`Prefs:    ${telemetryPath()}  (telemetry ${prefs?.enabled ? 'enabled' : 'disabled'})`);
    }
    formatResult(
      ok('telemetry show', {
        logPath,
        prefsPath: telemetryPath(),
        enabled: prefs?.enabled ?? null,
        eventCount: 0,
        events: [],
      }),
      { json },
    );
    return;
  }

  const raw = readFileSync(logPath, 'utf8');
  const lines = raw.split('\n').filter((l) => l.trim().length > 0);
  const events: unknown[] = [];
  for (const line of lines) {
    try {
      events.push(JSON.parse(line) as unknown);
    } catch {
      // Skip malformed lines (should never happen in practice, but a defensive
      // read protects against a partial write that escaped the atomic helper
      // for whatever reason).
    }
  }

  if (!json) {
    log.heading(`Telemetry events (${events.length})`);
    log.dim(`  Log path: ${logPath}`);
    log.dim(`  Prefs:    ${telemetryPath()}  (telemetry ${prefs?.enabled ? 'enabled' : 'disabled'})`);
    log.blank();
    for (const ev of events) {
      log.info(JSON.stringify(ev));
    }
  }

  formatResult(
    ok('telemetry show', {
      logPath,
      prefsPath: telemetryPath(),
      enabled: prefs?.enabled ?? null,
      eventCount: events.length,
      events,
    }),
    { json },
  );
}

/** `flint telemetry purge` — delete the local event log. */
export function runTelemetryPurge(opts: TelemetryCmdOptions = {}): void {
  const json = opts.json === true;
  const logPath = telemetryLogPath();
  let purged = false;
  let priorSize = 0;
  if (existsSync(logPath)) {
    try {
      priorSize = statSync(logPath).size;
    } catch {
      priorSize = 0;
    }
    rmSync(logPath, { force: true });
    purged = true;
    if (!json) log.ok(`Purged ${logPath} (${priorSize} bytes).`);
  } else {
    if (!json) log.info('(nothing to purge — no telemetry log exists)');
  }

  formatResult(
    ok('telemetry purge', { logPath, purged, priorBytes: priorSize }),
    { json },
  );
}

/** `flint telemetry export <file>` — copy the event log to <file>. */
export function runTelemetryExport(opts: TelemetryExportOptions): void {
  const json = opts.json === true;
  const logPath = telemetryLogPath();
  if (!existsSync(logPath)) {
    if (!json) log.err(`[flint] telemetry export: no log to export at ${logPath} — enable telemetry and run a few commands first.`);
    formatResult(
      ok('telemetry export', { source: logPath, destination: opts.outPath, copied: false }),
      { json },
    );
    process.exitCode = 1;
    return;
  }
  if (existsSync(opts.outPath) && opts.force !== true) {
    if (!json) log.err(`[flint] telemetry export: ${opts.outPath} already exists — pass --force to overwrite.`);
    formatResult(
      ok('telemetry export', { source: logPath, destination: opts.outPath, copied: false }),
      { json },
    );
    process.exitCode = 1;
    return;
  }
  copyFileSync(logPath, opts.outPath);
  if (!json) log.ok(`Exported telemetry log to ${opts.outPath}.`);
  formatResult(
    ok('telemetry export', { source: logPath, destination: opts.outPath, copied: true }),
    { json },
  );
}
