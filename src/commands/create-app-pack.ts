// `flint create-app <dir> --pack <pack-dir> --template <templateId>` — scaffold
// a new app from an EXTERNAL template pack instead of a built-in variant.
//
// This is the consumer side of the pack registry seam (see util/registry.ts +
// util/pack.ts). The business-aware content lives entirely in the pack; this
// command is the generic engine that:
//
//   1. Loads + validates the pack.json against contract `flint-pack-1`.
//   2. Resolves the pack's vars[] (provided values + from/transform
//      derivations + defaults + required enforcement).
//   3. Stamps the pack's core[] trees, then the chosen template's tree, into
//      the target directory — reusing the same collectFiles/writeTemplateFile/
//      manifest primitives the built-in scaffolders use.
//   4. Records flint.manifest.json with variant = the chosen template id and
//      the resolved vars persisted (so `flint upgrade` has the re-render args).
//   5. If the template declares bindings.d1=true, appends a [[d1_databases]]
//      block to the stamped wrangler.toml (opt-in; built-ins never do this).
//
// Composition order mirrors create-app's skeleton→variant overlay: core trees
// are laid down first (in declaration order), the template tree wins on
// conflict. Both are walked with the same `.tmpl`/gitignore rules.

import { existsSync, mkdirSync, readdirSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { input } from '@inquirer/prompts';
import { log } from '../util/logger.js';
import { type TemplateVars } from '../util/template.js';
import { ManifestTracker } from '../util/manifest-tracker.js';
import { readPackageVersion } from '../util/version.js';
import { collectFiles, relPosix, writeTemplateFile } from '../util/scaffold.js';
import {
  findTemplate,
  loadPack,
  resolvePackVars,
  type Pack,
  type PackTemplate,
} from '../util/pack.js';
import { formatResult, ok } from '../util/format-result.js';
import {
  appendD1DatabaseBlock,
  readWranglerToml,
  writeWranglerToml,
} from '../cloudflare/wrangler-toml.js';

export interface CreateAppFromPackOptions {
  /** Target directory name (created relative to cwd). */
  appName: string;
  /** Absolute or cwd-relative path to the pack directory (contains pack.json). */
  packDir: string;
  /** Template id to scaffold from. If omitted and interactive, the user picks. */
  templateId?: string;
  /**
   * Pre-resolved variable values keyed by var name. Whatever isn't provided is
   * derived/defaulted by the pack's vars[] graph (and required vars that can't
   * be resolved throw, unless interactive mode prompts for them).
   */
  vars?: Record<string, string>;
  /** Non-interactive mode — never prompt; missing required vars throw. */
  yes: boolean;
  /** Emit a structured JSON result on stdout instead of human output. */
  json?: boolean;
}

export async function runCreateAppFromPack(opts: CreateAppFromPackOptions): Promise<void> {
  validateAppName(opts.appName);

  // 1. Load + validate the pack.
  const pack = loadPack(resolve(process.cwd(), opts.packDir));
  log.dim(`Loaded pack "${pack.name}" v${pack.version} (${pack.templates.length} template(s)).`);

  // 2. Resolve the template id.
  const templateId = await resolveTemplateId(pack, opts.templateId, opts.yes);
  const template = findTemplate(pack, templateId);

  // 3. Resolve target directory.
  const target = resolve(process.cwd(), opts.appName);
  ensureEmptyTarget(target, opts.appName);

  // 4. Resolve variables (provided + prompted + derived).
  const provided = await collectProvidedVars(pack, opts.vars ?? {}, opts.yes);
  const vars = resolvePackVars({ pack, provided });

  log.heading(`Creating "${opts.appName}" from ${pack.name} / ${template.id}`);
  log.dim(`  Target:    ${target}`);
  log.dim(`  Rendering: ${template.rendering}`);
  log.dim(
    `  Bindings:  kv=${!!template.bindings.kv} r2=${!!template.bindings.r2} d1=${!!template.bindings.d1}`,
  );
  log.blank();

  mkdirSync(target, { recursive: true });

  const flintVersion = readPackageVersion();
  const tracker = new ManifestTracker(target, {
    // The "variant" recorded in the manifest is the template id, per spec.
    command: `create-app --pack ${pack.name} --template ${template.id}`,
    flintVersion,
    variant: template.id,
    vars,
  });

  // 5. Stamp core trees first, then the template tree (template wins on conflict).
  let coreCount = 0;
  for (const entry of pack.core) {
    coreCount += stampTree(
      pack,
      entry.from,
      entry.to,
      entry.exclude,
      target,
      vars,
      tracker,
      `core:${entry.from}`,
    );
  }
  log.ok(`Core: wrote ${coreCount} file(s) from ${pack.core.length} tree(s).`);

  const templateCount = stampTree(
    pack,
    template.path,
    '',
    [],
    target,
    vars,
    tracker,
    `template:${template.id}`,
  );
  log.ok(`Template ${template.id}: wrote ${templateCount} file(s).`);

  // 6. D1 seam — opt-in. If the template declares a D1 binding, ensure the
  //    stamped wrangler.toml carries a [[d1_databases]] block to provision.
  if (template.bindings.d1) {
    patchD1IntoWrangler(target, vars);
  }

  tracker.flush();
  log.ok(`Wrote flint.manifest.json (${tracker.recordCount} file(s) tracked).`);

  log.blank();
  log.heading('Done.');
  log.info('Next steps:');
  log.info(`  cd ${opts.appName}`);
  log.info('  flint auth init     # if you have not stored a Cloudflare token yet');
  log.info('  flint configure     # create the Pages project + provision resources');

  formatResult(
    ok('create-app', {
      appName: opts.appName,
      pack: pack.name,
      packVersion: pack.version,
      template: template.id,
      variant: template.id,
      target,
      rendering: template.rendering,
      bindings: template.bindings,
      vars,
      coreFiles: coreCount,
      templateFiles: templateCount,
    }),
    { json: opts.json === true },
  );
}

// ─── helpers ───────────────────────────────────────────────────────────────

function validateAppName(name: string): void {
  if (!name || name.trim().length === 0) {
    throw new Error('[flint] create-app: app name is required — pass it as the positional argument: `flint create-app my-app --pack <dir>`.');
  }
  if (/[\\/]/.test(name)) {
    throw new Error('[flint] create-app: app name must not contain path separators — pass a plain directory name like `my-app`.');
  }
  if (name === '.' || name === '..') {
    throw new Error('[flint] create-app: app name must not be "." or ".." — pass a plain directory name like `my-app`.');
  }
}

function ensureEmptyTarget(target: string, appName: string): void {
  if (existsSync(target)) {
    const contents = readdirSync(target);
    const meaningful = contents.filter(
      (e) => !['.git', '.DS_Store', '.idea', '.vscode'].includes(e),
    );
    if (meaningful.length > 0) {
      throw new Error(
        `[flint] create-app: target directory "${appName}" already exists and is not empty — remove it (or pick a fresh name) and re-run.`,
      );
    }
  }
}

async function resolveTemplateId(
  pack: Pack,
  raw: string | undefined,
  yes: boolean,
): Promise<string> {
  if (raw) {
    // findTemplate throws a clear error listing valid ids if not present.
    return findTemplate(pack, raw).id;
  }
  if (yes) {
    // Default to the first template in declaration order.
    const first = pack.templates[0]!;
    log.dim(`--yes without --template; defaulting to "${first.id}".`);
    return first.id;
  }
  const { select } = await import('@inquirer/prompts');
  return select<string>({
    message: 'Which template?',
    choices: pack.templates.map((t) => ({
      name: t.description ? `${t.title} — ${t.description}` : t.title,
      value: t.id,
    })),
    default: pack.templates[0]!.id,
  });
}

/**
 * Gather values for the pack's declared vars. In non-interactive mode we only
 * use what the caller provided (resolution + required-enforcement happens in
 * resolvePackVars). Interactively, we prompt for vars that are neither
 * provided nor derivable (no `from`) — i.e. the user-supplied "root" vars.
 */
async function collectProvidedVars(
  pack: Pack,
  provided: Record<string, string>,
  yes: boolean,
): Promise<Record<string, string>> {
  const out: Record<string, string> = { ...provided };
  if (yes) return out;

  for (const v of pack.vars) {
    // Only prompt for "root" vars the user must supply: not already provided,
    // not derived from another var. Derived/defaulted vars resolve later.
    if (out[v.name] !== undefined) continue;
    if (v.from) continue;
    if (v.default !== undefined && !v.required) continue;
    if (!v.required && !v.prompt) continue;

    const answer = await input({
      message: v.prompt ?? `Value for ${v.name}:`,
      default: v.default,
      validate: (val: string): true | string => {
        if (v.required && val.trim().length === 0) return `${v.name} is required.`;
        return true;
      },
    });
    if (answer.trim().length > 0) out[v.name] = answer.trim();
  }
  return out;
}

/**
 * Stamp one tree (a core path or a template path, both relative to the pack
 * root) into the target. Records each file into the manifest with a
 * templateSource that namespaces the pack so `flint upgrade` knows these came
 * from an external pack and can't be re-rendered from bundled templates.
 * Returns the number of files written.
 */
/**
 * Patterns never stamped into a generated site — test/spec files and build
 * artifacts. A pack's canonical core trees co-locate tests next to source
 * (good for the pack's own dev); those must not ship into client sites.
 */
const DEFAULT_STAMP_EXCLUDES = [
  '**/*.test.ts',
  '**/*.test.tsx',
  '**/*.spec.ts',
  '**/*.spec.tsx',
  '**/__tests__/**',
  '**/*.tsbuildinfo',
];

function stampTree(
  pack: Pack,
  fromRel: string,
  toSub: string,
  exclude: string[],
  target: string,
  vars: TemplateVars,
  tracker: ManifestTracker,
  sourceLabel: string,
): number {
  const root = join(pack.rootDir, fromRel);
  if (!existsSync(root)) {
    throw new Error(
      `[flint] create-app: pack "${pack.name}" declares tree "${fromRel}" but it does not exist on disk at ${root}.`,
    );
  }
  const files = collectFiles(root, [...DEFAULT_STAMP_EXCLUDES, ...exclude]);
  let written = 0;
  for (const file of files) {
    const dest = toSub ? `${toSub}/${file.dest}` : file.dest;
    const contents = writeTemplateFile({ src: file.src, dest }, target, vars);
    tracker.record({
      relPath: dest,
      templateSource: `pack:${pack.name}/${sourceLabel}/${relPosix(root, file.src)}`,
      contents,
    });
    written += 1;
  }
  return written;
}

/**
 * Append a `[[d1_databases]]` block to the stamped project's wrangler.toml.
 * Best-effort: if the pack template didn't ship a wrangler.toml we warn rather
 * than fail (the consumer can run `flint add d1` once they have one).
 */
function patchD1IntoWrangler(target: string, vars: TemplateVars): void {
  if (!existsSync(join(target, 'wrangler.toml'))) {
    log.warn('  Template declares a D1 binding but stamped no wrangler.toml — run `flint add d1 DB` after adding one.');
    return;
  }
  let doc;
  try {
    doc = readWranglerToml(target);
  } catch (e) {
    log.warn(`  Could not read stamped wrangler.toml for D1 patch: ${e instanceof Error ? e.message : String(e)}`);
    return;
  }
  if (doc.d1_databases.some((d) => d.binding === 'DB')) {
    log.dim('  wrangler.toml already declares a DB D1 binding — leaving as-is.');
    return;
  }
  const slug = (vars.siteSlug ?? vars.appNameLower ?? vars.appName ?? 'app')
    .toString()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-');
  const patched = appendD1DatabaseBlock(doc, {
    binding: 'DB',
    database_name: `${slug}-db`,
    comment: 'D1 database (declared by the template pack). Run `flint configure --d1` to provision.',
  });
  writeWranglerToml(target, patched);
  log.ok('  Appended [[d1_databases]] block (binding DB) to wrangler.toml.');
}

// Keep PackTemplate imported type referenced for the public option doc above.
export type { PackTemplate };
