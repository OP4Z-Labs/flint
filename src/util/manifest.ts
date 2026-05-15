// `flint.manifest.json` — forensic state tracking for every file Flint generates.
//
// This is SEPARATE from `flint.config.json`:
//   - `flint.config.json` is USER-editable preferences (asset budget thresholds,
//     telemetry opt-in, etc.). Edited by humans, read by Flint.
//   - `flint.manifest.json` is FLINT-managed forensic state. Edited only by
//     Flint itself, never by humans. Records what was generated and when, so
//     `flint upgrade` can detect drift between the user's current files and
//     the template they were generated from.
//
// Schema (load-bearing for v1.0 rescaffold work — see HANDOFF):
//
//   {
//     "$schema": "https://flint.op4z.dev/manifest.schema.v1.json",
//     "version": 1,
//     "flintVersion": "0.9.0",              // version that LAST WROTE this manifest
//     "createdAt": "2026-05-14T19:00:00.000Z",
//     "updatedAt": "2026-05-14T19:00:00.000Z",
//     "variant": "pages-fullstack",         // tier the project was scaffolded from
//     "history": [                          // every upgrade/init/add invocation
//       { "command": "init",         "flintVersion": "0.5.0", "at": "...", "files": 14 },
//       { "command": "create-app",   "flintVersion": "0.5.0", "at": "...", "files": 28 },
//       { "command": "add pwa",      "flintVersion": "0.9.0", "at": "...", "files": 2  },
//       { "command": "upgrade",      "flintVersion": "0.9.0", "at": "...", "files": 5  }
//     ],
//     "files": {
//       "wrangler.toml": {
//         "templateVersion": "0.9.0",       // version that GENERATED this file
//         "templateSource":  "pages-fullstack/wrangler.toml.tmpl",
//         "sha256":          "<hex>",       // sha of CONTENT AT GENERATION TIME
//         "modified":        false,         // recomputed at upgrade time
//         "ejected":         false          // user opted out of upgrades; always skip
//       },
//       ...
//     }
//   }
//
// File-state taxonomy (used by `flint upgrade --check`):
//   - "unmodified" — current sha256 matches recorded sha256 → safe to auto-update
//   - "modified"   — current sha256 differs → present 3-way merge in --apply
//   - "ejected"    — manifest entry has ejected: true → always skip
//   - "missing"    — manifest has entry but file is gone → ask to restore or remove
//
// Backfill: if `flint upgrade` runs in a project with NO manifest (because it
// was scaffolded by v0.5 or earlier), `backfillManifest()` generates one from
// the current file state, with EVERY entry flagged modified:true. This is
// deliberately conservative — we never overwrite a user's file without consent.

import {
  existsSync,
  readFileSync,
  renameSync,
  writeFileSync,
} from 'node:fs';
import { createHash } from 'node:crypto';
import { join } from 'node:path';

export const MANIFEST_FILENAME = 'flint.manifest.json';
export const MANIFEST_SCHEMA_VERSION = 1;
export const MANIFEST_SCHEMA_URL =
  'https://flint.op4z.dev/manifest.schema.v1.json';

export interface ManifestFileEntry {
  /** The Flint version that generated this file. */
  templateVersion: string;
  /** Relative path within `templates/` that this file was sourced from. */
  templateSource: string;
  /** sha256 of the file's contents at the moment Flint wrote it. */
  sha256: string;
  /**
   * True if the file has been modified since Flint wrote it. Recomputed at
   * upgrade time by comparing the file's current sha256 against this entry's
   * sha256. Persisted to disk between runs as a fast-path cache.
   */
  modified: boolean;
  /**
   * True if the user opted out of Flint upgrades for this file (via the
   * 3-way merge "eject" choice). Ejected files are always skipped by
   * `flint upgrade --apply`.
   */
  ejected: boolean;
}

export interface ManifestHistoryEntry {
  /** Subcommand that ran (e.g. "init", "create-app", "add pwa", "upgrade"). */
  command: string;
  /** Flint version at the time of the invocation. */
  flintVersion: string;
  /** ISO 8601 timestamp. */
  at: string;
  /** Number of files this invocation wrote / updated in the manifest. */
  files: number;
}

export interface Manifest {
  $schema: string;
  version: number;
  flintVersion: string;
  createdAt: string;
  updatedAt: string;
  /** The variant the project was scaffolded from. */
  variant: string;
  /**
   * Template variables used at scaffold time (appName, compatDate, cookieName,
   * tokenMessage, etc.). Persisted so `flint upgrade` can re-render the
   * current bundled template against the SAME vars the original scaffold used,
   * and produce a meaningful diff. Missing pre-v0.9 manifests will not have
   * this; upgrade backfills it from the project's wrangler.toml.
   */
  vars: Record<string, string>;
  history: ManifestHistoryEntry[];
  files: Record<string, ManifestFileEntry>;
}

/** sha256 of a UTF-8 string, returned as lowercase hex. */
export function sha256OfString(input: string): string {
  return createHash('sha256').update(input, 'utf8').digest('hex');
}

/** sha256 of a file's contents on disk. Returns null if the file is missing. */
export function sha256OfFile(absPath: string): string | null {
  if (!existsSync(absPath)) return null;
  const raw = readFileSync(absPath);
  return createHash('sha256').update(raw).digest('hex');
}

/** Absolute path to the manifest file inside a project root. */
export function manifestPath(projectRoot: string): string {
  return join(projectRoot, MANIFEST_FILENAME);
}

/** Read the manifest if it exists; return null otherwise. */
export function readManifest(projectRoot: string): Manifest | null {
  const path = manifestPath(projectRoot);
  if (!existsSync(path)) return null;
  try {
    const parsed = JSON.parse(readFileSync(path, 'utf8')) as Partial<Manifest>;
    if (parsed.version !== MANIFEST_SCHEMA_VERSION) return null;
    if (
      typeof parsed.flintVersion !== 'string' ||
      typeof parsed.createdAt !== 'string' ||
      typeof parsed.updatedAt !== 'string' ||
      typeof parsed.variant !== 'string' ||
      !parsed.files ||
      typeof parsed.files !== 'object'
    ) {
      return null;
    }
    return {
      $schema: parsed.$schema ?? MANIFEST_SCHEMA_URL,
      version: parsed.version,
      flintVersion: parsed.flintVersion,
      createdAt: parsed.createdAt,
      updatedAt: parsed.updatedAt,
      variant: parsed.variant,
      vars: parsed.vars ?? {},
      history: Array.isArray(parsed.history) ? parsed.history : [],
      files: parsed.files,
    };
  } catch {
    return null;
  }
}

/** Persist the manifest atomically (write-then-rename). */
export function writeManifest(projectRoot: string, manifest: Manifest): string {
  const path = manifestPath(projectRoot);
  const tmp = `${path}.tmp`;
  writeFileSync(
    tmp,
    JSON.stringify(manifest, null, 2) + '\n',
    'utf8',
  );
  renameSync(tmp, path);
  return path;
}

export interface CreateManifestOptions {
  flintVersion: string;
  variant: string;
  vars?: Record<string, string>;
}

/** Construct a fresh, empty manifest. */
export function createEmptyManifest(opts: CreateManifestOptions): Manifest {
  const now = new Date().toISOString();
  return {
    $schema: MANIFEST_SCHEMA_URL,
    version: MANIFEST_SCHEMA_VERSION,
    flintVersion: opts.flintVersion,
    createdAt: now,
    updatedAt: now,
    variant: opts.variant,
    vars: opts.vars ?? {},
    history: [],
    files: {},
  };
}

export interface RecordFileOptions {
  /** Relative path from project root. POSIX separators. */
  relPath: string;
  /** Relative path within `templates/` that this file was sourced from. */
  templateSource: string;
  /** Flint version writing the file. */
  flintVersion: string;
  /** Final file contents written to disk. */
  contents: string;
}

/**
 * Record a single generated file into the manifest. Existing entries for
 * the same path are overwritten; an `ejected: true` entry is preserved.
 */
export function recordFile(manifest: Manifest, opts: RecordFileOptions): void {
  const prior = manifest.files[opts.relPath];
  // Once a file is ejected, the user has explicitly chosen "stop managing
  // this." Flint must never silently re-claim it on a subsequent write.
  // We DO update the sha256 (the user's content changed) but keep ejected
  // true so future upgrades stay hands-off.
  if (prior && prior.ejected) {
    manifest.files[opts.relPath] = {
      ...prior,
      sha256: sha256OfString(opts.contents),
      modified: false,
    };
    return;
  }
  manifest.files[opts.relPath] = {
    templateVersion: opts.flintVersion,
    templateSource: opts.templateSource,
    sha256: sha256OfString(opts.contents),
    modified: false,
    ejected: false,
  };
}

/** Append a history entry and bump `updatedAt`. */
export function recordHistory(
  manifest: Manifest,
  entry: ManifestHistoryEntry,
): void {
  manifest.history.push(entry);
  manifest.updatedAt = entry.at;
  manifest.flintVersion = entry.flintVersion;
}

export type FileState =
  | { kind: 'unmodified'; entry: ManifestFileEntry }
  | { kind: 'modified'; entry: ManifestFileEntry; currentSha: string }
  | { kind: 'ejected'; entry: ManifestFileEntry }
  | { kind: 'missing'; entry: ManifestFileEntry };

/**
 * Classify a single tracked file against its current on-disk state. The
 * `modified` field on the entry is NOT trusted — we always recompute the
 * sha to detect drift. The cached `modified` is only used as a fast-path
 * hint by callers that don't need ground truth (e.g. status displays).
 */
export function classifyFile(
  projectRoot: string,
  relPath: string,
  entry: ManifestFileEntry,
): FileState {
  if (entry.ejected) return { kind: 'ejected', entry };
  const abs = join(projectRoot, relPath);
  const currentSha = sha256OfFile(abs);
  if (currentSha === null) return { kind: 'missing', entry };
  if (currentSha === entry.sha256) return { kind: 'unmodified', entry };
  return { kind: 'modified', entry, currentSha };
}

export interface ClassifiedFile {
  relPath: string;
  state: FileState;
}

/** Classify every entry in the manifest in one pass. */
export function classifyAll(
  projectRoot: string,
  manifest: Manifest,
): ClassifiedFile[] {
  return Object.entries(manifest.files)
    .map(([relPath, entry]) => ({
      relPath,
      state: classifyFile(projectRoot, relPath, entry),
    }))
    .sort((a, b) => a.relPath.localeCompare(b.relPath));
}

export interface BackfillOptions {
  /** Relative paths Flint considers "potentially generated by Flint". */
  candidatePaths: string[];
  /** Map from relPath → templateSource (best guess from the variant tree). */
  templateSources: Record<string, string>;
  flintVersion: string;
  variant: string;
  /** Template vars salvaged from the project's wrangler.toml. */
  vars: Record<string, string>;
}

/**
 * Build a synthetic manifest for a project scaffolded by an older Flint
 * (v0.5 and earlier — pre-manifest). Every backfilled entry is recorded with
 * a sentinel sha256 (`0…0` — sha of an empty string is never our content)
 * so the classifier reliably reports `modified` for every entry. This is
 * the conservative default — we don't know what version the user is on,
 * so we treat everything as "user owns it" until upgrade resolves.
 */
export function backfillManifest(
  projectRoot: string,
  opts: BackfillOptions,
): Manifest {
  const manifest = createEmptyManifest({
    flintVersion: opts.flintVersion,
    variant: opts.variant,
    vars: opts.vars,
  });
  // Sentinel value distinguishes "backfilled, never matched a template" from
  // "actually authored by Flint at some version." classifyFile will always
  // see drift against this sentinel until a real upgrade --apply runs.
  const SENTINEL_SHA = '0'.repeat(64);
  for (const rel of opts.candidatePaths) {
    const sha = sha256OfFile(join(projectRoot, rel));
    if (sha === null) continue;
    manifest.files[rel] = {
      templateVersion: '0.0.0-backfill',
      templateSource: opts.templateSources[rel] ?? rel,
      sha256: SENTINEL_SHA,
      modified: true,
      ejected: false,
    };
  }
  manifest.history.push({
    command: 'backfill',
    flintVersion: opts.flintVersion,
    at: manifest.createdAt,
    files: Object.keys(manifest.files).length,
  });
  return manifest;
}
