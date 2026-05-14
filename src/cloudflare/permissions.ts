// Canonical Cloudflare API token scopes required by Flint-managed apps.
// The list maps 1:1 to the table in plan §4 (Phase B), and is the single
// source of truth for both the on-screen "create your token" explainer and
// the `auth doctor` scope probe.

export interface RequiredScope {
  /** Human-readable name shown in the Cloudflare token-creation UI. */
  label: string;
  /** "Edit" or "Read" — what the user picks in the dashboard dropdown. */
  level: 'Edit' | 'Read';
  /** "Account", "User", or "Zone" — the parent group in the UI. */
  group: 'Account' | 'User' | 'Zone';
  /** Plain-English justification, shown in the educate-phase output. */
  why: string;
  /**
   * Probe function: invoked by `auth doctor` to confirm this scope is
   * actually granted. Returns `{ ok: true }` on success, or `{ ok: false,
   * reason }` on failure. Implementations are in cloudflare/api.ts.
   */
  probeId: ScopeProbeId;
}

export type ScopeProbeId =
  | 'pages.edit'
  | 'kv.edit'
  | 'r2.edit'
  | 'account.read'
  | 'workers.scripts.edit'
  | 'user.details.read'
  | 'zone.read';

export const REQUIRED_SCOPES: ReadonlyArray<RequiredScope> = [
  {
    label: 'Cloudflare Pages',
    level: 'Edit',
    group: 'Account',
    why: 'Create Pages projects, deploy, manage settings.',
    probeId: 'pages.edit',
  },
  {
    label: 'Workers KV Storage',
    level: 'Edit',
    group: 'Account',
    why: 'Create namespaces; read/write values from `flint configure` and Wrangler.',
    probeId: 'kv.edit',
  },
  {
    label: 'Workers R2 Storage',
    level: 'Edit',
    group: 'Account',
    why: 'Create buckets and manage objects for media storage.',
    probeId: 'r2.edit',
  },
  {
    label: 'Account Settings',
    level: 'Read',
    group: 'Account',
    why: 'Resolve your Account ID via the API on first use.',
    probeId: 'account.read',
  },
  {
    label: 'Workers Scripts',
    level: 'Edit',
    group: 'Account',
    why: 'Future-proof for plain Workers without re-issuing the token.',
    probeId: 'workers.scripts.edit',
  },
  {
    label: 'User Details',
    level: 'Read',
    group: 'User',
    why: 'Power `flint auth status` and `wrangler whoami`.',
    probeId: 'user.details.read',
  },
  {
    label: 'Zone',
    level: 'Read',
    group: 'Zone',
    why: 'Required for `wrangler pages domain` (custom domains).',
    probeId: 'zone.read',
  },
];

/** Pretty-printed scope list intended for the educate-phase output. */
export function scopeListText(): string {
  const rows = REQUIRED_SCOPES.map(
    (s) => `  • ${s.group} → ${s.label} :: ${s.level}  — ${s.why}`,
  );
  return rows.join('\n');
}

/**
 * Compact scope list for the clipboard. Format matches how Cloudflare's
 * token UI labels the permission rows: "<Group> · <Label> · <Level>"
 * — easy to scan against the dashboard form.
 */
export function scopeListClipboard(): string {
  const header =
    'Required scopes for Flint-managed Cloudflare Pages apps (paste this beside the dashboard form):';
  const rows = REQUIRED_SCOPES.map((s) => `- ${s.group} · ${s.label} · ${s.level}`);
  return [header, '', ...rows].join('\n');
}
