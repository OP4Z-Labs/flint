// Thin wrapper over the Cloudflare REST API. Covers the endpoints Flint
// needs through v0.2:
//
//   v0.1:
//     - GET /user/tokens/verify      → token validity + status
//     - GET /accounts                → enumerate accessible accounts
//     - Scope probes (used by auth doctor)
//
//   v0.2 (resource provisioning idempotency):
//     - GET /accounts/{id}/pages/projects               → list Pages projects
//     - GET /accounts/{id}/storage/kv/namespaces        → list KV namespaces
//     - GET /accounts/{id}/r2/buckets                   → list R2 buckets
//
// We intentionally avoid wrapping the entire CF SDK — native fetch keeps
// the dep tree small. Resource *creation* still goes through wrangler so
// the user's wrangler version is the source of truth for command shapes.

import type { ScopeProbeId } from './permissions.js';

const CF_API_BASE = 'https://api.cloudflare.com/client/v4';

export interface CloudflareAccount {
  id: string;
  name: string;
}

export interface VerifyResult {
  active: boolean;
  /** Token expiry (ISO 8601) if set; null/undefined for non-expiring. */
  expiresOn?: string | null;
  /** Token id from CF — useful only for display. */
  tokenId?: string;
}

export interface ProbeResult {
  ok: boolean;
  /** Reason for failure, or human-readable success note. */
  detail: string;
}

interface CFResponse<T> {
  success: boolean;
  errors: Array<{ code: number; message: string }>;
  messages: Array<{ code: number; message: string }>;
  result: T;
  result_info?: { count: number; page: number; per_page: number; total_count: number };
}

/** Internal helper: GET with bearer auth, returning the parsed JSON envelope. */
async function cfGet<T>(token: string, path: string): Promise<CFResponse<T>> {
  const res = await fetch(`${CF_API_BASE}${path}`, {
    method: 'GET',
    headers: {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json',
    },
  });
  // CF returns a typed envelope on both success and most failure modes;
  // a non-JSON body only happens on real network/edge problems.
  let body: unknown;
  try {
    body = await res.json();
  } catch {
    throw new Error(`[flint] cloudflare-api: non-JSON response from Cloudflare (HTTP ${res.status}) — check api.cloudflare.com status or retry; possibly a network/edge fault.`);
  }
  return body as CFResponse<T>;
}

/**
 * Verify the token is still active. Maps to `GET /user/tokens/verify`.
 * Throws if the token is invalid or the API is unreachable.
 */
export async function verifyToken(token: string): Promise<VerifyResult> {
  type Verify = { id: string; status: string; expires_on?: string | null };
  const body = await cfGet<Verify>(token, '/user/tokens/verify');
  if (!body.success) {
    const reason = body.errors?.[0]?.message ?? 'unknown';
    throw new Error(`[flint] cloudflare-api: token verification failed (${reason}) — re-create the token at https://dash.cloudflare.com/profile/api-tokens and run \`flint auth rotate\`.`);
  }
  return {
    active: body.result.status === 'active',
    expiresOn: body.result.expires_on ?? null,
    tokenId: body.result.id,
  };
}

/**
 * List all accounts this token can access. Maps to `GET /accounts`.
 * v0.1 only consumes the first 50 — pagination support is not needed
 * since solo devs are virtually always in 1–2 accounts.
 */
export async function listAccounts(token: string): Promise<CloudflareAccount[]> {
  type Account = { id: string; name: string };
  const body = await cfGet<Account[]>(token, '/accounts?per_page=50');
  if (!body.success) {
    const reason = body.errors?.[0]?.message ?? 'unknown';
    throw new Error(`[flint] cloudflare-api: listing accounts failed (${reason}) — verify the token has Account:Read and your network can reach api.cloudflare.com.`);
  }
  return body.result.map((a) => ({ id: a.id, name: a.name }));
}

// ─── Scope probes ──────────────────────────────────────────────────────────
// Each probe makes a low-cost API call that *requires* the named scope.
// Returns ok=true with a short detail on success; ok=false with the API's
// error message on failure. The doctor command runs all seven sequentially
// and reports the results in a table.

export async function probeScope(
  probeId: ScopeProbeId,
  token: string,
  accountId: string,
): Promise<ProbeResult> {
  switch (probeId) {
    case 'user.details.read':
      return probeGeneric(token, '/user', 'GET');
    case 'account.read':
      return probeGeneric(token, `/accounts/${accountId}`, 'GET');
    case 'pages.edit':
      // Listing projects requires Pages:Edit (Read alone is not granted by
      // CF for this resource — Edit subsumes Read in the token UI).
      return probeGeneric(token, `/accounts/${accountId}/pages/projects?per_page=1`, 'GET');
    case 'kv.edit':
      return probeGeneric(token, `/accounts/${accountId}/storage/kv/namespaces?per_page=1`, 'GET');
    case 'r2.edit':
      return probeGeneric(token, `/accounts/${accountId}/r2/buckets`, 'GET');
    case 'workers.scripts.edit':
      return probeGeneric(token, `/accounts/${accountId}/workers/scripts`, 'GET');
    case 'zone.read':
      return probeGeneric(token, '/zones?per_page=1', 'GET');
  }
}

// ─── Resource listing (for idempotency in `flint configure`) ──────────────
//
// Each list endpoint returns a paginated CF envelope. v0.2 uses these only
// to answer "does a resource with name X already exist?" so we fetch a
// single page sized to 50 — solo dev accounts virtually always have fewer
// resources than that. If pagination ever matters, the loop pattern is
// straightforward to add.

export interface PagesProjectSummary {
  /** Project name (== `wrangler.toml` `name`). */
  name: string;
  /** Production branch — useful for confirming the user's expectation. */
  production_branch: string;
  /** Live subdomain, e.g. `myapp.pages.dev`. */
  subdomain?: string;
}

export interface KvNamespaceSummary {
  /** Cloudflare-internal namespace id (32-char hex). */
  id: string;
  /** Human-readable title chosen at create time. */
  title: string;
}

export interface R2BucketSummary {
  /** Globally unique bucket name. */
  name: string;
  /** ISO 8601 string (CF returns "2026-01-01T00:00:00.000Z"). */
  creation_date?: string;
}

export async function listPagesProjects(
  token: string,
  accountId: string,
): Promise<PagesProjectSummary[]> {
  type Project = {
    name: string;
    production_branch?: string;
    subdomain?: string;
  };
  const body = await cfGet<Project[]>(
    token,
    `/accounts/${accountId}/pages/projects?per_page=50`,
  );
  if (!body.success) {
    const reason = body.errors?.[0]?.message ?? 'unknown';
    throw new Error(`[flint] cloudflare-api: listing Pages projects failed (${reason}) — verify the token has Pages:Edit on this account.`);
  }
  return (body.result ?? []).map((p) => ({
    name: p.name,
    production_branch: p.production_branch ?? 'main',
    subdomain: p.subdomain,
  }));
}

export async function listKvNamespaces(
  token: string,
  accountId: string,
): Promise<KvNamespaceSummary[]> {
  type Ns = { id: string; title: string };
  const body = await cfGet<Ns[]>(
    token,
    `/accounts/${accountId}/storage/kv/namespaces?per_page=50`,
  );
  if (!body.success) {
    const reason = body.errors?.[0]?.message ?? 'unknown';
    throw new Error(`[flint] cloudflare-api: listing KV namespaces failed (${reason}) — verify the token has Workers KV:Edit on this account.`);
  }
  return (body.result ?? []).map((n) => ({ id: n.id, title: n.title }));
}

export async function listR2Buckets(
  token: string,
  accountId: string,
): Promise<R2BucketSummary[]> {
  // CF returns R2 buckets in a slightly different envelope: `result.buckets`.
  type R2Result = { buckets?: Array<{ name: string; creation_date?: string }> };
  const body = await cfGet<R2Result>(token, `/accounts/${accountId}/r2/buckets`);
  if (!body.success) {
    const reason = body.errors?.[0]?.message ?? 'unknown';
    throw new Error(`[flint] cloudflare-api: listing R2 buckets failed (${reason}) — verify the token has R2:Edit on this account.`);
  }
  return (body.result?.buckets ?? []).map((b) => ({
    name: b.name,
    creation_date: b.creation_date,
  }));
}

async function probeGeneric(
  token: string,
  path: string,
  method: 'GET',
): Promise<ProbeResult> {
  try {
    const res = await fetch(`${CF_API_BASE}${path}`, {
      method,
      headers: {
        Authorization: `Bearer ${token}`,
        'Content-Type': 'application/json',
      },
    });
    if (res.ok) {
      return { ok: true, detail: `HTTP ${res.status}` };
    }
    // CF returns 403 with a JSON envelope on missing scopes; surface the
    // CF error message so the doctor output is actionable.
    let cfMessage = `HTTP ${res.status}`;
    try {
      const body = (await res.json()) as { errors?: Array<{ message: string }> };
      if (body.errors?.[0]?.message) {
        cfMessage = body.errors[0].message;
      }
    } catch {
      // body was non-JSON — keep the status as the detail.
    }
    return { ok: false, detail: cfMessage };
  } catch (e) {
    return { ok: false, detail: e instanceof Error ? e.message : 'network error' };
  }
}
