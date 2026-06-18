// Template-source registry — the seam that lets an EXTERNAL pack contribute
// templates alongside Flint's built-in variants.
//
// Before this module, the set of scaffoldable variants was hardcoded as
// `SUPPORTED_VARIANTS` arrays scattered across create-app.ts / init.ts /
// add-features.ts. That made the variant list a closed set: the only way to
// add a template was to edit Flint's source. The registry replaces the closed
// array with an open, two-source model:
//
//   (a) BUILT-IN variants — `static-spa`, `pages-functions`, `pages-fullstack`.
//       These are described declaratively below. Their on-disk trees live in
//       `templates/<variant>/` exactly as before, and the create-app/init
//       flows that stamp them are UNCHANGED. The registry just gives the rest
//       of the codebase a single place to ask "what built-in variants exist?"
//       instead of re-declaring the array.
//
//   (b) PACK templates — loaded on demand from an external pack directory
//       (see util/pack.ts). A pack contributes one registry entry per template
//       it declares. Flint never bundles pack content; it loads + validates a
//       pack only when the user passes `--pack <dir>`.
//
// IMPORTANT: this is additive. Built-in variant behaviour is byte-for-byte
// identical to before — `flint create-app foo --variant static-spa` does not
// touch any pack code path. The registry is the seam; built-ins are simply a
// built-in pack-like source.

import type { Pack, PackTemplate } from './pack.js';

/** The three built-in variant ids, in display order. */
export const BUILTIN_VARIANTS = ['static-spa', 'pages-functions', 'pages-fullstack'] as const;
export type BuiltinVariant = (typeof BUILTIN_VARIANTS)[number];

/** Human descriptions for the built-in variants (used by interactive pickers). */
export const BUILTIN_VARIANT_DESCRIPTIONS: Record<BuiltinVariant, string> = {
  'static-spa': 'static-spa — Vite + React + TS, no Pages Functions (Portfolio-style)',
  'pages-functions': 'pages-functions — adds 1 KV namespace + HMAC auth (Chorus-style)',
  'pages-fullstack': 'pages-fullstack — adds KV + R2 + PWA + HMAC auth (Blaze-style)',
};

/** Whether a string names a built-in variant. */
export function isBuiltinVariant(id: string): id is BuiltinVariant {
  return (BUILTIN_VARIANTS as ReadonlyArray<string>).includes(id);
}

/** A single scaffoldable entry in the registry. */
export interface RegistryEntry {
  /** Stable id used at the `--variant` / `--template` selection layer. */
  id: string;
  /** Human title for pickers. */
  title: string;
  /** Where this entry comes from. */
  source: 'builtin' | 'pack';
  /**
   * Resource bindings the entry wants provisioned. Built-ins carry their
   * bindings in their wrangler.toml template directly (so these are advisory
   * for built-ins); pack templates declare them explicitly.
   */
  bindings: { kv?: boolean; r2?: boolean; d1?: boolean };
  /** For pack entries: the pack + template this resolves to. */
  pack?: Pack;
  template?: PackTemplate;
}

/**
 * A registry is just an ordered list of entries plus lookup helpers. It is
 * cheap to construct — built-ins are static, packs are passed in already
 * loaded — so we build a fresh one per command invocation rather than caching.
 */
export class TemplateRegistry {
  private readonly entries: RegistryEntry[];

  private constructor(entries: RegistryEntry[]) {
    this.entries = entries;
  }

  /** A registry holding only the three built-in variants. */
  static builtinsOnly(): TemplateRegistry {
    return new TemplateRegistry(builtinEntries());
  }

  /**
   * A registry holding the built-in variants PLUS every template the given
   * pack contributes. Pack entries are keyed by their template id; if a pack
   * template id collides with a built-in variant id, the pack entry is given a
   * namespaced fallback id (`<packShortName>:<id>`) so the built-in stays
   * reachable. In practice packs use distinct ids (e.g. `spa-onepager`).
   */
  static withPack(pack: Pack): TemplateRegistry {
    const builtins = builtinEntries();
    const builtinIds = new Set(builtins.map((e) => e.id));
    const packEntries: RegistryEntry[] = pack.templates.map((t) => {
      const id = builtinIds.has(t.id) ? `${shortName(pack.name)}:${t.id}` : t.id;
      return {
        id,
        title: t.title,
        source: 'pack' as const,
        bindings: { kv: t.bindings.kv, r2: t.bindings.r2, d1: t.bindings.d1 },
        pack,
        template: t,
      };
    });
    return new TemplateRegistry([...builtins, ...packEntries]);
  }

  /** All entries in display order. */
  list(): ReadonlyArray<RegistryEntry> {
    return this.entries;
  }

  /** Look up an entry by id; undefined if not present. */
  find(id: string): RegistryEntry | undefined {
    return this.entries.find((e) => e.id === id);
  }

  /** Look up an entry by id; throws a clear error listing valid ids. */
  require(id: string): RegistryEntry {
    const found = this.find(id);
    if (found) return found;
    const ids = this.entries.map((e) => e.id).join(', ');
    throw new Error(
      `[flint] registry: unknown template "${id}" — available: ${ids}.`,
    );
  }
}

function builtinEntries(): RegistryEntry[] {
  return BUILTIN_VARIANTS.map((v) => ({
    id: v,
    title: BUILTIN_VARIANT_DESCRIPTIONS[v],
    source: 'builtin' as const,
    // Built-ins carry their real bindings in their wrangler.toml template; the
    // advisory flags here just describe them for any binding-aware consumer.
    bindings:
      v === 'static-spa'
        ? {}
        : v === 'pages-functions'
          ? { kv: true }
          : { kv: true, r2: true },
  }));
}

/** Derive a short, path-safe label from an npm-style pack name (`@op4z/csk` → `csk`). */
function shortName(packName: string): string {
  const last = packName.split('/').pop() ?? packName;
  return last.replace(/[^a-zA-Z0-9_-]+/g, '-');
}
