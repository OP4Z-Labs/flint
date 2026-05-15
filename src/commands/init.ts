// `flint init` — scaffold Cloudflare Pages config into an existing
// Vite + React + TS repo. v0.1 supports two variants:
//
//   pages-functions  — Chorus-style: KV + Functions + HMAC auth
//   pages-fullstack  — Blaze-style:  KV + R2 + Functions + HMAC auth + PWA
//
// The `static-spa` variant is reserved for v0.5. Trying to use it now
// gives a clear "not yet" error rather than a half-built scaffold.
//
// Idempotency: every write checks for an existing file. With `--force`
// the CLI overwrites unconditionally; without it, the CLI prompts.
//
// Acceptance criterion #9: `.dev.vars` MUST be gitignored before any
// secret is written, and the CLI MUST refuse to write if it's tracked.
// That invariant lives in `dev-vars.ts`; init never bypasses it.

import { confirm, input } from '@inquirer/prompts';
import { existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { basename, dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { renderFile, type TemplateVars } from '../util/template.js';
import { log } from '../util/logger.js';
import { ensureGitignored, writeDevVarsExample, type DevVarsEntry } from '../cloudflare/dev-vars.js';
import { ManifestTracker } from '../util/manifest-tracker.js';
import { readPackageVersion } from '../util/version.js';

export type InitVariant = 'pages-functions' | 'pages-fullstack';

export interface InitOptions {
  variant?: string;
  projectName?: string;
  includeCI: boolean;
  yes: boolean;
  force: boolean;
}

const SUPPORTED_VARIANTS: ReadonlyArray<InitVariant> = ['pages-functions', 'pages-fullstack'];

export async function runInit(opts: InitOptions): Promise<void> {
  const cwd = process.cwd();

  // Validate / prompt the variant.
  const variant = await resolveVariant(opts.variant, opts.yes);

  // Validate / prompt the project name (== Cloudflare Pages project name).
  const projectName = await resolveProjectName(opts.projectName, cwd, opts.yes);

  // Sanity check: a Vite project should have package.json. We don't hard-
  // require it (init might run on a fresh dir), but we warn if missing.
  if (!existsSync(join(cwd, 'package.json'))) {
    log.warn(
      'No package.json in the current directory. Flint will still write its config files, ' +
        'but you will need a Vite + React + TS package.json before `npm run dev` works.',
    );
  }

  const templateRoot = resolveTemplatesDir(variant);
  const flintVersionEarly = readPackageVersion();
  const vars: TemplateVars = {
    appName: projectName,
    appNameLower: projectName.toLowerCase(),
    compatDate: todayISODate(),
    cookieName: `${projectName.toLowerCase().replace(/[^a-z0-9]+/g, '_')}_admin`,
    tokenMessage: `${projectName.toLowerCase().replace(/[^a-z0-9]+/g, '-')}-admin-session-v1`,
    flintVersion: flintVersionEarly,
  };

  log.heading(`Scaffolding ${variant} for "${projectName}"`);
  log.dim(`  Target: ${cwd}`);
  log.dim(`  Template root: ${templateRoot}`);
  log.blank();

  const plan = collectFiles(templateRoot, opts.includeCI);
  let written = 0;
  let skipped = 0;

  const flintVersion = flintVersionEarly;
  const tracker = new ManifestTracker(cwd, {
    command: 'init',
    flintVersion,
    variant,
    vars,
  });

  for (const file of plan) {
    const destPath = join(cwd, file.dest);
    const exists = existsSync(destPath);
    if (exists && !opts.force) {
      if (opts.yes) {
        log.warn(`Exists, skipping: ${file.dest}`);
        skipped += 1;
        continue;
      }
      const overwrite = await confirm({
        message: `${file.dest} exists — overwrite?`,
        default: false,
      });
      if (!overwrite) {
        skipped += 1;
        continue;
      }
    }
    const rendered = renderFile(file.src, vars);
    mkdirSync(dirname(destPath), { recursive: true });
    writeFileSync(destPath, rendered, 'utf8');
    tracker.record({
      relPath: file.dest,
      templateSource: `${variant}/${relative(templateRoot, file.src).split(/[\\/]/).join('/')}`,
      contents: rendered,
    });
    log.ok(`Wrote ${file.dest}`);
    written += 1;
  }

  tracker.flush();

  // Gitignore enforcement. We don't write `.dev.vars` here (that's the auth
  // path's job); we DO write `.dev.vars.example` and append to .gitignore so
  // a user who later runs `flint auth init` from this repo doesn't trip
  // the "tracked file" guard.
  ensureGitignored(cwd);
  log.ok('.gitignore updated to ignore .dev.vars');

  const envEntries = devVarsEntriesForVariant(variant);
  const examplePath = writeDevVarsExample(cwd, envEntries);
  log.ok(`Wrote ${relative(cwd, examplePath)}`);

  // package.json script merge. We don't replace the user's package.json;
  // we only add/override the wrangler-related scripts. If package.json is
  // missing, we skip with a warning (caller can run `npm init` first).
  await mergeScriptsIntoPackageJson(cwd, projectName);

  log.blank();
  log.heading('Done.');
  log.info(`  Wrote ${written} file(s); skipped ${skipped}.`);
  log.info('  Next steps:');
  log.info('    1. `flint auth init` (if you have not yet) — stores your Cloudflare API token.');
  log.info('    2. `wrangler pages project create ' + projectName + '` (or use `flint configure` in v0.2).');
  log.info('    3. `npm run dev` — Vite + wrangler pages dev side-by-side.');
}

// ─── helpers ───────────────────────────────────────────────────────────────

async function resolveVariant(raw: string | undefined, yes: boolean): Promise<InitVariant> {
  if (raw) {
    if (raw === 'static-spa') {
      throw new Error('Variant `static-spa` is not implemented in v0.1. Targeted for v0.5.');
    }
    if (!SUPPORTED_VARIANTS.includes(raw as InitVariant)) {
      throw new Error(
        `Unknown variant "${raw}". Supported in v0.1: ${SUPPORTED_VARIANTS.join(', ')}.`,
      );
    }
    return raw as InitVariant;
  }
  if (yes) {
    log.dim('--yes specified without --variant; defaulting to pages-functions.');
    return 'pages-functions';
  }
  const { select } = await import('@inquirer/prompts');
  const picked = await select<InitVariant>({
    message: 'Which template variant?',
    choices: [
      {
        name: 'pages-functions — Functions + 1 KV namespace + HMAC auth (Chorus-style)',
        value: 'pages-functions',
      },
      {
        name: 'pages-fullstack — Functions + KV + R2 + HMAC auth + rate limit (Blaze-style)',
        value: 'pages-fullstack',
      },
    ],
    default: 'pages-functions',
  });
  return picked;
}

async function resolveProjectName(
  raw: string | undefined,
  cwd: string,
  yes: boolean,
): Promise<string> {
  const fallback = basename(cwd).toLowerCase().replace(/[^a-z0-9-]/g, '-');
  if (raw) {
    validateProjectName(raw);
    return raw;
  }
  if (yes) {
    return fallback;
  }
  const picked = await input({
    message: 'Cloudflare Pages project name:',
    default: fallback,
    validate: (v: string): true | string => {
      try {
        validateProjectName(v);
        return true;
      } catch (e) {
        return e instanceof Error ? e.message : String(e);
      }
    },
  });
  return picked;
}

function validateProjectName(name: string): void {
  if (!/^[a-z][a-z0-9-]{1,57}[a-z0-9]$/.test(name)) {
    throw new Error(
      'Project name must start with a letter, contain only lowercase letters, digits, ' +
        'and hyphens, be 3–58 characters, and not end with a hyphen.',
    );
  }
}

function todayISODate(): string {
  return new Date().toISOString().slice(0, 10);
}

interface PlannedFile {
  /** Absolute path to the template source on disk. */
  src: string;
  /** Path relative to the project root where the file should be written. */
  dest: string;
}

/**
 * Walk the variant's template tree and produce the list of files to write.
 * Path mapping rules:
 *   - File names ending in `.tmpl` lose that suffix in the output.
 *   - File named `gitignore.tmpl` writes as `.gitignore`. (Same trick npm/
 *     create-vite uses — bare `.gitignore` files inside a published package
 *     get stripped, so the template ships under a safe name.)
 *   - The `.github/workflows/ci.yml` template is omitted entirely when
 *     `--no-ci` was passed.
 */
function collectFiles(templateRoot: string, includeCI: boolean): PlannedFile[] {
  const planned: PlannedFile[] = [];
  walk(templateRoot, '');
  if (!includeCI) {
    return planned.filter((p) => !p.dest.startsWith('.github/'));
  }
  return planned;

  function walk(absDir: string, relDir: string): void {
    for (const entry of readdirSync(absDir)) {
      const abs = join(absDir, entry);
      const rel = relDir ? join(relDir, entry) : entry;
      const stat = statSync(abs);
      if (stat.isDirectory()) {
        walk(abs, rel);
        continue;
      }
      let destRel = rel;
      if (destRel.endsWith('.tmpl')) destRel = destRel.slice(0, -'.tmpl'.length);
      // Top-level "gitignore" in the template becomes ".gitignore" in the
      // project. (Some tooling strips dotfiles from published packages.)
      if (destRel === 'gitignore') destRel = '.gitignore';
      planned.push({ src: abs, dest: destRel });
    }
  }
}

function resolveTemplatesDir(variant: InitVariant): string {
  // dist/commands/init.js  →  ../../templates/<variant>
  // src/commands/init.ts   →  ../../templates/<variant>  (vitest test runs)
  const here = dirname(fileURLToPath(import.meta.url));
  const candidate = resolve(here, '..', '..', 'templates', variant);
  if (existsSync(candidate)) return candidate;
  throw new Error(`Templates directory not found: ${candidate}`);
}

function devVarsEntriesForVariant(_variant: InitVariant): DevVarsEntry[] {
  // Both variants get the same secrets surface in v0.1:
  //   - CF token + account id (for wrangler)
  //   - ADMIN_PASSWORD + COOKIE_SECRET (for the Functions HMAC auth flow)
  // The `_variant` parameter is kept so v0.2 can branch on it (R2 buckets,
  // extra KV namespaces, etc.) without an API change.
  return [
    {
      key: 'CLOUDFLARE_API_TOKEN',
      value: '',
      comment:
        'Cloudflare API token. Managed by Flint — run `flint auth init` to populate.',
    },
    {
      key: 'CLOUDFLARE_ACCOUNT_ID',
      value: '',
      comment: 'Cloudflare account id. Populated by `flint auth init`.',
    },
    {
      key: 'ADMIN_PASSWORD',
      value: '',
      comment: 'Plaintext password compared directly by /api/admin/login.',
    },
    {
      key: 'COOKIE_SECRET',
      value: '',
      comment:
        'Random hex for the HMAC session cookie. Rotate to invalidate every session.\nGenerate with: openssl rand -hex 32',
    },
  ];
}

async function mergeScriptsIntoPackageJson(cwd: string, projectName: string): Promise<void> {
  const path = join(cwd, 'package.json');
  if (!existsSync(path)) {
    log.warn('No package.json found — skipping script merge. Run `npm init -y` and re-run.');
    return;
  }
  const raw = readFileSync(path, 'utf8');
  let pkg: Record<string, unknown>;
  try {
    pkg = JSON.parse(raw) as Record<string, unknown>;
  } catch {
    log.err('package.json is not valid JSON — skipping script merge.');
    return;
  }
  const scripts = (pkg.scripts as Record<string, string> | undefined) ?? {};
  const flintScripts: Record<string, string> = {
    'dev:vite': 'vite --port 5173',
    'dev:cf': 'wrangler pages dev --proxy 5173 --port 8788',
    dev: 'concurrently -n vite,cf -c cyan,magenta "npm:dev:vite" "npm:dev:cf"',
    build: 'tsc -b && vite build',
    deploy: 'npm run build && wrangler pages deploy',
    logs: `wrangler pages deployment tail --project-name=${projectName}`,
    deployments: `wrangler pages deployment list --project-name=${projectName}`,
    secrets: `wrangler pages secret list --project-name=${projectName}`,
    'secret:set': `wrangler pages secret put --project-name=${projectName}`,
    whoami: 'wrangler whoami',
  };

  let changed = 0;
  for (const [key, value] of Object.entries(flintScripts)) {
    if (scripts[key] !== value) {
      scripts[key] = value;
      changed += 1;
    }
  }
  pkg.scripts = scripts;

  writeFileSync(path, JSON.stringify(pkg, null, 2) + '\n', 'utf8');
  log.ok(`Updated ${relative(cwd, path)} (${changed} script(s) set).`);
}
