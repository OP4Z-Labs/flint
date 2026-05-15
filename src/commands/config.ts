// `flint config` — read or change Flint global preferences.
//
// v0.9 scope was intentionally tiny: toggle telemetry on/off. v1.0 adds the
// `--json` envelope so scripted callers (CI, monorepo tooling) can read the
// settings programmatically.

import { log } from '../util/logger.js';
import {
  readTelemetryPrefs,
  setTelemetryEnabled,
  telemetryLogPath,
  telemetryPath,
} from '../util/telemetry.js';
import { formatResult, ok } from '../util/format-result.js';

export interface ConfigOptions {
  /** "on" / "off" — set telemetry preference. */
  telemetry?: string;
  /** Print the current settings. */
  show?: boolean;
  /** Emit a structured JSON result on stdout instead of human output. */
  json?: boolean;
}

interface ConfigData {
  telemetry: {
    enabled: boolean | null;
    sink: 'log' | 'stdout' | null;
    prefsPath: string;
    logPath: string | null;
  };
}

export async function runConfig(opts: ConfigOptions): Promise<void> {
  const json = opts.json === true;

  if (opts.telemetry !== undefined) {
    const value = opts.telemetry.toLowerCase().trim();
    if (value !== 'on' && value !== 'off') {
      throw new Error(
        `[flint] config: --telemetry must be "on" or "off" (got "${opts.telemetry}") — pass --telemetry on or --telemetry off.`,
      );
    }
    const prefs = setTelemetryEnabled(value === 'on');
    if (!json) {
      log.ok(`Telemetry ${prefs.enabled ? 'ENABLED' : 'DISABLED'}.`);
      log.dim(`  Preferences: ${telemetryPath()}`);
      if (prefs.enabled) {
        log.dim(`  Local log:   ${telemetryLogPath()}`);
        log.dim('  Emits to a local log only by default — set --telemetry-endpoint <url> for remote.');
      }
    }
    formatResult(
      ok<ConfigData>('config', {
        telemetry: {
          enabled: prefs.enabled,
          sink: prefs.sink,
          prefsPath: telemetryPath(),
          logPath: prefs.enabled ? telemetryLogPath() : null,
        },
      }),
      { json },
    );
    return;
  }

  // Default: show current state.
  const t = readTelemetryPrefs();
  if (!json) {
    log.heading('Flint configuration');
    if (t) {
      log.info(`  telemetry: ${t.enabled ? 'on' : 'off'}  (sink: ${t.sink})`);
      log.dim(`    file: ${telemetryPath()}`);
      if (t.enabled) log.dim(`    log:  ${telemetryLogPath()}`);
    } else {
      log.info('  telemetry: (not yet decided — first run will prompt)');
    }
    if (opts.show !== true) {
      log.blank();
      log.dim('Usage: flint config --telemetry on|off');
    }
  }
  formatResult(
    ok<ConfigData>('config', {
      telemetry: {
        enabled: t?.enabled ?? null,
        sink: t?.sink ?? null,
        prefsPath: telemetryPath(),
        logPath: t?.enabled ? telemetryLogPath() : null,
      },
    }),
    { json },
  );
}
