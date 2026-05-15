---
title: Getting started
description: Install Flint, scaffold your first Cloudflare Pages app, and deploy it.
---

This guide walks through:

1. Installing Flint
2. Scaffolding your first project
3. Configuring Cloudflare credentials
4. Deploying to Cloudflare Pages

Total time: about 5 minutes (excluding `npm install`).

## Prerequisites

- **Node 20, 22, or 24** — confirmed via `node --version`. Flint refuses to run on older.
- **A package manager** — npm, pnpm, or bun. (Yarn is best-effort.)
- **A Cloudflare account** — free tier is fine. Sign up at [cloudflare.com](https://cloudflare.com).
- **`wrangler` CLI** — Flint installs it transitively in your project, but you can also install globally: `npm install -g wrangler@latest`.

## 1. Install Flint

```bash
npm install -g @op4z/flint
```

Or run without installing:

```bash
npx @op4z/flint create my-app --variant pages-fullstack
```

Verify:

```bash
flint --version
# 1.0.0
flint doctor
# Runs a full preflight check: node version, wrangler, package manager,
# credentials, and project state.
```

## 2. Scaffold a project

Flint ships three template variants. Pick the one that matches your app shape:

| Variant | Use when |
| --- | --- |
| `static-spa` | Pure-frontend SPA with no backend functions. Vite + React + TypeScript. |
| `pages-functions` | SPA with Cloudflare Pages Functions for API routes. |
| `pages-fullstack` | Full-stack with Functions + KV + R2 + HMAC cookie auth. |

```bash
flint create my-app --variant pages-fullstack
cd my-app
```

The `create` command runs `npm install`, `git init`, and stamps a
`flint.manifest.json` that tracks every scaffolded file. The manifest lets
`flint upgrade` patch your project to new Flint versions later.

## 3. Configure Cloudflare credentials

Flint needs a Cloudflare API token to deploy and to provision KV/R2 resources.
The token lives in your project's `.dev.vars` file (mode 0600, gitignored
automatically).

```bash
flint auth init
```

This walks you through:

1. Creating an API token at <https://dash.cloudflare.com/profile/api-tokens>
   with the scopes Flint needs (Pages: Edit, KV: Edit, R2: Edit, Workers: Edit).
2. Pasting the token into Flint's prompt.
3. Selecting your Cloudflare account (Flint queries the API and lists them).

Want OS-keychain storage instead of `.dev.vars`? Pass `--keychain`:

```bash
flint auth init --keychain
```

(Falls back to `.dev.vars` gracefully if keytar isn't installed.)

## 4. Provision Cloudflare resources

For `pages-fullstack`, Flint can create the Pages project, KV namespace, and
R2 bucket in one shot:

```bash
flint configure
```

This runs `wrangler pages project create`, `wrangler kv namespace create`, and
`wrangler r2 bucket create` against your account, then patches `wrangler.toml`
with the resulting IDs. Idempotent — running it again is a no-op.

## 5. Deploy

```bash
flint deploy
```

Flint runs (in order):

1. `npm run lint`
2. `npm run typecheck`
3. `npm test`
4. `npm run build`
5. Asset budget check (warns on bundles > 1MB gzip)
6. `wrangler pages deploy dist`

To target a non-default environment (preview, staging, etc.):

```bash
flint deploy --env preview
```

See [Deploy environments](/guides/deploy-environments/) for details.

## What next

- [Commands reference](/start/commands/) — every command and flag
- [Templates reference](/start/templates/) — what each variant ships
- [Programmatic API](/guides/programmatic-api/) — using Flint from Node scripts
- [Compatibility](/guides/compatibility/) — OS / Node / wrangler support
