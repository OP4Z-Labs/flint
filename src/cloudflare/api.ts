// Thin wrapper over the Cloudflare REST API. Only covers the endpoints
// Flint v0.1 needs:
//
//   - GET /user/tokens/verify      → token validity + status
//   - GET /accounts                → enumerate accessible accounts
//   - Scope probes (used by auth doctor)
//
// We intentionally avoid wrapping the entire CF SDK — v0.1 needs four
// endpoints. When v0.2 adds resource provisioning, swap in their official
// SDK if it makes sense; for now, native fetch keeps the dep tree small.

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
    throw new Error(`Cloudflare API returned non-JSON response (HTTP ${res.status})`);
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
    throw new Error(`Token verification failed: ${reason}`);
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
    throw new Error(`Listing accounts failed: ${reason}`);
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
