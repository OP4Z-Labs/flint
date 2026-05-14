// `flint add kv|r2|secret` — additive scaffolds, post-init.
//
// Each subcommand:
//   1. Mutates wrangler.toml (or .dev.vars.example for secrets) to declare
//      the new resource.
//   2. Optionally prompts to run `flint configure` immediately to provision it.
//
// Idempotency: every command detects an existing entry with the same
// identifier (binding name, secret name) and offers reuse / rename / skip.
//
// Secrets DO NOT get their value written to disk. The only on-disk side
// effect is a documented stub line in .dev.vars.example (e.g.
// `ADMIN_PASSWORD=    # plaintext password ...`). The real value is piped
// to wrangler via stdin during provisioning.

import { confirm, input, password as passwordPrompt } from '@inquirer/prompts';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  appendKvNamespaceBlock,
  appendR2BucketBlock,
  readWranglerToml,
  writeWranglerToml,
} from '../cloudflare/wrangler-toml.js';
import { DEV_VARS_EXAMPLE_FILENAME } from '../util/paths.js';
import { log } from '../util/logger.js';
import { runConfigure } from './configure.js';
import { loadCredentialsOrExit } from './configure.js';
import { runWrangler } from '../cloudflare/wrangler-runner.js';

export interface AddKvOptions {
  /** Binding name as it appears in `[[kv_namespaces]]`. Required. */
  binding: string;
  /** Skip the "provision now?" prompt and never trigger configure. */
  noProvision: boolean;
  /** Force overwrite if a binding with the same name exists. */
  force: boolean;
  /** Accept defaults; never prompt. */
  yes: boolean;
}

export async function runAddKv(opts: AddKvOptions): Promise<void> {
  const cwd = process.cwd();
  const binding = normalizeBinding(opts.binding);
  let doc = readWranglerToml(cwd);

  const existing = doc.kv_namespaces.find((e) => e.binding === binding);
  if (existing) {
    log.warn(`A [[kv_namespaces]] block with binding="${binding}" already exists.`);
    if (!opts.force) {
      if (opts.yes) {
        log.info('Refusing to overwrite (no --force). Exiting.');
        return;
      }
      const proceed = await confirm({
        message: 'Append another block anyway? (This is rarely what you want.)',
        default: false,
      });
      if (!proceed) return;
    }
  }

  log.heading(`Adding KV namespace binding ${binding}`);
  doc = appendKvNamespaceBlock(doc, {
    binding,
    comment:
      `KV namespace for ${binding}. Run \`flint configure --kv ${binding}\` to provision.`,
  });
  writeWranglerToml(cwd, doc);
  log.ok(`Appended [[kv_namespaces]] block to wrangler.toml.`);

  await maybeRunConfigure({
    skipPagesProject: true,
    skipKv: false,
    skipR2: true,
    skipSecrets: true,
    yes: opts.yes,
    noProvision: opts.noProvision,
  });
}

export interface AddR2Options {
  binding: string;
  noProvision: boolean;
  force: boolean;
  yes: boolean;
}

export async function runAddR2(opts: AddR2Options): Promise<void> {
  const cwd = process.cwd();
  const binding = normalizeBinding(opts.binding);
  let doc = readWranglerToml(cwd);

  const existing = doc.r2_buckets.find((e) => e.binding === binding);
  if (existing && !opts.force) {
    if (opts.yes) {
      log.warn(
        `A [[r2_buckets]] block with binding="${binding}" already exists. Use --force to overwrite. Exiting.`,
      );
      return;
    }
    const action = await confirm({
      message: `An [[r2_buckets]] block with binding="${binding}" already exists. Append another anyway?`,
      default: false,
    });
    if (!action) return;
  }

  const defaultName =
    `${(doc.name ?? 'app').toLowerCase()}-${binding.toLowerCase().replace(/[^a-z0-9]+/g, '-')}`;
  const bucketName = opts.yes
    ? defaultName
    : await input({
        message: 'Bucket name (globally unique within your account):',
        default: defaultName,
        validate: (v: string): true | string => {
          if (!/^[a-z0-9][a-z0-9-]{1,61}[a-z0-9]$/.test(v)) {
            return 'Bucket name must be 3-63 chars: lowercase letters, digits, hyphens; cannot start/end with a hyphen.';
          }
          return true;
        },
      });

  log.heading(`Adding R2 bucket binding ${binding}`);
  doc = appendR2BucketBlock(doc, {
    binding,
    bucket_name: bucketName,
    comment:
      `R2 bucket for ${binding}. Run \`flint configure --r2 ${binding}\` to provision.`,
  });
  writeWranglerToml(cwd, doc);
  log.ok(`Appended [[r2_buckets]] block to wrangler.toml.`);

  await maybeRunConfigure({
    skipPagesProject: true,
    skipKv: true,
    skipR2: false,
    skipSecrets: true,
    yes: opts.yes,
    noProvision: opts.noProvision,
  });
}

export interface AddSecretOptions {
  name: string;
  /** Brief description shown next to the line in .dev.vars.example. */
  description?: string;
  /**
   * If true, ask the user for the value and write it ONLY to wrangler via
   * stdin (never disk). Default true; passing --no-provision skips this.
   */
  noProvision: boolean;
  /**
   * If true, ALSO append the value to local `.dev.vars` so `wrangler pages
   * dev` reads it. Off by default — secrets stay on the Pages dashboard
   * side unless the user explicitly opts in. (Acceptance criterion 10.)
   */
  writeToDevVars: boolean;
  yes: boolean;
}

export async function runAddSecret(opts: AddSecretOptions): Promise<void> {
  const cwd = process.cwd();
  const name = normalizeSecretName(opts.name);

  // Step 1: append documented stub to .dev.vars.example
  const description =
    opts.description ??
    (opts.yes
      ? `Secret. Set with \`wrangler pages secret put ${name}\` or \`flint configure --secrets\`.`
      : await input({
          message: 'Short description (shown as a comment in .dev.vars.example):',
          default: `Secret. Set with \`wrangler pages secret put ${name}\` or \`flint configure --secrets\`.`,
        }));

  updateDevVarsExample(cwd, name, description);
  log.ok(`Updated ${DEV_VARS_EXAMPLE_FILENAME} with ${name} stub.`);

  // Step 2: optionally provision the secret.
  if (opts.noProvision) {
    log.info(`Skipped provisioning. Run \`flint configure --secrets ${name}\` later.`);
    return;
  }

  const provisionNow = opts.yes
    ? true
    : await confirm({
        message: `Set ${name} in Cloudflare Pages now?`,
        default: true,
      });
  if (!provisionNow) {
    log.info(`Skipped provisioning. Run \`flint configure --secrets ${name}\` later.`);
    return;
  }

  // Read wrangler.toml ONLY to get the project name — secrets need it.
  const doc = readWranglerToml(cwd);
  if (!doc.name) {
    log.err('wrangler.toml has no `name` field — cannot set Pages secret without a project.');
    return;
  }

  const creds = await loadCredentialsOrExit(cwd);

  const value = await passwordPrompt({
    message: `Value for ${name} (hidden):`,
    mask: '*',
    validate: (v: string): true | string => (v ? true : 'Value cannot be empty.'),
  });

  log.step(`Running: wrangler pages secret put ${name} --project-name=${doc.name}`);
  const res = runWrangler(
    ['pages', 'secret', 'put', name, '--project-name', doc.name],
    {
      cwd,
      token: creds.token,
      accountId: creds.accountId,
      stdin: value + '\n',
    },
  );
  if (res.status !== 0) {
    log.err(`wrangler pages secret put failed (exit ${res.status}).`);
    log.info(res.output.trim());
    return;
  }
  log.ok(`Set ${name} on Cloudflare Pages project ${doc.name}.`);

  // Step 3 (opt-in): hydrate .dev.vars so local `wrangler pages dev` works.
  if (opts.writeToDevVars) {
    await hydrateDevVarsSecret(cwd, name, value);
  } else {
    log.dim(`Local .dev.vars NOT modified. Add \`${name}=...\` by hand if you need it for local dev.`);
  }
}

// ─── helpers ───────────────────────────────────────────────────────────────

function normalizeBinding(raw: string): string {
  // Bindings are conventionally UPPER_SNAKE_CASE. Tolerate other inputs by
  // upper-snake-casing them.
  return raw.trim().toUpperCase().replace(/[^A-Z0-9_]+/g, '_');
}

function normalizeSecretName(raw: string): string {
  const cleaned = raw.trim().toUpperCase().replace(/[^A-Z0-9_]+/g, '_');
  if (!cleaned) {
    throw new Error('Secret name cannot be empty.');
  }
  return cleaned;
}

function updateDevVarsExample(cwd: string, name: string, description: string): void {
  const path = join(cwd, DEV_VARS_EXAMPLE_FILENAME);
  const stubLine = `${name}=    # ${description}`;
  if (!existsSync(path)) {
    writeFileSync(
      path,
      `# Documented stubs for .dev.vars — safe to commit.\n${stubLine}\n`,
      'utf8',
    );
    return;
  }
  const raw = readFileSync(path, 'utf8');
  // Already present? Bail.
  const re = new RegExp(`^\\s*${name}\\s*=`, 'm');
  if (re.test(raw)) {
    log.dim(`${name} already declared in ${DEV_VARS_EXAMPLE_FILENAME} — leaving as-is.`);
    return;
  }
  const sep = raw.endsWith('\n') ? '' : '\n';
  writeFileSync(path, `${raw}${sep}${stubLine}\n`, 'utf8');
}

async function hydrateDevVarsSecret(cwd: string, name: string, value: string): Promise<void> {
  // Dynamic import so this module stays cheap to load.
  const { writeDevVars, isDevVarsTrackedByGit } = await import('../cloudflare/dev-vars.js');
  if (isDevVarsTrackedByGit(cwd)) {
    log.err(
      `.dev.vars is tracked by git in this repo. Refusing to write secret. ` +
        `Run \`git rm --cached .dev.vars\` and retry.`,
    );
    return;
  }
  // Merge with the existing .dev.vars file by appending one line, NOT
  // rewriting the whole thing — keeps the file's existing entries.
  const path = join(cwd, '.dev.vars');
  if (!existsSync(path)) {
    writeDevVars(cwd, [
      {
        key: name,
        value,
        comment: 'Local-dev shadow of a Cloudflare Pages secret (managed by Flint).',
      },
    ]);
    log.ok('Wrote .dev.vars (mode 0600, gitignored).');
    return;
  }
  // Append line.
  const raw = readFileSync(path, 'utf8');
  const re = new RegExp(`^\\s*${name}\\s*=.*$`, 'm');
  let next = raw;
  if (re.test(raw)) {
    next = raw.replace(re, `${name}=${value}`);
  } else {
    const sep = raw.endsWith('\n') ? '' : '\n';
    next = `${raw}${sep}${name}=${value}\n`;
  }
  writeFileSync(path, next, { encoding: 'utf8', mode: 0o600 });
  log.ok(`Updated .dev.vars with ${name}=…`);
}

interface ConfigureToggle {
  skipPagesProject: boolean;
  skipKv: boolean;
  skipR2: boolean;
  skipSecrets: boolean;
  yes: boolean;
  noProvision: boolean;
}

async function maybeRunConfigure(toggle: ConfigureToggle): Promise<void> {
  if (toggle.noProvision) {
    log.info('Skipped provisioning. Run `flint configure` later to create the resource.');
    return;
  }
  const provision = toggle.yes
    ? true
    : await confirm({
        message: 'Run `flint configure` now to provision the new resource?',
        default: true,
      });
  if (!provision) {
    log.info('Skipped provisioning. Run `flint configure` later.');
    return;
  }
  await runConfigure({
    dryRun: false,
    skipPagesProject: toggle.skipPagesProject,
    skipKv: toggle.skipKv,
    skipR2: toggle.skipR2,
    skipSecrets: toggle.skipSecrets,
  });
}
