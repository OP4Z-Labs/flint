---
title: Deploy environments
description: How flint deploy --env validates and targets a wrangler.toml [env.<name>] section.
---

Flint v1.0 adds explicit environment targeting to `flint deploy`. This document is the contract for what an "env" is in Flint's mental model and how Flint validates one before invoking wrangler.

## Why `--env`

A typical Cloudflare Pages project has at least two production-shaped surfaces — a staging Pages project (or a `staging` branch deploying to its own subdomain) and a production project. Each may have its own:

- KV namespace IDs (separate state)
- R2 bucket names (separate storage)
- Secret values (separate credentials)
- Cloudflare account (rare, but supported)

`flint deploy` without `--env` deploys to the top-level wrangler.toml config. With `--env staging` (or `--env production`), Flint reads the matching `[env.<name>]` section in wrangler.toml, validates it exists, and passes `--env=<name>` to `wrangler pages deploy`.

## wrangler.toml shape

The environment contract is the wrangler.toml `[env.<name>]` section:

```toml
# Top-level — used when --env is omitted
name = "my-app-dev"
pages_build_output_dir = "dist"
compatibility_date = "2025-12-01"

[[kv_namespaces]]
binding = "CONTENT_KV"
id = "dev-id-here"

# Staging env
[env.staging]
name = "my-app-staging"

[[env.staging.kv_namespaces]]
binding = "CONTENT_KV"
id = "stage-id-here"

# Production env
[env.production]
name = "my-app"

[[env.production.kv_namespaces]]
binding = "CONTENT_KV"
id = "prod-id-here"
```

Each `[env.<name>]` table can override:

- `name` — the Cloudflare Pages project name (falls back to top-level `name` if omitted)
- `[[env.<name>.kv_namespaces]]` — per-env KV bindings (each block must specify its own `id`)
- `[[env.<name>.r2_buckets]]` — per-env R2 bindings

## How Flint validates `--env <name>`

Before running `wrangler pages deploy`, Flint:

1. Parses `wrangler.toml` and pulls the `envs` map.
2. Confirms `envs[opts.env]` exists. If not, errors out with the list of available envs.
3. Resolves the project name: env's own `name` → top-level `name` → fail.
4. Passes `--env=<name>` to wrangler so wrangler's own env merging logic kicks in.

If you pass `--env staging` and wrangler.toml has no `[env.staging]`, Flint errors before invoking wrangler. This prevents silent deploys to the wrong place.

## Example workflow

```bash
# Deploy the staging env. Validates [env.staging] exists first.
flint deploy --env staging

# Deploy production.
flint deploy --env production --branch main

# Deploy a preview of the current git branch to staging.
flint deploy --env staging --preview

# Stay on the top-level config (no env).
flint deploy
```

## Secrets

Per-env secrets are set via `wrangler pages secret put <NAME> --env <name>` directly — Flint doesn't (yet) wrap this. `flint add secret` operates on the top-level secret namespace. For env-scoped secrets, use wrangler directly.

## Limitations at v1.0

- Flint does not validate that env-specific bindings are fully populated (e.g. an env can reference a binding that doesn't exist top-level — wrangler will error at runtime).
- `flint configure` doesn't yet have env-aware provisioning. v1.1 will likely add `flint configure --env <name>` to walk the per-env binding set.
- `flint deploy --rollback --env <name>` works (the env is passed through to `wrangler pages deployment list`), but the deployment-history listing isn't filtered by env in the UX — you'll see all deployments for that project.
