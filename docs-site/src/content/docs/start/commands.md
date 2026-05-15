---
title: Commands reference
description: Every Flint command, its flags, and exit codes.
---

This page covers every Flint command and its flags as of v1.0.

:::tip[Regenerating this page]
This page is hand-maintained from the output of `flint <command> --help`. To
regenerate, run `node ./dist/cli.js <command> --help` for each command in the
list below and copy the output into the corresponding section. A future
v1.x release will likely automate this from `commander`'s help machinery.
:::

## Global

```
Usage: flint [options] [command]
```

| Flag | Purpose |
| --- | --- |
| `-v, --version` | Print the Flint version. |
| `--telemetry-endpoint <url>` | POST telemetry events to `<url>` in addition to the local log. |
| `--json` | Emit a single JSON result on stdout instead of human output. |
| `-h, --help` | Display help for the (sub)command. |

## `flint init`

Scaffold Cloudflare Pages config into an existing Vite + React + TS repo.

```
Usage: flint init [options]
```

| Flag | Purpose |
| --- | --- |
| `--variant <variant>` | Template variant: `pages-functions` or `pages-fullstack`. |
| `--name <name>` | Cloudflare Pages project name (default: directory name). |
| `--no-ci` | Skip writing `.github/workflows/ci.yml`. |
| `-y, --yes` | Accept defaults and skip interactive prompts where possible. |
| `--force` | Overwrite existing files without prompting per-file. |

## `flint create-app`

Bootstrap a fresh Vite + React + TS app with Cloudflare Pages wiring pre-baked.

```
Usage: flint create-app [options] <name>
```

| Flag | Purpose |
| --- | --- |
| `--variant <variant>` | `static-spa`, `pages-functions`, or `pages-fullstack`. |
| `--template <git+url>` | Custom template git URL (reserved for advanced use). |
| `--pm <pm>` | Package manager: `npm`, `pnpm`, or `bun` (auto-detected by default). |
| `--cf-project <name>` | Cloudflare Pages project name (default: `<name>`). |
| `--no-install` | Do not run `<pm> install` after scaffolding. |
| `--no-git` | Do not run `git init` in the new directory. |
| `--provision` | Run `flint configure` immediately after scaffolding. |
| `-y, --yes` | Accept defaults and skip interactive prompts where possible. |

## `flint deploy`

Build + pre-flight + `wrangler pages deploy`, with health-ping summary.

```
Usage: flint deploy [options]
```

| Flag | Purpose |
| --- | --- |
| `--branch <name>` | Pages branch to deploy to (default: `main`). |
| `--preview` | Deploy as a preview using the current git branch name. |
| `--skip-checks` | Skip lint / typecheck / vitest pre-flight steps. |
| `--rollback` | List recent deployments and roll back to a chosen one. |
| `--strict-budget` | Fail (not just warn) if the asset budget is exceeded. |
| `--project-name <name>` | Override the Cloudflare Pages project name. |
| `--env <name>` | Deploy environment (must match a `[env.<name>]` section in `wrangler.toml`). |

See [Deploy environments](/guides/deploy-environments/) for the `--env` contract.

## `flint upgrade`

Detect and remediate drift between scaffolded files and current templates.

```
Usage: flint upgrade [options]
```

| Flag | Purpose |
| --- | --- |
| `--check` | Enumerate drift state per file (default if no mode given). |
| `--diff` | Print unified diffs for every modified file. |
| `--apply` | Interactively walk each drifted file with a 3-way merge. |
| `--dry-run` | Walk apply-mode but write nothing. |
| `--accept-current` | Non-interactive: record current file contents as the new manifest baseline (no writes to project files). |

`--accept-current` is the canonical onboarding path for projects that
pre-date Flint adoption — see [Migration from 0.x](/guides/migration-from-0x/).

## `flint doctor`

Full-stack diagnostics: node version, package manager, wrangler, auth, repo state.

```
Usage: flint doctor
```

No flags. Outputs a coloured report grouped by category. Exits 0 if all green,
1 if anything yellow or red.

## `flint uninstall`

Remove Flint-scaffolded files from the current project (manifest-aware).

```
Usage: flint uninstall [options]
```

| Flag | Purpose |
| --- | --- |
| `--dry-run` | Print the deletion plan without writing anything. |
| `-y, --yes` | Skip the confirmation prompt. |
| `--include-modified` | Also delete user-modified scaffolds (destructive). |

By default, `flint uninstall` deletes only `unmodified` manifest entries.
Ejected and modified files are preserved unless `--include-modified` is set.

## `flint configure`

Walk through provisioning every Cloudflare resource declared in `wrangler.toml`.

```
Usage: flint configure [options]
```

| Flag | Purpose |
| --- | --- |
| `--dry-run` | Print the planned commands and diff without invoking wrangler. |
| `--no-pages-project` | Skip the Pages project step. |
| `--no-kv` | Skip the KV namespace step. |
| `--no-r2` | Skip the R2 bucket step. |
| `--no-secrets` | Skip the secrets step. |
| `--secrets <names>` | Comma-separated list of secret names to set non-interactively. |

## `flint add`

Additive scaffolds. Six subcommands:

| Subcommand | Purpose |
| --- | --- |
| `flint add kv <binding>` | Declare a new `[[kv_namespaces]]` block (and optionally provision). |
| `flint add r2 <binding>` | Declare a new `[[r2_buckets]]` block (and optionally provision). |
| `flint add pwa` | Install `vite-plugin-pwa` + `workbox-window` and patch `vite.config.ts`. |
| `flint add auth` | Drop the HMAC cookie auth pattern into `functions/_shared/auth.ts`. |
| `flint add rate-limit` | Drop the sliding-window KV-bucket rate limiter into `functions/_shared/ratelimit.ts`. |
| `flint add secret <name>` | Document a new secret in `.dev.vars.example` (and optionally push to Pages). |

## `flint auth`

Manage the persistent Cloudflare API token.

| Subcommand | Purpose |
| --- | --- |
| `flint auth init` | Walk through Cloudflare API token creation, validate, store. |
| `flint auth status` | Show the currently stored token's account, validity, scopes. |
| `flint auth doctor` | Validate that the stored token carries every required scope. |
| `flint auth rotate` | Walk through replacing the stored token. |
| `flint auth purge` | Wipe local credentials + remind you to revoke in dashboard. |

`flint auth init` accepts `--keychain` to store in the OS keychain via keytar
(falls back to `.dev.vars` if keytar isn't available).

## `flint telemetry`

Inspect, purge, or export the local telemetry event log.

| Subcommand | Purpose |
| --- | --- |
| `flint telemetry show` | Print the current local event log. |
| `flint telemetry purge` | Delete the local event log. |
| `flint telemetry export <file>` | Copy the local event log to `<file>`. |

See [Telemetry transparency](/guides/telemetry-transparency/) for what is logged
and why.

## `flint config`

View or change global preferences.

```
Usage: flint config [options]
```

| Flag | Purpose |
| --- | --- |
| `--telemetry <on\|off>` | Enable or disable anonymous usage stats. |
| `--show` | Print current settings without changing anything. |

## Exit codes

| Code | Meaning |
| --- | --- |
| `0` | Success. |
| `1` | Generic failure (validation, missing file, etc.). |
| `2` | User cancelled an interactive prompt. |
| `3` | Pre-flight check failed (lint, typecheck, test, build). |
| `127` | External binary not found (e.g. `wrangler` missing from PATH). |
