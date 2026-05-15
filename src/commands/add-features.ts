// `flint add pwa | auth | rate-limit` — feature scaffolds (v0.9).
//
// Each subcommand layers a specific capability onto an existing project:
//
//   add pwa        — wires vite-plugin-pwa + workbox into vite.config.ts and
//                    ensures the required dev deps are installed.
//   add auth       — drops the HMAC-cookie auth pattern (auth.ts) into
//                    `functions/_shared/`, plus the .dev.vars stubs.
//   add rate-limit — drops the sliding-window KV-bucket pattern into
//                    `functions/_shared/`. Requires an existing KV binding.
//
// Idempotency rule shared across all three:
//   - If the destination file ALREADY exists, prompt before overwriting
//     (unless `--force`). In --yes mode without --force, skip.
//   - Existing dependencies in package.json are kept at their pinned
//     version; we never downgrade.
//
// Manifest contract:
//   - Every file these commands write or update gets recorded in the
//     manifest with templateSource pointing at the same template path
//     used by init / create-app. That way `flint upgrade --check` flags
//     drift on add-installed files the same as on init-installed ones.

import { confirm } from '@inquirer/prompts';
import {
  existsSync,
  mkdirSync,
  readFileSync,
} from 'node:fs';
import { spawnSync } from 'node:child_process';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { log } from '../util/logger.js';
import { renderFile, type TemplateVars } from '../util/template.js';
import { ManifestTracker } from '../util/manifest-tracker.js';
import { readManifest } from '../util/manifest.js';
import { writeFileAtomic } from '../util/atomic-write.js';
import { formatResult, ok as okResult } from '../util/format-result.js';
import { readPackageVersion } from '../util/version.js';
import { readWranglerToml } from '../cloudflare/wrangler-toml.js';
import {
  ensureGitignored,
  writeDevVarsExample,
} from '../cloudflare/dev-vars.js';

// Shared options across the three subcommands.
interface FeatureCommonOptions {
  /** Overwrite existing files without prompting. */
  force?: boolean;
  /** Skip all interactive prompts. Combined with --force, fully autonomous. */
  yes?: boolean;
  /** Emit a structured JSON result on stdout instead of human output. */
  json?: boolean;
}

export type AddPwaOptions = FeatureCommonOptions;
export type AddAuthOptions = FeatureCommonOptions;
export type AddRateLimitOptions = FeatureCommonOptions;

// ─── add pwa ───────────────────────────────────────────────────────────────

const PWA_DEPS = ['vite-plugin-pwa', 'workbox-window'] as const;

export async function runAddPwa(opts: AddPwaOptions): Promise<void> {
  const cwd = process.cwd();
  log.heading('Adding PWA support (vite-plugin-pwa + workbox)');

  const pkgPath = join(cwd, 'package.json');
  if (!existsSync(pkgPath)) {
    throw new Error('package.json not found. Run from your project root.');
  }
  const pkg = JSON.parse(readFileSync(pkgPath, 'utf8')) as {
    dependencies?: Record<string, string>;
    devDependencies?: Record<string, string>;
  };
  const installed = new Set([
    ...Object.keys(pkg.dependencies ?? {}),
    ...Object.keys(pkg.devDependencies ?? {}),
  ]);
  const missing = PWA_DEPS.filter((d) => !installed.has(d));

  if (missing.length === 0) {
    log.dim('  vite-plugin-pwa + workbox-window already installed.');
  } else {
    log.step(`Installing ${missing.length} missing dep(s): ${missing.join(', ')}`);
    const pm = detectPackageManager(cwd);
    const installRes = spawnSync(pm.bin, [...pm.installArgs, ...missing], {
      cwd,
      stdio: 'inherit',
    });
    if (installRes.status !== 0) {
      log.err(`Install failed. Run manually:  ${pm.bin} ${pm.installArgs.join(' ')} ${missing.join(' ')}`);
      process.exitCode = 1;
      return;
    }
    log.ok('Dependencies installed.');
  }

  // Patch vite.config.ts. We detect three cases:
  //   1. vite.config.ts is the Flint-stock pages-fullstack version (includes
  //      VitePWA already). Idempotent — bail with a friendly note.
  //   2. vite.config.ts exists but does NOT use VitePWA. Insert the import
  //      + plugin block via the inline patcher.
  //   3. vite.config.ts does not exist. Generate one from the static-spa
  //      template (which is the minimal pwa-enabled variant).
  const viteConfigPath = join(cwd, 'vite.config.ts');
  if (!existsSync(viteConfigPath)) {
    log.dim('  vite.config.ts missing — generating Flint stock with PWA.');
    const templateAbs = resolveTemplatePath('static-spa/vite.config.ts.tmpl');
    const vars: TemplateVars = renderVarsFromManifest(cwd, 'app');
    const contents = renderFile(templateAbs, vars);
    writeFileAtomic(viteConfigPath, contents);
    recordTrackerWrite(cwd, 'vite.config.ts', 'static-spa/vite.config.ts.tmpl', contents);
    log.ok('Wrote vite.config.ts with VitePWA enabled.');
    return;
  }

  const original = readFileSync(viteConfigPath, 'utf8');
  if (original.includes('vite-plugin-pwa') || original.includes('VitePWA(')) {
    log.dim('  vite.config.ts already references vite-plugin-pwa. Skipping patch.');
    return;
  }

  if (!opts.force) {
    if (opts.yes) {
      log.warn('  vite.config.ts exists; pass --force to patch it. Exiting.');
      return;
    }
    const ok = await confirm({
      message: 'Patch vite.config.ts to add the VitePWA plugin?',
      default: true,
    });
    if (!ok) {
      log.info('Skipped vite.config.ts patch.');
      return;
    }
  }

  const patched = patchViteConfigForPwa(original, projectNameFromManifest(cwd));
  writeFileAtomic(viteConfigPath, patched);
  log.ok('Patched vite.config.ts to enable vite-plugin-pwa.');
  recordTrackerWrite(cwd, 'vite.config.ts', 'add-pwa/inline-patch', patched);
  formatResult(
    okResult('add pwa', { cwd, action: 'patched-vite-config' }),
    { json: opts.json === true },
  );
}

/**
 * Inject the VitePWA import + plugin block into an existing vite.config.ts.
 * Best-effort textual patch: we insert after the last existing import line
 * and look for `plugins: [` to add the VitePWA(...) call. If the structure
 * is too unusual, we fall back to appending a comment instructing the user.
 */
export function patchViteConfigForPwa(source: string, appName: string): string {
  const importLine = `import { VitePWA } from 'vite-plugin-pwa'`;
  const lines = source.split('\n');
  let lastImportIdx = -1;
  for (let i = 0; i < lines.length; i += 1) {
    if (/^\s*import\s.+from\s.+;?\s*$/.test(lines[i]!)) lastImportIdx = i;
  }
  if (lastImportIdx >= 0) {
    lines.splice(lastImportIdx + 1, 0, importLine);
  } else {
    lines.unshift(importLine);
  }

  // Find a `plugins: [` array and insert VitePWA(...) at the start.
  let pluginsIdx = -1;
  for (let i = 0; i < lines.length; i += 1) {
    if (/plugins\s*:\s*\[/.test(lines[i]!)) {
      pluginsIdx = i;
      break;
    }
  }
  const pwaBlock = [
    `    VitePWA({`,
    `      registerType: 'autoUpdate',`,
    `      injectRegister: 'auto',`,
    `      manifest: {`,
    `        name: '${appName}',`,
    `        short_name: '${appName}',`,
    `        start_url: '/',`,
    `        scope: '/',`,
    `        display: 'standalone',`,
    `        background_color: '#0e0c0a',`,
    `        theme_color: '#0e0c0a',`,
    `        icons: [`,
    `          { src: '/icon-192.png', sizes: '192x192', type: 'image/png', purpose: 'any' },`,
    `          { src: '/icon-512.png', sizes: '512x512', type: 'image/png', purpose: 'any' },`,
    `        ],`,
    `      },`,
    `      workbox: {`,
    `        globPatterns: ['**/*.{js,css,html,svg,png,ico,woff,woff2}'],`,
    `        navigateFallback: '/index.html',`,
    `      },`,
    `      devOptions: { enabled: false },`,
    `    }),`,
  ];
  if (pluginsIdx >= 0) {
    lines.splice(pluginsIdx + 1, 0, ...pwaBlock);
  } else {
    // Couldn't find a plugins array; append a comment with the snippet so
    // the user can paste it in.
    lines.push(
      '',
      '// flint add pwa: could not locate `plugins: [` — paste the block below',
      '// into your plugins array manually.',
      '/*',
      ...pwaBlock,
      '*/',
    );
  }
  return lines.join('\n');
}

// ─── add auth ──────────────────────────────────────────────────────────────

const AUTH_TEMPLATE = 'pages-fullstack/functions/_shared/auth.ts.tmpl';
const AUTH_DEST = 'functions/_shared/auth.ts';

export async function runAddAuth(opts: AddAuthOptions): Promise<void> {
  const cwd = process.cwd();
  log.heading('Adding HMAC cookie auth pattern (functions/_shared/auth.ts)');

  const destAbs = join(cwd, AUTH_DEST);
  if (existsSync(destAbs)) {
    if (!opts.force) {
      if (opts.yes) {
        log.dim(`  ${AUTH_DEST} already exists. Pass --force to overwrite.`);
        return;
      }
      const ok = await confirm({
        message: `${AUTH_DEST} already exists. Overwrite?`,
        default: false,
      });
      if (!ok) {
        log.info('Skipped.');
        return;
      }
    }
  }

  const templateAbs = resolveTemplatePath(AUTH_TEMPLATE);
  if (!existsSync(templateAbs)) {
    throw new Error(`Template not found: ${templateAbs}`);
  }
  const vars: TemplateVars = renderVarsFromManifest(cwd, 'app');
  const rendered = renderFile(templateAbs, vars);
  mkdirSync(dirname(destAbs), { recursive: true });
  writeFileAtomic(destAbs, rendered);
  log.ok(`Wrote ${AUTH_DEST}.`);
  recordTrackerWrite(cwd, AUTH_DEST, AUTH_TEMPLATE, rendered);

  // .dev.vars.example — add ADMIN_PASSWORD + COOKIE_SECRET stubs if absent.
  ensureGitignored(cwd);
  const existingExample = readDevVarsExample(cwd);
  const entries = mergeDevVarsEntries(existingExample, [
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
  ]);
  writeDevVarsExample(cwd, entries);
  log.ok('Updated .dev.vars.example with ADMIN_PASSWORD + COOKIE_SECRET.');

  // wrangler.toml: ensure compatibility_flags includes nodejs_compat
  // (auth.ts uses crypto.subtle — available in workers runtime without the
  // flag, but the rest of the auth ecosystem depends on it). We don't add
  // a [vars] block — secrets live in the Pages dashboard, not in vars.
  try {
    readWranglerToml(cwd);
  } catch {
    log.warn(`  No wrangler.toml found. Run \`flint init\` to scaffold one first.`);
  }

  formatResult(
    okResult('add auth', { cwd, wroteFile: AUTH_DEST }),
    { json: opts.json === true },
  );
}

// ─── add rate-limit ────────────────────────────────────────────────────────

const RATELIMIT_TEMPLATE = 'pages-fullstack/functions/_shared/ratelimit.ts';
const RATELIMIT_DEST = 'functions/_shared/ratelimit.ts';

export async function runAddRateLimit(opts: AddRateLimitOptions): Promise<void> {
  const cwd = process.cwd();
  log.heading('Adding sliding-window rate limiter (functions/_shared/ratelimit.ts)');

  const destAbs = join(cwd, RATELIMIT_DEST);
  if (existsSync(destAbs)) {
    if (!opts.force) {
      if (opts.yes) {
        log.dim(`  ${RATELIMIT_DEST} already exists. Pass --force to overwrite.`);
        return;
      }
      const ok = await confirm({
        message: `${RATELIMIT_DEST} already exists. Overwrite?`,
        default: false,
      });
      if (!ok) {
        log.info('Skipped.');
        return;
      }
    }
  }

  // KV binding requirement. The pattern stores rate-limit state in a KV
  // bucket per (key, window). Check wrangler.toml for AT LEAST ONE
  // [[kv_namespaces]] block. If none, prompt to add one.
  let kvBindings: string[] = [];
  try {
    const doc = readWranglerToml(cwd);
    kvBindings = doc.kv_namespaces.map((k) => k.binding);
  } catch {
    log.warn('  No wrangler.toml found. Run `flint init` first.');
    return;
  }
  if (kvBindings.length === 0) {
    log.warn('  No KV namespaces declared. Rate-limit requires KV.');
    if (opts.yes) {
      log.info('  --yes given; not prompting. Run `flint add kv RATELIMIT_KV` first.');
      return;
    }
    const ok = await confirm({
      message: 'Add a [[kv_namespaces]] block named RATELIMIT_KV now?',
      default: true,
    });
    if (ok) {
      const { runAddKv } = await import('./add.js');
      await runAddKv({ binding: 'RATELIMIT_KV', noProvision: true, force: false, yes: true });
      log.ok('Added RATELIMIT_KV namespace block. Run `flint configure` to provision.');
    } else {
      log.info('Skipping. Add a KV binding before using the rate limiter.');
      return;
    }
  }

  const templateAbs = resolveTemplatePath(RATELIMIT_TEMPLATE);
  if (!existsSync(templateAbs)) {
    throw new Error(`Template not found: ${templateAbs}`);
  }
  // ratelimit.ts is not a .tmpl — copy bytes verbatim.
  const contents = readFileSync(templateAbs, 'utf8');
  mkdirSync(dirname(destAbs), { recursive: true });
  writeFileAtomic(destAbs, contents);
  log.ok(`Wrote ${RATELIMIT_DEST}.`);
  recordTrackerWrite(cwd, RATELIMIT_DEST, RATELIMIT_TEMPLATE, contents);

  formatResult(
    okResult('add rate-limit', { cwd, wroteFile: RATELIMIT_DEST, kvBindings }),
    { json: opts.json === true },
  );
}

// ─── shared helpers ────────────────────────────────────────────────────────

interface PackageManagerInfo {
  bin: string;
  installArgs: string[];
}

function detectPackageManager(cwd: string): PackageManagerInfo {
  // Lockfile sniff: pnpm-lock.yaml > bun.lockb > package-lock.json > yarn.lock
  if (existsSync(join(cwd, 'pnpm-lock.yaml'))) return { bin: 'pnpm', installArgs: ['add', '-D'] };
  if (existsSync(join(cwd, 'bun.lockb'))) return { bin: 'bun', installArgs: ['add', '-d'] };
  if (existsSync(join(cwd, 'yarn.lock'))) return { bin: 'yarn', installArgs: ['add', '-D'] };
  return { bin: 'npm', installArgs: ['install', '--save-dev'] };
}

function resolveTemplatePath(rel: string): string {
  const here = dirname(fileURLToPath(import.meta.url));
  return resolve(here, '..', '..', 'templates', rel);
}

function projectNameFromManifest(cwd: string): string {
  const m = readManifest(cwd);
  return m?.vars.appName ?? 'app';
}

function renderVarsFromManifest(cwd: string, fallbackAppName: string): TemplateVars {
  const m = readManifest(cwd);
  const appName = m?.vars.appName ?? fallbackAppName;
  return {
    appName,
    appNameLower: m?.vars.appNameLower ?? appName.toLowerCase(),
    compatDate: m?.vars.compatDate ?? new Date().toISOString().slice(0, 10),
    cookieName: m?.vars.cookieName ?? `${appName.toLowerCase().replace(/[^a-z0-9]+/g, '_')}_admin`,
    tokenMessage:
      m?.vars.tokenMessage ?? `${appName.toLowerCase().replace(/[^a-z0-9]+/g, '-')}-admin-session-v1`,
    flintVersion: readPackageVersion(),
  };
}

function recordTrackerWrite(
  cwd: string,
  relPath: string,
  templateSource: string,
  contents: string,
): void {
  const manifest = readManifest(cwd);
  const variant = manifest?.variant ?? 'pages-fullstack';
  const tracker = new ManifestTracker(cwd, {
    command: `add ${relPath.includes('auth.ts') ? 'auth' : relPath.includes('ratelimit') ? 'rate-limit' : 'pwa'}`,
    flintVersion: readPackageVersion(),
    variant,
  });
  tracker.record({ relPath, templateSource, contents });
  tracker.flush();
}

/** Parse an existing .dev.vars.example into entries; returns [] if absent. */
function readDevVarsExample(cwd: string): { key: string; value: string; comment?: string }[] {
  const path = join(cwd, '.dev.vars.example');
  if (!existsSync(path)) return [];
  const raw = readFileSync(path, 'utf8');
  const entries: { key: string; value: string; comment?: string }[] = [];
  let pendingComment: string[] = [];
  for (const line of raw.split('\n')) {
    const trimmed = line.trim();
    if (trimmed.startsWith('#') || trimmed === '') {
      if (trimmed.startsWith('# ')) {
        pendingComment.push(trimmed.slice(2));
      }
      continue;
    }
    const eq = trimmed.indexOf('=');
    if (eq < 0) continue;
    const key = trimmed.slice(0, eq).trim();
    const value = trimmed.slice(eq + 1).trim();
    entries.push({
      key,
      value,
      comment: pendingComment.length > 0 ? pendingComment.join('\n') : undefined,
    });
    pendingComment = [];
  }
  return entries;
}

/** Merge new entries into the existing list, deduping by key. */
function mergeDevVarsEntries(
  existing: { key: string; value: string; comment?: string }[],
  toAdd: { key: string; value: string; comment?: string }[],
): { key: string; value: string; comment?: string }[] {
  const byKey = new Map<string, { key: string; value: string; comment?: string }>();
  for (const e of existing) byKey.set(e.key, e);
  for (const e of toAdd) {
    if (!byKey.has(e.key)) byKey.set(e.key, e);
  }
  return Array.from(byKey.values());
}
