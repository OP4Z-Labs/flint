// Resolve the package version at runtime by reading the bundled package.json.
// Done at runtime (not import-time JSON import) because `resolveJsonModule`
// + `NodeNext` would require an `assert { type: 'json' }` and we want the
// source to stay portable across TS versions.

import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const FALLBACK_VERSION = '0.0.0-dev';

export function readPackageVersion(): string {
  try {
    // dist/util/version.js → ../../package.json
    const here = dirname(fileURLToPath(import.meta.url));
    const pkgPath = resolve(here, '..', '..', 'package.json');
    const raw = readFileSync(pkgPath, 'utf8');
    const parsed = JSON.parse(raw) as { version?: string };
    return parsed.version ?? FALLBACK_VERSION;
  } catch {
    return FALLBACK_VERSION;
  }
}
