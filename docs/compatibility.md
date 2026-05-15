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

### Known Windows-native gaps

- The fake-bin test harness uses POSIX `#!/bin/sh` scripts and is skipped on Windows. Real `wrangler` invocations should work since they go through `spawnSync` on whatever `wrangler.cmd` or `wrangler` the project ships.
- `$EDITOR` invocation in `flint upgrade --apply` uses `vi` as the fallback — not present on Windows. Set `EDITOR=notepad` (or VS Code's `code --wait`) before running upgrade interactively.

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
