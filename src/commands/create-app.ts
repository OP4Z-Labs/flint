// `flint create-app <name>` — bootstrap a fresh Vite + React + TS app with
// all Cloudflare Pages wiring pre-baked. Parallel to `npm create vite@latest`,
// but instead of "vite-app-template + vanilla wiring" you get:
//
//   - the chosen variant's wrangler.toml + _headers + _routes.json
//   - the variant's functions/_shared/* (pages-functions, pages-fullstack)
//   - the variant's vite.config.ts (PWA-on for static-spa & pages-fullstack,
//     PWA-on with Functions proxy for pages-functions)
//   - the shared skeleton: package.json, tsconfig refs, eslint config,
//     vitest config, index.html, src/App.tsx, src/main.tsx, src/index.css
//   - .gitignore (with .dev.vars), .dev.vars.example
//   - optional `git init` (default on; --no-git opts out)
//   - optional `npm install` / `pnpm install` / `bun install` (default on
//     for the auto-detected PM; --no-install opts out)
//   - optional `flint configure` invocation immediately after scaffold
//     (--provision opts in; default off — most users want to inspect first)
//
// Composition order: skeleton (_skeleton/) is laid down first, then the
// variant on top. The variant's files override skeleton on conflict. Both
// trees are walked with the same .tmpl-suffix-stripping + gitignore.tmpl
// → .gitignore renaming rules as `flint init`.
//
// Behavioural choice: we DON'T re-run the same code path as `flint init`,
// even though there's overlap. `init` overlays config onto an EXISTING repo
// (with overwrite prompts); `create-app` builds a NEW directory from
// scratch (no prompts ever, the dir must be empty). Keeping them separate
// makes both code paths simpler.

import { select } from '@inquirer/prompts';
import {
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  statSync,
} from 'node:fs';
import { spawnSync } from 'node:child_process';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { renderFile, type TemplateVars } from '../util/template.js';
import { log } from '../util/logger.js';
import { writeDevVarsExample, type DevVarsEntry } from '../cloudflare/dev-vars.js';
import { writeFileAtomic } from '../util/atomic-write.js';
import { formatResult, ok } from '../util/format-result.js';
import {
  installCommand,
  resolvePackageManager,
  type PackageManager,
} from '../util/package-manager.js';
import { ManifestTracker } from '../util/manifest-tracker.js';
import { readPackageVersion } from '../util/version.js';
import { applyTemplate } from '../util/template-url.js';
import {
  BUILTIN_VARIANTS,
  BUILTIN_VARIANT_DESCRIPTIONS,
  type BuiltinVariant,
} from '../util/registry.js';
import { runConfigure } from './configure.js';

export type CreateAppVariant = BuiltinVariant;

export interface CreateAppOptions {
  /** Target directory name (becomes the Pages project name unless overridden). */
  appName: string;
  /** Optional override for the Cloudflare Pages project name. */
  cfProject?: string;
  /** Template variant. If undefined, the CLI prompts (unless --yes). */
  variant?: string;
  /**
   * Scaffold from an external template pack at this directory (contains a
   * pack.json). When set, `template` is interpreted as a template id WITHIN
   * the pack rather than a git URL, and the entire pack-registry code path
   * runs instead of the built-in variant overlay. Mutually exclusive with
   * the git-url meaning of `--template`.
   */
  pack?: string;
  /**
   * - With `--pack`: a template id within the pack.
   * - Without `--pack`: a `git+<url>` custom template (v0.9 behaviour).
   */
  template?: string;
  /** Pre-resolved pack var values (CLI: --var name=value, repeatable). */
  vars?: Record<string, string>;
  /** Package manager override. Auto-detected if undefined. */
  pm?: string;
  /** If true, skip `<pm> install`. */
  noInstall: boolean;
  /** If true, skip `git init`. */
  noGit: boolean;
  /** If true, run `flint configure` immediately after scaffold. */
  provision: boolean;
  /** Non-interactive mode — skip all prompts, use defaults. */
  yes: boolean;
  /** Emit a structured JSON result on stdout instead of human output. */
  json?: boolean;
}

// Built-in variants now come from the template registry (the single source of
// truth). The local aliases keep the rest of this file's call sites unchanged.
const SUPPORTED_VARIANTS: ReadonlyArray<CreateAppVariant> = BUILTIN_VARIANTS;
const VARIANT_DESCRIPTIONS: Record<CreateAppVariant, string> = BUILTIN_VARIANT_DESCRIPTIONS;

export async function runCreateApp(opts: CreateAppOptions): Promise<void> {
  validateAppName(opts.appName);

  // Pack path: when --pack is set, the external template-pack registry takes
  // over entirely. Built-in --variant behaviour below is untouched — this is
  // a clean fork at the top of the command, not an interleaving.
  if (opts.pack) {
    const { runCreateAppFromPack } = await import('./create-app-pack.js');
    await runCreateAppFromPack({
      appName: opts.appName,
      packDir: opts.pack,
      templateId: opts.template,
      vars: opts.vars,
      yes: opts.yes,
      json: opts.json,
    });
    return;
  }

  // Resolve target directory + ensure it's safe to write into.
  const target = resolve(process.cwd(), opts.appName);
  if (existsSync(target)) {
    const contents = readdirSync(target);
    // Allow non-empty if only ignorable entries (.git, .DS_Store) are present.
    const meaningful = contents.filter(
      (e) => !['.git', '.DS_Store', '.idea', '.vscode'].includes(e),
    );
    if (meaningful.length > 0) {
      throw new Error(
        `[flint] create-app: target directory "${opts.appName}" already exists and is not empty — remove it (or pick a fresh name) and re-run.`,
      );
    }
  }

  // --template <git+url> support (v0.9). When set, the bundled variant
  // templates are bypassed in favor of a git clone. The variant is still
  // recorded in the manifest (so `flint upgrade` can match against future
  // bundled templates), but the templateSource of each file points at the
  // git URL.
  let parsedTemplate: ReturnType<typeof import('../util/template-url.js').parseTemplateUrl> | undefined;
  if (opts.template) {
    const { parseTemplateUrl } = await import('../util/template-url.js');
    parsedTemplate = parseTemplateUrl(opts.template);
  }

  // Resolve variant + package manager + cf project name.
  const variant = await resolveVariant(opts.variant, opts.yes);
  const cfProject = opts.cfProject ?? opts.appName;
  validateProjectName(cfProject);
  const pm = resolvePackageManager(opts.pm);

  log.heading(`Creating ${variant} app: "${opts.appName}"`);
  log.dim(`  Target:           ${target}`);
  log.dim(`  Pages project:    ${cfProject}`);
  log.dim(`  Package manager:  ${pm}`);
  log.dim(`  Git init:         ${opts.noGit ? 'no' : 'yes'}`);
  log.dim(`  Install deps:     ${opts.noInstall ? 'no' : 'yes'}`);
  log.dim(`  Provision now:    ${opts.provision ? 'yes' : 'no'}`);
  log.blank();

  // Make the target directory.
  mkdirSync(target, { recursive: true });

  const flintVersion = readPackageVersion();
  // Template vars used in both skeleton + variant trees.
  const vars: TemplateVars = {
    appName: cfProject,
    appNameLower: cfProject.toLowerCase(),
    compatDate: todayISODate(),
    cookieName: `${cfProject.toLowerCase().replace(/[^a-z0-9]+/g, '_')}_admin`,
    tokenMessage: `${cfProject.toLowerCase().replace(/[^a-z0-9]+/g, '-')}-admin-session-v1`,
    flintVersion,
  };

  const tracker = new ManifestTracker(target, {
    command: parsedTemplate ? `create-app --template ${opts.template}` : 'create-app',
    flintVersion,
    variant,
    vars,
  });

  if (parsedTemplate) {
    // External template path: clone the git URL, copy its contents verbatim,
    // record each file into the manifest. Variable substitution is NOT applied
    // — custom templates own their own placeholder semantics. We still write
    // the manifest + dev.vars.example below so the project still feels like
    // a Flint scaffold.
    log.step(`Cloning template from ${opts.template}…`);
    const result = applyTemplate({
      targetDir: target,
      url: parsedTemplate,
      tracker,
    });
    log.ok(`Template: cloned ${result.filesCopied} file(s) from ${parsedTemplate.repoUrl}.`);
  } else {
    // Phase 1: lay down the shared skeleton (Vite + React + TS scaffold).
    const skeletonRoot = resolveTemplatesDir('_skeleton');
    const skeletonFiles = collectFiles(skeletonRoot);
    let writtenSkeleton = 0;
    for (const file of skeletonFiles) {
      const contents = writeTemplateFile(file, target, vars);
      tracker.record({
        relPath: file.dest,
        templateSource: `_skeleton/${rel(skeletonRoot, file.src)}`,
        contents,
      });
      writtenSkeleton += 1;
    }
    log.ok(`Skeleton: wrote ${writtenSkeleton} file(s).`);

    // Phase 2: overlay the variant tree on top of the skeleton. Conflicting
    // files (e.g. wrangler.toml) win from the variant.
    const variantRoot = resolveTemplatesDir(variant);
    const variantFiles = collectFiles(variantRoot);
    let writtenVariant = 0;
    for (const file of variantFiles) {
      const contents = writeTemplateFile(file, target, vars);
      tracker.record({
        relPath: file.dest,
        templateSource: `${variant}/${rel(variantRoot, file.src)}`,
        contents,
      });
      writtenVariant += 1;
    }
    log.ok(`Variant ${variant}: wrote ${writtenVariant} file(s).`);
  }

  // .dev.vars.example — programmatically generated (entries depend on variant).
  // Skip when using a custom template — the consumer-supplied repo owns its
  // own .dev.vars.example shape.
  if (!parsedTemplate) {
    const envEntries = devVarsEntriesForVariant(variant);
    const examplePath = writeDevVarsExample(target, envEntries);
    log.ok(`Wrote ${relative(target, examplePath)}`);
  }

  // Persist the manifest with the history entry for this run.
  tracker.flush();
  log.ok(`Wrote flint.manifest.json (${tracker.recordCount} file(s) tracked).`);

  // Optional: git init.
  if (!opts.noGit) {
    const ok = runGitInit(target);
    if (ok) {
      log.ok('Initialized empty git repository.');
    } else {
      log.warn('git init failed — install git or pass --no-git.');
    }
  }

  // Optional: package manager install.
  if (!opts.noInstall) {
    log.blank();
    log.step(`Running \`${pm} install\` (this can take a minute)…`);
    const ok = runInstall(target, pm);
    if (ok) {
      log.ok(`${pm} install completed.`);
    } else {
      log.warn(`${pm} install failed. Run it manually:  cd ${opts.appName} && ${pm} install`);
    }
  }

  // Optional: --provision = run `flint configure` against the new directory.
  if (opts.provision) {
    log.blank();
    log.heading('Provisioning Cloudflare resources for the new project');
    const prevCwd = process.cwd();
    try {
      process.chdir(target);
      await runConfigure({
        dryRun: false,
        skipPagesProject: false,
        skipKv: false,
        skipR2: false,
        skipSecrets: false,
      });
    } catch (e) {
      log.err(`[flint] create-app: provisioning step failed — ${e instanceof Error ? e.message : String(e)}. Scaffold was written successfully; finish provisioning with \`cd ${opts.appName} && flint configure\`.`);
    } finally {
      process.chdir(prevCwd);
    }
  }

  // What's next.
  log.blank();
  log.heading('Done.');
  printNextSteps(opts.appName, pm, variant, {
    didInstall: !opts.noInstall,
    didProvision: opts.provision,
  });

  formatResult(
    ok('create-app', {
      appName: opts.appName,
      variant,
      target,
      packageManager: pm,
      installed: !opts.noInstall,
      provisioned: opts.provision === true,
    }),
    { json: opts.json === true },
  );
}

// ─── helpers ───────────────────────────────────────────────────────────────

function validateAppName(name: string): void {
  if (!name || name.trim().length === 0) {
    throw new Error('[flint] create-app: app name is required — pass it as the positional argument: `flint create-app my-app`.');
  }
  if (/[\\/]/.test(name)) {
    throw new Error('[flint] create-app: app name must not contain path separators — pass a plain directory name like `my-app`.');
  }
  if (name === '.' || name === '..') {
    throw new Error('[flint] create-app: app name must not be "." or ".." — pass a plain directory name like `my-app`.');
  }
}

function validateProjectName(name: string): void {
  if (!/^[a-z][a-z0-9-]{1,57}[a-z0-9]$/.test(name)) {
    throw new Error(
      `[flint] create-app: Cloudflare Pages project name "${name}" is invalid — pass --cf-project with lowercase letters, digits, and hyphens (3–58 chars, must start with a letter, not end with a hyphen).`,
    );
  }
}

async function resolveVariant(
  raw: string | undefined,
  yes: boolean,
): Promise<CreateAppVariant> {
  if (raw) {
    if (!SUPPORTED_VARIANTS.includes(raw as CreateAppVariant)) {
      throw new Error(
        `[flint] create-app: unknown variant "${raw}" — pass --variant with one of: ${SUPPORTED_VARIANTS.join(', ')}.`,
      );
    }
    return raw as CreateAppVariant;
  }
  if (yes) {
    log.dim('--yes specified without --variant; defaulting to static-spa.');
    return 'static-spa';
  }
  const picked = await select<CreateAppVariant>({
    message: 'Which template variant?',
    choices: SUPPORTED_VARIANTS.map((v) => ({
      name: VARIANT_DESCRIPTIONS[v],
      value: v,
    })),
    default: 'static-spa',
  });
  return picked;
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
 * Walk a template tree and produce the list of files to write. Path mapping:
 *   - Files ending in `.tmpl` lose that suffix in the output.
 *   - The top-level `gitignore` template (no leading dot — npm strips
 *     dotfiles from published packages) becomes `.gitignore`.
 */
function collectFiles(templateRoot: string): PlannedFile[] {
  const planned: PlannedFile[] = [];
  walk(templateRoot, '');
  return planned;

  function walk(absDir: string, relDir: string): void {
    for (const entry of readdirSync(absDir)) {
      const abs = join(absDir, entry);
      // POSIX separators on the relative path — the manifest stores `/`
      // exclusively and `path.join` would return `\` on Windows.
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

function writeTemplateFile(file: PlannedFile, target: string, vars: TemplateVars): string {
  const destPath = join(target, file.dest);
  // Use the templating engine for .tmpl files; otherwise copy bytes verbatim
  // through readFile/writeFile (no template processing on non-tmpl files —
  // {{...}} in raw source files like `eslint.config.js` is unmolested).
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

/** Compute a POSIX-separator relative path. */
function rel(rootAbs: string, fileAbs: string): string {
  return fileAbs.slice(rootAbs.length + 1).split(/[\\/]/).join('/');
}

function resolveTemplatesDir(variant: string): string {
  // dist/commands/create-app.js  →  ../../templates/<variant>
  // src/commands/create-app.ts   →  ../../templates/<variant>  (vitest)
  const here = dirname(fileURLToPath(import.meta.url));
  const candidate = resolve(here, '..', '..', 'templates', variant);
  if (existsSync(candidate)) return candidate;
  throw new Error(
    `[flint] create-app: templates directory not found at ${candidate} — your Flint install is broken; reinstall with \`npm install -g @op4z/flint\`.`,
  );
}

function devVarsEntriesForVariant(variant: CreateAppVariant): DevVarsEntry[] {
  // static-spa needs only the CF token (for `wrangler pages deploy`); the
  // function variants additionally need the HMAC + admin-password pair.
  const cfEntries: DevVarsEntry[] = [
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
  ];
  if (variant === 'static-spa') return cfEntries;
  return [
    ...cfEntries,
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

function runGitInit(target: string): boolean {
  // `git init` first; `git branch -m main` to normalize the default branch
  // (git defaults to `master` on systems without init.defaultBranch set).
  const init = spawnSync('git', ['init', '--quiet'], { cwd: target, encoding: 'utf8' });
  if (init.status !== 0) return false;
  // Best-effort rename to main; ignore failures (already-main, no commits yet
  // edge cases; an explicit branch -m fails on an empty repo on older git).
  const cfg = spawnSync('git', ['symbolic-ref', 'HEAD', 'refs/heads/main'], {
    cwd: target,
    encoding: 'utf8',
  });
  void cfg;
  return true;
}

function runInstall(target: string, pm: PackageManager): boolean {
  const [bin, args] = installCommand(pm);
  // stdio: 'inherit' so the user sees the install progress live. We don't
  // capture output — install logs are noisy and timing-sensitive.
  const res = spawnSync(bin, args, {
    cwd: target,
    stdio: 'inherit',
  });
  return res.status === 0;
}

function printNextSteps(
  appName: string,
  pm: PackageManager,
  variant: CreateAppVariant,
  state: { didInstall: boolean; didProvision: boolean },
): void {
  log.info('Next steps:');
  log.info(`  cd ${appName}`);
  if (!state.didInstall) {
    log.info(`  ${pm} install`);
  }
  if (!state.didProvision) {
    log.info('  flint auth init     # if you have not stored a Cloudflare token yet');
    log.info('  flint configure     # create the Pages project + provision resources');
  }
  if (pm === 'npm') {
    log.info('  npm run dev         # local dev (Vite + wrangler pages dev)');
    log.info('  flint deploy        # build, pre-flight, deploy to Cloudflare Pages');
  } else {
    log.info(`  ${pm} run dev         # local dev (Vite + wrangler pages dev)`);
    log.info('  flint deploy        # build, pre-flight, deploy to Cloudflare Pages');
  }
  log.blank();
  log.dim(`Generated variant: ${variant}`);
}
