// Path helpers — kept in one place so tests can stub HOME via env without
// having to thread overrides through every call site. The CLI honors
// the `FLINT_CONFIG_HOME` env var for tests/CI, falling back to
// `XDG_CONFIG_HOME` or `~/.config` per the XDG basedir spec.

import { homedir } from 'node:os';
import { join } from 'node:path';

const CONFIG_DIR_NAME = 'flint';

/** Root directory for Flint's cross-repo state (credentials, rotation history). */
export function flintConfigDir(): string {
  if (process.env.FLINT_CONFIG_HOME) {
    return process.env.FLINT_CONFIG_HOME;
  }
  const xdg = process.env.XDG_CONFIG_HOME;
  const base = xdg && xdg.length > 0 ? xdg : join(homedir(), '.config');
  return join(base, CONFIG_DIR_NAME);
}

/** Path to the active credentials JSON file. Mode 0600 on write. */
export function credentialsPath(): string {
  return join(flintConfigDir(), 'credentials');
}

/** Path to a per-rotation snapshot directory; one file per rotation event. */
export function rotatedCredentialsDir(): string {
  return join(flintConfigDir(), 'credentials.rotated');
}

/** Filename of the per-repo wrangler env file. Single source of truth. */
export const DEV_VARS_FILENAME = '.dev.vars';

/** Filename of the per-repo wrangler env example file. */
export const DEV_VARS_EXAMPLE_FILENAME = '.dev.vars.example';
