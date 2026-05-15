// `flint doctor` — full-stack diagnostics.
//
// Distinct from `flint auth doctor`, which only checks Cloudflare API scopes.
// This command surfaces the entire user setup: Node version, package
// manager, wrangler install, Cloudflare auth, repo state.
//
// Output is a tree of green/yellow/red checks. Exits non-zero if ANY red
// check is found. JSON mode produces a structured envelope so CI can wire
// flint doctor as a pre-flight gate.
//
// Why this exists: when "flint init" or "flint deploy" fails, users have
// often spent 5–10 minutes guessing whether the problem is Node, npm,
// wrangler, the token, or their repo. `flint doctor` answers that in one
// command.

import { existsSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { log, color } from '../util/logger.js';
import { readCredentials } from '../cloudflare/credentials.js';
import { verifyToken } from '../cloudflare/api.js';
import { resolveWranglerBin } from '../cloudflare/wrangler-runner.js';
import { detectPackageManager } from '../util/package-manager.js';
import { readManifest, MANIFEST_FILENAME, MANIFEST_SCHEMA_VERSION } from '../util/manifest.js';
import { formatResult, ok } from '../util/format-result.js';
import { readPackageVersion } from '../util/version.js';

export interface DoctorOptions {
  json?: boolean;
}

type CheckStatus = 'green' | 'yellow' | 'red';

interface CheckResult {
  category: string;
  name: string;
  status: CheckStatus;
  detail: string;
}

const SUPPORTED_NODE_MAJORS = [20, 22, 24] as const;

export async function runDoctor(opts: DoctorOptions = {}): Promise<void> {
  const json = opts.json === true;
  const results: CheckResult[] = [];
  const cwd = process.cwd();

  // Runtime ────────────────────────────────────────────────────────────────
  const nodeMajor = parseInt(process.versions.node.split('.')[0] ?? '0', 10);
  if (SUPPORTED_NODE_MAJORS.includes(nodeMajor as 20 | 22 | 24)) {
    results.push({
      category: 'runtime',
      name: 'node',
      status: 'green',
      detail: `Node ${process.versions.node} (supported).`,
    });
  } else if (nodeMajor >= 20) {
    results.push({
      category: 'runtime',
      name: 'node',
      status: 'yellow',
      detail: `Node ${process.versions.node} — not in the explicit support matrix (${SUPPORTED_NODE_MAJORS.join(', ')}). May work but untested.`,
    });
  } else {
    results.push({
      category: 'runtime',
      name: 'node',
      status: 'red',
      detail: `Node ${process.versions.node} — too old. Flint requires Node ${SUPPORTED_NODE_MAJORS[0]}+.`,
    });
  }

  results.push({
    category: 'runtime',
    name: 'flint',
    status: 'green',
    detail: `flint ${readPackageVersion()} (this CLI).`,
  });

  // Package manager
  const pm = detectPackageManager(cwd);
  results.push({
    category: 'tooling',
    name: 'package-manager',
    status: pm.tier === 'first-class' ? 'green' : 'yellow',
    detail: `Detected ${pm.name}${pm.version ? `@${pm.version}` : ''} (${pm.source}).`,
  });

  // Wrangler
  let wranglerBin: string | null = null;
  let wranglerVersion: string | null = null;
  try {
    wranglerBin = resolveWranglerBin(cwd);
  } catch {
    wranglerBin = null;
  }
  if (wranglerBin) {
    const res = spawnSync(wranglerBin, ['--version'], { encoding: 'utf8' });
    if (res.status === 0) {
      // Wrangler prints either " ⛅️ wrangler 4.x.y" or just "4.x.y".
      const match = /(\d+\.\d+\.\d+)/.exec(res.stdout + res.stderr);
      wranglerVersion = match ? match[1] : null;
    }
    results.push({
      category: 'tooling',
      name: 'wrangler',
      status: wranglerVersion ? 'green' : 'yellow',
      detail: wranglerVersion
        ? `wrangler ${wranglerVersion} at ${wranglerBin}.`
        : `wrangler resolved at ${wranglerBin} but version probe failed.`,
    });
  } else {
    results.push({
      category: 'tooling',
      name: 'wrangler',
      status: 'yellow',
      detail: 'wrangler binary not found. Install with `npm install --save-dev wrangler` in your project, or globally.',
    });
  }

  // Cloudflare auth
  const creds = readCredentials();
  if (!creds) {
    results.push({
      category: 'auth',
      name: 'cloudflare-token',
      status: 'yellow',
      detail: 'No Cloudflare credentials stored. Run `flint auth init` to set up.',
    });
  } else {
    try {
      const v = await verifyToken(creds.token);
      if (v.active) {
        results.push({
          category: 'auth',
          name: 'cloudflare-token',
          status: 'green',
          detail: `Token active for account ${creds.accountName} (${creds.accountId})${v.expiresOn ? `, expires ${v.expiresOn}` : ''}.`,
        });
      } else {
        results.push({
          category: 'auth',
          name: 'cloudflare-token',
          status: 'red',
          detail: 'Stored token is INACTIVE. Run `flint auth rotate`.',
        });
      }
    } catch (e) {
      results.push({
        category: 'auth',
        name: 'cloudflare-token',
        status: 'red',
        detail: `Token verification failed: ${e instanceof Error ? e.message : String(e)}`,
      });
    }
  }

  // Repo state
  const wranglerToml = join(cwd, 'wrangler.toml');
  if (existsSync(wranglerToml)) {
    results.push({
      category: 'repo',
      name: 'wrangler.toml',
      status: 'green',
      detail: `Present (${statSync(wranglerToml).size} bytes).`,
    });
  } else {
    results.push({
      category: 'repo',
      name: 'wrangler.toml',
      status: 'yellow',
      detail: 'No wrangler.toml in cwd. Run `flint init` to scaffold one.',
    });
  }

  // .dev.vars + gitignore check
  const devVarsPath = join(cwd, '.dev.vars');
  if (existsSync(devVarsPath)) {
    // Gitignore check via `git check-ignore`. If git's not on PATH, downgrade
    // to yellow ("can't verify").
    const gi = spawnSync('git', ['check-ignore', '.dev.vars'], { cwd, encoding: 'utf8' });
    if (gi.status === 0) {
      results.push({
        category: 'repo',
        name: '.dev.vars',
        status: 'green',
        detail: 'Present and gitignored.',
      });
    } else if (gi.status === 1) {
      results.push({
        category: 'repo',
        name: '.dev.vars',
        status: 'red',
        detail: '.dev.vars is NOT gitignored. Add it to .gitignore IMMEDIATELY or run `flint init` to fix.',
      });
    } else {
      results.push({
        category: 'repo',
        name: '.dev.vars',
        status: 'yellow',
        detail: 'Present, but git is unavailable to verify gitignore status.',
      });
    }
  } else {
    results.push({
      category: 'repo',
      name: '.dev.vars',
      status: 'yellow',
      detail: '.dev.vars not present (fine if you have no secrets to mirror locally).',
    });
  }

  // Manifest check
  const manifestFile = join(cwd, MANIFEST_FILENAME);
  if (existsSync(manifestFile)) {
    const manifest = readManifest(cwd);
    if (manifest && manifest.version === MANIFEST_SCHEMA_VERSION) {
      results.push({
        category: 'repo',
        name: 'manifest',
        status: 'green',
        detail: `${MANIFEST_FILENAME} present, schema v${manifest.version}, ${Object.keys(manifest.files).length} tracked files.`,
      });
    } else {
      const raw = readFileSync(manifestFile, 'utf8').slice(0, 200);
      void raw;
      results.push({
        category: 'repo',
        name: 'manifest',
        status: 'red',
        detail: `${MANIFEST_FILENAME} present but invalid or wrong schema version.`,
      });
    }
  } else {
    results.push({
      category: 'repo',
      name: 'manifest',
      status: 'yellow',
      detail: `${MANIFEST_FILENAME} not present (pre-v0.9 project or not yet scaffolded — run \`flint upgrade\` to backfill).`,
    });
  }

  // Print + result
  if (!json) {
    log.heading('Flint doctor');
    const byCategory = new Map<string, CheckResult[]>();
    for (const r of results) {
      if (!byCategory.has(r.category)) byCategory.set(r.category, []);
      byCategory.get(r.category)?.push(r);
    }
    for (const [cat, group] of byCategory) {
      log.blank();
      log.info(`  ${color('bold', cat)}`);
      for (const r of group) {
        const icon =
          r.status === 'green' ? color('green', '✓') :
          r.status === 'yellow' ? color('yellow', '!') :
          color('red', '✗');
        log.info(`    ${icon} ${r.name} — ${r.detail}`);
      }
    }
    log.blank();
    const reds = results.filter((r) => r.status === 'red').length;
    const yellows = results.filter((r) => r.status === 'yellow').length;
    if (reds === 0 && yellows === 0) {
      log.ok('All checks green.');
    } else if (reds === 0) {
      log.warn(`${yellows} warning(s). Flint will still work — see notes above.`);
    } else {
      log.err(`${reds} failed check(s). Fix the items above before running other Flint commands.`);
    }
  }

  const hasRed = results.some((r) => r.status === 'red');
  if (hasRed) process.exitCode = 1;

  formatResult(
    ok('doctor', {
      cwd,
      checks: results,
      counts: {
        green: results.filter((r) => r.status === 'green').length,
        yellow: results.filter((r) => r.status === 'yellow').length,
        red: results.filter((r) => r.status === 'red').length,
      },
    }),
    { json },
  );
}
