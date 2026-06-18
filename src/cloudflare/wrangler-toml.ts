// In-place patcher for `wrangler.toml`.
//
// Why a surgical patcher instead of `parse + mutate + stringify`?
//   - `wrangler.toml` is hand-edited by users and Flint's templates carry
//     extensive comments. Round-tripping through any TOML library on npm
//     today (smol-toml, @iarna/toml) drops those comments and re-orders
//     blocks. That fails acceptance criterion 3 ("writeback preserves
//     comments and ordering").
//   - So we use `smol-toml` only to *understand* the parsed shape (e.g.
//     "is there a [[kv_namespaces]] block with binding=FOO_KV?") and we
//     edit the raw text by line ranges to make changes.
//
// Operations supported:
//   - read & parse (returns the parsed object + the raw text)
//   - patch a key inside an existing `[[kv_namespaces]]` block keyed by binding
//   - patch a key inside an existing `[[r2_buckets]]` block keyed by binding
//   - patch a key inside an existing `[[d1_databases]]` block keyed by binding
//   - append a new `[[kv_namespaces]]` / `[[r2_buckets]]` / `[[d1_databases]]`
//     block at end-of-file
//
// D1 support (the SQLite-on-the-edge binding) was added as an OFF-by-default
// seam so a template pack that declares `bindings.d1 = true` can provision a
// D1 database. No built-in variant ships a D1 block — it is purely opt-in.
//
// Block identity is the `binding` value — Wrangler treats this as the
// effective primary key (the type-binding tuple is what shows up in the
// runtime env), so Flint follows suit.

import { existsSync, readFileSync } from 'node:fs';
import { parse } from 'smol-toml';
import { writeFileAtomic } from '../util/atomic-write.js';

export interface KvNamespaceEntry {
  binding: string;
  id?: string;
  preview_id?: string;
}

export interface R2BucketEntry {
  binding: string;
  bucket_name?: string;
}

export interface D1DatabaseEntry {
  binding: string;
  database_name?: string;
  database_id?: string;
}

export interface WranglerEnv {
  /** Per-env Pages project name (default: top-level `name`). */
  name?: string;
  kv_namespaces: KvNamespaceEntry[];
  r2_buckets: R2BucketEntry[];
  d1_databases: D1DatabaseEntry[];
}

export interface WranglerToml {
  /** Pages project name (`name = "..."` at the top level). */
  name?: string;
  pages_build_output_dir?: string;
  compatibility_date?: string;
  compatibility_flags?: string[];
  kv_namespaces: KvNamespaceEntry[];
  r2_buckets: R2BucketEntry[];
  d1_databases: D1DatabaseEntry[];
  /**
   * `[env.<name>]` sections parsed from the wrangler.toml. Each env is a
   * partial override of the top-level config. `flint deploy --env staging`
   * needs to confirm `envs['staging']` exists before invoking wrangler.
   */
  envs: Record<string, WranglerEnv>;
  /** Raw text — kept so callers can write it back after edits. */
  raw: string;
}

export class WranglerTomlNotFoundError extends Error {
  constructor(path: string) {
    super(
      `wrangler.toml not found at ${path}.\n` +
        `Run \`flint init\` first to scaffold a Pages config, or change directory ` +
        `into a project that already has one.`,
    );
    this.name = 'WranglerTomlNotFoundError';
  }
}

export class WranglerTomlParseError extends Error {
  constructor(path: string, cause: unknown) {
    const detail = cause instanceof Error ? cause.message : String(cause);
    super(`wrangler.toml at ${path} is not valid TOML: ${detail}`);
    this.name = 'WranglerTomlParseError';
  }
}

/** Read + parse `wrangler.toml` from the given repo root. */
export function readWranglerToml(repoRoot: string, filename = 'wrangler.toml'): WranglerToml {
  const path = `${repoRoot}/${filename}`;
  if (!existsSync(path)) {
    throw new WranglerTomlNotFoundError(path);
  }
  const raw = readFileSync(path, 'utf8');
  let parsed: Record<string, unknown>;
  try {
    parsed = parse(raw) as Record<string, unknown>;
  } catch (e) {
    throw new WranglerTomlParseError(path, e);
  }
  const kv = Array.isArray(parsed.kv_namespaces) ? parsed.kv_namespaces : [];
  const r2 = Array.isArray(parsed.r2_buckets) ? parsed.r2_buckets : [];
  const d1 = Array.isArray(parsed.d1_databases) ? parsed.d1_databases : [];

  // `[env.<name>]` sections come through smol-toml as an `env` object whose
  // keys are env names and whose values are partial WranglerToml-shaped
  // sub-objects. We pluck just the fields we care about.
  const envs: Record<string, WranglerEnv> = {};
  const envSection =
    typeof parsed.env === 'object' && parsed.env !== null
      ? (parsed.env as Record<string, unknown>)
      : {};
  for (const [envName, envValue] of Object.entries(envSection)) {
    if (typeof envValue !== 'object' || envValue === null) continue;
    const envObj = envValue as Record<string, unknown>;
    const envKv = Array.isArray(envObj.kv_namespaces) ? envObj.kv_namespaces : [];
    const envR2 = Array.isArray(envObj.r2_buckets) ? envObj.r2_buckets : [];
    const envD1 = Array.isArray(envObj.d1_databases) ? envObj.d1_databases : [];
    envs[envName] = {
      name: typeof envObj.name === 'string' ? envObj.name : undefined,
      kv_namespaces: envKv.filter(isKvEntry),
      r2_buckets: envR2.filter(isR2Entry),
      d1_databases: envD1.filter(isD1Entry),
    };
  }

  return {
    name: typeof parsed.name === 'string' ? parsed.name : undefined,
    pages_build_output_dir:
      typeof parsed.pages_build_output_dir === 'string'
        ? parsed.pages_build_output_dir
        : undefined,
    compatibility_date:
      typeof parsed.compatibility_date === 'string' ? parsed.compatibility_date : undefined,
    compatibility_flags: Array.isArray(parsed.compatibility_flags)
      ? (parsed.compatibility_flags.filter((x) => typeof x === 'string') as string[])
      : undefined,
    kv_namespaces: kv.filter(isKvEntry),
    r2_buckets: r2.filter(isR2Entry),
    d1_databases: d1.filter(isD1Entry),
    envs,
    raw,
  };
}

function isKvEntry(x: unknown): x is KvNamespaceEntry {
  return (
    typeof x === 'object' &&
    x !== null &&
    'binding' in x &&
    typeof (x as { binding: unknown }).binding === 'string'
  );
}
function isR2Entry(x: unknown): x is R2BucketEntry {
  return (
    typeof x === 'object' &&
    x !== null &&
    'binding' in x &&
    typeof (x as { binding: unknown }).binding === 'string'
  );
}
function isD1Entry(x: unknown): x is D1DatabaseEntry {
  return (
    typeof x === 'object' &&
    x !== null &&
    'binding' in x &&
    typeof (x as { binding: unknown }).binding === 'string'
  );
}

/** Persist the current `raw` text back to disk. */
export function writeWranglerToml(
  repoRoot: string,
  doc: WranglerToml,
  filename = 'wrangler.toml',
): string {
  const path = `${repoRoot}/${filename}`;
  writeFileAtomic(path, doc.raw);
  return path;
}

// ─── Surgical edits ────────────────────────────────────────────────────────
//
// All edits operate on the `raw` string and return a NEW `WranglerToml` with
// `raw` updated + the parsed view re-derived. Callers can chain edits and
// call `writeWranglerToml` once at the end.
//
// Block detection: we scan the text line-by-line. Headers are exactly
// `[[kv_namespaces]]` or `[[r2_buckets]]` (TOML allows whitespace and
// comments after, which we tolerate). A block ends at the next `[`-line
// or EOF.

type BlockKind = 'kv_namespaces' | 'r2_buckets' | 'd1_databases';

interface BlockRange {
  /** Header line index (0-based). */
  headerLine: number;
  /** First content line after the header. */
  bodyStart: number;
  /** Exclusive end (first line that is NOT part of this block). */
  end: number;
  /** Parsed `binding` value, if any. */
  binding: string | null;
}

/** Split into lines, preserving trailing emptiness so we can re-join losslessly. */
function splitLines(raw: string): string[] {
  return raw.split('\n');
}

/** Find every block of `kind` and return its range + the `binding` value. */
function findBlocks(lines: string[], kind: BlockKind): BlockRange[] {
  const header = `[[${kind}]]`;
  const ranges: BlockRange[] = [];
  for (let i = 0; i < lines.length; i++) {
    const trimmed = lines[i]!.trim();
    if (
      trimmed === header ||
      trimmed.startsWith(`${header} `) ||
      trimmed.startsWith(`${header}\t`) ||
      trimmed.startsWith(`${header}#`)
    ) {
      const bodyStart = i + 1;
      let end = lines.length;
      for (let j = bodyStart; j < lines.length; j++) {
        const tt = lines[j]!.trimStart();
        // Any new `[` line terminates this block — that's either another
        // array-of-tables entry or a new section.
        if (tt.startsWith('[')) {
          end = j;
          break;
        }
      }
      ranges.push({
        headerLine: i,
        bodyStart,
        end,
        binding: extractBinding(lines.slice(bodyStart, end)),
      });
      i = end - 1; // skip ahead
    }
  }
  return ranges;
}

/** Pull the `binding = "..."` value from a block's body lines, if present. */
function extractBinding(bodyLines: string[]): string | null {
  for (const line of bodyLines) {
    const m = /^\s*binding\s*=\s*"([^"]+)"\s*(?:#.*)?$/.exec(line);
    if (m) return m[1]!;
  }
  return null;
}

/**
 * Replace the value of `key` inside the block at `range`. Operates on a
 * COPY of `lines` and returns the new array — caller joins back.
 * If the key doesn't exist in the block, appends `key = "value"` at the
 * end of the block (before any trailing blank line that separates it from
 * the next section).
 */
function setKeyInBlock(
  lines: string[],
  range: BlockRange,
  key: string,
  value: string,
): string[] {
  const out = lines.slice();
  const keyRe = new RegExp(`^(\\s*)${escapeRegex(key)}\\s*=\\s*.*$`);
  for (let i = range.bodyStart; i < range.end; i++) {
    const m = keyRe.exec(out[i]!);
    if (m) {
      const indent = m[1] ?? '';
      out[i] = `${indent}${key} = "${value}"`;
      return out;
    }
  }
  // Key not found — append before the trailing blank-line gap if any.
  let insertAt = range.end;
  while (insertAt > range.bodyStart && out[insertAt - 1]!.trim() === '') {
    insertAt -= 1;
  }
  out.splice(insertAt, 0, `${key} = "${value}"`);
  return out;
}

function escapeRegex(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * Patch an existing `[[kv_namespaces]]` block keyed by `binding`. Sets `id`
 * and (optionally) `preview_id`. Returns the new document; throws if no
 * block with that binding exists.
 */
export function patchKvNamespace(
  doc: WranglerToml,
  binding: string,
  patch: { id?: string; preview_id?: string },
): WranglerToml {
  let lines = splitLines(doc.raw);
  const ranges = findBlocks(lines, 'kv_namespaces');
  const target = ranges.find((r) => r.binding === binding);
  if (!target) {
    throw new Error(
      `[flint] wrangler-toml: no [[kv_namespaces]] block with binding="${binding}" — run \`flint add kv ${binding}\` to declare it first.`,
    );
  }
  if (patch.id !== undefined) {
    lines = setKeyInBlock(lines, target, 'id', patch.id);
  }
  if (patch.preview_id !== undefined) {
    // Range indices shift if id was newly appended — re-find before second edit.
    const refreshed = findBlocks(lines, 'kv_namespaces').find((r) => r.binding === binding);
    if (refreshed) {
      lines = setKeyInBlock(lines, refreshed, 'preview_id', patch.preview_id);
    }
  }
  return reparse({ ...doc, raw: lines.join('\n') });
}

/**
 * Patch an existing `[[r2_buckets]]` block keyed by `binding`. Sets
 * `bucket_name`. Returns the new document.
 */
export function patchR2Bucket(
  doc: WranglerToml,
  binding: string,
  patch: { bucket_name?: string },
): WranglerToml {
  let lines = splitLines(doc.raw);
  const ranges = findBlocks(lines, 'r2_buckets');
  const target = ranges.find((r) => r.binding === binding);
  if (!target) {
    throw new Error(
      `[flint] wrangler-toml: no [[r2_buckets]] block with binding="${binding}" — run \`flint add r2 ${binding}\` to declare it first.`,
    );
  }
  if (patch.bucket_name !== undefined) {
    lines = setKeyInBlock(lines, target, 'bucket_name', patch.bucket_name);
  }
  return reparse({ ...doc, raw: lines.join('\n') });
}

/**
 * Patch an existing `[[d1_databases]]` block keyed by `binding`. Sets
 * `database_id` and (optionally) `database_name`. Returns the new document;
 * throws if no block with that binding exists. Mirrors `patchKvNamespace` so
 * comment preservation + re-parse-in-sync behave identically.
 */
export function patchD1Database(
  doc: WranglerToml,
  binding: string,
  patch: { database_id?: string; database_name?: string },
): WranglerToml {
  let lines = splitLines(doc.raw);
  const ranges = findBlocks(lines, 'd1_databases');
  const target = ranges.find((r) => r.binding === binding);
  if (!target) {
    throw new Error(
      `[flint] wrangler-toml: no [[d1_databases]] block with binding="${binding}" — declare it first (a template pack with bindings.d1=true stamps one, or run \`flint add d1 ${binding}\`).`,
    );
  }
  if (patch.database_name !== undefined) {
    lines = setKeyInBlock(lines, target, 'database_name', patch.database_name);
  }
  if (patch.database_id !== undefined) {
    // Range indices shift if database_name was newly appended — re-find first.
    const refreshed = findBlocks(lines, 'd1_databases').find((r) => r.binding === binding);
    if (refreshed) {
      lines = setKeyInBlock(lines, refreshed, 'database_id', patch.database_id);
    }
  }
  return reparse({ ...doc, raw: lines.join('\n') });
}

export interface AppendKvOptions {
  binding: string;
  /** Stub id placeholder (default: REPLACE_WITH_KV_NAMESPACE_ID). */
  id?: string;
  /** Stub preview id (default: same as id). */
  preview_id?: string;
  /** Optional comment block written above the new block (no leading `#`). */
  comment?: string;
}

/** Append a `[[kv_namespaces]]` block to the document. */
export function appendKvNamespaceBlock(doc: WranglerToml, opts: AppendKvOptions): WranglerToml {
  const id = opts.id ?? 'REPLACE_WITH_KV_NAMESPACE_ID';
  const previewId = opts.preview_id ?? id;
  const block = renderKvBlock(opts.binding, id, previewId, opts.comment);
  return reparse({ ...doc, raw: appendBlock(doc.raw, block) });
}

export interface AppendR2Options {
  binding: string;
  bucket_name: string;
  comment?: string;
}

export function appendR2BucketBlock(doc: WranglerToml, opts: AppendR2Options): WranglerToml {
  const block = renderR2Block(opts.binding, opts.bucket_name, opts.comment);
  return reparse({ ...doc, raw: appendBlock(doc.raw, block) });
}

export interface AppendD1Options {
  binding: string;
  database_name: string;
  /** Stub database id (default: REPLACE_WITH_D1_DATABASE_ID). */
  database_id?: string;
  comment?: string;
}

/** Append a `[[d1_databases]]` block to the document. */
export function appendD1DatabaseBlock(doc: WranglerToml, opts: AppendD1Options): WranglerToml {
  const databaseId = opts.database_id ?? 'REPLACE_WITH_D1_DATABASE_ID';
  const block = renderD1Block(opts.binding, opts.database_name, databaseId, opts.comment);
  return reparse({ ...doc, raw: appendBlock(doc.raw, block) });
}

function renderKvBlock(binding: string, id: string, previewId: string, comment?: string): string {
  const lines: string[] = [];
  if (comment) {
    for (const c of comment.split('\n')) lines.push(`# ${c}`);
  }
  lines.push('[[kv_namespaces]]');
  lines.push(`binding = "${binding}"`);
  lines.push(`id = "${id}"`);
  lines.push(`preview_id = "${previewId}"`);
  return lines.join('\n');
}

function renderR2Block(binding: string, bucketName: string, comment?: string): string {
  const lines: string[] = [];
  if (comment) {
    for (const c of comment.split('\n')) lines.push(`# ${c}`);
  }
  lines.push('[[r2_buckets]]');
  lines.push(`binding = "${binding}"`);
  lines.push(`bucket_name = "${bucketName}"`);
  return lines.join('\n');
}

function renderD1Block(
  binding: string,
  databaseName: string,
  databaseId: string,
  comment?: string,
): string {
  const lines: string[] = [];
  if (comment) {
    for (const c of comment.split('\n')) lines.push(`# ${c}`);
  }
  lines.push('[[d1_databases]]');
  lines.push(`binding = "${binding}"`);
  lines.push(`database_name = "${databaseName}"`);
  lines.push(`database_id = "${databaseId}"`);
  return lines.join('\n');
}

/** Append a block to `raw`, ensuring exactly one blank line of separation. */
function appendBlock(raw: string, block: string): string {
  const trimmed = raw.replace(/\s*$/, '');
  return `${trimmed}\n\n${block}\n`;
}

/** Re-parse a doc after a raw-text edit so the parsed view stays in sync. */
function reparse(doc: WranglerToml): WranglerToml {
  let parsed: Record<string, unknown>;
  try {
    parsed = parse(doc.raw) as Record<string, unknown>;
  } catch (e) {
    throw new Error(
      `[flint] wrangler-toml: in-place patch produced invalid TOML — this is a Flint bug, please file an issue with the failing wrangler.toml. Original error: ${e instanceof Error ? e.message : String(e)}`,
    );
  }
  const kv = Array.isArray(parsed.kv_namespaces) ? parsed.kv_namespaces : [];
  const r2 = Array.isArray(parsed.r2_buckets) ? parsed.r2_buckets : [];
  const d1 = Array.isArray(parsed.d1_databases) ? parsed.d1_databases : [];
  return {
    ...doc,
    name: typeof parsed.name === 'string' ? parsed.name : doc.name,
    kv_namespaces: kv.filter(isKvEntry),
    r2_buckets: r2.filter(isR2Entry),
    d1_databases: d1.filter(isD1Entry),
  };
}

// ─── Pretty diff for --dry-run ─────────────────────────────────────────────

/**
 * Render a minimal unified-style diff between two raw TOML strings. The
 * goal is to show the user what `--dry-run` would change without pulling in
 * a `diff` dep. We emit `-` for removed lines and `+` for added lines around
 * the first changed hunk only — enough to be useful, not a full diff.
 */
export function diffTomlText(before: string, after: string): string {
  if (before === after) return '(no changes)';
  const a = splitLines(before);
  const b = splitLines(after);
  const out: string[] = [];
  // Find the first divergence.
  let i = 0;
  while (i < a.length && i < b.length && a[i] === b[i]) i++;
  // Show 2 lines of context before.
  const ctxStart = Math.max(0, i - 2);
  for (let k = ctxStart; k < i; k++) out.push(`  ${a[k]!}`);
  // Show the diverging tail of both. Cap at 20 lines each side to stay
  // readable for large appends.
  const aTailEnd = Math.min(a.length, i + 20);
  const bTailEnd = Math.min(b.length, i + 20);
  for (let k = i; k < aTailEnd; k++) out.push(`- ${a[k]!}`);
  for (let k = i; k < bTailEnd; k++) out.push(`+ ${b[k]!}`);
  if (a.length > aTailEnd || b.length > bTailEnd) {
    out.push(`  ... (diff truncated)`);
  }
  return out.join('\n');
}
