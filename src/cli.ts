#!/usr/bin/env node
// Flint CLI entrypoint. Dispatches to the v0.1 + v0.2 command surfaces:
//   - flint auth init / status / doctor / rotate                       (v0.1)
//   - flint init --variant <pages-functions|pages-fullstack>           (v0.1)
//   - flint configure [--dry-run]                                      (v0.2)
//   - flint add kv|r2|secret <name>                                    (v0.2)
//
// v0.5+ surfaces (create-app, deploy, upgrade) are reserved in the plan
// but not implemented here. Adding them in later milestones is a matter of
// registering a new sub-command — the dispatch layer is open.

import { Command } from 'commander';
import { authInit, authStatus, authDoctor, authRotate, authPurge } from './commands/auth.js';
import { runInit } from './commands/init.js';
import { runConfigure } from './commands/configure.js';
import { runAddKv, runAddR2, runAddD1, runAddSecret } from './commands/add.js';
import { runAddPwa, runAddAuth, runAddRateLimit } from './commands/add-features.js';
import { runCreateApp } from './commands/create-app.js';
import { runDeploy } from './commands/deploy.js';
import { runUpgrade } from './commands/upgrade.js';
import { runConfig } from './commands/config.js';
import {
  runTelemetryShow,
  runTelemetryPurge,
  runTelemetryExport,
} from './commands/telemetry.js';
import { runUninstall } from './commands/uninstall.js';
import { runDoctor } from './commands/doctor.js';
import { readPackageVersion } from './util/version.js';
import { emitEvent, ensureTelemetryConsent } from './util/telemetry.js';
import { setJsonMode } from './util/logger.js';
import { formatResult, err as errResult } from './util/format-result.js';

const program = new Command();

program
  .name('flint')
  .description('Flint — Cloudflare Pages bootstrap CLI (Vite + React + TypeScript + Wrangler v4)')
  .version(readPackageVersion(), '-v, --version', 'print the Flint version')
  .option(
    '--telemetry-endpoint <url>',
    'POST telemetry events to <url> instead of (or in addition to) the local log',
  )
  .option('--json', 'emit a single JSON result on stdout instead of human output');

/**
 * Resolve the `--json` flag for a subcommand. Commander attaches global flags
 * to the parent program rather than the action handler's `opts`, so we read
 * them from the program instance.
 */
function globalJson(): boolean {
  const opts = program.opts<{ json?: boolean }>();
  return opts.json === true;
}

/**
 * Commander accumulator for the repeatable `--var name=value` flag. Each
 * occurrence is parsed into the accumulating record. Used by `create-app
 * --pack` to pass pack variables non-interactively.
 */
function collectVar(raw: string, acc: Record<string, string>): Record<string, string> {
  const eq = raw.indexOf('=');
  if (eq < 0) {
    throw new Error(`[flint] create-app: --var expects name=value, got "${raw}".`);
  }
  const name = raw.slice(0, eq).trim();
  const value = raw.slice(eq + 1);
  if (name.length === 0) {
    throw new Error(`[flint] create-app: --var name cannot be empty (got "${raw}").`);
  }
  acc[name] = value;
  return acc;
}

/**
 * Resolve the `--telemetry-endpoint <url>` flag. Set the env var so
 * `emitEvent` can pick it up without taking a parameter on every call site.
 */
function applyTelemetryEndpoint(): void {
  const opts = program.opts<{ telemetryEndpoint?: string }>();
  if (typeof opts.telemetryEndpoint === 'string' && opts.telemetryEndpoint.length > 0) {
    process.env.FLINT_TELEMETRY_ENDPOINT = opts.telemetryEndpoint;
  }
}

// ─── auth ──────────────────────────────────────────────────────────────────
const auth = program
  .command('auth')
  .description('manage the persistent Cloudflare API token used by Wrangler');

auth
  .command('init')
  .description('walk through Cloudflare API token creation, validate, and store')
  .option('--no-browser', 'do not attempt to open the dashboard in a browser')
  .option('--no-clipboard', 'do not copy the scope list to the clipboard')
  .option('--keychain', 'also store credentials in the OS keychain (opt-in)')
  .action(
    async (opts: { browser: boolean; clipboard: boolean; keychain?: boolean }) => {
      await authInit({
        openBrowser: opts.browser,
        useClipboard: opts.clipboard,
        useKeychain: opts.keychain === true,
      });
    },
  );

auth
  .command('status')
  .description("show the currently stored token's account, validity, and scopes")
  .action(async () => {
    await authStatus({ json: globalJson() });
  });

auth
  .command('doctor')
  .description('validate that the stored token carries every required Cloudflare scope')
  .action(async () => {
    await authDoctor({ json: globalJson() });
  });

auth
  .command('rotate')
  .description('walk through replacing the stored token (manual revoke reminder)')
  .option('--no-browser', 'do not attempt to open the dashboard in a browser')
  .option('--no-clipboard', 'do not copy the scope list to the clipboard')
  .option('--keychain', 'also store the rotated credentials in the OS keychain')
  .action(
    async (opts: { browser: boolean; clipboard: boolean; keychain?: boolean }) => {
      await authRotate({
        openBrowser: opts.browser,
        useClipboard: opts.clipboard,
        useKeychain: opts.keychain === true,
      });
    },
  );

auth
  .command('purge')
  .description('wipe local Cloudflare credentials + reminder to revoke in dashboard')
  .option('-y, --yes', 'do not prompt for confirmation')
  .option('--include-archive', 'also wipe ~/.config/flint/credentials.rotated/')
  .action(async (opts: { yes?: boolean; includeArchive?: boolean }) => {
    await authPurge({
      yes: opts.yes === true,
      includeArchive: opts.includeArchive === true,
    });
  });

// ─── init ──────────────────────────────────────────────────────────────────
program
  .command('init')
  .description('scaffold Cloudflare Pages config into an existing Vite + React + TS repo')
  .option(
    '--variant <variant>',
    'template variant: pages-functions | pages-fullstack',
  )
  .option('--name <name>', 'Cloudflare Pages project name (default: directory name)')
  .option('--no-ci', 'skip writing .github/workflows/ci.yml')
  .option('-y, --yes', 'accept defaults and skip interactive prompts where possible')
  .option('--force', 'overwrite existing files (default: prompt per-file)')
  .action(
    async (opts: {
      variant?: string;
      name?: string;
      ci: boolean;
      yes: boolean;
      force: boolean;
    }) => {
      await runInit({
        variant: opts.variant,
        projectName: opts.name,
        includeCI: opts.ci,
        yes: opts.yes,
        force: opts.force,
        json: globalJson(),
      });
    },
  );

// ─── create-app (v0.5) ─────────────────────────────────────────────────────
program
  .command('create-app <name>')
  .description('bootstrap a fresh Vite + React + TS app with Cloudflare Pages wiring pre-baked')
  .option(
    '--variant <variant>',
    'template variant: static-spa | pages-functions | pages-fullstack',
  )
  .option(
    '--pack <dir>',
    'scaffold from an external template pack directory (contains pack.json)',
  )
  .option(
    '--template <id-or-git+url>',
    'with --pack: a template id within the pack; otherwise a custom git+<url> template',
  )
  .option(
    '--var <name=value>',
    'set a pack variable (repeatable, e.g. --var siteName="Acme Cafe")',
    collectVar,
    {} as Record<string, string>,
  )
  .option('--pm <pm>', 'package manager: npm | pnpm | bun (auto-detected by default)')
  .option('--cf-project <name>', 'Cloudflare Pages project name (default: <name>)')
  .option('--no-install', 'do not run `<pm> install` after scaffolding')
  .option('--no-git', 'do not run `git init` in the new directory')
  .option('--provision', 'run `flint configure` immediately after scaffolding')
  .option('-y, --yes', 'accept defaults and skip interactive prompts where possible')
  .action(
    async (
      name: string,
      opts: {
        variant?: string;
        pack?: string;
        template?: string;
        var?: Record<string, string>;
        pm?: string;
        cfProject?: string;
        install: boolean;
        git: boolean;
        provision?: boolean;
        yes?: boolean;
      },
    ) => {
      await runCreateApp({
        appName: name,
        variant: opts.variant,
        pack: opts.pack,
        template: opts.template,
        vars: opts.var,
        pm: opts.pm,
        cfProject: opts.cfProject,
        noInstall: opts.install === false,
        noGit: opts.git === false,
        provision: opts.provision === true,
        yes: opts.yes === true,
        json: globalJson(),
      });
    },
  );

// ─── deploy (v0.5) ─────────────────────────────────────────────────────────
program
  .command('deploy')
  .description('build + pre-flight + wrangler pages deploy, with health-ping summary')
  .option('--branch <name>', 'Pages branch to deploy to (default: main)')
  .option('--preview', 'deploy as a preview using the current git branch name')
  .option('--skip-checks', 'skip lint / typecheck / vitest pre-flight steps')
  .option('--rollback', 'list recent deployments and roll back to a chosen one')
  .option('--strict-budget', 'fail (not just warn) if the asset budget is exceeded')
  .option(
    '--project-name <name>',
    'Cloudflare Pages project name (default: wrangler.toml `name`)',
  )
  .option(
    '--env <name>',
    'Deploy environment (must match a [env.<name>] section in wrangler.toml)',
  )
  .action(
    async (opts: {
      branch?: string;
      preview?: boolean;
      skipChecks?: boolean;
      rollback?: boolean;
      strictBudget?: boolean;
      projectName?: string;
      env?: string;
    }) => {
      await runDeploy({
        branch: opts.branch,
        preview: opts.preview === true,
        skipChecks: opts.skipChecks === true,
        rollback: opts.rollback === true,
        strictBudget: opts.strictBudget === true,
        projectName: opts.projectName,
        env: opts.env,
        json: globalJson(),
      });
    },
  );

// ─── upgrade (v0.9) ────────────────────────────────────────────────────────
program
  .command('upgrade')
  .description('detect and remediate drift between scaffolded files and current templates')
  .option('--check', 'enumerate drift state per file (default if no mode given)')
  .option('--diff', 'print unified diffs for every modified file')
  .option('--apply', 'interactively walk each drifted file with a 3-way merge')
  .option('--dry-run', 'walk apply-mode but write nothing')
  .option(
    '--accept-current',
    'non-interactive: record current file contents as the new manifest baseline (no writes to project files)',
  )
  .option(
    '--pack <dir>',
    'path to the template pack the project was scaffolded from — required to re-render pack-stamped files (e.g. Client-Site-Kit sites)',
  )
  .action(
    async (opts: {
      check?: boolean;
      diff?: boolean;
      apply?: boolean;
      dryRun?: boolean;
      acceptCurrent?: boolean;
      pack?: string;
    }) => {
      await runUpgrade({
        check: opts.check === true,
        diff: opts.diff === true,
        apply: opts.apply === true,
        dryRun: opts.dryRun === true,
        acceptCurrent: opts.acceptCurrent === true,
        pack: opts.pack,
        json: globalJson(),
      });
    },
  );

// ─── doctor (v1.0) ─────────────────────────────────────────────────────────
program
  .command('doctor')
  .description('full-stack diagnostics — node, package manager, wrangler, auth, repo state')
  .action(async () => {
    await runDoctor({ json: globalJson() });
  });

// ─── uninstall (v1.0) ──────────────────────────────────────────────────────
program
  .command('uninstall')
  .description('remove Flint-scaffolded files from the current project (manifest-aware)')
  .option('--dry-run', 'print the deletion plan without writing anything')
  .option('-y, --yes', 'skip the confirmation prompt')
  .option('--include-modified', 'also delete user-modified scaffolds (destructive)')
  .action(async (opts: { dryRun?: boolean; yes?: boolean; includeModified?: boolean }) => {
    await runUninstall({
      dryRun: opts.dryRun === true,
      yes: opts.yes === true,
      includeModified: opts.includeModified === true,
      json: globalJson(),
    });
  });

// ─── telemetry (v1.0) ──────────────────────────────────────────────────────
const telemetry = program
  .command('telemetry')
  .description('inspect, purge, or export the local telemetry event log');

telemetry
  .command('show')
  .description('print the current local event log on stdout (JSON lines or pretty)')
  .action(() => {
    runTelemetryShow({ json: globalJson() });
  });

telemetry
  .command('purge')
  .description('delete the local telemetry event log')
  .action(() => {
    runTelemetryPurge({ json: globalJson() });
  });

telemetry
  .command('export <file>')
  .description('copy the local telemetry event log to <file>')
  .option('--force', 'overwrite <file> if it already exists')
  .action((file: string, opts: { force?: boolean }) => {
    runTelemetryExport({ outPath: file, force: opts.force === true, json: globalJson() });
  });

// ─── config (v0.9) ─────────────────────────────────────────────────────────
program
  .command('config')
  .description('view or change Flint global preferences (telemetry, etc.)')
  .option('--telemetry <on|off>', 'enable or disable anonymous usage stats')
  .option('--show', 'print current settings without changing anything')
  .action(async (opts: { telemetry?: string; show?: boolean }) => {
    await runConfig({ telemetry: opts.telemetry, show: opts.show === true, json: globalJson() });
  });

// ─── configure (v0.2) ──────────────────────────────────────────────────────
program
  .command('configure')
  .description('walk through provisioning every Cloudflare resource declared in wrangler.toml')
  .option('--dry-run', 'print the planned commands and diff without invoking wrangler')
  .option('--no-pages-project', 'skip the Pages project step')
  .option('--no-kv', 'skip the KV namespace step')
  .option('--no-r2', 'skip the R2 bucket step')
  .option('--no-d1', 'skip the D1 database step (D1 is opt-in; off unless a block is declared)')
  .option('--no-secrets', 'skip the secrets step')
  .option('--secrets <names>', 'comma-separated list of secret names to set non-interactively')
  .action(
    async (opts: {
      dryRun?: boolean;
      pagesProject: boolean;
      kv: boolean;
      r2: boolean;
      d1: boolean;
      secrets: boolean | string;
    }) => {
      const secretNames =
        typeof opts.secrets === 'string'
          ? opts.secrets.split(',').map((s) => s.trim()).filter((s) => s.length > 0)
          : [];
      await runConfigure({
        dryRun: opts.dryRun === true,
        skipPagesProject: opts.pagesProject === false,
        skipKv: opts.kv === false,
        skipR2: opts.r2 === false,
        skipD1: opts.d1 === false,
        skipSecrets: opts.secrets === false,
        secrets: secretNames,
        json: globalJson(),
      });
    },
  );

// ─── add (v0.2) ────────────────────────────────────────────────────────────
const add = program
  .command('add')
  .description('additive scaffolds: kv | r2 | d1 | secret | pwa | auth | rate-limit');

add
  .command('kv <binding>')
  .description('declare a new [[kv_namespaces]] block and (optionally) provision it')
  .option('--no-provision', 'do not prompt to run `flint configure` after adding')
  .option('--force', 'append a duplicate block even if the binding already exists')
  .option('-y, --yes', 'accept defaults; never prompt')
  .action(
    async (binding: string, opts: { provision: boolean; force?: boolean; yes?: boolean }) => {
      await runAddKv({
        binding,
        noProvision: opts.provision === false,
        force: opts.force === true,
        yes: opts.yes === true,
        json: globalJson(),
      });
    },
  );

add
  .command('r2 <binding>')
  .description('declare a new [[r2_buckets]] block and (optionally) provision it')
  .option('--no-provision', 'do not prompt to run `flint configure` after adding')
  .option('--force', 'append a duplicate block even if the binding already exists')
  .option('-y, --yes', 'accept defaults; never prompt')
  .action(
    async (binding: string, opts: { provision: boolean; force?: boolean; yes?: boolean }) => {
      await runAddR2({
        binding,
        noProvision: opts.provision === false,
        force: opts.force === true,
        yes: opts.yes === true,
        json: globalJson(),
      });
    },
  );

add
  .command('d1 <binding>')
  .description('declare a new [[d1_databases]] block and (optionally) provision it')
  .option('--no-provision', 'do not prompt to run `flint configure` after adding')
  .option('--force', 'append a duplicate block even if the binding already exists')
  .option('-y, --yes', 'accept defaults; never prompt')
  .action(
    async (binding: string, opts: { provision: boolean; force?: boolean; yes?: boolean }) => {
      await runAddD1({
        binding,
        noProvision: opts.provision === false,
        force: opts.force === true,
        yes: opts.yes === true,
        json: globalJson(),
      });
    },
  );

// ─── add pwa | auth | rate-limit (v0.9) ────────────────────────────────────
add
  .command('pwa')
  .description('install vite-plugin-pwa + workbox-window and patch vite.config.ts')
  .option('--force', 'overwrite an existing vite.config.ts patch')
  .option('-y, --yes', 'accept defaults; never prompt')
  .action(async (opts: { force?: boolean; yes?: boolean }) => {
    await runAddPwa({ force: opts.force === true, yes: opts.yes === true, json: globalJson() });
  });

add
  .command('auth')
  .description('drop the HMAC cookie auth pattern into functions/_shared/auth.ts')
  .option('--force', 'overwrite an existing functions/_shared/auth.ts')
  .option('-y, --yes', 'accept defaults; never prompt')
  .action(async (opts: { force?: boolean; yes?: boolean }) => {
    await runAddAuth({ force: opts.force === true, yes: opts.yes === true, json: globalJson() });
  });

add
  .command('rate-limit')
  .description('drop the sliding-window KV-bucket rate limiter into functions/_shared/ratelimit.ts')
  .option('--force', 'overwrite an existing functions/_shared/ratelimit.ts')
  .option('-y, --yes', 'accept defaults; never prompt')
  .action(async (opts: { force?: boolean; yes?: boolean }) => {
    await runAddRateLimit({ force: opts.force === true, yes: opts.yes === true, json: globalJson() });
  });

add
  .command('secret <name>')
  .description('document a new secret in .dev.vars.example and (optionally) push it to Pages')
  .option('--description <text>', 'inline description for .dev.vars.example')
  .option('--no-provision', 'only update .dev.vars.example; do not call wrangler')
  .option(
    '--write-to-dev-vars',
    'ALSO write the secret value to local .dev.vars (off by default — opt-in)',
  )
  .option('-y, --yes', 'accept defaults; never prompt')
  .action(
    async (
      name: string,
      opts: {
        description?: string;
        provision: boolean;
        writeToDevVars?: boolean;
        yes?: boolean;
      },
    ) => {
      await runAddSecret({
        name,
        description: opts.description,
        noProvision: opts.provision === false,
        writeToDevVars: opts.writeToDevVars === true,
        yes: opts.yes === true,
        json: globalJson(),
      });
    },
  );

// Telemetry: first-run consent prompt happens before dispatch unless we're
// in a "fast path" (help, version, config-only) that exits without running a
// user command. Once dispatched, the subcommand name is what we record.
const fastPathArgs = new Set(['-h', '--help', '-v', '--version']);
const skipConsent =
  process.argv.length <= 2 ||
  fastPathArgs.has(process.argv[2] ?? '') ||
  process.argv[2] === 'config' ||
  // commander prints sub-help via "auth --help" etc; don't prompt then.
  process.argv.includes('--help') ||
  process.argv.includes('-h');

async function main(): Promise<void> {
  // Pre-parse the global flags so we can wire logger + telemetry endpoint
  // before commander dispatches. parseOptions short-circuits without running
  // any subcommand action.
  if (process.argv.includes('--json')) {
    setJsonMode(true);
  }
  applyTelemetryEndpoint();

  if (!skipConsent && !process.argv.includes('--json')) {
    // Skip the consent prompt in --json mode: interactive prompts would
    // corrupt the JSON-on-stdout contract. Telemetry remains off by default
    // when no preference is set.
    await ensureTelemetryConsent();
  }
  // Emit a telemetry event for the top-level command name (no args). This is
  // intentionally fire-and-forget. Errors are swallowed inside emitEvent.
  const top = process.argv[2];
  if (top && !top.startsWith('-')) {
    emitEvent({ event: top });
  }
  await program.parseAsync(process.argv);
}

main().catch((err: unknown) => {
  if (err && typeof err === 'object' && 'name' in err && err.name === 'ExitPromptError') {
    console.error('\nCancelled.');
    process.exit(130);
  }
  // Emit error event for the failing command (errorType only, never message).
  const top = process.argv[2];
  const errType =
    err && typeof err === 'object' && 'code' in err && typeof (err as { code: unknown }).code === 'string'
      ? (err as { code: string }).code
      : err instanceof Error
        ? err.name
        : 'Unknown';
  if (top && !top.startsWith('-')) {
    emitEvent({ event: top, errorType: errType });
  }
  const message = err instanceof Error ? err.message : String(err);
  if (process.argv.includes('--json')) {
    formatResult(errResult(top ?? 'unknown', errType, message), { json: true });
  } else if (err instanceof Error) {
    console.error(`\nflint: ${err.message}`);
  } else {
    console.error('\nflint: unknown error', err);
  }
  process.exit(1);
});
