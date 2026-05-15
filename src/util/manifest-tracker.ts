// `ManifestTracker` — the thin shim that init/create-app/add use to record
// every file they write into `flint.manifest.json` without each of them
// having to re-implement the manifest schema.
//
// Usage pattern:
//
//   const tracker = new ManifestTracker(projectRoot, {
//     command: 'init',
//     flintVersion,
//     variant: 'pages-fullstack',
//   });
//   for (const file of plannedFiles) {
//     const contents = renderFile(file.src, vars);
//     writeFileSync(destPath, contents);
//     tracker.record({
//       relPath: file.dest,
//       templateSource: file.templateSource,
//       contents,
//     });
//   }
//   tracker.flush();
//
// The tracker loads any EXISTING manifest first, so re-running init (or
// running `add` on top of init) preserves history and doesn't clobber
// the createdAt timestamp.
//
// The "command" string is the human-readable history entry. Pass exactly
// what would appear in shell — "add pwa", "add auth", "init", etc.

import { readManifest, writeManifest, recordFile, recordHistory, createEmptyManifest, type Manifest, type ManifestHistoryEntry } from './manifest.js';

export interface ManifestTrackerOptions {
  /** Subcommand label for the history entry. */
  command: string;
  /** Flint version writing the files. */
  flintVersion: string;
  /** Variant the project belongs to. Read from existing manifest if present. */
  variant: string;
  /**
   * Template variables used during this run (appName, compatDate, etc.).
   * Persisted to the manifest so `flint upgrade` can re-render bundled
   * templates against the same vars. When passed and the manifest already
   * has vars, the existing vars win (sticky semantics — a later `add pwa`
   * won't accidentally overwrite `appName`).
   */
  vars?: Record<string, string>;
}

export interface RecordFileInput {
  /** Relative path from project root. POSIX separators. */
  relPath: string;
  /** Relative path within `templates/` (e.g. "pages-fullstack/wrangler.toml.tmpl"). */
  templateSource: string;
  /** Final contents (post-render) written to disk. */
  contents: string;
}

export class ManifestTracker {
  private manifest: Manifest;
  private fileCount = 0;

  constructor(
    private readonly projectRoot: string,
    private readonly opts: ManifestTrackerOptions,
  ) {
    const existing = readManifest(projectRoot);
    if (existing) {
      this.manifest = existing;
      // Variant is sticky — once a project is scaffolded as pages-fullstack,
      // a later `add pwa` cannot quietly relabel it. Honor the existing
      // value and ignore the constructor argument. Same for createdAt.
      // Vars: merge in any new keys from the current run, but don't overwrite
      // existing ones (sticky semantics — see options doc).
      if (opts.vars) {
        for (const [k, v] of Object.entries(opts.vars)) {
          if (!(k in this.manifest.vars)) this.manifest.vars[k] = v;
        }
      }
    } else {
      this.manifest = createEmptyManifest({
        flintVersion: opts.flintVersion,
        variant: opts.variant,
        vars: opts.vars,
      });
    }
  }

  /** Record a single file. Call once per write. */
  record(input: RecordFileInput): void {
    recordFile(this.manifest, {
      relPath: input.relPath,
      templateSource: input.templateSource,
      flintVersion: this.opts.flintVersion,
      contents: input.contents,
    });
    this.fileCount += 1;
  }

  /** Persist the manifest to disk with a history entry for this run. */
  flush(): void {
    const entry: ManifestHistoryEntry = {
      command: this.opts.command,
      flintVersion: this.opts.flintVersion,
      at: new Date().toISOString(),
      files: this.fileCount,
    };
    recordHistory(this.manifest, entry);
    writeManifest(this.projectRoot, this.manifest);
  }

  /** Read-only access for callers that want to introspect the live manifest. */
  get current(): Readonly<Manifest> {
    return this.manifest;
  }

  /** How many file records have been added during this tracker's lifetime. */
  get recordCount(): number {
    return this.fileCount;
  }
}
