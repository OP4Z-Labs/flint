// `flint upgrade` — config drift remediation.
//
// Sub-modes:
//   --check    walk manifest, classify every entry into one of:
//                unmodified | modified | ejected | missing
//              print a concise table. Exit 0 if no drift; 1 if anything
//              other than unmodified is present.
//   --diff     same walk; for every modified file, print a unified diff
//              between the user's current content and the current bundled
//              template (re-rendered with the manifest's stored vars).
//   --apply    interactive 3-way merge per file:
//                unmodified → auto-update to new template
//                modified   → keep | take-new | merge ($EDITOR) | eject
//                ejected    → always skip
//                missing    → restore from template | remove from manifest
//   --dry-run  same UX as --apply but writes nothing.
//
// Backfill: if there is no manifest, upgrade can generate one by inspecting
// the project's wrangler.toml + a candidate file list. Every backfilled
// entry is flagged `modified: true`, so --apply always asks before writing.
//
// Implementation notes:
//   - "Current bundled template" comes from `templates/<templateSource>`
//     re-rendered with the manifest's `vars`. Template paths that don't
//     exist in the current Flint (file was removed) are skipped with a note.
//   - $EDITOR merge uses a write-merge-block file. The user resolves
//     conflict markers in their editor; on close, we re-read and use the
//     content verbatim. Standard `git mergetool` pattern.

import { select } from '@inquirer/prompts';
import {
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { spawnSync } from 'node:child_process';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  classifyAll,
  classifyFile,
  readManifest,
  writeManifest,
  recordHistory,
  sha256OfString,
  backfillManifest,
  type Manifest,
  type ClassifiedFile,
  type FileState,
} from '../util/manifest.js';
import { renderString, type TemplateVars } from '../util/template.js';
import { renderUnifiedDiff } from '../util/diff.js';
import { log } from '../util/logger.js';
import { readPackageVersion } from '../util/version.js';

export interface UpgradeOptions {
  /** Print drift table only. */
  check: boolean;
  /** Print drift table + unified diff for every modified file. */
  diff: boolean;
  /** Walk each file with interactive 3-way merge. */
  apply: boolean;
  /** Like --apply but writes nothing. */
  dryRun: boolean;
}

const ACTION_NEEDED_KINDS: ReadonlyArray<FileState['kind']> = [
  'modified',
  'missing',
];

export async function runUpgrade(opts: UpgradeOptions): Promise<void> {
  const projectRoot = process.cwd();
  let manifest = readManifest(projectRoot);
  if (!manifest) {
    log.warn('No flint.manifest.json found. Running backfill mode.');
    log.dim('  Pre-v0.9 scaffolds didn\'t produce a manifest. Flint will build');
    log.dim('  one from the current file state and flag every entry as modified.');
    manifest = await runBackfill(projectRoot);
    if (!manifest) {
      log.err('Backfill failed — could not detect any Flint-managed files.');
      process.exitCode = 1;
      return;
    }
    log.ok(`Backfilled flint.manifest.json with ${Object.keys(manifest.files).length} entries.`);
    log.blank();
  }

  const flintVersion = readPackageVersion();
  log.heading(`Flint upgrade — ${manifest.variant} project @ ${manifest.flintVersion} → ${flintVersion}`);
  log.dim(`  Project: ${projectRoot}`);
  log.dim(`  History: ${manifest.history.length} prior invocation(s).`);
  log.blank();

  const classified = classifyAll(projectRoot, manifest);
  printDriftTable(classified);
  log.blank();

  if (opts.check) {
    const hasDrift = classified.some((c) => ACTION_NEEDED_KINDS.includes(c.state.kind));
    if (hasDrift) {
      log.info('Drift detected. Run `flint upgrade --diff` for details or `flint upgrade --apply` to remediate.');
      process.exitCode = 1;
    } else {
      log.ok('Project is in sync with the current Flint template.');
    }
    return;
  }

  if (opts.diff) {
    printDiffForModified(projectRoot, manifest, classified);
    return;
  }

  if (opts.apply || opts.dryRun) {
    await applyInteractively(projectRoot, manifest, classified, {
      dryRun: opts.dryRun,
      flintVersion,
    });
    return;
  }

  // No mode flag — default is check.
  log.info('No mode flag supplied. Defaulting to --check.');
  log.info('Use --diff for unified diffs or --apply to remediate.');
}

/** Print the four-state drift table. */
function printDriftTable(classified: ClassifiedFile[]): void {
  if (classified.length === 0) {
    log.info('No tracked files in the manifest.');
    return;
  }
  const counts: Record<FileState['kind'], number> = {
    unmodified: 0,
    modified: 0,
    ejected: 0,
    missing: 0,
  };
  for (const c of classified) counts[c.state.kind] += 1;
  log.info('Files tracked: ' + classified.length);
  log.info(`  unmodified: ${counts.unmodified}`);
  log.info(`  modified:   ${counts.modified}`);
  log.info(`  ejected:    ${counts.ejected}`);
  log.info(`  missing:    ${counts.missing}`);
  log.blank();
  for (const c of classified) {
    const tag = c.state.kind.padEnd(10);
    log.info(`  [${tag}] ${c.relPath}`);
  }
}

function printDiffForModified(
  projectRoot: string,
  manifest: Manifest,
  classified: ClassifiedFile[],
): void {
  const modified = classified.filter((c) => c.state.kind === 'modified');
  if (modified.length === 0) {
    log.ok('No modified files. Nothing to diff.');
    return;
  }
  log.heading(`Diffs for ${modified.length} modified file(s)`);
  for (const c of modified) {
    const userContent = readFileSync(join(projectRoot, c.relPath), 'utf8');
    const renderedNew = renderTemplateContent(c.state.entry.templateSource, manifest.vars);
    if (renderedNew === null) {
      log.warn(`  Skipping ${c.relPath} — template source not found in current Flint: ${c.state.entry.templateSource}`);
      continue;
    }
    const diff = renderUnifiedDiff(userContent, renderedNew, {
      oldLabel: `a/${c.relPath} (your version)`,
      newLabel: `b/${c.relPath} (flint@${readPackageVersion()})`,
    });
    log.blank();
    log.info(`# ${c.relPath}`);
    if (diff === '') {
      log.dim('  (no textual difference — sha mismatch may be from a trailing newline change)');
    } else {
      process.stdout.write(diff);
    }
  }
}

interface ApplyContext {
  dryRun: boolean;
  flintVersion: string;
}

async function applyInteractively(
  projectRoot: string,
  manifest: Manifest,
  classified: ClassifiedFile[],
  ctx: ApplyContext,
): Promise<void> {
  if (ctx.dryRun) {
    log.heading('Dry-run: showing planned actions without writing.');
  } else {
    log.heading('Walking drift interactively. Choose an action per file.');
  }
  log.blank();

  let updated = 0;
  let kept = 0;
  let ejectedCount = 0;
  let restored = 0;
  let removedFromManifest = 0;

  for (const c of classified) {
    if (c.state.kind === 'ejected') {
      log.dim(`  [ejected]   ${c.relPath} — skipping (always)`);
      continue;
    }
    if (c.state.kind === 'unmodified') {
      // Auto-update path: re-render the bundled template + check if the
      // current bundled version differs from what the user has. If so,
      // update silently (no prompt needed — the user hasn't touched it).
      const renderedNew = renderTemplateContent(c.state.entry.templateSource, manifest.vars);
      if (renderedNew === null) continue;
      const userContent = readFileSync(join(projectRoot, c.relPath), 'utf8');
      if (userContent === renderedNew) {
        // truly identical — nothing to do.
        continue;
      }
      if (ctx.dryRun) {
        log.info(`  [auto]      ${c.relPath} — would update to flint@${ctx.flintVersion}`);
      } else {
        writeFileSync(join(projectRoot, c.relPath), renderedNew, 'utf8');
        manifest.files[c.relPath] = {
          ...c.state.entry,
          sha256: sha256OfString(renderedNew),
          templateVersion: ctx.flintVersion,
          modified: false,
        };
        log.ok(`Updated ${c.relPath} to flint@${ctx.flintVersion}.`);
      }
      updated += 1;
      continue;
    }
    if (c.state.kind === 'missing') {
      const choice = await select<'restore' | 'remove' | 'skip'>({
        message: `${c.relPath} is missing. What should Flint do?`,
        choices: [
          { name: 'restore — write the template at this path again', value: 'restore' },
          { name: 'remove — drop this entry from the manifest', value: 'remove' },
          { name: 'skip   — leave the manifest alone for now', value: 'skip' },
        ],
        default: 'skip',
      });
      if (choice === 'restore') {
        const renderedNew = renderTemplateContent(c.state.entry.templateSource, manifest.vars);
        if (renderedNew === null) {
          log.warn(`  Template source not found in current Flint — cannot restore.`);
          continue;
        }
        if (ctx.dryRun) {
          log.info(`  [restore]   would restore ${c.relPath}.`);
        } else {
          const abs = join(projectRoot, c.relPath);
          mkdirSync(dirname(abs), { recursive: true });
          writeFileSync(abs, renderedNew, 'utf8');
          manifest.files[c.relPath] = {
            ...c.state.entry,
            sha256: sha256OfString(renderedNew),
            templateVersion: ctx.flintVersion,
            modified: false,
          };
          log.ok(`Restored ${c.relPath}.`);
        }
        restored += 1;
      } else if (choice === 'remove') {
        if (!ctx.dryRun) {
          delete manifest.files[c.relPath];
        }
        removedFromManifest += 1;
        log.dim(`  Dropped ${c.relPath} from manifest.`);
      }
      continue;
    }
    // modified path
    if (c.state.kind === 'modified') {
      const userContent = readFileSync(join(projectRoot, c.relPath), 'utf8');
      const renderedNew = renderTemplateContent(c.state.entry.templateSource, manifest.vars);
      if (renderedNew === null) {
        log.warn(`  ${c.relPath}: template source missing in current Flint (${c.state.entry.templateSource}). Skipping.`);
        continue;
      }
      // Show the diff inline so the user has context before choosing.
      log.blank();
      log.info(`# ${c.relPath}`);
      const diff = renderUnifiedDiff(userContent, renderedNew, {
        oldLabel: `a/${c.relPath} (your version)`,
        newLabel: `b/${c.relPath} (flint@${ctx.flintVersion})`,
      });
      if (diff) process.stdout.write(diff);

      const choice = await select<'keep' | 'take-new' | 'merge' | 'eject'>({
        message: `Action for ${c.relPath}:`,
        choices: [
          { name: 'keep     — leave your version as-is, stop tracking until next change', value: 'keep' },
          { name: 'take-new — overwrite with the new template (you lose your edits)', value: 'take-new' },
          { name: 'merge    — open $EDITOR to merge manually', value: 'merge' },
          { name: 'eject    — mark file as user-owned forever; never offer upgrades again', value: 'eject' },
        ],
        default: 'keep',
      });

      if (choice === 'keep') {
        kept += 1;
        if (!ctx.dryRun) {
          // Record the user's current content as the new baseline so future
          // diffs are against THIS content, not the historical template. The
          // file remains tracked but its templateVersion is unchanged.
          manifest.files[c.relPath] = {
            ...c.state.entry,
            sha256: sha256OfString(userContent),
            modified: false,
          };
        }
      } else if (choice === 'take-new') {
        if (ctx.dryRun) {
          log.info(`  [take-new]  would overwrite ${c.relPath}.`);
        } else {
          writeFileSync(join(projectRoot, c.relPath), renderedNew, 'utf8');
          manifest.files[c.relPath] = {
            ...c.state.entry,
            sha256: sha256OfString(renderedNew),
            templateVersion: ctx.flintVersion,
            modified: false,
          };
          log.ok(`Updated ${c.relPath} to flint@${ctx.flintVersion}.`);
        }
        updated += 1;
      } else if (choice === 'merge') {
        if (ctx.dryRun) {
          log.info(`  [merge]     would open $EDITOR on ${c.relPath}.`);
          updated += 1;
        } else {
          const merged = await openEditorMerge({
            userContent,
            renderedNew,
            relPath: c.relPath,
          });
          if (merged === null) {
            log.warn(`Merge cancelled for ${c.relPath}. Keeping your version.`);
            kept += 1;
            continue;
          }
          writeFileSync(join(projectRoot, c.relPath), merged, 'utf8');
          manifest.files[c.relPath] = {
            ...c.state.entry,
            sha256: sha256OfString(merged),
            templateVersion: ctx.flintVersion,
            modified: false,
          };
          log.ok(`Merged ${c.relPath}.`);
          updated += 1;
        }
      } else if (choice === 'eject') {
        if (!ctx.dryRun) {
          manifest.files[c.relPath] = {
            ...c.state.entry,
            ejected: true,
            sha256: sha256OfString(userContent),
            modified: false,
          };
        }
        ejectedCount += 1;
        log.ok(`Ejected ${c.relPath} — Flint will never offer upgrades for it again.`);
      }
    }
  }

  log.blank();
  log.heading('Upgrade summary');
  log.info(`  updated:    ${updated}`);
  log.info(`  kept:       ${kept}`);
  log.info(`  ejected:    ${ejectedCount}`);
  log.info(`  restored:   ${restored}`);
  log.info(`  dropped:    ${removedFromManifest}`);

  if (!ctx.dryRun) {
    recordHistory(manifest, {
      command: 'upgrade',
      flintVersion: ctx.flintVersion,
      at: new Date().toISOString(),
      files: updated + kept + ejectedCount + restored + removedFromManifest,
    });
    writeManifest(projectRoot, manifest);
    log.ok('Manifest updated.');
  } else {
    log.dim('--dry-run: manifest left untouched.');
  }
}

/**
 * Read `templates/<templateSource>` from the bundled templates directory,
 * render with the supplied vars. Returns null if the source no longer exists
 * (template was renamed / removed in the current Flint version) or if the
 * source is a non-bundled custom URL.
 *
 * The CURRENT Flint version is always injected as `flintVersion` (overriding
 * any persisted value) so generated-by header comments reflect the upgrading
 * version, not the version that originally scaffolded the file.
 */
function renderTemplateContent(
  templateSource: string,
  vars: Record<string, string>,
): string | null {
  if (templateSource.startsWith('git+')) {
    // Custom-template files — there's no bundled template to re-render
    // against. Treat as unmanaged.
    return null;
  }
  const here = dirname(fileURLToPath(import.meta.url));
  const abs = resolve(here, '..', '..', 'templates', templateSource);
  if (!existsSync(abs)) return null;
  const raw = readFileSync(abs, 'utf8');
  if (templateSource.endsWith('.tmpl')) {
    const renderVars = { ...vars, flintVersion: readPackageVersion() };
    return renderString(raw, renderVars as TemplateVars);
  }
  return raw;
}

interface EditorMergeArgs {
  userContent: string;
  renderedNew: string;
  relPath: string;
}

/**
 * Write a three-section merge file (yours / new / instructions), open it in
 * $EDITOR, then read the resolved content back. The user owns the resolution
 * — Flint takes whatever they save.
 *
 * Returns null if the editor exited non-zero OR if the file ends up empty.
 */
async function openEditorMerge(args: EditorMergeArgs): Promise<string | null> {
  const tmpFile = join(
    process.env.TMPDIR ?? '/tmp',
    `flint-merge-${Date.now()}-${args.relPath.replace(/[\\/]/g, '_')}`,
  );
  const banner = [
    '<<<<<<< Yours (your current file)',
    args.userContent.trimEnd(),
    '=======',
    args.renderedNew.trimEnd(),
    '>>>>>>> Flint (new template)',
    '',
    '# Resolve the conflict block above. Save & exit when done.',
    '# Flint will use the entire file content as the merged result.',
    '# Empty file = cancel.',
  ].join('\n') + '\n';
  writeFileSync(tmpFile, banner, 'utf8');
  const editor = process.env.EDITOR ?? process.env.VISUAL ?? 'vi';
  const result = spawnSync(editor, [tmpFile], { stdio: 'inherit' });
  if (result.status !== 0) {
    return null;
  }
  const resolved = readFileSync(tmpFile, 'utf8');
  // Strip the trailing "# Flint will use..." comments if the user didn't
  // remove them; we treat comment-only content as cancellation.
  const stripped = resolved
    .split('\n')
    .filter((line) => !line.startsWith('# '))
    .join('\n');
  if (stripped.trim().length === 0) return null;
  return resolved;
}

/**
 * Generate a manifest for a project scaffolded by older Flint. Probes for
 * a known set of paths (one per supported template) and salvages template
 * vars from wrangler.toml.
 */
async function runBackfill(projectRoot: string): Promise<Manifest | null> {
  // Salvage variant + template vars from the existing wrangler.toml.
  const wranglerPath = join(projectRoot, 'wrangler.toml');
  if (!existsSync(wranglerPath)) {
    log.err('No wrangler.toml found — cannot backfill. Was this a Flint-scaffolded project?');
    return null;
  }
  const wranglerText = readFileSync(wranglerPath, 'utf8');
  const appNameMatch = wranglerText.match(/^name\s*=\s*"([^"]+)"/m);
  const compatMatch = wranglerText.match(/^compatibility_date\s*=\s*"([^"]+)"/m);
  const hasFunctions = existsSync(join(projectRoot, 'functions', '_shared'));
  const hasR2 = /\[\[r2_buckets\]\]/.test(wranglerText);
  let variant: 'static-spa' | 'pages-functions' | 'pages-fullstack';
  if (!hasFunctions) variant = 'static-spa';
  else if (hasR2) variant = 'pages-fullstack';
  else variant = 'pages-functions';

  const appName = appNameMatch?.[1] ?? 'app';
  const compatDate = compatMatch?.[1] ?? new Date().toISOString().slice(0, 10);
  const vars: Record<string, string> = {
    appName,
    appNameLower: appName.toLowerCase(),
    compatDate,
    cookieName: `${appName.toLowerCase().replace(/[^a-z0-9]+/g, '_')}_admin`,
    tokenMessage: `${appName.toLowerCase().replace(/[^a-z0-9]+/g, '-')}-admin-session-v1`,
    flintVersion: readPackageVersion(),
  };

  // Walk the variant template tree for candidate file paths.
  const here = dirname(fileURLToPath(import.meta.url));
  const candidates: string[] = [];
  const templateSources: Record<string, string> = {};
  for (const treeName of ['_skeleton', variant]) {
    const tree = resolve(here, '..', '..', 'templates', treeName);
    if (!existsSync(tree)) continue;
    walkTree(tree, '');
    function walkTree(dir: string, relPrefix: string): void {
      for (const entry of readdirSync(dir)) {
        const abs = join(dir, entry);
        const rel = relPrefix ? join(relPrefix, entry) : entry;
        const stat = statSync(abs);
        if (stat.isDirectory()) {
          walkTree(abs, rel);
          continue;
        }
        let destRel = rel;
        if (destRel.endsWith('.tmpl')) destRel = destRel.slice(0, -'.tmpl'.length);
        if (destRel === 'gitignore') destRel = '.gitignore';
        destRel = destRel.split(/[\\/]/).join('/');
        candidates.push(destRel);
        templateSources[destRel] = `${treeName}/${rel.split(/[\\/]/).join('/')}`;
      }
    }
  }

  return backfillManifest(projectRoot, {
    candidatePaths: candidates,
    templateSources,
    flintVersion: readPackageVersion(),
    variant,
    vars,
  });
}

// Export internals for unit-test reach-arounds.
export const __test = {
  classifyFile,
  renderTemplateContent,
};
