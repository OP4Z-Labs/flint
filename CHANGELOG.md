# Changelog

All notable changes to `@op4z/flint` are documented in this file. Format
follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/); this
project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [1.0.0] - 2026-05-14

The first stable release. Manifest schema, CLI surface, and programmatic
API are all frozen. Future MINOR releases may add new commands/flags;
breaking changes wait for 2.0.0.

### Added

- **Programmatic API.** `import { init, createApp, deploy, upgrade, ... } from '@op4z/flint'`
  exposes every CLI command as a callable function plus the manifest schema,
  classification helpers, atomic write primitives, and telemetry types. See
  `docs/programmatic-api.md`.
- **`--json` envelope on every command.** Top-level commands now emit a
  single JSON object on stdout when `--json` is passed, suitable for piping
  into CI scripts. The envelope shape is `{ command, ok, data, error? }`
  and is part of the stable contract.
- **`flint upgrade --accept-current`.** Non-interactive way to onboard a
  pre-Flint project: backfills the manifest, then records every file's
  current content as the new baseline (zero writes to the project tree).
  See `docs/migration-from-0.x.md` for the canonical first-Flint-onboarding
  flow.
- **`flint deploy --env <name>`.** Targets a `[env.<name>]` section in
  `wrangler.toml`. Validates the section exists before invoking wrangler.
  See `docs/deploy-environments.md`.
- **`flint doctor`.** Full-stack diagnostics: node version, package manager,
  wrangler, credentials, and project state. Exit-zero on all green.
- **`flint uninstall`.** Manifest-aware deletion of Flint-scaffolded files.
  Preserves `ejected` and `modified` entries unless `--include-modified` is
  passed. `--dry-run` prints the plan without writing.
- **`flint telemetry` (opt-in, off by default).** Records anonymous usage
  events to `~/.config/flint/events.log` for local-only diagnostics. Pass
  `--telemetry-endpoint <url>` (or set via `flint config --telemetry on`)
  to forward to a self-hosted collector. Full data shape in
  `docs/telemetry-transparency.md`.
- **`flint auth init --keychain`.** Optional OS-keychain storage via
  dynamic-imported `keytar`. Falls back to `.dev.vars` automatically if
  keytar isn't installed.
- **`flint create-app --template <git+url>`.** Custom-template support via
  shallow git clone. Manifest records the source URL so future upgrades
  diff against the same upstream.
- **Atomic write helpers.** `writeFileAtomic` and `writeJsonAtomic` are
  exported from the public API. Every internal write path now uses them
  to prevent half-written files on crash.
- **Asset budget.** `flint deploy` inspects `dist/` and warns when the JS
  bundle exceeds 1 MB gzipped. `--strict-budget` upgrades the warning to
  a hard fail.
- **Compatibility audit + Windows-native polish.** POSIX-separator
  manifest paths, platform-aware editor fallback for `flint upgrade --apply`
  (`notepad` on Windows, `vi` on POSIX), and `.cmd` shim resolution for
  `npm`/`pnpm`/`bun`/`yarn`/`npx`/`wrangler` on Windows. See
  `docs/compatibility.md`.
- **Astro Starlight docs site at `docs-site/`.** Dogfoods Cadence for its
  own scaffold. Targets deploy at https://flint.op4z.dev.
- **Three rescaffold reports.** `docs/rescaffold-report-{portfolio,chorus,blaze}.md`
  record the v1.0 verification that Flint's templates produce the same
  shape as three production apps.

### Changed

- **Error message shape standardized.** Every `throw new Error(...)` and
  `log.err(...)` in `src/` now follows the shape
  `[flint] <subsystem>: <what happened> — <actionable next step>`. See
  `docs/error-messages.md` for the contract.
- **Package-manager detection.** `flint create-app` now resolves the PM
  via (1) explicit `--pm` flag, (2) lockfile in parent dir, (3)
  `npm_config_user_agent`, (4) npm default. Previously it used only the
  UA string.
- **`private: true` removed from `package.json`.** v1.0 is the first
  version we intend to publish.

### Fixed

- **Manifest path separators on Windows.** `flint init` and `flint create-app`
  now produce POSIX-separator relative paths in `flint.manifest.json`
  regardless of host OS. Previously, `path.join` on Windows produced
  `\`-separated keys that broke `.startsWith('.github/')` glob filters and
  caused manifest drift between Windows and POSIX contributors.
- **Editor merge tempdir on Windows.** `flint upgrade --apply` now uses
  `os.tmpdir()` instead of `process.env.TMPDIR ?? '/tmp'`. Windows uses
  `%TEMP%`/`%TMP%`, which `os.tmpdir()` honors.
- **Package-manager `.cmd` resolution on Windows.** Node's `spawnSync`
  without `shell: true` does not auto-resolve a bare `npm` to `npm.cmd`.
  Flint now appends `.cmd` explicitly on Windows for `npm`/`pnpm`/`bun`/
  `yarn`/`npx`/`wrangler` shims.

### Removed

- Nothing removed since 0.9.0. (The 0.x → 1.0 migration is non-breaking
  for projects scaffolded by 0.9. Projects on 0.5–0.8 need a one-time
  `flint upgrade --check && flint upgrade --accept-current`. See
  `docs/migration-from-0.x.md`.)

### Documentation

- `docs/programmatic-api.md` — full programmatic API surface and stability guarantees.
- `docs/telemetry-transparency.md` — what events are recorded, where, and how to opt in/out.
- `docs/compatibility.md` — Node/OS/PM/wrangler support tiers + the v1.0 Windows audit.
- `docs/deploy-environments.md` — the `--env` contract.
- `docs/migration-from-0.x.md` — upgrade path for pre-1.0 users.
- `docs/error-messages.md` — error-message shape and contributor checklist.
- `docs/release-1.0-checklist.md` — publish process.
- `docs-site/` — Astro Starlight docs site (deploy target: https://flint.op4z.dev).
- `CONTRIBUTING.md` — full contributor workflow.

## [0.9.0] - 2026-05-14

Pre-release polish. See git log for details — this version was never published
to npm (`private: true` was set throughout 0.x).

Significant additions in 0.9: manifest schema v1, drift detection
(`flint upgrade --check / --diff / --apply / --dry-run`), `flint auth`
command family, `flint add` additive scaffolds (kv/r2/secret/pwa/auth/rate-limit),
and the three template variants (`static-spa`, `pages-functions`,
`pages-fullstack`).

## [0.5.0] - 2026-05-14

Initial usable scaffolder. `flint init` + `flint create-app` working on the
two function-based variants. Not published.

## [0.2.0] - 2026-05-14

Internal milestone — first integration with Cloudflare API (token verify,
account list, scope probes). Not published.

## [0.1.0] - 2026-05-14

Skeleton CLI with Commander wiring. Not published.

[1.0.0]: https://github.com/beau-g/flint/releases/tag/v1.0.0
[0.9.0]: https://github.com/beau-g/flint/releases/tag/v0.9.0
[0.5.0]: https://github.com/beau-g/flint/releases/tag/v0.5.0
[0.2.0]: https://github.com/beau-g/flint/releases/tag/v0.2.0
[0.1.0]: https://github.com/beau-g/flint/releases/tag/v0.1.0
