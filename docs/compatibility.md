# Compatibility matrix

This document covers what Flint supports as of v1.0.

## Node.js

| Version | Tier | Notes |
| --- | --- | --- |
| **Node 20** (LTS) | First-class | Runs in CI on every PR. Most-tested target. |
| **Node 22** (LTS) | First-class | Runs in CI on every PR. |
| **Node 24** | First-class | Runs in CI on every PR. |
| Node ≤ 19 | Unsupported | Flint depends on Node 20+ features (top-level `fetch`, stable `node:stream/promises`). |

`flint doctor` will surface a yellow warning on unsupported Node versions and a red error on too-old runtimes.

## Operating systems

| OS | Tier | Notes |
| --- | --- | --- |
| **Linux** (x86_64, arm64) | First-class | Daily target. All commands work end-to-end. |
| **macOS** (Intel, Apple Silicon) | First-class | Daily target. All commands work end-to-end. |
| **WSL2 on Windows** | First-class | All commands work end-to-end. Functionally identical to Linux. |
| **Windows native** | Best-effort | `flint init`, `flint add *`, `flint configure` work. `flint deploy` and `flint auth init` are tested only via WSL — use WSL for production deploys. |

### Windows-native audit (v1.0)

A full Windows-compatibility audit ran for v1.0. The cheap fixes landed in
this release; the remaining gaps are documented as known limitations.

**Fixed in v1.0:**

- **Manifest path separators.** `flint init` and `flint create-app` now produce
  POSIX-separator relative paths in `flint.manifest.json` regardless of host
  OS. Previously, `path.join` on Windows produced `\`-separated keys that broke
  `.startsWith('.github/')` glob filters and would have caused manifest drift
  between Windows + POSIX project contributors. (Fix: `init.ts`, `create-app.ts`
  `walk()` helpers.)
- **Editor merge tempdir.** `flint upgrade --apply` now uses `os.tmpdir()`
  instead of `process.env.TMPDIR ?? '/tmp'` — Windows uses `%TEMP%`/`%TMP%`,
  which `os.tmpdir()` honors.
- **Editor fallback.** When neither `$EDITOR` nor `$VISUAL` is set,
  `flint upgrade --apply` now falls back to `notepad` on Windows (vs. `vi` on
  POSIX). Notepad has understood `\n` line endings since the Windows 10 May
  2018 Update.
- **Package-manager `.cmd` resolution.** On Windows, npm-installed shims
  (`npm`, `pnpm`, `bunx`, `yarn`, `npx`, `wrangler`) live as `.cmd` files in
  `node_modules/.bin/`. Node's `spawnSync` without `shell: true` does not
  auto-resolve a bare `npm` to `npm.cmd`. The package-manager helpers
  (`installCommand`, `runScriptCommand`, `execCommand` in
  `src/util/package-manager.ts`; `resolveWranglerBin` in
  `src/cloudflare/wrangler-runner.ts`) now append `.cmd` explicitly on Windows.
  We deliberately avoid `shell: true` to keep glob/quoting hazards out of the
  spawn surface.

**Known limitations:**

- **Deploy / auth init not validated on Windows-native.** `flint deploy` and
  `flint auth init` are exercised on Linux/macOS/WSL only. The Windows
  spawn-resolution fixes above should make them work, but they have not been
  run end-to-end on a Windows-native host. For production deploys on Windows,
  use WSL2.
- **keytar is opt-in and dynamic-imported.** `flint auth init --keychain`
  attempts a runtime `import('keytar')`. If keytar is not installed or fails
  to load (libsecret missing on minimal Linux, etc.), Flint warns and falls
  back to `.dev.vars` automatically. On Windows-native, keytar uses the
  Credential Manager; this path is untested but should work if keytar is
  installed independently.
- **Fake-bin test harness is POSIX-only.** Tests that exercise `wrangler` /
  package-manager spawn paths use `#!/bin/sh` scripts and are skipped on
  Windows (`it.skipIf(process.platform === 'win32')`). Real binaries work via
  the spawn fixes; only the harness is POSIX.
- **CI matrix does not include `windows-latest`.** Doubling CI minutes for a
  best-effort platform is deferred to v1.1. Beau runs spot-checks on WSL2.

### Quick Windows-native verification

If you are running Flint on Windows-native and want to verify the install:

```powershell
flint --version
flint doctor
flint init --variant static-spa my-app --no-git --no-install
cd my-app
flint upgrade --check
```

All four should exit zero. If `flint doctor` complains about wrangler, run
`npm install` inside the scaffolded project first.

## Package managers

| PM | Tier | Detection signals | Notes |
| --- | --- | --- | --- |
| **npm** | First-class | `package-lock.json`, UA, default | All commands work, all CI runs use npm. |
| **pnpm** | First-class | `pnpm-lock.yaml`, UA | `flint create-app --pm pnpm` works. `flint add pwa` installs deps via pnpm. |
| **bun** | First-class | `bun.lockb` / `bun.lock`, UA | Same. |
| **yarn** | Best-effort | `yarn.lock`, UA | Install + run commands work via `yarn install` / `yarn run`. Tested less rigorously than the first-class trio. See `docs/package-managers.md` for caveats. |

## Cloudflare wrangler

| Wrangler version | Tier |
| --- | --- |
| **4.x** | First-class — Flint is tested against wrangler 4.90. |
| 3.x | Not tested. Some commands may work; others will surface warnings. |
| 5.x and beyond | Forward-compatible best-effort — Flint will surface a warning if the output format changes. |

`flint doctor` probes the installed wrangler version and reports it.

## Cloudflare Pages

Flint targets the **Cloudflare Pages with Functions** workflow (deploy via `wrangler pages deploy`). Workers + Vite (the newer Cloudflare full-stack offering) is not a v1.0 target.

## See also

- `docs/package-managers.md` — per-PM caveats and fixtures
- `docs/deploy-environments.md` — `flint deploy --env <name>` contract
- `flint doctor` — runtime check that all of the above is satisfied on your machine
