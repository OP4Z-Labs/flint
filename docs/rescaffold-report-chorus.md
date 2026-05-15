# Rescaffold Report — Chorus

**Date:** 2026-05-14
**Flint version:** 0.9.0
**Source repo:** `~/dev/chorus` (untouched, verified)
**Working copy:** `~/dev/_flint-test/chorus-rescaffold/`
**Source commit SHA at start:** `496bc96ba2ee21df42df4b5ad3d4da15304e2ba1`
**Source commit SHA at end:** `496bc96ba2ee21df42df4b5ad3d4da15304e2ba1` (untouched)

## Summary

Chorus is the `pages-functions` variant — Functions + KV + HMAC auth.
Same First-Flint-onboarding flow as Portfolio:

1. `cp -r` to `_flint-test/chorus-rescaffold` (excluding `node_modules`,
   `dist`, `dev-dist`).
2. `npm install` (712 packages).
3. Baseline: build green, 135 tests in 13 files, typecheck clean.
4. `flint upgrade --check` — backfill detected the variant as
   **`pages-functions`** (functions dir present, no `[[r2_buckets]]` in
   wrangler.toml). 21 files tracked.
5. `flint upgrade --accept-current` — flipped 21 sentinel hashes to real
   content hashes. No project files written.
6. `flint upgrade --check` again — clean (in sync).
7. Post-rescaffold gates: build green, 135/135 tests, typecheck clean.

## Variant detection

- `functions/_shared/` directory: **present** → not `static-spa`
- `[[r2_buckets]]` in `wrangler.toml`: **absent** → not `pages-fullstack`
- Conclusion: `pages-functions` ✓

## Files tracked in manifest

21 entries:

| Category | Files |
| --- | --- |
| Config | `.gitignore`, `eslint.config.js`, `tsconfig.json`, `tsconfig.app.json`, `tsconfig.node.json`, `vitest.config.ts`, `wrangler.toml` |
| App entry | `index.html`, `src/main.tsx`, `src/App.tsx`, `src/index.css`, `src/test-setup.ts`, `src/vite-env.d.ts`, `package.json` |
| Functions | `functions/_shared/auth.ts`, `functions/_shared/schemas.ts`, `functions/_shared/storage.ts` |
| Public | `public/_routes.json`, `public/favicon.svg` |
| CI | `.github/workflows/ci.yml` |
| Docs | `README.md` |

Note: chorus has additional functions (route handlers under
`functions/api/`) that are NOT in the Flint template — they're
application-specific. Backfill correctly skipped those, since they're
not template candidates. The shared utility files (`auth`, `schemas`,
`storage`) ARE template-derived, so they're tracked.

## Drift inventory

`upgrade --diff` showed drift in all 21 files — expected, since the
sentinel hashes guarantee every entry classifies as `modified` on
first backfill. The actual divergences from the bundled template were
mostly real (e.g., chorus's `wrangler.toml` has the `SUBMISSIONS_KV`
namespace binding pinned to a specific id; the template has placeholder
text). All such divergences are user-owned content and are now baked
into the manifest baseline by `--accept-current`.

## Final state

After rescaffold:

| Gate | Pre-rescaffold | Post-rescaffold |
| --- | --- | --- |
| `npm run build` | green | green |
| `npm run test` | 135 tests in 13 files | 135 tests in 13 files |
| `npx tsc -b` | clean | clean |

Files modified by Flint: 0 (only `flint.manifest.json` added).

## No issues encountered

Rescaffold ran cleanly. Variant detection correct. All gates green.

## Source repo verification

```
$ cd ~/dev/chorus && git status --short
(no output — clean working tree)
$ git rev-parse HEAD
496bc96ba2ee21df42df4b5ad3d4da15304e2ba1
```

SHA matches start-of-run. Source repo untouched. ✓

## Status: GREEN
