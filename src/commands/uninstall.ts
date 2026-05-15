// `flint uninstall` — undo what Flint did to a project.
//
// Reads `flint.manifest.json` to find every file Flint generated, classifies
// each as either "still as Flint wrote it" (safe to delete) or "modified by
// the user" (preserve), and removes the safe set. The manifest itself is
// also removed. Idempotent: rerunning on a fresh tree is a no-op.
//
// Crucially, this command never:
//   - Deletes files NOT recorded in the manifest. If you ran `flint init`
//     and then created your own `src/MyComponent.tsx`, that file stays.
//   - Deletes user-modified scaffolds. The sha256 comparison protects them.
//   - Touches global Flint state (`~/.config/flint/`). That's
//     `flint auth purge` + `flint telemetry purge`.
//
// Default UX: prints what would be deleted + asks for confirmation. Use
// `--dry-run` to skip the deletion entirely; `-y` to skip the prompt.

import { confirm } from '@inquirer/prompts';
import { existsSync, rmSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { log } from '../util/logger.js';
import {
  classifyAll,
  manifestPath,
  readManifest,
  type ClassifiedFile,
} from '../util/manifest.js';
import { formatResult, ok } from '../util/format-result.js';

export interface UninstallOptions {
  /** Skip the interactive confirmation prompt. */
  yes?: boolean;
  /** Print what would be deleted but write nothing. */
  dryRun?: boolean;
  /** Also delete user-modified files (off by default — destructive). */
  includeModified?: boolean;
  /** Emit a structured JSON result on stdout instead of human output. */
  json?: boolean;
}

interface UninstallPlan {
  deletable: ClassifiedFile[]; // unmodified or missing
  preserved: ClassifiedFile[]; // modified or ejected (and on disk)
}

export async function runUninstall(opts: UninstallOptions = {}): Promise<void> {
  const json = opts.json === true;
  const projectRoot = process.cwd();
  const manifest = readManifest(projectRoot);
  if (!manifest) {
    if (!json) {
      log.err('[flint] uninstall: no flint.manifest.json in this directory — nothing to undo.');
    }
    formatResult(
      ok('uninstall', { projectRoot, deleted: [], preserved: [], manifestRemoved: false }),
      { json },
    );
    process.exitCode = 1;
    return;
  }

  const classified = classifyAll(projectRoot, manifest);
  const plan: UninstallPlan = { deletable: [], preserved: [] };
  for (const c of classified) {
    if (c.state.kind === 'unmodified') {
      plan.deletable.push(c);
    } else if (c.state.kind === 'modified' && opts.includeModified) {
      plan.deletable.push(c);
    } else if (c.state.kind === 'missing') {
      // Already gone; nothing to do, but record it in deletable for the
      // summary so the user sees we're cleaning up the manifest entry too.
      plan.deletable.push(c);
    } else {
      plan.preserved.push(c);
    }
  }

  if (!json) {
    log.heading('Flint uninstall plan');
    log.info(`  Project: ${projectRoot}`);
    log.info(`  Variant: ${manifest.variant}`);
    log.info(`  Tracked files: ${classified.length}`);
    log.blank();
    if (plan.deletable.length > 0) {
      log.info(`  Would DELETE ${plan.deletable.length} file(s) (Flint-managed, unmodified or missing):`);
      for (const c of plan.deletable) {
        const tag = c.state.kind === 'missing' ? '(already gone)' : '';
        log.dim(`    - ${c.relPath} ${tag}`);
      }
    } else {
      log.info('  Nothing to delete (no unmodified Flint files found).');
    }
    log.blank();
    if (plan.preserved.length > 0) {
      log.info(`  Would PRESERVE ${plan.preserved.length} file(s):`);
      for (const c of plan.preserved) {
        log.dim(`    - ${c.relPath} (${c.state.kind})`);
      }
      log.dim('  (Pass --include-modified to also delete user-edited scaffolds.)');
    }
    log.blank();
  }

  if (opts.dryRun) {
    if (!json) log.info('--dry-run: not deleting anything. Pass --yes to confirm or rerun without --dry-run.');
    formatResult(
      ok('uninstall', {
        projectRoot,
        dryRun: true,
        wouldDelete: plan.deletable.map((c) => ({ path: c.relPath, kind: c.state.kind })),
        preserved: plan.preserved.map((c) => ({ path: c.relPath, kind: c.state.kind })),
        manifestRemoved: false,
      }),
      { json },
    );
    return;
  }

  // Confirmation. Skipped in --yes and --json.
  if (!opts.yes && !json) {
    const proceed = await confirm({
      message: `Delete ${plan.deletable.length} file(s) + the manifest?`,
      default: false,
    });
    if (!proceed) {
      log.info('Aborted. Nothing was deleted.');
      formatResult(
        ok('uninstall', { projectRoot, aborted: true, deleted: [], preserved: [], manifestRemoved: false }),
        { json },
      );
      return;
    }
  }

  const deletedFiles: string[] = [];
  for (const c of plan.deletable) {
    if (c.state.kind === 'missing') continue;
    const abs = join(projectRoot, c.relPath);
    try {
      if (existsSync(abs) && statSync(abs).isFile()) {
        rmSync(abs);
        deletedFiles.push(c.relPath);
      }
    } catch (e) {
      if (!json) log.err(`  [flint] uninstall: failed to delete ${c.relPath} — ${e instanceof Error ? e.message : String(e)}. Check permissions on the path and retry.`);
    }
  }

  // Manifest itself.
  let manifestRemoved = false;
  const mpath = manifestPath(projectRoot);
  if (existsSync(mpath)) {
    try {
      rmSync(mpath);
      manifestRemoved = true;
    } catch (e) {
      if (!json) log.err(`  [flint] uninstall: failed to delete ${mpath} — ${e instanceof Error ? e.message : String(e)}. Check permissions on the path and retry.`);
    }
  }

  if (!json) {
    log.blank();
    log.ok(`Deleted ${deletedFiles.length} file(s)${manifestRemoved ? ' + flint.manifest.json' : ''}.`);
    if (plan.preserved.length > 0) {
      log.info(`Preserved ${plan.preserved.length} user-touched file(s). Delete manually if desired.`);
    }
  }

  formatResult(
    ok('uninstall', {
      projectRoot,
      deleted: deletedFiles,
      preserved: plan.preserved.map((c) => ({ path: c.relPath, kind: c.state.kind })),
      manifestRemoved,
    }),
    { json },
  );
}
