// `flint auth` — persistent Cloudflare API token management.
//
// Four sub-commands, all designed for solo-dev ergonomics:
//
//   init   — four-phase guided flow (educate → browser → capture/validate → store)
//   status — print currently stored account + token validity
//   doctor — probe each of the seven required scopes, report pass/fail
//   rotate — replace the stored token with a freshly created one
//
// Token storage rules:
//   - Source of truth: ~/.config/flint/credentials (mode 0600)
//   - Per-repo cache: ./.dev.vars (gitignored, mode 0600)
//   - Old creds archived to ~/.config/flint/credentials.rotated/<ts>.json
//
// The CLI never writes a token value to anywhere outside these paths.
// CLOUDFLARE_API_TOKEN env var is what Wrangler reads — both paths get
// it from `.dev.vars`, picked up by Wrangler natively.

import { confirm, input, password, select } from '@inquirer/prompts';
import {
  listAccounts,
  probeScope,
  verifyToken,
  type CloudflareAccount,
} from '../cloudflare/api.js';
import {
  REQUIRED_SCOPES,
  scopeListClipboard,
  scopeListText,
} from '../cloudflare/permissions.js';
import {
  archiveCurrentCredentials,
  readCredentials,
  writeCredentials,
  type Credentials,
} from '../cloudflare/credentials.js';
import {
  writeDevVars,
  writeDevVarsExample,
  DevVarsTrackedError,
  type DevVarsEntry,
} from '../cloudflare/dev-vars.js';
import { copyToClipboard } from '../util/clipboard.js';
import { openInBrowser } from '../util/browser.js';
import { log, color } from '../util/logger.js';
import { credentialsPath } from '../util/paths.js';

const DASHBOARD_URL = 'https://dash.cloudflare.com/profile/api-tokens';

export interface AuthInteractiveOptions {
  openBrowser: boolean;
  useClipboard: boolean;
}

// ─── auth init ─────────────────────────────────────────────────────────────

export async function authInit(opts: AuthInteractiveOptions): Promise<void> {
  const existing = readCredentials();
  if (existing) {
    log.heading('A Cloudflare API token is already stored.');
    log.dim(`  Account: ${existing.accountName} (${existing.accountId})`);
    log.dim(`  Created: ${existing.createdAt}`);
    log.dim(`  Path:    ${credentialsPath()}`);
    log.blank();
    const proceed = await confirm({
      message: 'Replace the stored token? (Use `flint auth rotate` for a guided replacement.)',
      default: false,
    });
    if (!proceed) {
      log.info('No changes made.');
      return;
    }
  }

  await runAuthFlow(opts, { archivePrevious: false });
}

// ─── auth rotate ───────────────────────────────────────────────────────────

export async function authRotate(opts: AuthInteractiveOptions): Promise<void> {
  const existing = readCredentials();
  if (!existing) {
    log.warn('No stored credentials found — running `auth init` instead.');
    await runAuthFlow(opts, { archivePrevious: false });
    return;
  }
  log.heading('Rotating Cloudflare API token');
  log.dim(`  Current account: ${existing.accountName} (${existing.accountId})`);
  log.dim('  Old token will be archived for 30 days under ~/.config/flint/credentials.rotated/.');
  log.blank();
  log.warn(
    'Cloudflare cannot self-revoke API tokens via the API. After Flint stores the new ' +
      'token, you must manually revoke the old one in the dashboard. Flint will print ' +
      'the dashboard URL at the end.',
  );
  log.blank();

  await runAuthFlow(opts, { archivePrevious: true, previousAccount: existing });

  log.blank();
  log.heading('Action required — revoke the OLD token');
  log.info(`Open: ${DASHBOARD_URL}`);
  log.info('Find the previous token and click "Roll" or "Delete" beside it.');
  log.dim('Flint considers rotation incomplete until you confirm the revoke.');
  const revoked = await confirm({
    message: 'I have revoked the old token in the Cloudflare dashboard.',
    default: false,
  });
  if (revoked) {
    log.ok('Rotation complete.');
  } else {
    log.warn('Rotation marked incomplete. Re-run `flint auth status` once the old token is revoked.');
  }
}

// ─── auth status ───────────────────────────────────────────────────────────

export async function authStatus(): Promise<void> {
  const creds = readCredentials();
  if (!creds) {
    log.err('No Cloudflare credentials stored.');
    log.info('Run `flint auth init` to create and store an API token.');
    process.exitCode = 1;
    return;
  }

  log.heading('Cloudflare credentials');
  log.dim(`  Path:    ${credentialsPath()}`);
  log.dim(`  Account: ${creds.accountName}`);
  log.dim(`  ID:      ${creds.accountId}`);
  log.dim(`  Created: ${creds.createdAt}`);
  log.blank();

  log.step('Verifying token with Cloudflare…');
  try {
    const result = await verifyToken(creds.token);
    if (result.active) {
      log.ok(`Token is active${result.expiresOn ? ` (expires ${result.expiresOn})` : ' (no expiry)'}.`);
    } else {
      log.err('Token is not active. Run `flint auth rotate`.');
      process.exitCode = 1;
    }
  } catch (e) {
    log.err(e instanceof Error ? e.message : String(e));
    process.exitCode = 1;
  }
}

// ─── auth doctor ───────────────────────────────────────────────────────────

export async function authDoctor(): Promise<void> {
  const creds = readCredentials();
  if (!creds) {
    log.err('No Cloudflare credentials stored.');
    log.info('Run `flint auth init` first.');
    process.exitCode = 1;
    return;
  }

  log.heading(`Probing required scopes against account ${creds.accountName} (${creds.accountId})`);
  log.dim('Each scope below is checked by making the smallest possible API call that needs it.');
  log.blank();

  // Confirm the token itself is still active before running probes — saves
  // the user from a wall of identical "invalid token" errors.
  try {
    const verify = await verifyToken(creds.token);
    if (!verify.active) {
      log.err('Token is not active. Run `flint auth rotate` before re-running the doctor.');
      process.exitCode = 1;
      return;
    }
  } catch (e) {
    log.err(`Token verification failed: ${e instanceof Error ? e.message : String(e)}`);
    process.exitCode = 1;
    return;
  }

  let failures = 0;
  for (const scope of REQUIRED_SCOPES) {
    const result = await probeScope(scope.probeId, creds.token, creds.accountId);
    const label = `${scope.group} → ${scope.label} (${scope.level})`;
    if (result.ok) {
      log.ok(`${label} — ${result.detail}`);
    } else {
      failures += 1;
      log.err(`${label} — ${result.detail}`);
    }
  }
  log.blank();
  if (failures === 0) {
    log.ok('All required scopes present.');
  } else {
    log.err(`${failures} scope(s) missing. Edit the token at ${DASHBOARD_URL} and add the missing rows above.`);
    process.exitCode = 1;
  }
}

// ─── shared flow ───────────────────────────────────────────────────────────

interface RunFlowOptions {
  archivePrevious: boolean;
  previousAccount?: Credentials;
}

async function runAuthFlow(
  interactive: AuthInteractiveOptions,
  flow: RunFlowOptions,
): Promise<void> {
  // PHASE A — Educate.
  log.heading('Flint needs a Cloudflare API token.');
  log.info('Wrangler reads `CLOUDFLARE_API_TOKEN` from your environment. Flint stores');
  log.info('a long-lived token once, so `wrangler login` (which expires) is never needed.');
  log.blank();
  log.info('Required scopes (a custom token with all of these):');
  log.info(scopeListText());
  log.blank();

  if (interactive.useClipboard) {
    if (copyToClipboard(scopeListClipboard())) {
      log.ok('Scope list copied to clipboard.');
    } else {
      log.dim('Clipboard not available — paste this block into the dashboard form by hand:');
      log.blank();
      log.dim(scopeListClipboard());
      log.blank();
    }
  }

  // PHASE B — Open the browser.
  log.heading('Open the Cloudflare token-creation page');
  log.info(DASHBOARD_URL);
  log.info('  → click "Create Token" → "Custom token" → "Get started".');
  log.info('  → paste the scope list as a reference, add each row, then save.');
  log.dim('  → Account Resources: scope to one account, or "All accounts" if multi-account.');
  log.dim('  → TTL: leave empty for non-expiring (recommended for solo dev).');
  log.blank();

  if (interactive.openBrowser) {
    const wantOpen = await confirm({
      message: 'Open the dashboard in your default browser now?',
      default: true,
    });
    if (wantOpen) {
      const ok = openInBrowser(DASHBOARD_URL);
      if (ok) {
        log.dim('Browser launched.');
      } else {
        log.warn(`Could not open a browser automatically. Open ${DASHBOARD_URL} manually.`);
      }
    }
  }

  // PHASE C — Capture and validate.
  log.blank();
  log.heading('Paste the token (input is hidden)');
  const tokenRaw = await password({
    message: 'Cloudflare API token:',
    mask: '*',
    validate: (value: string): true | string => {
      const v = value.trim();
      if (!v) return 'Token cannot be empty.';
      // CF API tokens are 40+ chars of [A-Za-z0-9_-]. We're loose on the
      // exact regex (CF has changed the shape historically) but reject
      // anything obviously not-a-token.
      if (v.length < 32) return 'That looks too short to be a Cloudflare API token.';
      if (/\s/.test(v)) return 'Token must not contain whitespace.';
      return true;
    },
  });
  const token = tokenRaw.trim();

  log.step('Verifying token with Cloudflare…');
  const verifyResult = await verifyToken(token);
  if (!verifyResult.active) {
    throw new Error('Cloudflare reports the token is not active. Re-create it and try again.');
  }
  log.ok(
    `Token verified${verifyResult.expiresOn ? ` (expires ${verifyResult.expiresOn})` : ' (no expiry)'}.`,
  );

  log.step('Listing accessible accounts…');
  const accounts = await listAccounts(token);
  if (accounts.length === 0) {
    throw new Error(
      'Token has no accessible accounts. Re-issue with Account Resources scoped correctly.',
    );
  }
  const chosen = await pickAccount(accounts, flow.previousAccount?.accountId);

  // PHASE D — Store.
  if (flow.archivePrevious) {
    const archive = archiveCurrentCredentials();
    if (archive) {
      log.dim(`Archived previous credentials to ${archive}.`);
    }
  }

  const creds: Credentials = {
    token,
    accountId: chosen.id,
    accountName: chosen.name,
    createdAt: new Date().toISOString(),
  };
  writeCredentials(creds);
  log.ok(`Wrote ${credentialsPath()} (mode 0600).`);

  // Hydrate the current repo's .dev.vars too, when we're standing in one.
  await hydrateLocalDevVars(creds);

  log.blank();
  log.ok('Flint is authenticated.');
  log.info('Next: run `flint auth doctor` to verify all scopes, or `flint init` to scaffold.');
}

async function pickAccount(
  accounts: CloudflareAccount[],
  preferredId?: string,
): Promise<CloudflareAccount> {
  if (accounts.length === 1) {
    log.ok(`Single account detected: ${accounts[0]!.name} (${accounts[0]!.id}).`);
    return accounts[0]!;
  }
  const chosenId = await select({
    message: 'Which account should Flint default to?',
    choices: accounts.map((a) => ({
      name: `${a.name} ${color('dim', `(${a.id})`)}`,
      value: a.id,
    })),
    default: preferredId,
  });
  const found = accounts.find((a) => a.id === chosenId);
  if (!found) {
    // Inquirer's select guarantees the picked value is in `choices`, so this
    // is a logic bug if it ever fires. Throw the clearest error possible.
    throw new Error(`Selected account ${chosenId} is not in the accounts list.`);
  }
  return found;
}

/**
 * If we're standing in what looks like a Pages-style repo (`package.json` or
 * `wrangler.toml` present), offer to also write `.dev.vars` here. Skipped
 * silently if neither is present — that's almost certainly not a repo.
 */
async function hydrateLocalDevVars(creds: Credentials): Promise<void> {
  const { existsSync } = await import('node:fs');
  const cwd = process.cwd();
  const looksLikeRepo =
    existsSync(`${cwd}/package.json`) || existsSync(`${cwd}/wrangler.toml`);
  if (!looksLikeRepo) {
    log.dim(
      'Not in a project directory (no package.json or wrangler.toml) — skipping local .dev.vars.',
    );
    return;
  }
  const want = await confirm({
    message: `Also write ${cwd}/.dev.vars for this repo?`,
    default: true,
  });
  if (!want) return;

  const entries: DevVarsEntry[] = [
    {
      key: 'CLOUDFLARE_API_TOKEN',
      value: creds.token,
      comment:
        'Cloudflare API token. Managed by Flint — re-run `flint auth init` or `flint auth rotate` to change.',
    },
    {
      key: 'CLOUDFLARE_ACCOUNT_ID',
      value: creds.accountId,
      comment: `Default account: ${creds.accountName}.`,
    },
  ];
  try {
    const path = writeDevVars(cwd, entries);
    log.ok(`Wrote ${path} (mode 0600, gitignored).`);
    const examplePath = writeDevVarsExample(cwd, entries);
    log.dim(`Wrote ${examplePath} for new contributors.`);
  } catch (e) {
    if (e instanceof DevVarsTrackedError) {
      log.err(e.message);
      throw e;
    }
    throw e;
  }
}

// `input` is imported for typing parity if a future flow needs free text;
// silence unused-import lint by referencing the symbol once. (Keeping
// the import keeps the bundle import-graph stable for tree-shaking.)
void input;
