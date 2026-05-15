# Package manager support

Flint v1.0 supports four package managers across the `create-app` and `add pwa` paths. This document covers how detection works, which PMs are first-class, and known caveats per PM.

## Detection order

When Flint needs to know which PM to invoke for `install`, `run`, or `exec`, it consults signals in this order:

1. **Explicit `--pm` flag** (where applicable). Wins unconditionally.
2. **Lockfile in `cwd`** (project-aware detection added in v1.0):
   - `bun.lockb` or `bun.lock` → bun
   - `pnpm-lock.yaml` → pnpm
   - `yarn.lock` → yarn
   - `package-lock.json` → npm
3. **`npm_config_user_agent`** env var (set by every modern PM when invoking child processes).
4. **Default: npm.**

This means `flint init` and `flint add pwa` work correctly without `--pm` in pnpm/bun/yarn projects — Flint reads the lockfile and runs the right tool. `flint doctor` shows you which signal Flint used (e.g. `Detected pnpm@9.4.0 (lockfile)`).

## Tiers

### First-class: `npm`, `pnpm`, `bun`

These three PMs are tested in CI on every PR. The full surface works:

- `flint create-app --pm <name>` scaffolds and runs install
- `flint add pwa` detects the lockfile and uses the right PM to install `vite-plugin-pwa`
- `flint deploy` invokes the build through the PM's run-script

### Best-effort: `yarn`

Yarn 1.x and yarn 2+ (Berry) are detected and recognised, but Flint's CI doesn't run yarn-specific scenarios end-to-end. The shapes used are:

- `yarn install` — works across yarn 1 and yarn 2+
- `yarn run <script>` — universal
- `yarn exec <bin> [args]` — yarn 2+; yarn 1.x supports `yarn <script>` with caveats

**Known yarn caveats:**

- Yarn 2+ uses PnP by default, which means `node_modules/.bin/wrangler` may not resolve directly. Flint's `wrangler-runner` falls back to `WRANGLER_BINARY` and PATH, so as long as wrangler is in `package.json` and yarn's PnP setup is intact, `flint deploy` works.
- Yarn 2+ workspaces with non-default install layouts haven't been tested.
- `flint create-app --pm yarn` runs `yarn install` after scaffold. If yarn isn't on PATH, you'll see a spawn error.

If you hit a yarn-specific issue, report it via `.github/ISSUE_TEMPLATE/bug-report.md` and we'll investigate.

## Per-command translation

The cross-PM command set Flint uses internally:

| Operation | npm | pnpm | bun | yarn |
| --- | --- | --- | --- | --- |
| install | `npm install` | `pnpm install` | `bun install` | `yarn install` |
| run script | `npm run <s>` | `pnpm run <s>` | `bun run <s>` | `yarn run <s>` |
| exec binary | `npx --no-install <bin>` | `pnpm exec <bin>` | `bunx <bin>` | `yarn exec <bin>` |

These mappings live in `src/util/package-manager.ts`. If a PM-specific edge surfaces, file an issue with the exact command you tried and the PM version (`<pm> --version`).
