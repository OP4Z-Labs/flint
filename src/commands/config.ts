// `flint config` — read or change Flint global preferences.
//
// v0.9 scope is intentionally tiny: toggle telemetry on/off. v1.0 may extend
// with default-variant, default-branch, asset-budget overrides, etc. The
// shape `flint config --<key> <value>` is the contract.

import { log } from '../util/logger.js';
import {
  readTelemetryPrefs,
  setTelemetryEnabled,
  telemetryLogPath,
  telemetryPath,
} from '../util/telemetry.js';

export interface ConfigOptions {
  /** "on" / "off" — set telemetry preference. */
  telemetry?: string;
  /** Print the current settings. */
  show?: boolean;
}

export async function runConfig(opts: ConfigOptions): Promise<void> {
  if (opts.telemetry !== undefined) {
    const value = opts.telemetry.toLowerCase().trim();
    if (value !== 'on' && value !== 'off') {
      throw new Error(`--telemetry must be "on" or "off" (got "${opts.telemetry}").`);
    }
    const prefs = setTelemetryEnabled(value === 'on');
    log.ok(`Telemetry ${prefs.enabled ? 'ENABLED' : 'DISABLED'}.`);
    log.dim(`  Preferences: ${telemetryPath()}`);
    if (prefs.enabled) {
      log.dim(`  Local log:   ${telemetryLogPath()}`);
      log.dim('  v0.9 emits to a local log only — no remote endpoint yet.');
    }
    return;
  }

  // Default: show current state.
  const t = readTelemetryPrefs();
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
