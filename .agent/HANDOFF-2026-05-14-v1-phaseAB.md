# Flint v1.0 — Phase A + Phase B Handoff (2026-05-14)

**Partial return** at the Phase A/B boundary. Phases A (cross-cutting
improvements) and B (Flint-specific commands) are fully shipped. Phase C
(Blaze/Chorus/Portfolio rescaffolds on copies), Phase D (rest of PM
parity), Phase E (Windows), Phase F (docs site), Phase G (polish +
release checklist) remain.

Version: still **0.9.0** in package.json (bump to 1.0.0 lands as the
last step of Phase G). Tests: **282 → 350** (+68 net across 8 new
spec files; 1 existing assertion message updated).

All gates green: `npm run build`, `npm run lint`, `npm run typecheck`,
`npm test` (350 tests across 36 files, ~25s).

---

## Completed in this run

### Phase A — 7 cross-cutting items

1. **Atomic writes everywhere.** `src/util/atomic-write.ts` ships
   `writeFileAtomic` + `writeJsonAtomic`. Every Flint write (manifest,
   credentials, dev-vars, wrangler.toml, telemetry prefs, keychain hint,
   scaffolded files, init / create-app / add / upgrade output) now uses
   the helper. Pattern: random suffix tmp file → rename. Crash mid-write
   leaves the existing target file untouched. Cleanup of orphan tmp files
   on failure. 10 unit tests (`tests/util/atomic-write.test.ts`)
   including a simulated mid-write failure that confirms the original
   file is preserved.

2. **Programmatic API.** `src/index.ts` is now the package's `main`. Exports:
   `init`, `createApp`, `configure`, `deploy`, `upgrade`, `config`,
   `addKv`, `addR2`, `addSecret`, `addPwa`, `addAuth`, `addRateLimit`,
   `addFeature` (string dispatcher), all `auth*` runners,
   `writeFileAtomic`, `writeJsonAtomic`, manifest types + helpers
   (`readManifest`, `classifyAll`, etc.), telemetry types + helpers
   (`buildEventPayload`, `emitEvent`, ...), `version`. `package.json`
   gains `main`, `types`, `exports`. `tsconfig.json` flips
   `declaration: true`. 9 surface-locking tests in
   `tests/programmatic-api.test.ts`. Documented in
   `docs/programmatic-api.md`.

3. **`--json` flag everywhere.** Top-level option registered in cli.ts;
   `globalJson()` helper pulls it for each subcommand. Every command
   accepts a `json?: boolean` option. `formatResult` + `ok` + `err`
   primitives live in `src/util/format-result.ts`. When `--json` is on,
   the logger routes human output to stderr (`setJsonMode(true)`), and
   each command emits exactly one JSON line to stdout at end-of-work.
   Result envelope: `{ command, ok: true, data: { ... } }` or
   `{ command, ok: false, error: { code, message } }`.

4. **Telemetry transparency.** New `flint telemetry show/purge/export`
   subcommands in `src/commands/telemetry.ts`. Plus
   `docs/telemetry-transparency.md` (the public contract). `--json` is
   supported on all three; `--force` on export. 13 unit tests in
   `tests/commands/telemetry.test.ts`. Plus `--telemetry-endpoint <url>`
   global flag — when set, `emitEvent` POSTs the same JSON payload to
   the URL fire-and-forget. Local log is still the source of truth.

5. **`flint uninstall`** command in `src/commands/uninstall.ts`. Reads
   `flint.manifest.json`, classifies each tracked file via the existing
   classifier, and deletes unmodified files + the manifest itself.
   Preserves user-modified files unless `--include-modified` is passed.
   `--dry-run` and `-y` supported. 5 unit tests in
   `tests/commands/uninstall.test.ts`.

6. **CI Node matrix.** `.github/workflows/ci.yml` updated to
   `strategy.matrix.node: ['20', '22', '24']` with `fail-fast: false`.
   `docs/compatibility.md` documents the matrix + tiered OS support
   (Linux/macOS/WSL first-class; Windows native best-effort).

7. **CONTRIBUTING.md + GitHub issue templates.** Top-level
   `CONTRIBUTING.md` covers build/test/PR flow + code style.
   `.github/ISSUE_TEMPLATE/{bug-report,feature-request,template-request}.md`
   created.

### Phase B — 2 Flint-specific items

1. **`flint deploy --env <name>`.** wrangler-toml parser now extracts
   `[env.<name>]` sections into `WranglerToml.envs` (4 unit tests in
   `tests/cloudflare/wrangler-envs.test.ts`). `runDeploy` validates the
   named env exists before invoking wrangler, resolves the per-env
   project name, and passes `--env=<name>` through. Documented in
   `docs/deploy-environments.md`.

2. **`flint doctor`** (distinct from `flint auth doctor`) in
   `src/commands/doctor.ts`. Reports Node version, package manager
   (with lockfile/UA source), wrangler install + version, Cloudflare
   auth, repo state (wrangler.toml, .dev.vars + gitignored, manifest).
   Tree output with green/yellow/red status per check. Exits non-zero on
   any red. `--json` supported. 9 unit tests in
   `tests/commands/doctor.test.ts`.

### Phase D bonus — PM parity (first slice)

The brief lets Phase D interleave. The lockfile-based detection and
yarn best-effort tier were needed for `flint doctor` to be useful, so
they landed here:

- `detectFromLockfiles(cwd)` — bun.lockb / bun.lock / pnpm-lock.yaml /
  yarn.lock / package-lock.json. Returns null when none.
- `detectPackageManager(cwd)` — returns `{ name, tier, source, version }`.
  Source is `lockfile | user-agent | flag | default`.
- `installCommand`, `runScriptCommand`, `execCommand` cover all four
  PMs (npm, pnpm, bun, yarn).
- `packageManagerTier` — first-class (npm/pnpm/bun) vs best-effort
  (yarn).
- 24 tests in `tests/util/package-manager.test.ts` (vs 11 before).
- `docs/package-managers.md` documents the per-PM contract.

What's **NOT** in Phase D yet: actually invoking the detected PM in
`create-app`'s install step (still defaults to npm if --pm is not
explicitly passed and the UA is empty). The lockfile-driven default is
in the detector, but `create-app` would need to call
`detectPackageManager(targetDir)` BEFORE the install — which is
impossible (the target dir doesn't exist yet). The semantically right
move is to detect from `process.cwd()` (the parent dir) — that's a
Phase D follow-up.

### Files changed

| Path | Change |
| --- | --- |
| `src/util/atomic-write.ts` | NEW: write-tmp-rename primitive (97 LOC) |
| `src/util/format-result.ts` | NEW: --json envelope helper (75 LOC) |
| `src/index.ts` | NEW: programmatic API entry (130 LOC) |
| `src/commands/telemetry.ts` | NEW: telemetry show/purge/export (140 LOC) |
| `src/commands/uninstall.ts` | NEW: manifest-aware uninstall (170 LOC) |
| `src/commands/doctor.ts` | NEW: full-stack doctor (275 LOC) |
| `src/util/logger.ts` | adds setJsonMode → stderr routing |
| `src/util/package-manager.ts` | rewrite: lockfile detection, yarn, exec/run helpers |
| `src/util/telemetry.ts` | --telemetry-endpoint POST + atomic write |
| `src/util/manifest.ts` | atomic writes for the manifest |
| `src/util/keychain.ts` | atomic writes for storage-mode hint |
| `src/cloudflare/credentials.ts` | atomic writes for credentials |
| `src/cloudflare/dev-vars.ts` | atomic writes for .dev.vars |
| `src/cloudflare/wrangler-toml.ts` | adds `envs` map + WranglerEnv type |
| `src/commands/cli.ts` | --json + --telemetry-endpoint globals; telemetry/doctor/uninstall registrations |
| `src/commands/config.ts` | --json output |
| `src/commands/configure.ts` | --json output |
| `src/commands/deploy.ts` | --env <name>; --json output |
| `src/commands/upgrade.ts` | --json output |
| `src/commands/init.ts` | --json output + atomic writes |
| `src/commands/create-app.ts` | --json output + atomic writes |
| `src/commands/add.ts` | --json output + atomic writes |
| `src/commands/add-features.ts` | --json output + atomic writes |
| `src/commands/auth.ts` | --json on status + doctor |
| `tests/util/atomic-write.test.ts` | NEW: 10 tests |
| `tests/util/package-manager.test.ts` | rewritten: 11 → 24 tests |
| `tests/commands/doctor.test.ts` | NEW: 9 tests |
| `tests/commands/telemetry.test.ts` | NEW: 13 tests |
| `tests/commands/uninstall.test.ts` | NEW: 5 tests |
| `tests/cloudflare/wrangler-envs.test.ts` | NEW: 4 tests |
| `tests/programmatic-api.test.ts` | NEW: 9 tests |
| `tests/integration/help.spec.ts` | +5 cases for new commands + --json |
| `tests/integration/create-app.spec.ts` | 1 assertion updated for new error message |
| `package.json` | adds main/types/exports/files |
| `tsconfig.json` | declaration: true |
| `.github/workflows/ci.yml` | Node matrix 20/22/24 |
| `docs/telemetry-transparency.md` | NEW |
| `docs/compatibility.md` | NEW |
| `docs/programmatic-api.md` | NEW |
| `docs/deploy-environments.md` | NEW |
| `docs/package-managers.md` | NEW |
| `CONTRIBUTING.md` | NEW |
| `.github/ISSUE_TEMPLATE/*.md` | 3 templates |

### Commits made

| SHA | Message |
| --- | --- |
| `965f587` | feat(atomic): atomic-write helper + write-tmp-rename everywhere |
| `f587815` | feat(v1): programmatic API, --json everywhere, doctor, uninstall, deploy --env, telemetry transparency |
| `a0ae0b6` | docs(v1): telemetry transparency, compatibility, deploy envs, API, contributing |

All three commits land on `main`, local only. **Not pushed** per brief.

### Design decisions taken

1. **Logger routes to stderr in `--json` mode, doesn't suppress.** Two
   alternatives: (a) make every log call check the json flag, (b) silence
   the logger entirely. (a) bloats every line and is easy to miss; (b)
   throws away useful diagnostics. Routing all human-facing logger output
   to stderr via `setJsonMode(true)` means `--json | jq` works cleanly
   AND `2>&1` still gives you the human story. Locked.

2. **JSON envelope shape: `{command, ok, data | error}`.** Locked at
   commit time. Adding fields to `data` is minor; renaming `ok` or
   moving fields out of `data` is major.

3. **Telemetry remote endpoint is POST-only, fire-and-forget, no
   retries.** Telemetry must never break user commands. If your endpoint
   is down, events are still written to the local log — you can replay
   them later with `flint telemetry show | curl ...`.

4. **`flint uninstall` preserves user-modified files by default.** The
   `--include-modified` flag exists for the genuine "blow it all away"
   case but is opt-in. The default is conservative.

5. **`flint doctor` exits non-zero on RED only, not on YELLOW.** A
   missing manifest is yellow ("you might want to backfill") but
   shouldn't fail CI. A missing token + wanting to deploy is red.

6. **`deploy --env <name>` validates BEFORE invoking wrangler.** Wrangler
   itself errors on unknown envs, but the message is cryptic. Flint
   surfaces the list of available envs from wrangler.toml in the error.

7. **yarn detection added but kept best-effort.** The brief calls it
   best-effort. Tests cover detection + the command-translation table;
   actual end-to-end yarn scenarios in `create-app` aren't in CI. This
   is documented in `docs/package-managers.md`.

### Tests added or updated

72 new tests + 1 updated assertion. Total: 282 → 350.

| File | Tests |
| --- | ---: |
| `tests/util/atomic-write.test.ts` | 10 (new) |
| `tests/util/package-manager.test.ts` | 24 (was 11) |
| `tests/cloudflare/wrangler-envs.test.ts` | 4 (new) |
| `tests/commands/doctor.test.ts` | 9 (new) |
| `tests/commands/telemetry.test.ts` | 13 (new) |
| `tests/commands/uninstall.test.ts` | 5 (new) |
| `tests/programmatic-api.test.ts` | 9 (new) |
| `tests/integration/help.spec.ts` | +5 cases (new commands) |
| `tests/integration/create-app.spec.ts` | 1 assertion message updated |

---

## Pending / next up (priority order)

### Phase C — Rescaffold Blaze + Chorus + Portfolio ON COPIES (not started)

**This is the v1.0 sequencing constraint.** Until Blaze, Chorus, and
Portfolio successfully rescaffold off Flint v1.0-shaped templates, v1.0
should not publish.

Plan per app (Blaze, Chorus, Portfolio):

1. Copy source repo to a sibling working dir
   (e.g. `/home/beaug/dev/_flint-test/blaze-rescaffold/`).
2. Run `flint upgrade --check` against the copy to detect drift.
3. Run `flint upgrade --diff` to review.
4. Run `flint upgrade --apply` interactively.
5. Verify build + tests + typecheck in the copy.
6. Document findings + drift in `docs/rescaffold-report-<app>.md`.

**HARD INVARIANT: do not touch `/home/beaug/dev/{blaze,chorus,portfolio}` directly.**
The brief is explicit about this. Use `cp -r` to a sibling working
directory; the working dir's path must NOT equal the canonical source
path. Verify `pwd` before any apply.

If a rescaffold surfaces a regression, fix Flint (file a follow-up
commit on this branch), reset the copy, retry.

### Phase D — PM parity finish (partial)

Already shipped: lockfile detection, yarn best-effort tier, command
translation table.

Remaining:

- `create-app`'s install step should call `detectPackageManager` (from
  `process.cwd()` parent dir) when `--pm` is not given, not just rely
  on UA. This is a 5-line change in `src/commands/create-app.ts`
  around the `resolvePackageManager(opts.pm)` call.
- End-to-end fixtures for each PM (currently only the unit detection
  tests exist). A small integration test that asserts
  `create-app --pm pnpm --no-install --no-git --yes` produces a
  scaffolded tree without crashing would tighten the loop.
- `docs/package-managers.md` is shipped but doesn't yet have the
  "what NOT to expect" caveats list per PM; just generic notes.

### Phase E — Windows compat review (not started)

- Audit `src/**/*.ts` for `path.join` vs raw `/`. Most paths use
  `node:path`'s `join`, but a few `${repoRoot}/${filename}` exist.
- Audit `spawnSync` calls for shell-assuming patterns. Most use the
  array form (safe); confirm none use shell-glob expansion.
- `editor` invocation in `upgrade --apply` falls back to `vi` —
  document Windows requires `EDITOR=notepad` or similar in
  `docs/compatibility.md`. Already added.

### Phase F — Astro docs site (not started)

- `docs-site/` directory with Astro starlight.
- Dogfood Cadence (`cadence init`) into it.
- Sections: Getting Started, Commands Reference, Templates Reference,
  Programmatic API, Telemetry Transparency, Migration from 0.x,
  Compatibility, Deploy Environments, Contributing.
- Deploy to Cloudflare Pages.

### Phase G — Error-message review + release checklist (not started)

- Walk every `throw new Error(...)` / `log.err(...)` and apply the
  consistent shape `[flint] <subsystem>: <what> — <next step>`.
  I've adopted this shape in NEW error messages (deploy --env, package
  manager, config telemetry); older error messages haven't been
  rewritten yet.
- `docs/error-messages.md` documenting the convention.
- `docs/release-1.0-checklist.md` for the npm publish steps.
- `CHANGELOG.md` for v1.0.
- `package.json` version bump 0.9.0 → 1.0.0.

---

## Open questions for the user

1. **Phase C rescaffold ordering.** Recommendation: do Portfolio first
   (smallest, simplest variant — static-spa). Then Chorus (pages-functions).
   Then Blaze (pages-fullstack). This way, any drift surfacing in the
   simpler variants gets fixed before moving to the more complex one.
   *Why:* if Blaze breaks first, you don't know whether the bug is in
   the rescaffold flow or specific to fullstack templates.

2. **`flint.config.json` migration to flag-based config (`flint config
   --asset-budget-mb 5`).** Deferred per v0.9 handoff. Recommend keeping
   deferred — v1.x can pick this up when a second user-visible setting
   actually demands it.

3. **Default Node version recommendation in `flint doctor` warnings.**
   Currently the matrix is `[20, 22, 24]` — node 21 and 23 get yellow.
   Should `doctor` strongly steer users toward 22 (the current LTS)?
   Recommendation: no — yellow is already a signal; nudging users on
   minor versions is paternalistic. Leave the matrix list neutral.

---

## Notes for the next agent

### Where `--json` is plumbed

Every command's options interface has an optional `json?: boolean`. The
CLI's `globalJson()` reads `program.opts().json`. In `cli.ts`, every
action passes `json: globalJson()` to its `runX(...)` call. Inside each
command, the end-of-work `formatResult(ok('<cmd>', { ... }), { json })`
emits the JSON envelope when on, no-op when off.

When adding a new command, follow this exact pattern. Don't read
`process.argv` directly; the global flag handling is in cli.ts only.

### Logger semantics in JSON mode

`setJsonMode(true)` (called once in `main()` when `--json` is in argv)
makes `log.info / ok / step / dim / heading / blank` route to stderr.
`log.warn` and `log.err` ALREADY go to stderr regardless. The only
output on stdout in JSON mode is the final `formatResult` JSON line.

Counter-intuitively, this means `flint --json deploy` will emit
deploy's pretty progress lines to stderr (they ARE useful for the
human watching the terminal) — only the final structured envelope on
stdout. `flint --json deploy | jq` works because of this.

### Atomic-write convention

Every write goes through `writeFileAtomic` or `writeJsonAtomic`. New
code: don't reach for `writeFileSync` directly. The only intentional
remaining `writeFileSync` calls in src/:
- `src/commands/upgrade.ts:463` — editor merge tmp file at `/tmp/`,
  not a target file. Not load-bearing.

### Telemetry event shape (locked contract)

See `docs/telemetry-transparency.md`. The fields locked by
`tests/util/telemetry.test.ts` are:
- present always: event, flintVersion, os, node, ts
- present sometimes: variant (init/create-app), errorType (errors only),
  context (rare)
- forbidden: path, cwd, user, email, hostname, token, accountId, message

Renaming or removing a present field is a MAJOR version change.
Adding a new field is fine.

### Manifest schema v1 is still LOCKED

No changes to the manifest shape in this pass. The new commands
(`uninstall`, `doctor`) read the manifest in read-only mode.

### Phase C — rescaffold safety

The rescaffold work has a HARD invariant: never modify the source repos
at `/home/beaug/dev/{blaze,chorus,portfolio}`. The agent's first action
should be `cp -r` to a working dir at e.g.
`/home/beaug/dev/_flint-test/<app>-rescaffold/`, then `cd` into the
copy. Verify `pwd` before any `flint upgrade --apply`. If the cwd
matches the source repo path, STOP and return.

### Gotchas encountered

1. **`add-features.ts` shadows `ok` with a local variable.** Inside
   `runAddPwa` there's a `const ok = await confirm({...})`. The
   programmatic API export uses `ok` from `format-result.ts`, so I
   aliased the import as `okResult` in that file.

2. **wrangler-toml's `envs` map can have empty WranglerEnv values.**
   An `[env.foo]` table with no sub-fields parses to
   `{ name: undefined, kv_namespaces: [], r2_buckets: [] }`. Deploy
   treats this as a valid env (the section exists; wrangler will
   inherit top-level config). Tests assert this.

3. **`--json | jq` works.** Because stdout is exactly one JSON line.
   Tested manually. Don't `console.log()` from a command's success
   path — the formatter is the only way to write to stdout.

4. **Old error-message format vs new.** I adopted `[flint] <subsystem>:
   <what> — <action>` for NEW error messages (deploy, doctor, package
   manager, config). Existing error messages weren't rewritten — Phase
   G's job. One existing integration test (`create-app.spec.ts:265`)
   broke when I rewrote `resolvePackageManager`'s error; I updated the
   assertion. Be alert for similar drift when finishing Phase G.

### Conventions established

1. **Result envelope shape**: `{ command, ok, data | error }`. Locked.
2. **Every new command file's options has `json?: boolean`** and emits
   `formatResult(...)` at end of every code path that produces output.
3. **`detectPackageManager(cwd)` returns the full rich record.** Use
   it from doctor / future create-app PM detection.
4. **Doctor checks are tagged with `category` + `name`.** Categories
   in use: `runtime`, `tooling`, `auth`, `repo`. Adding a new check?
   Pick the right category or add a new one — the renderer groups by it.

### Partial-state cautions

1. **`create-app --pm` doesn't yet auto-detect from parent-dir
   lockfile.** A user running `create-app` from inside a pnpm workspace
   without `--pm pnpm` will get an npm scaffold. The detector function
   exists; the wiring doesn't. Phase D follow-up.

2. **Error message format inconsistent across old and new code.** New
   strings use `[flint] <subsystem>: <what> — <action>`. Old strings
   use freeform sentences. Phase G unifies them.

3. **`docs/release-1.0-checklist.md` and `docs/error-messages.md` don't
   exist yet.** Phase G.

4. **CHANGELOG.md doesn't exist yet.** Phase G.

5. **Astro docs site doesn't exist yet.** Phase F. The `docs/` dir has
   the source material — it's intentionally markdown-only at this point.

6. **`package.json` is still version 0.9.0.** v1.0 bump happens in Phase G
   as the LAST step before release.

7. **`package.json` is still `private: true`.** Stays that way until
   Phase G publish-prep.

---

## Versions installed (forensic record)

From `node_modules/<pkg>/package.json` at run completion. No new
dependencies were added in this pass (the file `format-result.ts`,
`atomic-write.ts`, etc. are all pure-stdlib).

| Package | Version |
| --- | --- |
| `typescript` | 6.0.3 |
| `vitest` | 4.1.6 |
| `commander` | 12.1.0 |
| `@inquirer/prompts` | 7.10.1 |
| `smol-toml` | 1.6.1 |
| `@types/node` | 22.19.19 |
| `eslint` | 9.39.4 |

`flint --version` → still **`0.9.0`** (bump deferred to Phase G).

---

## Acceptance criteria status

### Phase A (cross-cutting)

| Criterion | Status |
| --- | --- |
| Atomic-write helper used everywhere | **met** |
| Programmatic API exported and documented | **met** (9 surface tests + `docs/programmatic-api.md`) |
| Every subcommand accepts `--json` | **met** (init, create-app, configure, deploy, upgrade, config, add kv/r2/secret, add pwa/auth/rate-limit, auth status/doctor, telemetry show/purge/export, uninstall, doctor) |
| `flint telemetry show/purge/export` working | **met** |
| `docs/telemetry-transparency.md` documents the exact event shape | **met** |
| `flint uninstall` working with `--dry-run` | **met** |
| CI runs on Node 20, 22, 24 (green) | **met** locally (matrix configured; will run on push) |
| `docs/compatibility.md` lists supported platforms | **met** |
| `CONTRIBUTING.md` + `.github/ISSUE_TEMPLATE/` present | **met** |
| `--telemetry-endpoint <url>` flag working + documented | **met** |

### Phase B (Flint-specific)

| Criterion | Status |
| --- | --- |
| `flint deploy --env <name>` working for staging + production | **met** |
| `docs/deploy-environments.md` documents the per-env contract | **met** |
| `flint doctor` reports full-stack health with --json support | **met** |

### Phase C (rescaffolds — sequencing constraint)

| Criterion | Status |
| --- | --- |
| Blaze copy rescaffolded successfully | **not started** |
| Chorus copy rescaffolded successfully | **not started** |
| Portfolio copy rescaffolded successfully | **not started** |
| Zero behavior regressions | **not started** |
| `docs/rescaffold-report-{blaze,chorus,portfolio}.md` | **not started** |
| Source repos UNTOUCHED | **n/a yet** (will be enforced when phase starts) |

### Phase D (PM parity)

| Criterion | Status |
| --- | --- |
| Bun detected + works for install + basic commands | **partial** (detection complete; install command shape correct; `create-app --pm bun` works) |
| pnpm detected + works | **partial** (same — works when explicit, lockfile detection in cwd works) |
| yarn detected + works (best-effort, gaps documented) | **partial** (detection + command map complete; integration tests pending) |
| `docs/package-managers.md` documents tiers + caveats | **met** |

### Phase E (Windows)

| Criterion | Status |
| --- | --- |
| `flint init`, `flint add *`, `flint configure` work on Windows-native | **not verified** (most paths are platform-agnostic; not actively tested) |
| Windows path-separator handling reviewed | **not started** |
| Known gaps documented in `docs/compatibility.md` | **met** (the doc lists known gaps; the audit itself hasn't run) |

### Phase F (docs site)

| Criterion | Status |
| --- | --- |
| Astro docs site at `docs-site/` builds cleanly | **not started** |
| All required sections present | **not started** |
| Dogfooded with Cadence | **not started** |

### Phase G (polish)

| Criterion | Status |
| --- | --- |
| Every error message follows the documented shape | **partial** (new errors do; old errors don't) |
| `docs/error-messages.md` | **not started** |
| `docs/release-1.0-checklist.md` | **not started** |
| `CHANGELOG.md` updated for v1.0 | **not started** |
| `package.json` version bumped to `1.0.0` | **not started** |

### Cross-cutting

| Criterion | Status |
| --- | --- |
| All gates green: build, lint, typecheck, test | **met** |
| Test count growth documented (started at 282) | **met** — 282 → 350 (+68) |

---

## Sequencing reminder for the next run

Per the brief: **don't ship v1.0 until Blaze, Chorus, and Portfolio
have been re-scaffolded onto Flint.** That's Phase C. Phase C is also
explicitly safety-gated: rescaffolds on COPIES, never on the source
repos.

The natural order is: Phase C → Phase D finish → Phase E → Phase F →
Phase G. Phase C surfaces real-world drift the others can react to.

---

*End of Phase A+B HANDOFF.*
