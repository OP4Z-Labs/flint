// `flint configure` — orchestrator that walks the user through provisioning
// every Cloudflare resource declared in `wrangler.toml` but not yet
// resolved (i.e. placeholder ids, no Pages project yet, etc.).
//
// Flow:
//   1. Pre-flight: confirm CLOUDFLARE_API_TOKEN is set (read from
//      ~/.config/flint/credentials, fall back to env, fall back to .dev.vars).
//      Confirm Account ID is resolved. Probe wrangler version (warn on <4).
//   2. Read wrangler.toml — detect Pages project + all bindings.
//   3. For each resource type, walk the user through:
//        - skip / configure / reuse-existing
//        - on "configure": invoke wrangler, capture the id, patch wrangler.toml
//        - on "reuse":     look up id via CF REST API, patch wrangler.toml
//   4. Secrets pass: prompt to set each secret name; values are piped to
//      `wrangler pages secret put` via stdin and never touch disk.
//   5. Print summary table.
//
// Modes:
//   - Interactive (default): every step prompts.
//   - --dry-run: print the planned commands and diffs without changing anything.

import { confirm, input, password as passwordPrompt, select } from '@inquirer/prompts';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  listKvNamespaces,
  listPagesProjects,
  listR2Buckets,
  verifyToken,
} from '../cloudflare/api.js';
import { readCredentials, type Credentials } from '../cloudflare/credentials.js';
import {
  getWranglerVersion,
  parseMajor,
  runWrangler,
} from '../cloudflare/wrangler-runner.js';
import {
  patchKvNamespace,
  patchR2Bucket,
  readWranglerToml,
  writeWranglerToml,
  diffTomlText,
  type WranglerToml,
} from '../cloudflare/wrangler-toml.js';
import { log } from '../util/logger.js';
import { formatResult, ok } from '../util/format-result.js';

export interface ConfigureOptions {
  /** Show what would happen without invoking wrangler or writing anything. */
  dryRun: boolean;
  /** Skip the Pages-project step. */
  skipPagesProject: boolean;
  /** Skip the KV-namespace step. */
  skipKv: boolean;
  /** Skip the R2 bucket step. */
  skipR2: boolean;
  /** Skip the secrets step. */
  skipSecrets: boolean;
  /** Optional list of secret names to set. If empty, we'll prompt. */
  secrets?: string[];
  /** Emit a structured JSON result on stdout instead of human output. */
  json?: boolean;
}

interface ConfigureContext {
  cwd: string;
  creds: Credentials;
  doc: WranglerToml;
  /** Track applied changes so the summary at the end is accurate. */
  summary: SummaryEntry[];
  /** When true, no real wrangler calls, no disk writes. */
  dryRun: boolean;
}

type ResourceKind = 'pages-project' | 'kv' | 'r2' | 'secret';

interface SummaryEntry {
  kind: ResourceKind;
  /** Human label, e.g. "MEDIA_BUCKET" or the Pages project name. */
  label: string;
  /** Final value: id for KV, bucket name for R2, "set" for secret. */
  result: string;
  /** "created", "reused", "skipped", "would-create" (dry run). */
  status: 'created' | 'reused' | 'skipped' | 'would-create' | 'failed';
}

export async function runConfigure(opts: ConfigureOptions): Promise<void> {
  const cwd = process.cwd();

  // Pre-flight
  //
  // The token must be PRESENT (otherwise the user has nothing to dry-run
  // with) — but in dry-run mode we deliberately skip the network probe
  // (`GET /user/tokens/verify`). Hitting CF during a dry-run defeats the
  // CI / offline ergonomics the flag is there to support. Resource-config
  // helpers below already handle list-call failures with a warning, so a
  // fully offline dry-run produces a plan-only output (no real changes).
  const creds = await loadCredentialsOrExit(cwd);
  if (opts.dryRun) {
    log.dim('--dry-run: skipping Cloudflare token verify (no network probe).');
  } else {
    await verifyTokenOrExit(creds);
  }
  warnOnOldWrangler(cwd);

  const doc = readWranglerToml(cwd);
  log.heading(`Configuring Cloudflare resources for "${doc.name ?? '(unnamed project)'}"`);
  log.dim(`  wrangler.toml: ${cwd}/wrangler.toml`);
  log.dim(`  Account:       ${creds.accountName} (${creds.accountId})`);
  if (opts.dryRun) log.warn('--dry-run: no changes will be applied.');
  log.blank();

  const ctx: ConfigureContext = {
    cwd,
    creds,
    doc,
    summary: [],
    dryRun: opts.dryRun,
  };

  if (!opts.skipPagesProject) {
    await configurePagesProject(ctx);
  }
  if (!opts.skipKv) {
    await configureKvNamespaces(ctx);
  }
  if (!opts.skipR2) {
    await configureR2Buckets(ctx);
  }
  if (!opts.skipSecrets) {
    await configureSecrets(ctx, opts.secrets ?? []);
  }

  // Writeback + summary
  const changed = ctx.doc.raw !== doc.raw;
  if (changed && !ctx.dryRun) {
    writeWranglerToml(cwd, ctx.doc);
    log.ok(`Updated ${cwd}/wrangler.toml.`);
  } else if (changed && ctx.dryRun) {
    log.heading('Planned diff for wrangler.toml');
    console.log(diffTomlText(doc.raw, ctx.doc.raw));
  } else if (!changed) {
    log.dim('No changes to wrangler.toml.');
  }

  printSummary(ctx.summary);
  log.blank();
  log.info('Next: `npm run dev` to test locally, or `npm run deploy` to ship.');

  formatResult(
    ok('configure', {
      cwd,
      dryRun: ctx.dryRun,
      wranglerTomlChanged: changed,
      summary: ctx.summary,
    }),
    { json: opts.json === true },
  );
}

// Pre-flight ───────────────────────────────────────────────────────────────

export async function loadCredentialsOrExit(cwd: string): Promise<Credentials> {
  let creds = readCredentials();
  if (creds) return creds;

  // Fallback A: process.env (CI / shell-exported).
  const envToken = process.env.CLOUDFLARE_API_TOKEN;
  const envAccount = process.env.CLOUDFLARE_ACCOUNT_ID;
  if (envToken && envAccount) {
    return {
      token: envToken,
      accountId: envAccount,
      accountName: '(from CLOUDFLARE_ACCOUNT_ID env)',
      createdAt: new Date(0).toISOString(),
    };
  }

  // Fallback B: parse .dev.vars in cwd.
  const devVarsPath = join(cwd, '.dev.vars');
  if (existsSync(devVarsPath)) {
    creds = parseDevVarsForCreds(devVarsPath);
    if (creds) return creds;
  }

  log.err('No Cloudflare API token found.');
  log.info('Run `flint auth init` first to store one.');
  process.exit(2);
}

function parseDevVarsForCreds(path: string): Credentials | null {
  try {
    const raw = readFileSync(path, 'utf8');
    const token = matchEnvLine(raw, 'CLOUDFLARE_API_TOKEN');
    const accountId = matchEnvLine(raw, 'CLOUDFLARE_ACCOUNT_ID');
    if (token && accountId) {
      return {
        token,
        accountId,
        accountName: '(from .dev.vars)',
        createdAt: new Date(0).toISOString(),
      };
    }
  } catch {
    // Permissions, parse failures — fall through.
  }
  return null;
}

function matchEnvLine(body: string, key: string): string | null {
  const re = new RegExp(`^\\s*${key}\\s*=\\s*(?:"([^"]*)"|([^\\s#]+))`, 'm');
  const m = re.exec(body);
  if (!m) return null;
  return m[1] ?? m[2] ?? null;
}

async function verifyTokenOrExit(creds: Credentials): Promise<void> {
  try {
    const v = await verifyToken(creds.token);
    if (!v.active) {
      log.err('Cloudflare reports the stored token is not active.');
      log.info('Run `flint auth rotate` to replace it.');
      process.exit(2);
    }
  } catch (e) {
    log.err(`Could not verify token with Cloudflare: ${e instanceof Error ? e.message : String(e)}`);
    log.info('Check your network connection or run `flint auth doctor`.');
    process.exit(2);
  }
}

function warnOnOldWrangler(cwd: string): void {
  const version = getWranglerVersion(cwd);
  if (!version) {
    log.warn(
      'Could not detect a `wrangler` binary on PATH or in node_modules/.bin.\n' +
        '  Install wrangler@^4 in this repo before continuing: `npm install -D wrangler@^4`.',
    );
    return;
  }
  const major = parseMajor(version);
  if (major !== null && major < 4) {
    log.warn(
      `Detected wrangler@${version}. Flint targets wrangler@^4 — some commands may behave differently.\n` +
        '  Upgrade with: `npm install -D wrangler@^4`.',
    );
  } else {
    log.dim(`Detected wrangler@${version}.`);
  }
}

// Pages project ────────────────────────────────────────────────────────────

async function configurePagesProject(ctx: ConfigureContext): Promise<void> {
  const projectName = ctx.doc.name;
  if (!projectName) {
    log.warn('wrangler.toml has no `name` field — skipping Pages project step.');
    ctx.summary.push({
      kind: 'pages-project',
      label: '(none)',
      result: '(no name in wrangler.toml)',
      status: 'skipped',
    });
    return;
  }

  log.heading(`Pages project: ${projectName}`);

  // Idempotency: does the project already exist?
  let existing: string[] = [];
  try {
    const projects = await listPagesProjects(ctx.creds.token, ctx.creds.accountId);
    existing = projects.map((p) => p.name);
  } catch (e) {
    log.warn(`Could not list existing Pages projects: ${e instanceof Error ? e.message : String(e)}`);
  }

  if (existing.includes(projectName)) {
    log.ok(`Pages project "${projectName}" already exists — reusing.`);
    ctx.summary.push({
      kind: 'pages-project',
      label: projectName,
      result: 'exists',
      status: 'reused',
    });
    return;
  }

  const action = await select<'create' | 'skip'>({
    message: `Create Pages project "${projectName}"?`,
    choices: [
      { name: 'Yes — wrangler pages project create', value: 'create' },
      { name: 'Skip', value: 'skip' },
    ],
    default: 'create',
  });

  if (action === 'skip') {
    ctx.summary.push({
      kind: 'pages-project',
      label: projectName,
      result: '(skipped by user)',
      status: 'skipped',
    });
    return;
  }

  const branch = await input({
    message: 'Production branch:',
    default: 'main',
  });

  const cmd = ['pages', 'project', 'create', projectName, '--production-branch', branch];
  if (ctx.dryRun) {
    printPlannedCmd(cmd);
    ctx.summary.push({
      kind: 'pages-project',
      label: projectName,
      result: '(dry-run)',
      status: 'would-create',
    });
    return;
  }

  log.step(`Running: wrangler ${cmd.join(' ')}`);
  const res = runWrangler(cmd, {
    cwd: ctx.cwd,
    token: ctx.creds.token,
    accountId: ctx.creds.accountId,
  });
  if (res.status !== 0) {
    log.err(`wrangler pages project create failed (exit ${res.status}).`);
    log.info(res.output.trim());
    ctx.summary.push({
      kind: 'pages-project',
      label: projectName,
      result: `(failed: status ${res.status})`,
      status: 'failed',
    });
    return;
  }
  log.ok(`Created Pages project "${projectName}".`);
  ctx.summary.push({
    kind: 'pages-project',
    label: projectName,
    result: 'created',
    status: 'created',
  });
}

// KV namespaces ────────────────────────────────────────────────────────────

const KV_PLACEHOLDER_ID = 'REPLACE_WITH_KV_NAMESPACE_ID';

async function configureKvNamespaces(ctx: ConfigureContext): Promise<void> {
  if (ctx.doc.kv_namespaces.length === 0) {
    log.dim('No [[kv_namespaces]] declared. Add one with `flint add kv <BINDING>`.');
    return;
  }

  // Fetch existing namespaces once so we can offer "reuse" for every binding.
  let existing: { id: string; title: string }[] = [];
  try {
    existing = await listKvNamespaces(ctx.creds.token, ctx.creds.accountId);
  } catch (e) {
    log.warn(`Could not list KV namespaces: ${e instanceof Error ? e.message : String(e)}`);
  }

  for (const entry of ctx.doc.kv_namespaces) {
    const isPlaceholder =
      !entry.id || entry.id === KV_PLACEHOLDER_ID || /^REPLACE_/i.test(entry.id);
    if (!isPlaceholder) {
      log.dim(`KV ${entry.binding}: id already set (${entry.id}). Skipping.`);
      ctx.summary.push({
        kind: 'kv',
        label: entry.binding,
        result: entry.id!,
        status: 'reused',
      });
      continue;
    }

    log.heading(`KV namespace for binding ${entry.binding}`);
    const defaultTitle =
      `${(ctx.doc.name ?? 'app').toLowerCase()}-${entry.binding.toLowerCase().replace(/[^a-z0-9]+/g, '-')}`;

    const action = await select<'create' | 'reuse' | 'skip'>({
      message: `Action for ${entry.binding}?`,
      choices: [
        { name: 'Create a new namespace', value: 'create' },
        { name: 'Reuse an existing namespace', value: 'reuse' },
        { name: 'Skip', value: 'skip' },
      ],
      default: 'create',
    });
    if (action === 'skip') {
      ctx.summary.push({
        kind: 'kv',
        label: entry.binding,
        result: '(skipped)',
        status: 'skipped',
      });
      continue;
    }

    if (action === 'reuse') {
      if (existing.length === 0) {
        log.warn('No existing KV namespaces visible to this token.');
        ctx.summary.push({
          kind: 'kv',
          label: entry.binding,
          result: '(none to reuse)',
          status: 'skipped',
        });
        continue;
      }
      const id = await select<string>({
        message: 'Pick an existing namespace:',
        choices: existing.map((n) => ({ name: `${n.title} (${n.id})`, value: n.id })),
      });
      ctx.doc = patchKvNamespace(ctx.doc, entry.binding, { id, preview_id: id });
      log.ok(`Patched [[kv_namespaces]] binding="${entry.binding}" id=${id}.`);
      ctx.summary.push({
        kind: 'kv',
        label: entry.binding,
        result: id,
        status: 'reused',
      });
      continue;
    }

    // action === 'create'
    const title = await input({
      message: 'Namespace title (visible in CF dashboard):',
      default: defaultTitle,
    });

    // Detect a name collision before invoking wrangler (saves an error).
    const collision = existing.find((n) => n.title === title);
    if (collision) {
      const reuse = await confirm({
        message: `A namespace titled "${title}" already exists (${collision.id}). Reuse it?`,
        default: true,
      });
      if (reuse) {
        ctx.doc = patchKvNamespace(ctx.doc, entry.binding, {
          id: collision.id,
          preview_id: collision.id,
        });
        log.ok(`Patched [[kv_namespaces]] binding="${entry.binding}" id=${collision.id}.`);
        ctx.summary.push({
          kind: 'kv',
          label: entry.binding,
          result: collision.id,
          status: 'reused',
        });
        continue;
      }
    }

    const cmd = ['kv', 'namespace', 'create', title];
    if (ctx.dryRun) {
      printPlannedCmd(cmd);
      ctx.summary.push({
        kind: 'kv',
        label: entry.binding,
        result: '(dry-run)',
        status: 'would-create',
      });
      continue;
    }

    log.step(`Running: wrangler ${cmd.join(' ')}`);
    const res = runWrangler(cmd, {
      cwd: ctx.cwd,
      token: ctx.creds.token,
      accountId: ctx.creds.accountId,
    });
    if (res.status !== 0) {
      log.err(`wrangler kv namespace create failed (exit ${res.status}).`);
      log.info(res.output.trim());
      ctx.summary.push({
        kind: 'kv',
        label: entry.binding,
        result: `(failed: status ${res.status})`,
        status: 'failed',
      });
      continue;
    }
    const id = extractKvIdFromOutput(res.output);
    if (!id) {
      log.err(`Could not extract namespace id from wrangler output:\n${res.output}`);
      ctx.summary.push({
        kind: 'kv',
        label: entry.binding,
        result: '(id parse failed)',
        status: 'failed',
      });
      continue;
    }
    ctx.doc = patchKvNamespace(ctx.doc, entry.binding, { id, preview_id: id });
    log.ok(`Created namespace "${title}" id=${id}; patched wrangler.toml.`);
    ctx.summary.push({
      kind: 'kv',
      label: entry.binding,
      result: id,
      status: 'created',
    });
  }
}

/**
 * Wrangler 4.x prints the new namespace id in one of two shapes depending on
 * the version. We try both:
 *
 *   1) JSON object on stdout: `{"id":"abc123","title":"..."}`
 *   2) A line like: `id = "abc123"` (TOML snippet to paste)
 *   3) A line like: `Created namespace with title "X" and id "abc123"`
 */
export function extractKvIdFromOutput(output: string): string | null {
  // JSON form
  const jsonMatch = /"id"\s*:\s*"([0-9a-f]{16,})"/i.exec(output);
  if (jsonMatch) return jsonMatch[1]!;
  // TOML snippet form (`id = "abc"`)
  const tomlMatch = /\bid\s*=\s*"([0-9a-f]{16,})"/i.exec(output);
  if (tomlMatch) return tomlMatch[1]!;
  // Sentence form
  const sentenceMatch = /id\s+["']([0-9a-f]{16,})["']/i.exec(output);
  if (sentenceMatch) return sentenceMatch[1]!;
  return null;
}

// R2 buckets ───────────────────────────────────────────────────────────────

async function configureR2Buckets(ctx: ConfigureContext): Promise<void> {
  if (ctx.doc.r2_buckets.length === 0) {
    log.dim('No [[r2_buckets]] declared. Add one with `flint add r2 <BINDING>`.');
    return;
  }

  let existing: { name: string }[] = [];
  try {
    existing = await listR2Buckets(ctx.creds.token, ctx.creds.accountId);
  } catch (e) {
    log.warn(`Could not list R2 buckets: ${e instanceof Error ? e.message : String(e)}`);
  }

  for (const entry of ctx.doc.r2_buckets) {
    log.heading(`R2 bucket for binding ${entry.binding}`);
    const currentName = entry.bucket_name;
    const defaultName =
      currentName && !/^REPLACE_/i.test(currentName)
        ? currentName
        : `${(ctx.doc.name ?? 'app').toLowerCase()}-${entry.binding.toLowerCase().replace(/[^a-z0-9]+/g, '-')}`;

    // Already-resolved + already-exists in the account → reuse silently.
    if (currentName && existing.some((b) => b.name === currentName)) {
      log.ok(`R2 bucket "${currentName}" already exists — reusing.`);
      ctx.summary.push({
        kind: 'r2',
        label: entry.binding,
        result: currentName,
        status: 'reused',
      });
      continue;
    }

    const action = await select<'create' | 'reuse' | 'skip'>({
      message: `Action for ${entry.binding}?`,
      choices: [
        { name: `Create a new bucket (default name: ${defaultName})`, value: 'create' },
        { name: 'Reuse an existing bucket', value: 'reuse' },
        { name: 'Skip', value: 'skip' },
      ],
      default: 'create',
    });
    if (action === 'skip') {
      ctx.summary.push({
        kind: 'r2',
        label: entry.binding,
        result: '(skipped)',
        status: 'skipped',
      });
      continue;
    }

    if (action === 'reuse') {
      if (existing.length === 0) {
        log.warn('No existing R2 buckets visible to this token.');
        ctx.summary.push({
          kind: 'r2',
          label: entry.binding,
          result: '(none to reuse)',
          status: 'skipped',
        });
        continue;
      }
      const name = await select<string>({
        message: 'Pick an existing bucket:',
        choices: existing.map((b) => ({ name: b.name, value: b.name })),
      });
      ctx.doc = patchR2Bucket(ctx.doc, entry.binding, { bucket_name: name });
      log.ok(`Patched [[r2_buckets]] binding="${entry.binding}" bucket_name=${name}.`);
      ctx.summary.push({
        kind: 'r2',
        label: entry.binding,
        result: name,
        status: 'reused',
      });
      continue;
    }

    // create
    const bucketName = await input({
      message: 'Bucket name (must be globally unique within your account):',
      default: defaultName,
      validate: (v: string): true | string => {
        if (!/^[a-z0-9][a-z0-9-]{1,61}[a-z0-9]$/.test(v)) {
          return 'Bucket name must be 3-63 chars: lowercase letters, digits, hyphens; cannot start/end with a hyphen.';
        }
        return true;
      },
    });
    const location = await select<'auto' | 'wnam' | 'enam' | 'eu' | 'apac'>({
      message: 'Location hint:',
      choices: [
        { name: 'auto (Cloudflare picks)', value: 'auto' },
        { name: 'wnam (Western North America)', value: 'wnam' },
        { name: 'enam (Eastern North America)', value: 'enam' },
        { name: 'eu (Europe)', value: 'eu' },
        { name: 'apac (Asia-Pacific)', value: 'apac' },
      ],
      default: 'auto',
    });

    const cmd = ['r2', 'bucket', 'create', bucketName];
    if (location !== 'auto') {
      cmd.push('--location', location);
    }
    if (ctx.dryRun) {
      printPlannedCmd(cmd);
      ctx.summary.push({
        kind: 'r2',
        label: entry.binding,
        result: '(dry-run)',
        status: 'would-create',
      });
      // Still patch the doc in dry-run so the diff shows the user the intended change.
      ctx.doc = patchR2Bucket(ctx.doc, entry.binding, { bucket_name: bucketName });
      continue;
    }

    log.step(`Running: wrangler ${cmd.join(' ')}`);
    const res = runWrangler(cmd, {
      cwd: ctx.cwd,
      token: ctx.creds.token,
      accountId: ctx.creds.accountId,
    });
    if (res.status !== 0) {
      log.err(`wrangler r2 bucket create failed (exit ${res.status}).`);
      log.info(res.output.trim());
      ctx.summary.push({
        kind: 'r2',
        label: entry.binding,
        result: `(failed: status ${res.status})`,
        status: 'failed',
      });
      continue;
    }
    ctx.doc = patchR2Bucket(ctx.doc, entry.binding, { bucket_name: bucketName });
    log.ok(`Created R2 bucket "${bucketName}"; patched wrangler.toml.`);
    ctx.summary.push({
      kind: 'r2',
      label: entry.binding,
      result: bucketName,
      status: 'created',
    });
  }
}

// Secrets ──────────────────────────────────────────────────────────────────

async function configureSecrets(ctx: ConfigureContext, names: string[]): Promise<void> {
  if (!ctx.doc.name) {
    log.warn('wrangler.toml has no `name` field — cannot configure Pages secrets.');
    return;
  }

  const list = names.length > 0 ? names : await promptForSecretNames();
  if (list.length === 0) return;

  for (const name of list) {
    await configureSecret(ctx, name);
  }
}

async function promptForSecretNames(): Promise<string[]> {
  const wantSecrets = await confirm({
    message: 'Configure any Pages secrets now?',
    default: false,
  });
  if (!wantSecrets) return [];
  const raw = await input({
    message: 'Secret names to set (comma-separated, e.g. ADMIN_PASSWORD,COOKIE_SECRET):',
    default: '',
  });
  return raw
    .split(',')
    .map((s) => s.trim().toUpperCase())
    .filter((s) => s.length > 0);
}

async function configureSecret(ctx: ConfigureContext, name: string): Promise<void> {
  log.heading(`Pages secret: ${name}`);

  const value = await passwordPrompt({
    message: `Value for ${name} (hidden):`,
    mask: '*',
    validate: (v: string): true | string => {
      if (!v) return 'Secret value cannot be empty.';
      return true;
    },
  });

  const cmd = ['pages', 'secret', 'put', name, '--project-name', ctx.doc.name!];
  if (ctx.dryRun) {
    printPlannedCmd(cmd);
    log.dim('  (the secret value would be piped to wrangler via stdin — never written to disk)');
    ctx.summary.push({
      kind: 'secret',
      label: name,
      result: '(dry-run)',
      status: 'would-create',
    });
    return;
  }

  log.step(`Running: wrangler ${cmd.join(' ')}`);
  const res = runWrangler(cmd, {
    cwd: ctx.cwd,
    token: ctx.creds.token,
    accountId: ctx.creds.accountId,
    stdin: value + '\n',
  });
  if (res.status !== 0) {
    log.err(`wrangler pages secret put failed (exit ${res.status}).`);
    log.info(res.output.trim());
    ctx.summary.push({
      kind: 'secret',
      label: name,
      result: `(failed: status ${res.status})`,
      status: 'failed',
    });
    return;
  }
  log.ok(`Set secret ${name} for project ${ctx.doc.name}.`);
  ctx.summary.push({
    kind: 'secret',
    label: name,
    result: 'set',
    status: 'created',
  });
}

// Summary table ────────────────────────────────────────────────────────────

function printSummary(rows: SummaryEntry[]): void {
  if (rows.length === 0) {
    log.dim('No resources configured.');
    return;
  }
  log.heading('Summary');
  const kindCol = padCol(rows.map((r) => r.kind), 14);
  const labelCol = padCol(rows.map((r) => r.label), 24);
  const statusCol = padCol(rows.map((r) => r.status), 14);
  for (let i = 0; i < rows.length; i++) {
    const r = rows[i]!;
    console.log(`  ${kindCol[i]}  ${labelCol[i]}  ${statusCol[i]}  ${r.result}`);
  }
}

function padCol(values: string[], minWidth: number): string[] {
  const w = Math.max(minWidth, ...values.map((v) => v.length));
  return values.map((v) => v.padEnd(w, ' '));
}

function printPlannedCmd(args: string[]): void {
  log.dim(`  would run: wrangler ${args.join(' ')}`);
}
