# Rescaffold Report — Blaze

**Date:** 2026-05-14
**Flint version:** 0.9.0
**Source repo:** `~/dev/blaze` (untouched, verified)
**Working copy:** `~/dev/_flint-test/blaze-rescaffold/`
**Source commit SHA at start:** `bc3c9951dd12b044ca53bca6991e5c10817d2eaa`
**Source commit SHA at end:** `bc3c9951dd12b044ca53bca6991e5c10817d2eaa` (untouched)

## Summary

Blaze is the most complex variant — `pages-fullstack` with Functions +
KV + R2 + HMAC auth + PWA. Same First-Flint-onboarding flow:

1. `cp -r` to `_flint-test/blaze-rescaffold`.
2. `npm install` (775 packages — heaviest of the three).
3. Baseline: build green, 55 tests in 8 files, typecheck clean.
4. `flint upgrade --check` — backfill detected variant as
   **`pages-fullstack`** (functions dir present, `[[r2_buckets]]`
   present in wrangler.toml). 19 files tracked.
5. `flint upgrade --accept-current` — 19 entries baselined. No project
   writes.
6. `flint upgrade --check` — clean.
7. Post-rescaffold gates: build green, 55/55 tests, typecheck clean.

## Variant detection

- `functions/_shared/` directory: **present**
- `[[r2_buckets]]` in `wrangler.toml`: **present** (PHOTOS_BUCKET)
- Conclusion: `pages-fullstack` ✓

## Files tracked in manifest

19 entries:

| Category | Files |
| --- | --- |
| Config | `.gitignore`, `eslint.config.js`, `tsconfig.json`, `tsconfig.app.json`, `tsconfig.node.json`, `vite.config.ts`, `wrangler.toml` |
| App entry | `index.html`, `src/main.tsx`, `src/App.tsx`, `src/index.css`, `src/test-setup.ts`, `package.json` |
| Functions | `functions/_shared/auth.ts`, `functions/_shared/schemas.ts`, `functions/_shared/storage.ts` |
| Public | `public/favicon.svg` |
| CI | `.github/workflows/ci.yml` |
| Docs | `README.md` |

## Drift observations and known data-quality gaps

Blaze surfaced two interesting findings during backfill that the next
Flint version should consider:

### 1. Files in the template but missing in the project

The `pages-fullstack` template ships these files, but Blaze doesn't
have them:

- `functions/_shared/ratelimit.ts` (template-only)
- `functions/_shared/response.ts` (template-only)
- `vitest.config.ts` (template-only — Blaze uses inline Vitest config
  inside `vite.config.ts`)
- `public/_routes.json` (template-only)
- `public/_headers` (template-only)
- `src/vite-env.d.ts` (template-only)

Backfill **only** records entries for files that EXIST in the project
(`sha256OfFile` returns null for missing files and the loop skips
them). So these template-side files don't appear in Blaze's manifest.
A future `flint add ratelimit` or `flint upgrade` walk could surface
them as candidates the user might want to opt into; for First-Flint-
onboarding, omitting them is correct.

### 2. Files in the project but not in the template

Blaze has test files (`auth.test.ts`, `schemas.test.ts`) and
application-specific functions under `functions/api/`,
`functions/admin/`, etc. that aren't template files. Those correctly
aren't tracked — they're user-owned.

### Recommendation for future Flint versions

A "Flint adoption gap" hint command (NOT in scope for this run) could
diff the project tree against the resolved variant template and
recommend `flint add ratelimit` etc. Useful but additive — not a
blocker for v1.0.

## Final state

After rescaffold:

| Gate | Pre-rescaffold | Post-rescaffold |
| --- | --- | --- |
| `npm run build` | green | green |
| `npm run test` | 55 tests in 8 files | 55 tests in 8 files |
| `npx tsc -b` | clean | clean |

Files modified by Flint: 0 (only `flint.manifest.json` added).

## No regressions

Rescaffold completed cleanly on the most complex variant. The
hard-invariant adherence held throughout — no writes to the source
repo at `~/dev/blaze`.

## Source repo verification

```
$ cd ~/dev/blaze && git status --short
(no output — clean working tree)
$ git rev-parse HEAD
bc3c9951dd12b044ca53bca6991e5c10817d2eaa
```

SHA matches start-of-run. Source repo untouched. ✓

## Status: GREEN
