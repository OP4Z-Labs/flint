# Rescaffold Report — Portfolio

**Date:** 2026-05-14
**Flint version:** 0.9.0
**Source repo:** `~/dev/portfolio` (untouched, verified)
**Working copy:** `~/dev/_flint-test/portfolio-rescaffold/`
**Source commit SHA at start:** `deae4f224addcf7ef1ab94639085b8dd6f91be6a`
**Source commit SHA at end:** `deae4f224addcf7ef1ab94639085b8dd6f91be6a` (untouched)

## Summary

Portfolio was the **first-Flint-onboarding** case — a real production
SPA that pre-dates Flint's manifest tracking. The rescaffold flow used:

1. `cp -r` to `_flint-test/portfolio-rescaffold` (excluding `node_modules`,
   `dist`, `dev-dist`).
2. `npm install` in the copy to populate node_modules.
3. Baseline build + test + typecheck (all green; 43 tests passing).
4. `flint upgrade --check` — this triggered Flint's existing backfill
   mode, which inspected `wrangler.toml`, detected the variant as
   `static-spa` (no `functions/` dir, no `[[r2_buckets]]`), and built a
   synthetic manifest with sentinel `sha256` hashes for 20 candidate
   files.
5. `flint upgrade --accept-current` (**new flag this run** — see
   "Design decision" below). This walked every entry the classifier
   marked `modified` (all 20, by virtue of the sentinel sha) and
   recorded the user's CURRENT content as the new manifest baseline.
   No project files were written.
6. `flint upgrade --check` again — all 20 files now report
   `unmodified`. Drift table clean. The portfolio is now a
   Flint-managed project.
7. Post-rescaffold gates: build green, 43/43 tests passing, typecheck
   clean.

## Variant detection

`flint upgrade --check`'s backfill correctly detected `static-spa` for
Portfolio:

- `functions/` directory: **absent** → not `pages-functions` or
  `pages-fullstack`
- `[[r2_buckets]]` in `wrangler.toml`: **absent** → confirms not
  `pages-fullstack`
- Conclusion: `static-spa`

The detection logic lives in `src/commands/upgrade.ts:runBackfill()`.

## Files tracked in manifest

20 entries total:

| Category | Files |
| --- | --- |
| Config | `.gitignore`, `eslint.config.js`, `tsconfig.json`, `tsconfig.app.json`, `tsconfig.node.json`, `vite.config.ts`, `vitest.config.ts`, `wrangler.toml` |
| App entry | `index.html`, `src/main.tsx`, `src/App.tsx`, `src/index.css`, `src/test-setup.ts`, `src/vite-env.d.ts`, `package.json` |
| Public assets | `public/_headers`, `public/_routes.json`, `public/favicon.svg` |
| CI | `.github/workflows/ci.yml` |
| Docs | `README.md` |

## Drift inventory (pre-baseline-lock)

`flint upgrade --diff` reported real drift between current portfolio
files and the bundled `static-spa` template. Examples:

- `.github/workflows/ci.yml` — portfolio uses `npx tsc -b` /
  `npx vitest run`; template uses `npx tsc --noEmit` / `npm test`.
- `.gitignore` — portfolio has `# Wrangler`; template uses
  `# Wrangler / Cloudflare`.
- `eslint.config.js`, `tsconfig.*`, `vite.config.ts` — divergences
  reflecting portfolio's specific deps (Tailwind v4, PWA plugin,
  Framer Motion, etc.).

None of these were applied. The whole point of `--accept-current` is
that portfolio's current configuration is the desired state — Flint's
templates are the *new starting point* for a future rescaffold, not
something to overwrite the user's working setup.

## Final state

After `flint upgrade --check` + `flint upgrade --accept-current`:

- `flint.manifest.json` (NEW, gitignored by Flint convention but
  retained in the copy for inspection) — describes 20 tracked files
  with real content hashes.
- No project files modified.
- `flint upgrade --check` exits 0 (no drift).
- All quality gates green:

| Gate | Pre-rescaffold | Post-rescaffold |
| --- | --- | --- |
| `npm run build` | green | green |
| `npm run test` | 43 tests in 10 files | 43 tests in 10 files |
| `npx tsc -b` | clean | clean |

## Design decision — `upgrade --accept-current`

The brief flagged two paths for First-Flint-onboarding: (a) add
`--skip-overwrite` to `flint init`, or (b) manually craft an initial
manifest. Inspecting the codebase showed a third — and cleaner — path:

**Flint already has backfill logic in `upgrade --check`.** It walks the
template tree, hashes each candidate path's current content, and writes
a synthetic manifest with sentinel hashes (every entry marked
`modified`). The only missing piece was a non-interactive way to flip
those sentinels to real content hashes without running through 20
interactive prompts per app.

`upgrade --accept-current` fills exactly that gap:

- For every entry currently classified `modified`, replace the
  manifest's sentinel `sha256` with the real `sha256` of the file's
  current content. Set `modified: false`.
- Touch nothing else. No file writes. No template overwrites.
- `missing` and `ejected` entries pass through untouched.
- Writes a history entry with `command: "accept-current"`.

This is exactly the right shape for First-Flint-onboarding without
introducing `init --skip-overwrite` semantics that overlap with the
backfill path.

Tests: 3 new in `tests/commands/upgrade-accept-current.test.ts`.

## No issues encountered

The rescaffold ran cleanly the first time. No regressions surfaced,
no template drift was applied to project files.

## Source repo verification

```
$ cd ~/dev/portfolio && git status --short
(no output — clean working tree)
$ git rev-parse HEAD
deae4f224addcf7ef1ab94639085b8dd6f91be6a
```

Identical to start-of-run. Source repo untouched. ✓

## Status: GREEN
