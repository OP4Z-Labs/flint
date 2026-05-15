// Opt-in telemetry (v0.9 first ship — local log only).
//
// Plan §1 locked decision: off by default, prompted on first invocation,
// minimal anonymous events. v0.9 emits events to a LOCAL log file or
// stdout in dev — NO remote endpoint. v1.0 will pick a backend.
//
// Event shape (PUBLIC API once shipped — users will script against this):
//
//   {
//     "event":      "init",                // command run (no args)
//     "variant":    "pages-fullstack",     // for init / create-app
//     "errorType":  "ENOENT",              // only on error; never the message
//     "flintVersion": "0.9.0",
//     "os":         "linux" | "darwin" | "win32",
//     "node":       "20",                  // major only — minor not useful
//     "ts":         "2026-05-14T20:00:00.000Z"
//   }
//
// Fields are deliberately spartan. Things explicitly NOT collected:
//   - project paths, file names, command args, env vars
//   - token info, user identifiers, machine ids
//   - command output / error messages (only the error TYPE / code)
//
// First-run flow:
//   - On first CLI invocation, check ~/.config/flint/telemetry.json
//   - If absent, prompt: "Help improve Flint? (y/N)" defaulting to no
//   - Write the preference. The "installed" timestamp lives there forever
//     (anonymous; not a user id, but lets us reason about first-run UX
//     improvements over time in v1.0).
//   - Re-prompt is never offered — the user changes it via `flint config
//     --telemetry on|off`.

import { existsSync, mkdirSync, readFileSync, writeFileSync, appendFileSync } from 'node:fs';
import { join } from 'node:path';
import { flintConfigDir } from './paths.js';
import { readPackageVersion } from './version.js';

const TELEMETRY_FILE = 'telemetry.json';
const TELEMETRY_LOG = 'telemetry.log';

export interface TelemetryPrefs {
  enabled: boolean;
  installed: string; // ISO timestamp of first prompt/decision
  /** Where to emit when enabled. v0.9 supports "log" (local file) and "stdout" (dev). */
  sink: 'log' | 'stdout';
}

export function telemetryPath(): string {
  return join(flintConfigDir(), TELEMETRY_FILE);
}

export function telemetryLogPath(): string {
  return join(flintConfigDir(), TELEMETRY_LOG);
}

/** Read the current telemetry preference. Null when never set (= first run). */
export function readTelemetryPrefs(): TelemetryPrefs | null {
  const path = telemetryPath();
  if (!existsSync(path)) return null;
  try {
    const parsed = JSON.parse(readFileSync(path, 'utf8')) as Partial<TelemetryPrefs>;
    if (typeof parsed.enabled !== 'boolean' || typeof parsed.installed !== 'string') {
      return null;
    }
    return {
      enabled: parsed.enabled,
      installed: parsed.installed,
      sink: parsed.sink === 'stdout' ? 'stdout' : 'log',
    };
  } catch {
    return null;
  }
}

/** Persist telemetry preferences atomically. Creates config dir as needed. */
export function writeTelemetryPrefs(prefs: TelemetryPrefs): void {
  const dir = flintConfigDir();
  if (!existsSync(dir)) {
    mkdirSync(dir, { recursive: true, mode: 0o700 });
  }
  writeFileSync(
    telemetryPath(),
    JSON.stringify(prefs, null, 2) + '\n',
    { encoding: 'utf8', mode: 0o600 },
  );
}

export interface TelemetryEvent {
  /** Command/subcommand identifier. */
  event: string;
  /** Variant chosen (init / create-app only). */
  variant?: string;
  /** Error type/code, never the message. */
  errorType?: string;
  /** Extra non-PII context (small set of keys per event type). */
  context?: Record<string, string | number | boolean>;
}

/**
 * Build the canonical wire shape for an event. Pure function — no I/O. Made
 * exportable so tests can lock the shape.
 */
export function buildEventPayload(input: TelemetryEvent): Record<string, unknown> {
  const node = process.versions.node.split('.')[0];
  return {
    event: input.event,
    ...(input.variant !== undefined ? { variant: input.variant } : {}),
    ...(input.errorType !== undefined ? { errorType: input.errorType } : {}),
    ...(input.context !== undefined ? { context: input.context } : {}),
    flintVersion: readPackageVersion(),
    os: process.platform,
    node,
    ts: new Date().toISOString(),
  };
}

/**
 * Emit an event if telemetry is enabled. No-op when disabled or unconfigured.
 * Errors are swallowed — telemetry must never break user commands.
 */
export function emitEvent(input: TelemetryEvent): void {
  try {
    const prefs = readTelemetryPrefs();
    if (!prefs || !prefs.enabled) return;
    const payload = buildEventPayload(input);
    const line = JSON.stringify(payload) + '\n';
    if (prefs.sink === 'stdout') {
      process.stdout.write(`telemetry: ${line}`);
      return;
    }
    appendFileSync(telemetryLogPath(), line, { encoding: 'utf8', mode: 0o600 });
  } catch {
    // never throw
  }
}

/**
 * If no telemetry preference exists yet, prompt the user once and persist
 * their decision. Returns the resulting preference. Idempotent — second
 * call with an existing pref just returns it.
 *
 * Skipped silently when stdin is not a TTY (CI / piped invocations) — we
 * persist `enabled: false` so subsequent runs don't keep asking.
 */
export async function ensureTelemetryConsent(): Promise<TelemetryPrefs> {
  const existing = readTelemetryPrefs();
  if (existing) return existing;
  const prefs: TelemetryPrefs = {
    enabled: false,
    installed: new Date().toISOString(),
    sink: 'log',
  };

  // Don't prompt in non-interactive contexts. Just persist "disabled" so we
  // never bother the user again unprompted.
  if (!process.stdin.isTTY) {
    writeTelemetryPrefs(prefs);
    return prefs;
  }
  if (process.env.FLINT_TELEMETRY_NO_PROMPT === '1') {
    writeTelemetryPrefs(prefs);
    return prefs;
  }

  const { confirm } = await import('@inquirer/prompts');
  let enabled = false;
  try {
    enabled = await confirm({
      message: 'Help improve Flint by sharing anonymous usage stats? (no project info, no token info)',
      default: false,
    });
  } catch {
    // Ctrl-C or no-tty edge — default off.
    enabled = false;
  }
  prefs.enabled = enabled;
  writeTelemetryPrefs(prefs);
  return prefs;
}

/** Toggle telemetry preference; used by `flint config --telemetry on|off`. */
export function setTelemetryEnabled(enabled: boolean): TelemetryPrefs {
  const existing =
    readTelemetryPrefs() ?? {
      enabled: false,
      installed: new Date().toISOString(),
      sink: 'log' as const,
    };
  const next: TelemetryPrefs = { ...existing, enabled };
  writeTelemetryPrefs(next);
  return next;
}
