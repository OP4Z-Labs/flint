---
title: Templates reference
description: The three Flint template variants and what each scaffolds.
---

Flint ships three template variants. They share a common skeleton (Vite +
React + TypeScript + Tailwind + Vitest + ESLint + Prettier + a `.dev.vars`
secrets surface) and differ only in the Cloudflare integration shape.

## `static-spa`

**Use when:** Your app is pure-frontend. No Cloudflare Pages Functions, no KV,
no R2.

**Ships:**

- `vite.config.ts` with React + Vitest plugins.
- `wrangler.toml` minimal — just `name`, `compatibility_date`, `pages_build_output_dir = "dist"`.
- A starter React component + tests.
- `.dev.vars` with `CLOUDFLARE_API_TOKEN` and `CLOUDFLARE_ACCOUNT_ID` only.
- GitHub Actions CI workflow (`.github/workflows/ci.yml`) that runs lint + typecheck + test + build.

**Cloudflare resources provisioned by `flint configure`:**

- Pages project only.

## `pages-functions`

**Use when:** You need API routes (Cloudflare Pages Functions) but no
persistent storage.

**Ships:**

- Everything from `static-spa`.
- `functions/api/hello.ts` — a sample Pages Function showing the request/response shape.
- `functions/_shared/response.ts` — utilities for typed JSON responses.
- TypeScript types for the Pages Functions runtime.

**Cloudflare resources provisioned by `flint configure`:**

- Pages project. (KV / R2 are NOT in this variant; add via `flint add kv` / `flint add r2`.)

## `pages-fullstack`

**Use when:** You need API routes + storage + auth. The flagship variant.

**Ships:**

- Everything from `pages-functions`.
- HMAC cookie auth in `functions/_shared/auth.ts`.
- `functions/api/admin/login.ts` — sample admin login route demonstrating the auth flow.
- A `[[kv_namespaces]]` declaration for the auth/session KV.
- A `[[r2_buckets]]` declaration for asset storage.
- Sliding-window rate limiter in `functions/_shared/ratelimit.ts`.
- `.dev.vars` adds `ADMIN_PASSWORD` and `COOKIE_SECRET` stubs.
- Asset-budget config (`flint.budget.json`) with 1MB gzip cap on the JS bundle.

**Cloudflare resources provisioned by `flint configure`:**

- Pages project
- KV namespace
- R2 bucket
- Secrets (`COOKIE_SECRET`, `ADMIN_PASSWORD`)

## Custom templates (advanced)

The `--template <git+url>` flag on `flint create-app` is reserved for v0.9+
custom templates. The contract:

- Repo must contain a top-level `flint.manifest.json` (Flint's manifest schema v1).
- Repo must contain a top-level `wrangler.toml` with at minimum a `name` and `pages_build_output_dir`.
- Files ending in `.tmpl` are rendered through Flint's templating engine; all others are copied verbatim.

See `src/util/template-url.ts` for the full git+URL parser (subdirectory and ref support).

## Adding to an existing scaffold

`flint add` provides additive scaffolds that work after the initial `init` or
`create-app`:

- `flint add pwa` — adds `vite-plugin-pwa` + workbox config.
- `flint add auth` — adds the HMAC auth pattern (useful for upgrading `pages-functions` → fullstack-style).
- `flint add rate-limit` — adds the rate-limit helper.
- `flint add kv <binding>` — declares a new KV namespace.
- `flint add r2 <binding>` — declares a new R2 bucket.
- `flint add secret <name>` — declares a new secret.

Every `flint add` writes to the manifest so `flint upgrade` and
`flint uninstall` know what's tracked.
