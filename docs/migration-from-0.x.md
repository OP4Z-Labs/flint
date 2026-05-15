# Migration from 0.x

Flint 1.0 is the first stable release. The manifest schema and CLI surface are locked, the programmatic API ships, and the rough edges from 0.5 -> 0.9 have been sanded down.

## Breaking changes from 0.9 to 1.0

**None.** Flint 1.0 is fully compatible with projects scaffolded by Flint 0.9.x. The manifest schema, CLI flags, and template variants are all preserved. You can upgrade your global Flint install without changing anything in your project.

If you're on **0.5 -> 0.8**, the only breaking change you need to know about is the manifest schema introduction in 0.9. See below.

## Breaking changes from 0.5-0.8 to 1.0

### Manifest schema v1 (was: ad-hoc tracking)

Pre-0.9 versions of Flint did not write a `flint.manifest.json` to your project. The CLI was a one-shot scaffolder with no upgrade path. 0.9 introduced the manifest, and 1.0 locks the v1 schema as stable.

**To upgrade a pre-0.9 project:**

```bash
flint upgrade --check
# Flint detects the project shape (variant), walks the template tree, and
# writes a synthetic manifest with all entries marked `modified`.

flint upgrade --accept-current
# Flint reads every file's current content, records the real sha256 as the
# manifest baseline, and clears the `modified` flag. Zero project files are
# touched — only flint.manifest.json is written.
```

After these two commands, `flint upgrade --check` should report zero drift, and future Flint upgrades will track changes correctly.

### `flint create-app` lockfile detection (0.9 -> 1.0 polish, non-breaking)

In 0.9, `flint create-app` used only the `npm_config_user_agent` env var to detect which package manager to install with. In 1.0, the detection order is:

1. Explicit `--pm` flag.
2. Lockfile in the parent directory (`pnpm-lock.yaml`, `bun.lockb`, `yarn.lock`, `package-lock.json`).
3. `npm_config_user_agent`.
4. Default to npm.

If your CI script relied on the UA-only behavior, the new behavior is strictly a superset — no migration needed.

## Programmatic API (new in 1.0)

The programmatic API (`import { ... } from '@op4z/flint'`) is new in 1.0. See [`docs/programmatic-api.md`](./programmatic-api.md) for the full surface.

If you have CI scripts that invoked the CLI via a Node spawn, you can now use the programmatic API directly. The CLI remains supported — both surfaces are tier-1.

## Telemetry (opt-in, new in 1.0)

Flint 1.0 records anonymous usage events to `~/.config/flint/events.log` by default. **No data leaves your machine** unless you explicitly opt-in by passing `--telemetry-endpoint <url>` or by running `flint config --telemetry on` against an endpoint you've configured.

To disable entirely:

```bash
flint config --telemetry off
```

See [`docs/telemetry-transparency.md`](./telemetry-transparency.md) for the full data shape and storage layout.

## Windows-native (best-effort, new in 1.0)

Flint 1.0 audited and fixed several Windows-native correctness issues — POSIX-separator manifest paths, platform-aware editor fallback, and `.cmd` shim resolution for npm/pnpm/bun/wrangler. See [`docs/compatibility.md`](./compatibility.md) for the full audit findings and known gaps.

If you previously ran Flint exclusively on WSL2, nothing changes. If you want to try Flint-native on Windows, the basic flows (`init`, `add`, `configure`) are supported.

## Should I upgrade?

If you're on 0.9.x: **yes.** It's a zero-effort upgrade — `npm install -g @op4z/flint@latest`. Your projects continue to work unchanged.

If you're on 0.5-0.8: **yes**, but plan for a per-project `flint upgrade --check && flint upgrade --accept-current` to backfill the manifest.

## Reporting migration issues

If `flint upgrade --check` doesn't correctly classify your project, file an issue with:

- Your `wrangler.toml` (redact secrets).
- Output of `flint --version` and `flint doctor`.
- The contents of `flint.manifest.json` if one was written.

The `flint upgrade` backfill heuristic is documented in `src/commands/upgrade.ts` if you want to inspect or patch the detection rules.
