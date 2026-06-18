// Shared tree-stamping primitives for scaffolders.
//
// `flint init` and `flint create-app` each carry a private `collectFiles` +
// `writeTemplateFile` pair (kept inline there so their byte-for-byte behaviour
// is obvious and unchanged). The pack scaffolder needs the SAME mechanics —
// walk a template tree, strip `.tmpl` suffixes, rename `gitignore` →
// `.gitignore`, render `.tmpl` files through the substitution engine and copy
// everything else verbatim — so we factor those mechanics here for the new
// code path to reuse rather than re-implement a third time.
//
// This module is intentionally a faithful extraction of the create-app helpers
// (same path-mapping rules, same POSIX-separator handling). It does NOT change
// the existing commands; they keep their inline copies.

import { mkdirSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { renderFile, type TemplateVars } from './template.js';
import { writeFileAtomic } from './atomic-write.js';

export interface PlannedFile {
  /** Absolute path to the template source on disk. */
  src: string;
  /** Path relative to the project root where the file should be written. */
  dest: string;
}

/**
 * Walk a template tree and produce the list of files to write. Path mapping:
 *   - Files ending in `.tmpl` lose that suffix in the output.
 *   - A top-level `gitignore` (no leading dot — npm strips dotfiles from
 *     published packages) becomes `.gitignore`.
 * POSIX separators are used on the relative path so the manifest stays `/`-only.
 */
export function collectFiles(templateRoot: string): PlannedFile[] {
  const planned: PlannedFile[] = [];
  walk(templateRoot, '');
  return planned;

  function walk(absDir: string, relDir: string): void {
    for (const entry of readdirSync(absDir)) {
      const abs = join(absDir, entry);
      const rel = relDir ? `${relDir}/${entry}` : entry;
      const stat = statSync(abs);
      if (stat.isDirectory()) {
        walk(abs, rel);
        continue;
      }
      let destRel = rel;
      if (destRel.endsWith('.tmpl')) destRel = destRel.slice(0, -'.tmpl'.length);
      if (destRel === 'gitignore') destRel = '.gitignore';
      planned.push({ src: abs, dest: destRel });
    }
  }
}

/**
 * Write a single planned file into `target`, rendering `.tmpl` files through
 * the substitution engine and copying everything else byte-for-byte. Returns
 * the contents written (so the caller can record them into the manifest).
 */
export function writeTemplateFile(
  file: PlannedFile,
  target: string,
  vars: TemplateVars,
): string {
  const destPath = join(target, file.dest);
  let contents: string;
  if (file.src.endsWith('.tmpl')) {
    contents = renderFile(file.src, vars);
  } else {
    contents = readFileSync(file.src, 'utf8');
  }
  mkdirSync(dirname(destPath), { recursive: true });
  writeFileAtomic(destPath, contents);
  return contents;
}

/** Compute a POSIX-separator relative path of `fileAbs` under `rootAbs`. */
export function relPosix(rootAbs: string, fileAbs: string): string {
  return fileAbs.slice(rootAbs.length + 1).split(/[\\/]/).join('/');
}
