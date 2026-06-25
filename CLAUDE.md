# Flint — Claude Code Context

> **Last Updated:** 2026-06-25
> **Branch:** main
> **Phase:** v1.0.1 published; pack-aware upgrade landed on `main` and unreleased

---

## What this is

`@op4z/flint` is a **generic Cloudflare Pages bootstrap CLI** — a published, GA tool (v1.0.1 on npm; repo at `github.com/op4z-labs/flint`). It scaffolds Vite + React + TS apps wired to Cloudflare Pages, provisions Cloudflare resources via the REST API, and remediates drift between the generated tree and the current templates via a manifest-tracked 3-way merge. Three runtime deps: `commander`, `@inquirer/prompts`, `smol-toml`. Node ≥ 20.

The load-bearing principle is **stamp, don't depend**. A site Flint generates carries the rendered template tree on disk; it has no runtime dependency on `@op4z/flint`. Every generated file is recorded in `flint.manifest.json` with `templateSource`, `templateVersion`, and `sha256`, so months later `flint upgrade` can detect drift and feed it through 3-way merge without the site ever needing to install Flint as a dependency.

Flint is the engine. Business-specific scaffolds (themes, content, copy) live in **template packs** — external directories with a `pack.json` (contract `flint-pack-1`). The reference consumer is the private kit `@op4z/csk` over at `~/dev/client-site-kit`, which ships its templates as a pack and drives Flint via the CLI binary. **No business logic ever lives in this repo.** Flint stays a clean, public, generic OSS engine.

---

## Agent Work Protocol

### Before starting

1. Read this file end-to-end.
2. Skim `README.md` for the user-facing CLI surface, then `CHANGELOG.md` for what's landed since `v1.0.0`.
3. If touching the manifest, packs, or upgrade: read `src/util/manifest.ts`, `src/util/pack.ts`, and `src/util/pack-upgrade.ts` head comments — they each carry a long banner explaining the contract.
4. If touching CLI wiring: `src/cli.ts` is the dispatch surface. Each subcommand delegates to `src/commands/<name>.ts`.

### During work

- **No new prod deps.** The dep tree is the value proposition — adding to `commander` / `@inquirer/prompts` / `smol-toml` requires explicit Beau-level justification. JSON-schema validation in `src/util/pack.ts` is hand-rolled for exactly this reason; don't reach for `ajv`.
- **Atomic writes.** Use `writeFileAtomic` / `writeJsonAtomic` from `src/util/atomic-write.ts`, never `writeFileSync` against project files.
- **Banner comments.** Every source file opens with a comment explaining why it exists and the non-obvious choices. Match the tone in `src/util/manifest.ts` and `src/util/pack-upgrade.ts`.
- **Error message shape.** `[flint] <subsystem>: <what happened> — <actionable next step>`. See `docs/error-messages.md`.
- **POSIX-separator paths in the manifest** even on Windows — Windows compat is a contract, not a nice-to-have (see `docs/compatibility.md`).

### Before committing

```bash
npm run build       # tsc -p tsconfig.json
npm run lint        # eslint .
npm run typecheck   # tsc -b
npm test            # vitest run — ~350 tests across ~36 files
```

All four must pass. Commit conventions are described in `CONTRIBUTING.md`: `<type>(<scope>): <subject>`. **No `[OP-NNN]` task tags here** — that's an OP4Z-internal convention; Flint is public. No Claude/AI co-authorship lines unless explicitly requested.

---

## Tech stack

- **Language:** TypeScript 6.0 (strict), ESM-only, `"type": "module"`.
- **Runtime:** Node ≥ 20. ESM imports must include the `.js` extension.
- **Runtime deps:** `commander` ^12 (CLI), `@inquirer/prompts` ^7 (TTY prompts), `smol-toml` ^1.6 (comment-preserving TOML patcher).
- **Test:** Vitest 4 + v8 coverage. Integration tests spawn `node dist/cli.js` against a temp dir; unit tests mock filesystem via `tmpdir`.
- **CI:** Lint / typecheck / build / test on Node 20, 22, 24 (see `.github/workflows/`).

---

## Repository structure

- `src/cli.ts` — commander wiring; the only entry point.
- `src/index.ts` — programmatic API surface (frozen at v1.0).
- `src/commands/` — one file per CLI subcommand: `auth`, `init`, `create-app`, `create-app-pack`, `configure`, `add`, `add-features`, `deploy`, `upgrade`, `doctor`, `uninstall`, `telemetry`, `config`.
- `src/cloudflare/` — REST client, token verification, `.dev.vars` patching, comment-preserving `wrangler.toml` editor.
- `src/util/` — `manifest.ts` (schema + classifyAll/backfill), `pack.ts` (loader/validator + var derivation), `pack-upgrade.ts` (re-render seam for `upgrade --pack`), `registry.ts` (built-in + pack registry), `scaffold.ts` (collectFiles walk), `template.ts` (`.tmpl` renderer), `atomic-write.ts`, `diff.ts`, `telemetry.ts`.
- `templates/{static-spa,pages-functions,pages-fullstack,_skeleton}/` — the three built-in variants + the shared Vite + React + TS base.
- `tests/util,commands,cloudflare,templates/` — unit tests. `tests/integration/` — spawns `node dist/cli.js`.
- `docs/` — Markdown reference. `docs-site/` — Astro Starlight site targeting `flint.op4z.dev`.
- `.agent/HANDOFF-*` — milestone notes; informational, not load-bearing.
- `dist/` — `tsc` output; consumed directly by some downstream tools (see Consumers).

---

## The CLI surface

Every command supports `--json` for a single JSON envelope (`{ command, ok, data, error? }`) on stdout and a `--telemetry-endpoint <url>` global flag. The actual binary is `flint`.

| Command | Purpose |
| ------- | ------- |
| `flint auth init` | walk Cloudflare API-token creation, validate, store in `~/.config/flint/credentials` (and OS keychain if `--keychain`) |
| `flint auth status` / `auth doctor` | inspect the stored token; doctor validates every required scope |
| `flint auth rotate` / `auth purge` | rotate or wipe credentials (purge prompts for confirmation, `--include-archive` clears rotated archive) |
| `flint init` | scaffold Pages config into an existing Vite + React + TS repo (`--variant pages-functions|pages-fullstack`) |
| `flint create-app <name>` | bootstrap a fresh app from a built-in variant (`--variant static-spa|pages-functions|pages-fullstack`), a `--pack <dir>` + `--template <id>`, or a `--template git+<url>` |
| `flint configure` | walk every Pages project / KV / R2 / D1 / secret declared in `wrangler.toml` and provision via the Cloudflare REST API (idempotent, `--dry-run` supported) |
| `flint add kv|r2|d1 <binding>` | append a binding block to `wrangler.toml` and optionally provision |
| `flint add secret <name>` | document in `.dev.vars.example` and optionally push to Pages (never writes the value to `.dev.vars` unless `--write-to-dev-vars`) |
| `flint add pwa|auth|rate-limit` | additive feature scaffolds (PWA via `vite-plugin-pwa`, HMAC cookie auth, sliding-window KV rate limiter) |
| `flint deploy` | pre-flight (lint / typecheck / vitest / build / asset budget) + `wrangler pages deploy`, with `--rollback`, `--env`, `--strict-budget` |
| `flint upgrade --check` | classify every manifest entry as unmodified / modified / ejected / missing |
| `flint upgrade --diff` | unified diff for every modified file vs. current bundled template |
| `flint upgrade --apply` | interactive 3-way merge per file: keep / take-new / merge ($EDITOR) / eject |
| `flint upgrade --accept-current` | non-interactive: record current contents as the new baseline (zero writes to project tree) — the canonical "introduce Flint to a pre-Flint project" flow |
| `flint upgrade --pack <dir>` | re-render pack-stamped files from the current pack on disk so upstream pack fixes flow through 3-way merge into already-stamped sites (added in `0d082e9`, **unreleased**) |
| `flint doctor` | node / pm / wrangler / credentials / repo-state diagnostics |
| `flint uninstall` | manifest-aware deletion; `--include-modified` is destructive |
| `flint telemetry show|purge|export` | inspect, wipe, or export `~/.config/flint/events.log` (opt-in, off by default) |
| `flint config --telemetry on|off` / `--show` | global preferences |

---

## The pack model

A **pack** is an external directory contributing templates to Flint without putting business logic in this repo. The contract is `flint-pack-1` (validated in `src/util/pack.ts`).

```jsonc
// pack.json — top-level shape
{
  "flintPackFormat": 1,
  "name": "@op4z/csk",
  "version": "0.1.0",
  "core":     [{ "from": "_core/edge", "to": "kit/edge", "exclude": ["**/*.test.ts"] }],
  "vars":     [{ "name": "siteSlug", "from": "siteName", "transform": "kebab", "required": true }],
  "templates": [{ "id": "spa-onepager", "title": "...", "path": "templates/spa-onepager",
                  "rendering": "spa", "bindings": { "kv": true, "r2": false } }]
}
```

- `core[]` trees are always stamped into every generated site. A plain string flattens the tree to the site root; the `{ from, to, exclude }` object form maps a sub-tree under a destination subdir (e.g. `_core/edge` → `kit/edge`).
- `vars[]` declares prompts and derivations. Supported transforms: `kebab`, `snakeCookie`, `lower`, `title`. `from` chains derivations; `resolvePackVars` runs a fixed-point loop so order in `vars[]` doesn't matter.
- `templates[]` are one-of selections; each has its own tree path, rendering (`spa` or `ssg`), and `bindings { kv?, r2?, d1? }`.
- The seam that mixes built-in variants with pack templates is `TemplateRegistry` in `src/util/registry.ts`. The built-in `--variant` flow is byte-for-byte unchanged when no `--pack` is passed.

---

## The upgrade model

Every generated file is recorded in `flint.manifest.json` (schema in `src/util/manifest.ts`). Each entry stores `templateSource`, `templateVersion`, `sha256`, `modified`, `ejected`. Upgrade classifies each entry against current disk contents:

- **unmodified** (sha matches) → auto-update to the current template under `--apply`
- **modified** (sha differs) → interactive 3-way merge: keep / take-new / merge in `$EDITOR` / eject
- **ejected** → always skip; the user opted out
- **missing** → restore from template or remove from manifest

Re-rendering pulls the source from `templates/<templateSource>` and renders it with the manifest's stored `vars`. Older pre-manifest projects (≤ 0.5) are auto-backfilled with a sentinel `sha256` on first `upgrade`; `--accept-current` flips those sentinels to real hashes without touching any project files.

**`flint upgrade --pack <dir>` (commit `0d082e9`, unreleased).** Closes a real gap: files scaffolded by `create-app --pack` are recorded with `templateSource: pack:<name>/...`, which the built-in re-render path couldn't resolve (it only knows `templates/<...>`), so it silently skipped them. That meant upstream pack fixes never reached already-stamped sites — the "stamp, don't depend; upgrade keeps sites current" promise was false for every pack-based site. `src/util/pack-upgrade.ts` rebuilds the exact `templateSource → rendered-content` map the scaffolder would produce from the CURRENT pack on disk, map-keyed (not string-reverse-parsed — packNames contain `/`), and feeds the results into the existing 3-way merge machinery. Required for any Client-Site-Kit upgrade flow.

---

## Consumers

- **`~/dev/client-site-kit`** (private, `@op4z/csk`) is the primary downstream. Its CLI wraps Flint, resolving the binary via (1) `FLINT_BIN` env, (2) `$PATH`, (3) the local dev dist at `~/dev/public/flint/dist/cli.js` — see `client-site-kit/cli/src/flint.ts`. **The kit currently consumes Flint as a CLI binary by path, not as an npm dependency.** That means changes to `src/` only land in the kit after `npm run build` populates `dist/`.
- Built-in variants exist to anchor parity with three production apps: `static-spa` ≈ Portfolio, `pages-functions` ≈ Chorus, `pages-fullstack` ≈ Blaze. See `docs/rescaffold-report-{portfolio,chorus,blaze}.md` for the v1.0 verification snapshots.

---

## Common commands

```bash
npm run build         # tsc -p tsconfig.json (writes dist/)
npm run dev           # tsc --watch
npm run lint          # eslint .
npm run lint:fix
npm run typecheck     # tsc -b
npm test              # vitest run
npm run test:watch
npm run test:unit             # tests/cloudflare tests/commands tests/templates tests/util
npm run test:integration      # tests/integration only — spawns node dist/cli.js
npm run test:coverage         # v8 coverage report
```

`npm run prepare` runs `npm run build`, so `npm publish` always ships a fresh `dist/`.

---

## Architectural decisions worth knowing

- **Stamp, don't depend.** Generated sites carry their template tree on disk and have no runtime dep on `@op4z/flint`. The manifest is what makes `upgrade` work without re-installing.
- **Flint stays generic OSS; business logic stays in private packs.** The IP boundary is the pack contract. Anything Client-Site-Kit-specific belongs in `@op4z/csk`; if you find yourself adding kit-aware code here, stop.
- **Hand-rolled pack validator.** No `ajv`. The schema is small and frozen; a focused validator gives better error messages and zero added deps.
- **Programmatic API is frozen.** `src/index.ts` exports are part of the v1.0 contract. Don't break shapes without a major bump.
- **Atomic writes everywhere.** Every project-tree write is write-temp-rename. Crashes never leave half-written files.
- **POSIX manifest paths on Windows.** `path.join` produces `\`-separated keys on Windows that break `.startsWith('.github/')` checks; the manifest stores POSIX always.
- **Telemetry is opt-in, local-by-default.** Events go to `~/.config/flint/events.log`; nothing leaves the machine unless `--telemetry-endpoint` is set. See `docs/telemetry-transparency.md`.

---

## What NOT to do

- **Don't add new prod dependencies** without explicit discussion. Three runtime deps is the brand.
- **Don't let business logic leak in.** No knowledge of CSK / clients / themes / brand vocabulary in `src/`. Pack contract is the seam.
- **Don't bypass `writeFileAtomic`** for project-tree writes. Direct `writeFileSync` is fine inside tests against `tmpdir`, never against a user project.
- **Don't break the manifest schema** in a minor release. The schema is at v1; downstream tools read it.
- **Don't run `flint upgrade --apply` non-interactively against modified files.** It will stall on `@inquirer/prompts` input. Use `--check`, `--diff`, or `--accept-current` in CI/scripted contexts.
- **Don't modify pack-stamped files in a consumer site** (e.g. files under `kit/` in a CSK site) and expect `flint upgrade` to "fix" them later without `--pack <dir>` pointed at the kit. Without `--pack`, those files are silently skipped.
- **Don't bundle pack content into this repo.** Packs ship from their own repos; Flint only loads them via `--pack <dir>`.
- **Don't rewrite history on `main`** unless explicitly asked. `op4z-labs/flint` is public.

---

## Commit conventions

Defer to `CONTRIBUTING.md`. Summary: `<type>(<scope>): <subject>`, no task tags, no AI co-authorship lines. Recent shape:

```
feat(upgrade): pack-aware `flint upgrade --pack` — propagate pack fixes to sites
feat(packs): per-core destination mapping + stamp excludes for tests/build
feat(packs): pluggable template packs, D1 support, zod skeleton fix
chore(release): flint 1.0.1 — README accuracy polish
```

---

_This file is the primary context document for Claude Code in this repo. For deeper detail: `README.md` (user-facing surface), `CHANGELOG.md` (what shipped), `CONTRIBUTING.md` (PR flow), `docs/programmatic-api.md`, `docs/compatibility.md`, `docs/migration-from-0.x.md`, `docs/error-messages.md`._
