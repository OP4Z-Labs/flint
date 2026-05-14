// Helpers for redirecting Flint's config home into a sandbox directory
// during tests. Avoids touching the developer's real
// ~/.config/flint/credentials.

import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

export interface TempHome {
  dir: string;
  cleanup: () => void;
}

export function setupTempHome(): TempHome {
  const dir = mkdtempSync(join(tmpdir(), 'flint-test-'));
  process.env.FLINT_CONFIG_HOME = dir;
  return {
    dir,
    cleanup: () => {
      delete process.env.FLINT_CONFIG_HOME;
      rmSync(dir, { recursive: true, force: true });
    },
  };
}
