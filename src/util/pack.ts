// Template-pack loader + validator.
//
// A "pack" is an EXTERNAL directory (shipped by something like the Client Site
// Kit) that contributes business-aware templates to Flint WITHOUT putting any
// business logic into Flint itself. Flint stays a generic engine: it knows how
// to read a `pack.json`, validate it, resolve variables, and stamp trees — it
// knows nothing about what the templates are *for*.
//
// The pack format is contract `flint-pack-1` (see the JSON schema the kit
// ships at docs/contracts/pack.schema.json). A pack directory contains:
//
//   pack.json            — the manifest (validated by this module)
//   <core paths>/        — tree paths in `core[]`, always stamped
//   <template paths>/    — one tree per entry in `templates[]`
//
// Why a hand-rolled validator instead of a JSON-schema dependency:
//   - Flint's whole value proposition is a tiny dep tree (3 runtime deps).
//     Pulling ajv (+ its transitive deps) to validate one small, frozen
//     schema would be the largest dependency in the project. The schema is
//     ~10 constrained fields; a focused validator is cheaper and gives nicer
//     error messages than a generic schema engine.
//   - The checks below mirror the schema's `required`, `enum`, and
//     `additionalProperties: false` constraints exactly.

import { existsSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import type { TemplateVars } from './template.js';

/** Contract version this loader understands. */
export const FLINT_PACK_FORMAT = 1;

/** The four var-derivation transforms the contract enumerates. */
export type VarTransform = 'kebab' | 'snakeCookie' | 'lower' | 'title';
const VAR_TRANSFORMS: ReadonlyArray<VarTransform> = ['kebab', 'snakeCookie', 'lower', 'title'];

/** Template rendering mode the contract enumerates. */
export type PackRendering = 'spa' | 'ssg';
const PACK_RENDERINGS: ReadonlyArray<PackRendering> = ['spa', 'ssg'];

export interface PackVar {
  name: string;
  prompt?: string;
  required?: boolean;
  default?: string;
  /** Derive this var's value from another var's value. */
  from?: string;
  /** Transform applied when deriving (or to a provided value). */
  transform?: VarTransform;
}

export interface PackTemplateBindings {
  kv?: boolean;
  r2?: boolean;
  d1?: boolean;
}

export interface PackTemplate {
  id: string;
  title: string;
  description?: string;
  /** Tree path relative to the pack root. */
  path: string;
  rendering: PackRendering;
  bindings: PackTemplateBindings;
  /** Names of core sub-trees this template includes (informational). */
  includesCore?: string[];
}

export interface Pack {
  $schema?: string;
  flintPackFormat: number;
  name: string;
  version: string;
  description?: string;
  /** Tree paths always stamped into a generated site. */
  core: string[];
  vars: PackVar[];
  templates: PackTemplate[];
  /** Absolute path to the pack directory (set by the loader). */
  rootDir: string;
}

/** Thrown when a pack directory or its manifest is malformed. */
export class PackValidationError extends Error {
  constructor(message: string) {
    super(`[flint] pack: ${message}`);
    this.name = 'PackValidationError';
  }
}

/**
 * Load + validate a pack from a directory. The directory must contain a
 * `pack.json` conforming to contract `flint-pack-1`. Returns the parsed,
 * validated manifest with `rootDir` filled in.
 */
export function loadPack(packDir: string): Pack {
  const abs = packDir;
  if (!existsSync(abs) || !statSync(abs).isDirectory()) {
    throw new PackValidationError(
      `pack directory not found at "${packDir}" — pass --pack pointing at a directory that contains a pack.json.`,
    );
  }
  const manifestPath = join(abs, 'pack.json');
  if (!existsSync(manifestPath)) {
    throw new PackValidationError(
      `no pack.json in "${packDir}" — a Flint template pack must ship a pack.json at its root.`,
    );
  }
  let raw: unknown;
  try {
    raw = JSON.parse(readFileSync(manifestPath, 'utf8'));
  } catch (e) {
    throw new PackValidationError(
      `pack.json in "${packDir}" is not valid JSON: ${e instanceof Error ? e.message : String(e)}`,
    );
  }
  return validatePack(raw, abs);
}

/**
 * Validate a parsed pack.json object against contract `flint-pack-1`. Mirrors
 * the JSON schema's required/enum/additionalProperties constraints. Exposed
 * separately from `loadPack` so callers (and tests) can validate in-memory
 * objects without touching disk.
 */
export function validatePack(raw: unknown, rootDir: string): Pack {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
    throw new PackValidationError('pack.json must be a JSON object.');
  }
  const obj = raw as Record<string, unknown>;

  // additionalProperties: false at the top level.
  const allowedTop = new Set([
    '$schema',
    'flintPackFormat',
    'name',
    'version',
    'description',
    'core',
    'vars',
    'templates',
  ]);
  for (const key of Object.keys(obj)) {
    if (!allowedTop.has(key)) {
      throw new PackValidationError(`unknown top-level key "${key}" in pack.json (the format is strict).`);
    }
  }

  if (obj.flintPackFormat !== FLINT_PACK_FORMAT) {
    throw new PackValidationError(
      `unsupported flintPackFormat ${JSON.stringify(obj.flintPackFormat)} — this Flint understands format ${FLINT_PACK_FORMAT}.`,
    );
  }
  const name = requireString(obj, 'name');
  const version = requireString(obj, 'version');
  const description = optionalString(obj, 'description');

  if (!Array.isArray(obj.core)) {
    throw new PackValidationError('pack.json "core" is required and must be an array of tree paths.');
  }
  const core = obj.core.map((c, i) => {
    if (typeof c !== 'string') {
      throw new PackValidationError(`pack.json core[${i}] must be a string path.`);
    }
    return c;
  });

  const vars = validateVars(obj.vars);

  if (!Array.isArray(obj.templates) || obj.templates.length < 1) {
    throw new PackValidationError('pack.json "templates" is required and must contain at least one template.');
  }
  const templates = obj.templates.map((t, i) => validateTemplate(t, i));

  // Reject duplicate template ids — the registry keys templates by id.
  const seen = new Set<string>();
  for (const t of templates) {
    if (seen.has(t.id)) {
      throw new PackValidationError(`duplicate template id "${t.id}" — template ids must be unique within a pack.`);
    }
    seen.add(t.id);
  }

  return {
    $schema: optionalString(obj, '$schema'),
    flintPackFormat: FLINT_PACK_FORMAT,
    name,
    version,
    description,
    core,
    vars,
    templates,
    rootDir,
  };
}

function validateVars(raw: unknown): PackVar[] {
  if (raw === undefined) return [];
  if (!Array.isArray(raw)) {
    throw new PackValidationError('pack.json "vars" must be an array when present.');
  }
  return raw.map((v, i) => {
    if (typeof v !== 'object' || v === null || Array.isArray(v)) {
      throw new PackValidationError(`pack.json vars[${i}] must be an object.`);
    }
    const vo = v as Record<string, unknown>;
    const allowed = new Set(['name', 'prompt', 'required', 'default', 'from', 'transform']);
    for (const key of Object.keys(vo)) {
      if (!allowed.has(key)) {
        throw new PackValidationError(`pack.json vars[${i}] has unknown key "${key}".`);
      }
    }
    const name = requireString(vo, 'name', `vars[${i}]`);
    const transform = vo.transform;
    if (transform !== undefined && !VAR_TRANSFORMS.includes(transform as VarTransform)) {
      throw new PackValidationError(
        `pack.json vars[${i}].transform "${String(transform)}" is invalid — allowed: ${VAR_TRANSFORMS.join(', ')}.`,
      );
    }
    return {
      name,
      prompt: optionalString(vo, 'prompt'),
      required: typeof vo.required === 'boolean' ? vo.required : undefined,
      default: optionalString(vo, 'default'),
      from: optionalString(vo, 'from'),
      transform: transform as VarTransform | undefined,
    };
  });
}

function validateTemplate(raw: unknown, i: number): PackTemplate {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
    throw new PackValidationError(`pack.json templates[${i}] must be an object.`);
  }
  const to = raw as Record<string, unknown>;
  const allowed = new Set([
    'id',
    'title',
    'description',
    'path',
    'rendering',
    'bindings',
    'includesCore',
  ]);
  for (const key of Object.keys(to)) {
    if (!allowed.has(key)) {
      throw new PackValidationError(`pack.json templates[${i}] has unknown key "${key}".`);
    }
  }
  const id = requireString(to, 'id', `templates[${i}]`);
  const title = requireString(to, 'title', `templates[${i}]`);
  const path = requireString(to, 'path', `templates[${i}]`);
  const rendering = to.rendering;
  if (!PACK_RENDERINGS.includes(rendering as PackRendering)) {
    throw new PackValidationError(
      `pack.json templates[${i}].rendering "${String(rendering)}" is invalid — allowed: ${PACK_RENDERINGS.join(', ')}.`,
    );
  }
  if (typeof to.bindings !== 'object' || to.bindings === null || Array.isArray(to.bindings)) {
    throw new PackValidationError(`pack.json templates[${i}].bindings is required and must be an object.`);
  }
  const bo = to.bindings as Record<string, unknown>;
  const allowedBindings = new Set(['kv', 'r2', 'd1']);
  for (const key of Object.keys(bo)) {
    if (!allowedBindings.has(key)) {
      throw new PackValidationError(`pack.json templates[${i}].bindings has unknown key "${key}".`);
    }
    if (typeof bo[key] !== 'boolean') {
      throw new PackValidationError(`pack.json templates[${i}].bindings.${key} must be a boolean.`);
    }
  }
  let includesCore: string[] | undefined;
  if (to.includesCore !== undefined) {
    if (!Array.isArray(to.includesCore)) {
      throw new PackValidationError(`pack.json templates[${i}].includesCore must be an array.`);
    }
    includesCore = to.includesCore.map((c, j) => {
      if (typeof c !== 'string') {
        throw new PackValidationError(`pack.json templates[${i}].includesCore[${j}] must be a string.`);
      }
      return c;
    });
  }
  return {
    id,
    title,
    description: optionalString(to, 'description'),
    path,
    rendering: rendering as PackRendering,
    bindings: {
      kv: typeof bo.kv === 'boolean' ? bo.kv : undefined,
      r2: typeof bo.r2 === 'boolean' ? bo.r2 : undefined,
      d1: typeof bo.d1 === 'boolean' ? bo.d1 : undefined,
    },
    includesCore,
  };
}

function requireString(obj: Record<string, unknown>, key: string, ctx = 'pack.json'): string {
  const v = obj[key];
  if (typeof v !== 'string' || v.length === 0) {
    throw new PackValidationError(`${ctx} "${key}" is required and must be a non-empty string.`);
  }
  return v;
}

function optionalString(obj: Record<string, unknown>, key: string): string | undefined {
  const v = obj[key];
  return typeof v === 'string' ? v : undefined;
}

// ─── Variable derivation ─────────────────────────────────────────────────────

/** Find a template by id within a loaded pack. */
export function findTemplate(pack: Pack, templateId: string): PackTemplate {
  const t = pack.templates.find((x) => x.id === templateId);
  if (!t) {
    const ids = pack.templates.map((x) => x.id).join(', ');
    throw new PackValidationError(
      `template "${templateId}" not found in pack "${pack.name}" — available templates: ${ids}.`,
    );
  }
  return t;
}

/** Apply a single transform to a string value. */
export function applyTransform(value: string, transform: VarTransform): string {
  switch (transform) {
    case 'kebab':
      // "Acme Cafe & Bar" → "acme-cafe-bar"
      return value
        .trim()
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, '-')
        .replace(/^-+|-+$/g, '');
    case 'snakeCookie':
      // Cookie-name-safe: "acme-cafe" → "acme_cafe_admin". The `_admin`
      // suffix matches Flint's built-in cookieName convention so pack and
      // built-in scaffolds produce the same cookie shape.
      return `${value
        .trim()
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, '_')
        .replace(/^_+|_+$/g, '')}_admin`;
    case 'lower':
      return value.toLowerCase();
    case 'title':
      // "acme cafe" → "Acme Cafe"
      return value
        .trim()
        .split(/\s+/)
        .map((w) => (w.length > 0 ? w[0]!.toUpperCase() + w.slice(1) : w))
        .join(' ');
    default: {
      // Exhaustiveness guard for JS callers.
      const never: never = transform;
      throw new PackValidationError(`unknown transform "${String(never)}".`);
    }
  }
}

export interface ResolveVarsInput {
  /** The pack whose vars[] declares the resolution graph. */
  pack: Pack;
  /**
   * Caller-provided values keyed by var name (e.g. from prompts or CLI flags).
   * Used as the base; derived/default vars fill in the rest.
   */
  provided: Record<string, string>;
}

/**
 * Resolve the full set of template variables for a pack, honoring:
 *   - provided values (highest priority)
 *   - `from` + `transform` derivations (derive from another resolved var)
 *   - `transform` applied to a provided/default value (no `from`)
 *   - `default` values
 *   - `required` enforcement (throws if a required var has no value)
 *
 * Derivation is order-independent within reason: we iterate to a fixed point
 * so a var can derive from another derived var regardless of declaration order.
 */
export function resolvePackVars(input: ResolveVarsInput): TemplateVars {
  const { pack, provided } = input;
  const resolved: Record<string, string> = {};

  // Seed with provided values that match a declared var OR are extra
  // (callers may inject vars like compatDate the pack didn't declare).
  for (const [k, v] of Object.entries(provided)) {
    resolved[k] = v;
  }

  // Fixed-point loop: each pass resolves any var whose dependency is ready.
  const declared = pack.vars;
  const maxPasses = declared.length + 1;
  for (let pass = 0; pass < maxPasses; pass++) {
    let progressed = false;
    for (const v of declared) {
      if (resolved[v.name] !== undefined && !needsRederive(v, provided)) continue;

      // Provided value present and no transform-on-provided → keep as-is.
      if (provided[v.name] !== undefined) {
        let val = provided[v.name]!;
        if (v.transform && !v.from) val = applyTransform(val, v.transform);
        if (resolved[v.name] !== val) {
          resolved[v.name] = val;
          progressed = true;
        }
        continue;
      }

      // Derived from another var.
      if (v.from) {
        const src = resolved[v.from];
        if (src === undefined) continue; // dependency not ready yet
        const val = v.transform ? applyTransform(src, v.transform) : src;
        if (resolved[v.name] !== val) {
          resolved[v.name] = val;
          progressed = true;
        }
        continue;
      }

      // Default value.
      if (v.default !== undefined) {
        const val = v.transform ? applyTransform(v.default, v.transform) : v.default;
        if (resolved[v.name] !== val) {
          resolved[v.name] = val;
          progressed = true;
        }
        continue;
      }
    }
    if (!progressed) break;
  }

  // Enforce required vars.
  for (const v of declared) {
    if (v.required && (resolved[v.name] === undefined || resolved[v.name] === '')) {
      throw new PackValidationError(
        `required variable "${v.name}" (${v.prompt ?? 'no prompt'}) was not provided and could not be derived.`,
      );
    }
  }

  return resolved;
}

/**
 * A provided var that also carries a transform-on-provided still needs a pass
 * to apply the transform; this tells the loop to re-process it once.
 */
function needsRederive(v: PackVar, provided: Record<string, string>): boolean {
  return v.transform !== undefined && !v.from && provided[v.name] !== undefined;
}
