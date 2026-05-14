# Flint

> The Cloudflare Pages bootstrap CLI for Vite + React + TypeScript apps.
> _Flint sparks the spark._

Flint replaces the ad-hoc dance of "create a Vite app, add Tailwind, wire up
Wrangler, copy `_headers` from the last project, paste a token from the
dashboard, hope CSP is right" with one command per step. It is opinionated
on stack (Vite + React + TS + Wrangler v4) and unopinionated on everything
else.

**Status:** v0.1 (auth + init MVP). See _Roadmap_ for what's coming.

---

## Install (v0.1: local only)

Flint v0.1 is not yet published to npm. Run from a local clone:

```bash
git clone <flint-repo> ~/dev/flint
cd ~/dev/flint
npm install   # also builds via `prepare`
npm link      # exposes `flint` globally
```

After linking, the `flint` binary is on your `$PATH`. To uninstall, run
`npm unlink -g flint` from the repo root.

> **Publishing:** the npm package name is `@op4z/flint` (scope avoids
> the bare-`flint` collision risk). The binary stays `flint` — users
> still invoke `npx @op4z/flint init` or `flint <command>` after install.
> Fallback names if the `@op4z` scope ever needs revisiting: `ember`,
> `forge`, `embark`.

---

## What Flint v0.1 ships

Two surfaces, both self-contained:

1. **`flint auth ...`** — persistent Cloudflare API token management. Run
   once, and every Wrangler invocation (including CI) reads
   `CLOUDFLARE_API_TOKEN` from `.dev.vars` natively. No more
   `wrangler login` sessions that expire mid-week.
2. **`flint init`** — scaffold Cloudflare Pages config (`wrangler.toml`,
   `_headers`, `_routes.json`, `functions/_shared/*`, CI workflow,
   `.dev.vars.example`, `package.json` scripts) into an existing Vite +
   React + TS repo.

### Two template variants in v0.1

| Variant            | What you get                                                         | Mirrors  |
| ------------------ | -------------------------------------------------------------------- | -------- |
| `pages-functions`  | Functions + 1 KV namespace + HMAC auth + rate limit                  | Chorus   |
| `pages-fullstack`  | All of the above + R2 bucket + `vite-plugin-pwa` wiring              | Blaze    |

`static-spa` (Portfolio-style) is reserved for v0.5.

---

## Usage

### 1. Authenticate once

```bash
flint auth init
```

Walks through four phases:

1. **Educate** — prints the seven required Cloudflare API token scopes
   (Pages, KV, R2, Workers Scripts, Account Settings, User Details, Zone)
   and copies them to your clipboard.
2. **Open the browser** — offers to launch
   `https://dash.cloudflare.com/profile/api-tokens` so you can create a
   Custom Token.
3. **Capture & validate** — paste the token (input is masked). Flint hits
   `GET /user/tokens/verify` and `GET /accounts` to confirm validity and
   resolve the Account ID.
4. **Store** — writes `~/.config/flint/credentials` (mode 0600) and offers
   to hydrate the current repo's `.dev.vars` if you're inside a project.

```bash
flint auth status   # show current account + token validity
flint auth doctor   # probe each of the 7 required scopes individually
flint auth rotate   # replace the stored token (manual revoke reminder)
```

### 2. Scaffold a Pages app

Inside a fresh `npm create vite@latest`-style repo:

```bash
flint init --variant pages-functions --name my-app
```

This writes (without overwriting existing files unless you pass `--force`):

```
wrangler.toml
public/_headers
public/_routes.json
functions/_shared/auth.ts        (HMAC cookie helpers, templated for your app)
functions/_shared/response.ts    (ok/err envelope)
functions/_shared/storage.ts     (typed KVCollection wrapper)
functions/_shared/ratelimit.ts   (KV-backed sliding window)
functions/_shared/schemas.ts     (Zod schemas — login starter)
functions/api/health.ts          (binding sanity check)
.dev.vars.example                (CLOUDFLARE_*, ADMIN_PASSWORD, COOKIE_SECRET)
.github/workflows/ci.yml         (lint + typecheck + test + build)
```

It also:

- adds `.dev.vars` to `.gitignore` if missing,
- merges 10 wrangler-related scripts into `package.json`
  (`dev`, `build`, `deploy`, `secret:set`, `logs`, `deployments`, etc.),
- **hard-blocks** if `.dev.vars` is already tracked in git history (the
  CLI never writes secrets where they could be committed; rotate any
  exposed token before continuing).

`flint init --variant pages-fullstack` adds an R2 bucket binding,
`R2Media` storage helper, and a `vite.config.ts` pre-wired with
`vite-plugin-pwa`.

### Flags

```text
flint auth init    [--no-browser] [--no-clipboard]
flint auth rotate  [--no-browser] [--no-clipboard]

flint init  [--variant <pages-functions|pages-fullstack>]
            [--name <project>]
            [--no-ci]
            [-y, --yes]
            [--force]
```

---

## Token storage model

Flint v0.1 stores the API token in **two** places per the plan:

| Location                          | Purpose                          | Mode  |
| --------------------------------- | -------------------------------- | ----- |
| `~/.config/flint/credentials`     | Cross-repo source of truth (JSON) | 0600  |
| `<repo>/.dev.vars`                | Per-repo `CLOUDFLARE_API_TOKEN`   | 0600  |

`XDG_CONFIG_HOME` is honored; tests can override via `FLINT_CONFIG_HOME`.

**OS keychain storage is NOT supported in v0.1.** It's on the roadmap
behind a `--keychain` flag, but the cross-platform native deps to do it
well outweigh the benefit at this stage. The plaintext-on-disk model is
hardened by:

- Mode 0600 on both files (POSIX).
- Strict gitignore enforcement on `.dev.vars` (hard-blocks tracked files).
- Atomic write+rename so partial writes don't corrupt the credential.

Rotation events archive the previous credentials to
`~/.config/flint/credentials.rotated/<timestamp>.json` for recovery.
Nothing reads these automatically — they're a 30-day safety net.

---

## v0.1 limitations (explicitly out of scope)

These are deliberate omissions, queued for later milestones:

- **`flint create-app <name>`** — full new-project scaffold (v0.5).
- **`flint configure`** — Cloudflare resource provisioning (KV/R2/Pages
  project creation via the API) (v0.2).
- **`flint add <feature>`** — feature toggles (`add kv`, `add r2`,
  `add pwa`) (v0.2 + v0.9).
- **`flint deploy`** — wrapped `wrangler pages deploy` with pre-flight
  checks (v0.5).
- **`flint upgrade`** — config drift remediation (v0.9).
- **`static-spa` variant** — Portfolio-style scaffold (v0.5).
- **Telemetry** — even opt-in is deferred to v0.9.
- **OS keychain token storage** — post-v0.1.
- **npm publish** — v1.0.

---

## Roadmap (high level)

| Milestone | Adds                                                              |
| --------- | ----------------------------------------------------------------- |
| v0.2.0    | `configure`, `add kv`, `add r2`, `add secret`                     |
| v0.5.0    | `create-app`, `static-spa` variant, `deploy` wrapper              |
| v0.9.0    | `upgrade`, `add pwa`, `add auth`, asset-budget pre-flight, telemetry |
| v1.0.0    | Public npm publish, docs site, Bun + pnpm parity                  |

Full plan in
`/home/beaug/dev/TheNexusProject/docs/plans/flint-cloudflare-bootstrapper.md`.

---

## Development

```bash
npm install         # also builds via `prepare`
npm test            # vitest (43 unit tests across auth + templates)
npm run lint        # eslint
npm run typecheck   # tsc -b
npm run build       # tsc -> dist/
```

### Layout

```
src/
├── cli.ts                       # commander entrypoint
├── commands/
│   ├── auth.ts                  # init / status / doctor / rotate
│   └── init.ts                  # scaffold inside existing repo
├── cloudflare/
│   ├── api.ts                   # fetch wrapper + scope probes
│   ├── credentials.ts           # ~/.config/flint/credentials I/O
│   ├── dev-vars.ts              # .dev.vars writer + gitignore enforcement
│   └── permissions.ts           # canonical required-scope list
├── util/
│   ├── browser.ts               # open URL cross-platform
│   ├── clipboard.ts             # copy text cross-platform
│   ├── logger.ts                # tiny ANSI logger
│   ├── paths.ts                 # XDG config paths
│   ├── template.ts              # {{var}} renderer
│   └── version.ts               # read package.json at runtime
templates/
├── pages-functions/             # Chorus-style scaffold
└── pages-fullstack/             # Blaze-style scaffold
tests/
├── cloudflare/                  # api + credentials + dev-vars tests
├── templates/                   # smoke test renders every .tmpl file
├── util/                        # template engine tests
└── util/tmp-home.ts             # FLINT_CONFIG_HOME sandbox helper
```

### Adding a new template file

1. Drop it under `templates/<variant>/` at the path it should land in the
   user's repo.
2. If it needs substitution, name it `<file>.tmpl` and use `{{varName}}`
   placeholders. Available vars: `appName`, `appNameLower`, `compatDate`,
   `cookieName`, `tokenMessage`.
3. The smoke test (`tests/templates/render.test.ts`) will pick it up
   automatically and fail if it references an unknown variable.

---

## License

MIT.
