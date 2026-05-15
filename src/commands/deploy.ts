// `flint deploy` — wrapped `wrangler pages deploy` with pre-flight checks
// and a deployment health-ping.
//
// Pre-flight sequence (each step is sequential; first failure halts the deploy):
//   1. flint auth doctor --quiet   — token still valid + has required scopes
//   2. npm run lint                — code style + obvious bugs
//   3. npx tsc -b                  — type errors
//   4. npx vitest run              — automated tests
//   5. npm run build               — production build, populates dist/
//   6. asset budget guard          — warns (or fails with --strict-budget)
//   7. wrangler pages deploy dist  — actual deploy
//   8. health-ping the deployment  — GET /, GET /api/health if Functions present
//   9. print summary               — deployment URL, branch, duration, asset count
//
// Pre-flight steps 2-4 are skippable with --skip-checks. Build is NOT
// skippable — without `dist/`, there's nothing to deploy.
//
// On health-ping failure: we DO NOT auto-rollback. We print the rollback
// command for one-paste recovery. The user decides.
//
// `--rollback`: lists the last 10 deployments via `wrangler pages
// deployment list`, lets the user select one, then runs `wrangler pages
// deployment rollback <id>`. Purely UX over wrangler.

import { select } from '@inquirer/prompts';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { spawnSync, type SpawnSyncOptions } from 'node:child_process';
import { log, color } from '../util/logger.js';
import {
  readWranglerToml,
  WranglerTomlNotFoundError,
} from '../cloudflare/wrangler-toml.js';
import { runWrangler } from '../cloudflare/wrangler-runner.js';
import { readCredentials } from '../cloudflare/credentials.js';
import { formatResult, ok } from '../util/format-result.js';
import { verifyToken } from '../cloudflare/api.js';
import {
  inspectAssetBudget,
  loadBudgetConfig,
  formatMB,
  formatKB,
} from '../util/asset-budget.js';

export interface DeployOptions {
  /** Pages branch to deploy to. Default: main. */
  branch?: string;
  /** Use current git branch as the deploy branch (preview environment). */
  preview: boolean;
  /** Skip lint / typecheck / vitest pre-flight steps. Build still runs. */
  skipChecks: boolean;
  /** List + select a previous deployment to roll back to. */
  rollback: boolean;
  /** If budget exceeded, fail (default: warn only). */
  strictBudget: boolean;
  /** Override the Cloudflare Pages project name (default: wrangler.toml `name`). */
  projectName?: string;
  /**
   * Deploy environment. Maps to `[env.<name>]` sections in wrangler.toml.
   * When provided, the deploy uses per-env bindings + project name + branch
   * overrides. Defaults to no env (i.e. top-level wrangler.toml).
   */
  env?: string;
  /** Emit a structured JSON result on stdout instead of human output. */
  json?: boolean;
}

interface DeployContext {
  cwd: string;
  projectName: string;
  branch: string;
  hasFunctions: boolean;
  strictBudget: boolean;
  /** Resolved env name, or undefined for no-env deploy. */
  env?: string;
}

export async function runDeploy(opts: DeployOptions): Promise<void> {
  const cwd = process.cwd();

  let project: string;
  let envName: string | undefined;
  try {
    const wrangler = readWranglerToml(cwd);

    // Resolve --env <name>: must match a `[env.<name>]` section. If the env
    // overrides `name`, use that as the project name; otherwise inherit the
    // top-level name.
    if (typeof opts.env === 'string' && opts.env.length > 0) {
      const envCfg = wrangler.envs[opts.env];
      if (!envCfg) {
        const available = Object.keys(wrangler.envs).sort();
        const list = available.length > 0 ? available.join(', ') : '(none defined)';
        throw new Error(
          `[flint] deploy: --env "${opts.env}" not found in wrangler.toml — add a [env.${opts.env}] section. Available envs: ${list}.`,
        );
      }
      envName = opts.env;
      if (opts.projectName) {
        project = opts.projectName;
      } else if (typeof envCfg.name === 'string' && envCfg.name.length > 0) {
        project = envCfg.name;
      } else if (typeof wrangler.name === 'string' && wrangler.name.length > 0) {
        project = wrangler.name;
      } else {
        throw new Error(
          `[flint] deploy: wrangler.toml has no \`name\` (top-level or [env.${opts.env}]) — pass --project-name or add \`name = "..."\`.`,
        );
      }
    } else if (opts.projectName) {
      project = opts.projectName;
    } else if (typeof wrangler.name === 'string' && wrangler.name.length > 0) {
      project = wrangler.name;
    } else {
      throw new Error(
        '[flint] deploy: wrangler.toml has no `name` — pass --project-name or set `name = "..."`.',
      );
    }
  } catch (e) {
    if (e instanceof WranglerTomlNotFoundError) {
      log.err(e.message);
      process.exitCode = 2;
      return;
    }
    throw e;
  }

  if (opts.rollback) {
    await runRollback(cwd, project);
    return;
  }

  const branch = resolveBranch(cwd, opts);
  const hasFunctions = existsSync(join(cwd, 'functions'));

  const ctx: DeployContext = {
    cwd,
    projectName: project,
    branch,
    hasFunctions,
    strictBudget: opts.strictBudget,
    env: envName,
  };

  log.heading(`Deploying ${project}`);
  if (envName) log.dim(`  Env:       ${envName}`);
  log.dim(`  Branch:    ${branch}`);
  log.dim(`  Functions: ${hasFunctions ? 'yes' : 'no'}`);
  log.dim(`  Strict budget: ${opts.strictBudget ? 'yes (fail on warning)' : 'no (warn only)'}`);
  log.blank();

  const t0 = Date.now();

  if (!(await stepAuthDoctorQuiet())) return;

  if (!opts.skipChecks) {
    if (!stepNpm(ctx, 'lint', 'lint', ['run', 'lint'])) return;
    if (!stepNpx(ctx, 'typecheck', ['tsc', '-b'])) return;
    if (!stepNpx(ctx, 'tests', ['vitest', 'run'])) return;
  } else {
    log.warn('--skip-checks: skipping lint, typecheck, and tests.');
  }

  if (!stepNpm(ctx, 'build', 'build', ['run', 'build'])) return;

  if (!stepAssetBudget(ctx)) return;

  const deployRes = stepWranglerDeploy(ctx);
  if (!deployRes) return;

  await stepHealthPing(deployRes.url, ctx.hasFunctions);

  const elapsed = ((Date.now() - t0) / 1000).toFixed(1);
  log.blank();
  log.heading('Deploy complete.');
  log.ok(`  URL:        ${deployRes.url}`);
  if (deployRes.deploymentId) {
    log.ok(`  Deployment: ${deployRes.deploymentId}`);
  }
  log.ok(`  Branch:     ${ctx.branch}`);
  if (ctx.env) log.ok(`  Env:        ${ctx.env}`);
  log.ok(`  Duration:   ${elapsed}s`);

  formatResult(
    ok('deploy', {
      projectName: ctx.projectName,
      branch: ctx.branch,
      env: ctx.env ?? null,
      url: deployRes.url,
      deploymentId: deployRes.deploymentId ?? null,
      durationSeconds: Number(elapsed),
    }),
    { json: opts.json === true },
  );
}

// ─── pre-flight steps ──────────────────────────────────────────────────────

async function stepAuthDoctorQuiet(): Promise<boolean> {
  log.step('auth doctor (quiet) — verifying stored Cloudflare token');
  const creds = readCredentials();
  if (!creds) {
    log.err('  [flint] deploy: no Cloudflare credentials stored — run `flint auth init` before deploying.');
    process.exitCode = 2;
    return false;
  }
  try {
    const v = await verifyToken(creds.token);
    if (!v.active) {
      log.err('  [flint] deploy: stored token is not active — run `flint auth rotate` and retry.');
      process.exitCode = 2;
      return false;
    }
  } catch (e) {
    log.err(`  [flint] deploy: token verification failed — ${e instanceof Error ? e.message : String(e)}. Check network access to api.cloudflare.com.`);
    process.exitCode = 2;
    return false;
  }
  log.ok(`  Token valid (${creds.accountName}).`);
  return true;
}

function stepNpm(
  ctx: DeployContext,
  label: string,
  scriptCheck: string,
  args: string[],
): boolean {
  const pkgPath = join(ctx.cwd, 'package.json');
  if (!existsSync(pkgPath)) {
    log.err(`  [flint] deploy: cannot run ${label} — no package.json at ${ctx.cwd}. Run \`npm init -y\` first or invoke deploy from your project root.`);
    process.exitCode = 2;
    return false;
  }
  try {
    const pkg = JSON.parse(readFileSync(pkgPath, 'utf8')) as {
      scripts?: Record<string, string>;
    };
    if (!pkg.scripts || !pkg.scripts[scriptCheck]) {
      log.warn(`  Skipping ${label}: no "${scriptCheck}" script in package.json.`);
      return true;
    }
  } catch {
    // Unparseable package.json — let npm's own error surface.
  }
  log.step(`${label} — npm ${args.join(' ')}`);
  return runChild(npmBin(), args, { cwd: ctx.cwd }, label);
}

function stepNpx(ctx: DeployContext, label: string, args: string[]): boolean {
  log.step(`${label} — npx ${args.join(' ')}`);
  return runChild(npxBin(), args, { cwd: ctx.cwd }, label);
}

/** Windows-aware bin resolution — `npm.cmd` on Windows, `npm` on POSIX. */
function npmBin(): string {
  return process.platform === 'win32' ? 'npm.cmd' : 'npm';
}

function npxBin(): string {
  return process.platform === 'win32' ? 'npx.cmd' : 'npx';
}

function stepAssetBudget(ctx: DeployContext): boolean {
  log.step('asset budget — inspecting dist/');
  const budget = loadBudgetConfig(ctx.cwd);
  const distDir = join(ctx.cwd, 'dist');
  const report = inspectAssetBudget(distDir, budget);

  if (report.fileCount === 0) {
    log.err(`  [flint] deploy: dist/ is empty or missing — your build step did not produce output. Re-run \`npm run build\` and check for errors.`);
    process.exitCode = 2;
    return false;
  }

  log.dim(
    `  ${report.fileCount} file(s); total ${formatMB(report.totalBytes)}; ` +
      `${report.chunks.length} JS chunk(s).`,
  );
  if (report.chunks.length > 0) {
    const biggest = report.chunks[0]!;
    log.dim(`  Largest chunk: ${biggest.path} (${formatKB(biggest.gzippedBytes)} gzipped).`);
  }

  if (report.warnings.length === 0) {
    log.ok(`  Within budget (max ${budget.maxBundleMB} MB total / ${budget.maxChunkKB} KB per chunk).`);
    return true;
  }
  for (const w of report.warnings) {
    log.warn(`  ${w}`);
  }
  if (ctx.strictBudget) {
    log.err('  [flint] deploy: asset budget exceeded and --strict-budget is set — aborting. Reduce bundle size or drop --strict-budget to ship anyway.');
    process.exitCode = 3;
    return false;
  }
  log.warn('  Asset budget exceeded — continuing (pass --strict-budget to fail next time).');
  return true;
}

interface DeployStdoutResult {
  url: string;
  deploymentId?: string;
}

function stepWranglerDeploy(ctx: DeployContext): DeployStdoutResult | null {
  const envFlag = ctx.env ? ` --env=${ctx.env}` : '';
  log.step(
    `deploy — wrangler pages deploy dist --project-name=${ctx.projectName} --branch=${ctx.branch}${envFlag}`,
  );
  const args = [
    'pages',
    'deploy',
    'dist',
    `--project-name=${ctx.projectName}`,
    `--branch=${ctx.branch}`,
  ];
  if (ctx.env) {
    args.push(`--env=${ctx.env}`);
  }
  const creds = readCredentials();
  const res = runWrangler(args, {
    cwd: ctx.cwd,
    token: creds?.token,
    accountId: creds?.accountId,
  });
  if (res.output.trim().length > 0) {
    process.stdout.write(res.output);
    if (!res.output.endsWith('\n')) process.stdout.write('\n');
  }
  if (res.status !== 0) {
    log.err(`  [flint] deploy: wrangler exited with status ${res.status} — see the wrangler output above; common causes are missing scopes, an invalid project name, or network failure.`);
    process.exitCode = 4;
    return null;
  }
  const parsed = parseDeployStdout(res.output);
  if (!parsed) {
    log.warn('  wrangler deploy succeeded but the deployment URL could not be parsed.');
    return { url: '' };
  }
  return parsed;
}

/**
 * Pull the deployment URL out of wrangler's stdout. Wrangler v4 prints
 * lines like `Take a peek over at https://<id>.<project>.pages.dev`.
 * We accept any `https://*.pages.dev` URL in the output as a candidate.
 */
export function parseDeployStdout(output: string): DeployStdoutResult | null {
  const urlMatch = /https:\/\/[a-z0-9-]+(?:\.[a-z0-9-]+)*\.pages\.dev[^\s]*/i.exec(output);
  if (!urlMatch) return null;
  const url = urlMatch[0].replace(/[.,]+$/, '');
  const idMatch =
    /\b([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\b/i.exec(output);
  return { url, deploymentId: idMatch ? idMatch[1] : undefined };
}

async function stepHealthPing(deployUrl: string, hasFunctions: boolean): Promise<void> {
  if (!deployUrl) {
    log.dim('  Skipping health-ping (deployment URL not parsed).');
    return;
  }
  log.step(`health-ping — GET ${deployUrl}`);
  const ok = await ping(deployUrl);
  if (ok) {
    log.ok(`  GET / → 200`);
  } else {
    log.warn(
      `  GET / did not return 2xx. Run \`flint deploy --rollback\` if this is a regression.`,
    );
  }
  if (hasFunctions) {
    const healthUrl = `${deployUrl.replace(/\/$/, '')}/api/health`;
    log.step(`health-ping — GET ${healthUrl}`);
    const okFn = await ping(healthUrl);
    if (okFn) {
      log.ok(`  GET /api/health → 200`);
    } else {
      log.warn(
        `  GET /api/health did not return 2xx. Run \`flint deploy --rollback\` if this is a regression.`,
      );
    }
  }
}

async function ping(url: string): Promise<boolean> {
  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 15_000);
    const res = await fetch(url, { method: 'GET', signal: controller.signal });
    clearTimeout(timer);
    return res.ok;
  } catch {
    return false;
  }
}

// ─── rollback ──────────────────────────────────────────────────────────────

async function runRollback(cwd: string, project: string): Promise<void> {
  log.heading(`Rollback — last 10 deployments for ${project}`);
  const creds = readCredentials();
  const listRes = runWrangler(
    ['pages', 'deployment', 'list', `--project-name=${project}`],
    { cwd, token: creds?.token, accountId: creds?.accountId },
  );
  if (listRes.status !== 0) {
    log.err(`[flint] deploy: wrangler pages deployment list exited ${listRes.status} — see output below; verify the project name and token scopes.\n${listRes.output}`);
    process.exitCode = 4;
    return;
  }
  const deployments = parseDeploymentList(listRes.output);
  if (deployments.length === 0) {
    log.warn('No deployments found in wrangler output.');
    log.dim('Raw output:');
    log.dim(listRes.output);
    return;
  }
  const top = deployments.slice(0, 10);
  const picked = await select<string>({
    message: 'Roll back to which deployment?',
    choices: top.map((d, i) => ({
      name:
        `${i === 0 ? color('dim', '(current)') : '         '} ` +
        `${d.id}  ${d.branch ?? '?'}  ${d.created ?? ''}`,
      value: d.id,
    })),
  });
  log.step(`Rolling back to ${picked}`);
  const rbRes = runWrangler(
    ['pages', 'deployment', 'rollback', `--project-name=${project}`, picked],
    { cwd, token: creds?.token, accountId: creds?.accountId },
  );
  if (rbRes.output.trim().length > 0) {
    process.stdout.write(rbRes.output);
    if (!rbRes.output.endsWith('\n')) process.stdout.write('\n');
  }
  if (rbRes.status !== 0) {
    log.err(`[flint] deploy: rollback failed with status ${rbRes.status} — see the wrangler output above; verify the deployment id and token scopes.`);
    process.exitCode = 4;
    return;
  }
  log.ok(`Rolled back to ${picked}.`);
}

interface ParsedDeployment {
  id: string;
  branch?: string;
  created?: string;
}

/**
 * Parse `wrangler pages deployment list` output. Wrangler v4 prints a
 * table with columns: Environment | Branch | Source | Deployment | Status | Build | URL.
 * We're permissive — any line containing a UUID is treated as a row.
 */
export function parseDeploymentList(output: string): ParsedDeployment[] {
  const results: ParsedDeployment[] = [];
  const uuidRe = /\b([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\b/i;
  for (const line of output.split(/\r?\n/)) {
    const m = uuidRe.exec(line);
    if (!m) continue;
    const tokens = line
      .split(/\s+|│|\|/)
      .map((s) => s.trim())
      .filter((s) => s.length > 0);
    const idx = tokens.indexOf(m[1]!);
    const branch = idx > 0 ? tokens[idx - 1] : undefined;
    const isoMatch = /\d{4}-\d{2}-\d{2}T[\d:.Z]+/.exec(line);
    results.push({
      id: m[1]!,
      branch,
      created: isoMatch ? isoMatch[0] : undefined,
    });
  }
  return results;
}

// ─── helpers ───────────────────────────────────────────────────────────────

function resolveBranch(cwd: string, opts: DeployOptions): string {
  if (opts.branch) return opts.branch;
  if (opts.preview) {
    const branch = currentGitBranch(cwd);
    if (branch) return branch;
    log.warn('--preview but could not detect git branch; falling back to "preview".');
    return 'preview';
  }
  return 'main';
}

function currentGitBranch(cwd: string): string | null {
  const res = spawnSync('git', ['-C', cwd, 'symbolic-ref', '--short', 'HEAD'], {
    encoding: 'utf8',
  });
  if (res.status !== 0) return null;
  return res.stdout.trim() || null;
}

function runChild(
  bin: string,
  args: string[],
  spawnOpts: SpawnSyncOptions,
  label: string,
): boolean {
  const res = spawnSync(bin, args, {
    ...spawnOpts,
    stdio: 'inherit',
  });
  if (res.status !== 0) {
    log.err(`  [flint] deploy: ${label} failed (exit ${res.status}) — fix the failing step or re-run with --skip-checks if you intentionally want to ship unverified.`);
    process.exitCode = 3;
    return false;
  }
  log.ok(`  ${label} passed.`);
  return true;
}
