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
import { authInit, authStatus, authDoctor, authRotate } from './commands/auth.js';
import { runInit } from './commands/init.js';
import { runConfigure } from './commands/configure.js';
import { runAddKv, runAddR2, runAddSecret } from './commands/add.js';
import { runCreateApp } from './commands/create-app.js';
import { runDeploy } from './commands/deploy.js';
import { readPackageVersion } from './util/version.js';

const program = new Command();

program
  .name('flint')
  .description('Flint — Cloudflare Pages bootstrap CLI (Vite + React + TypeScript + Wrangler v4)')
  .version(readPackageVersion(), '-v, --version', 'print the Flint version');

// ─── auth ──────────────────────────────────────────────────────────────────
const auth = program
  .command('auth')
  .description('manage the persistent Cloudflare API token used by Wrangler');

auth
  .command('init')
  .description('walk through Cloudflare API token creation, validate, and store')
  .option('--no-browser', 'do not attempt to open the dashboard in a browser')
  .option('--no-clipboard', 'do not copy the scope list to the clipboard')
  .action(async (opts: { browser: boolean; clipboard: boolean }) => {
    await authInit({ openBrowser: opts.browser, useClipboard: opts.clipboard });
  });

auth
  .command('status')
  .description("show the currently stored token's account, validity, and scopes")
  .action(async () => {
    await authStatus();
  });

auth
  .command('doctor')
  .description('validate that the stored token carries every required Cloudflare scope')
  .action(async () => {
    await authDoctor();
  });

auth
  .command('rotate')
  .description('walk through replacing the stored token (manual revoke reminder)')
  .option('--no-browser', 'do not attempt to open the dashboard in a browser')
  .option('--no-clipboard', 'do not copy the scope list to the clipboard')
  .action(async (opts: { browser: boolean; clipboard: boolean }) => {
    await authRotate({ openBrowser: opts.browser, useClipboard: opts.clipboard });
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
  .option('--template <git+url>', '(reserved for v0.9) custom template git URL')
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
        template?: string;
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
        template: opts.template,
        pm: opts.pm,
        cfProject: opts.cfProject,
        noInstall: opts.install === false,
        noGit: opts.git === false,
        provision: opts.provision === true,
        yes: opts.yes === true,
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
  .action(
    async (opts: {
      branch?: string;
      preview?: boolean;
      skipChecks?: boolean;
      rollback?: boolean;
      strictBudget?: boolean;
      projectName?: string;
    }) => {
      await runDeploy({
        branch: opts.branch,
        preview: opts.preview === true,
        skipChecks: opts.skipChecks === true,
        rollback: opts.rollback === true,
        strictBudget: opts.strictBudget === true,
        projectName: opts.projectName,
      });
    },
  );

// ─── configure (v0.2) ──────────────────────────────────────────────────────
program
  .command('configure')
  .description('walk through provisioning every Cloudflare resource declared in wrangler.toml')
  .option('--dry-run', 'print the planned commands and diff without invoking wrangler')
  .option('--no-pages-project', 'skip the Pages project step')
  .option('--no-kv', 'skip the KV namespace step')
  .option('--no-r2', 'skip the R2 bucket step')
  .option('--no-secrets', 'skip the secrets step')
  .option('--secrets <names>', 'comma-separated list of secret names to set non-interactively')
  .action(
    async (opts: {
      dryRun?: boolean;
      pagesProject: boolean;
      kv: boolean;
      r2: boolean;
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
        skipSecrets: opts.secrets === false,
        secrets: secretNames,
      });
    },
  );

// ─── add (v0.2) ────────────────────────────────────────────────────────────
const add = program
  .command('add')
  .description('additive scaffolds: kv | r2 | secret');

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
      });
    },
  );

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
      });
    },
  );

// All errors should bubble up as a non-zero exit. Inquirer's ExitPromptError
// (raised on Ctrl-C) gets soft-handled so the terminal isn't left with a
// stack trace for a user-initiated cancel.
program.parseAsync(process.argv).catch((err: unknown) => {
  if (err && typeof err === 'object' && 'name' in err && err.name === 'ExitPromptError') {
    console.error('\nCancelled.');
    process.exit(130);
  }
  if (err instanceof Error) {
    console.error(`\nflint: ${err.message}`);
  } else {
    console.error('\nflint: unknown error', err);
  }
  process.exit(1);
});
