// Pack-aware re-render seam for `flint upgrade --pack <dir>`.
//
// Background: files scaffolded by `flint create-app --pack <dir>` are recorded
// in the manifest with a `templateSource` of the form
//
//     pack:<packName>/<label>/<relPathWithinTree>
//
// where <label> is `core:<from>` (for a core[] tree) or `template:<id>` (for the
// chosen template tree) — see create-app-pack.ts `stampTree`. The built-in
// upgrade path (`renderTemplateContent` in upgrade.ts) only knows how to
// re-render Flint's BUNDLED `templates/<...>` trees; for a `pack:` source it
// resolves to a nonexistent bundled path and returns null, so the file is
// skipped. That means `flint upgrade` could never propagate a fix made upstream
// in the PACK into an already-generated site — the headline "stamp, don't
// depend; upgrade keeps sites current" promise was false for pack-stamped files
// (i.e. every file in a Client-Site-Kit site).
//
// This module closes that gap WITHOUT touching the built-in path. It rebuilds —
// from the CURRENT pack on disk — the exact `templateSource → rendered content`
// map that `create-app --pack` would produce today, keyed by the SAME
// templateSource strings the original scaffold recorded. `flint upgrade --pack`
// then resolves a manifest entry's `templateSource` against this map and feeds
// the result straight into the existing classify / diff / 3-way-merge machinery
// — so all of the user-edit-preservation logic (unmodified→auto-update,
// modified→keep/take-new/merge/eject) works for pack files identically to
// built-in ones.
//
// We rebuild the full map (rather than reverse-parsing each templateSource back
// to a path) so rendering is byte-identical to the scaffolder: same
// collectFiles walk, same `.tmpl`/gitignore mapping, same default test-excludes,
// same renderer, same injected `flintVersion`. A packName containing a `/`
// (e.g. `@op4z/csk`) makes string reverse-parsing ambiguous; map-keying sidesteps
// that entirely.

import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { loadPack, type Pack } from './pack.js';
import { collectFiles, relPosix, type PlannedFile } from './scaffold.js';
import { renderFile, type TemplateVars } from './template.js';
import { readFileSync } from 'node:fs';
import { readPackageVersion } from './version.js';

/**
 * Mirror of create-app-pack.ts DEFAULT_STAMP_EXCLUDES. Kept in sync so the
 * upgrade re-render walks exactly the same file set the scaffolder did (test /
 * spec / build-artifact files are never stamped into a site, so they must never
 * be offered as upgrades either).
 */
const DEFAULT_STAMP_EXCLUDES = [
  '**/*.test.ts',
  '**/*.test.tsx',
  '**/*.spec.ts',
  '**/*.spec.tsx',
  '**/__tests__/**',
  '**/*.tsbuildinfo',
];

/**
 * Resolves a manifest `templateSource` to the content the CURRENT pack would
 * stamp for it. Returns null for any source the pack no longer provides (file
 * removed/renamed upstream) or any non-pack source (built-in / git+ — those are
 * handled by the built-in path, not here).
 */
export interface PackRenderResolver {
  /** The loaded pack (for messaging — name/version). */
  readonly pack: Pack;
  /** Map a recorded templateSource → current rendered content, or null. */
  resolve(templateSource: string): string | null;
  /** Every templateSource the current pack provides (for "new file" detection). */
  readonly sources: ReadonlySet<string>;
}

/**
 * Build a {@link PackRenderResolver} from a pack directory + the vars persisted
 * in the manifest. Throws (via loadPack) if the dir isn't a valid pack — the
 * caller surfaces that as a clean CLI error.
 *
 * `flintVersion` is injected (overriding any persisted value) so generated-by
 * headers reflect the upgrading version, exactly as the built-in
 * `renderTemplateContent` does.
 */
export function buildPackResolver(
  packDir: string,
  vars: Record<string, string>,
): PackRenderResolver {
  const pack = loadPack(packDir);
  const renderVars: TemplateVars = { ...vars, flintVersion: readPackageVersion() };

  // templateSource → absolute source path on disk (keeps `.tmpl` suffix).
  const sourceToFile = new Map<string, string>();

  for (const entry of pack.core) {
    indexTree(pack, entry.from, entry.exclude, `core:${entry.from}`, sourceToFile);
  }
  for (const template of pack.templates) {
    indexTree(pack, template.path, [], `template:${template.id}`, sourceToFile);
  }

  return {
    pack,
    sources: new Set(sourceToFile.keys()),
    resolve(templateSource: string): string | null {
      if (!templateSource.startsWith('pack:')) return null;
      const src = sourceToFile.get(templateSource);
      if (src === undefined) return null;
      if (!existsSync(src)) return null;
      if (src.endsWith('.tmpl')) return renderFile(src, renderVars);
      return readFileSync(src, 'utf8');
    },
  };
}

/**
 * Walk one pack tree and record `templateSource → absolute source path` for
 * every file, using the SAME label + relPosix convention create-app-pack's
 * `stampTree` uses to MINT the templateSource. This guarantees the keys here
 * match the strings recorded in the manifest at scaffold time.
 */
function indexTree(
  pack: Pack,
  fromRel: string,
  exclude: string[],
  sourceLabel: string,
  out: Map<string, string>,
): void {
  const root = join(pack.rootDir, fromRel);
  if (!existsSync(root)) return; // tree removed upstream — its files resolve to null
  const files: PlannedFile[] = collectFiles(root, [...DEFAULT_STAMP_EXCLUDES, ...exclude]);
  for (const file of files) {
    const templateSource = `pack:${pack.name}/${sourceLabel}/${relPosix(root, file.src)}`;
    out.set(templateSource, file.src);
  }
}
