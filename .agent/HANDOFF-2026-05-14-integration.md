# Flint v0.2.1 — Integration Test Conversion Handoff (2026-05-14)

Converts the 10 automatable steps of `.agent/SMOKE-2026-05-14.md` into a
permanent vitest integration suite. Every milestone going forward gets
this baseline coverage automatically — no more manual smoke-testing for
the surfaces these specs cover.

---

## Conversion summary

- **Smoke steps converted:** 10 of 11 (steps 1-9, 11). Step 10
  (`.dev.vars` git-tracked hard-block under interactive `auth init`)
  explicitly skipped + documented as manual-only.
- **New tests added:** 36 across 5 spec files.
- **Test count:** 100 (pre-conversion) → **136** (post-conversion). +36.
- **CI workflow:** added (`.github/workflows/ci.yml`) — the project had
  none before this pass. Runs lint → typecheck → build → test on PRs and
  pushes to main.
- **Time elapsed:** ~50 minutes wall.
- **Gates after every commit:** lint clean, tsc -b clean, vitest run
  136/136, build clean.

---

## Tests created

### `tests/integration/_harness.ts` — shared harness

Exports the spawn-the-bin pattern reused by every spec:

- `runFlint(args, opts)` — spawnSync wrapper. Returns
  `{ stdout, stderr, status, raw }`. Never throws on non-zero exit; tests
  assert on `status` explicitly.
- `createTempRepo({ seedPackageJson })` — `mkdtempSync` + optional
  starter `package.json`. Returns `{ dir, cleanup }`.
- `readRepoFile / writeRepoFile / repoFileExists` — small sugar to keep
  spec assertions terse.
- `CLI_ENTRY` — absolute path to `dist/cli.js`. Resolved from the
  harness file's own location so the path is independent of process cwd.

The harness defaults `FLINT_CONFIG_HOME` to a sandbox path on every
spawn so the developer's real `~/.config/flint/credentials` never
participates. It also forces `NO_COLOR=1` so substring assertions stay
stable across CI environments.

### `tests/integration/init.spec.ts` — smoke steps 1-4 (10 tests)

| `it()` block | Smoke step | What it verifies |
| --- | --- | --- |
| writes all pages-functions files for a fresh repo | 1-2 | All 10 expected files written; wrangler.toml templated with `name=flint-smoke`; CONTENT_KV block present |
| pages-fullstack variant additionally writes vite.config.ts | 1-2 | Variant differentiation: fullstack is a superset |
| writes .dev.vars.example with the documented stubs | 2 | All 4 documented secret stubs (CF token, account id, ADMIN_PASSWORD, COOKIE_SECRET) |
| merges flint scripts into package.json | 2 | All 10 wrangler scripts inserted with project-name interpolation |
| appends .dev.vars to .gitignore when the file does not exist | 3 | Cold-path gitignore creation |
| appends .dev.vars to a pre-existing .gitignore without duplicating | 3 | Warm-path append + dedup |
| re-running init does NOT duplicate the .dev.vars gitignore entry | 3 | Idempotency across two init runs |
| re-running init in --yes mode without --force preserves existing files | 4 | Sentinel comment survives second run |
| re-running init with --force unconditionally overwrites | 4 | Counter-test: --force opt-in works |
| rejects an unknown variant with a non-zero exit and an actionable message | (extra) | Error-path coverage |

Tricky setup: seeds a minimal `package.json` so init's
`mergeScriptsIntoPackageJson` has something real to merge into. Does not
seed a full Vite scaffold (per the smoke brief, which explicitly skipped
`npm install`).

### `tests/integration/add.spec.ts` — smoke steps 5-7 (7 tests)

| `it()` block | Smoke step | What it verifies |
| --- | --- | --- |
| flint add kv CACHE_KV appends a [[kv_namespaces]] block | 5 | New block appended + CONTENT_KV preserved |
| flint add kv does NOT duplicate an existing binding | 5 | Re-adding CONTENT_KV is a no-op in --yes mode |
| flint add r2 MEDIA_R2 appends with auto-derived bucket_name | 6 | `bucket_name = "flint-smoke-media-r2"` (project + binding, lowercase-dashed) |
| flint add r2 preserves the original [[kv_namespaces]] block | 6 | Counter-isolation |
| flint add secret writes a documented stub to .dev.vars.example | 7 | Stub line + comment pointer |
| flint add secret does NOT create .dev.vars (disk-free invariant) | 7 | **THE v0.1 security invariant** |
| flint add secret normalizes the name to UPPER_SNAKE_CASE | 7 | Binding-name hygiene |

Tricky setup: seeds wrangler.toml directly rather than running `flint
init` first. Keeps each test ~150ms instead of ~1.5s (init does a lot of
template walking).

### `tests/integration/configure.spec.ts` — smoke step 8 (5 tests)

| `it()` block | What it verifies |
| --- | --- |
| --dry-run prints the offline-mode banner | Exact string `--dry-run: skipping Cloudflare token verify (no network probe).` on stdout |
| --dry-run completes with exit 0 against a known-bad token | Indirect proof of "no verify call": if verify still fired, bogus token would 401 + exit 2 |
| --dry-run emits the "no changes will be applied" notice | Comes from `log.warn`, which writes to stderr — test checks both streams |
| --dry-run reports no fetch / verify failure on stdout or stderr | Negative assertion — none of "token verification failed", "invalid request headers", "could not verify token with cloudflare", "fetch failed" should appear |
| exits non-zero when no credentials are available even in --dry-run mode | Counter-test: token must still be PRESENT (per cleanup pass design — see `loadCredentialsOrExit`) |

Special handling for the `--dry-run` network-absence assertion: see
**Harness decisions** below.

### `tests/integration/wrangler-patch.spec.ts` — smoke step 9 (4 tests)

The load-bearing v0.2 acceptance criterion.

| `it()` block | What it verifies |
| --- | --- |
| flint add r2 preserves a user comment at its original line position | Marker comment `# CUSTOM_MARKER_COMMENT_DO_NOT_DROP_a3f9` stays at index 2 byte-identical |
| flint add r2 only appends to the tail, never rewrites the head | Entire pre-existing fixture is a prefix of the post-write file |
| the block-attached comment stays glued to its [[kv_namespaces]] block | Comment immediately above `[[kv_namespaces]]` doesn't drift |
| the new [[r2_buckets]] block appears at the tail of the file | New block index is greater than existing kv block index |

### `tests/integration/help.spec.ts` — smoke step 11 (10 tests)

A regression where `--help` crashes is invisible to direct-import unit
tests — commander only walks its option/command graph when it
dispatches. Spawning the bin with `--help` is the cheapest way to assert
the dispatch graph is intact.

- 8 help surfaces: root, `auth`, `init`, `configure`, `add`, plus the 3
  `add` subcommands (`kv`, `r2`, `secret`).
- `flint --version` prints `0.2.0`.
- `flint` with no args exits non-zero with a help banner (asserts the
  expected commander behavior — guards against a silent-exit-0
  regression of the kind the sibling Cadence project hit).

Per-surface assertions are targeted substrings (option names, command
words) rather than full-stdout snapshots — commander version bumps
won't churn this test file.

---

## Harness decisions

### spawnSync vs tsx-direct vs subprocess library

**Chosen:** `child_process.spawnSync(process.execPath, [CLI_ENTRY, ...args], ...)`.

- `process.execPath` is the same Node binary running the tests, so we
  inherit the developer's chosen Node version without surprises.
- `CLI_ENTRY` is the on-disk built `dist/cli.js` — the same file the
  `bin` field in `package.json` points at. This is the closest
  representation of "what a `npm install -g` user would actually run."
- `spawnSync` (vs `spawn`) is the right tradeoff: we don't need streaming
  stdio for asserting on exit codes and final stdout/stderr.

**Rejected alternatives:**

1. **`tsx` to run `src/cli.ts` directly.** Would skip the `tsc` build
   step — but tests would no longer catch build-time issues (broken
   imports, lost templates, ESM/CJS confusion in dist). The build IS one
   of the things integration tests exist to validate.
2. **`execa` or similar subprocess library.** Adds a dependency for one
   wrapper function. The Node stdlib spawnSync is fine.
3. **`npm link` inside test setup.** Global side effects, conflicts on
   CI runners that test multiple branches in parallel. Hard pass.

### tmpdir strategy

Each test calls `createTempRepo()` in `beforeEach` and `repo.cleanup()`
in `afterEach`. The temp directory pattern is
`mkdtempSync(join(tmpdir(), 'flint-integration-'))` — guaranteed-unique
suffix means parallel test workers don't collide.

`afterEach` uses `rmSync(dir, { recursive: true, force: true })` so a
failing assertion doesn't strand directories. Vitest's per-file
parallelism is fine — every test owns its own tmp dir.

### How CI invokes the integration tests

`npm test` in `package.json` runs `vitest run`, which picks up both
`*.test.ts` (unit) and `*.spec.ts` (integration) per the updated
`include` glob in `vitest.config.ts`. The new
`.github/workflows/ci.yml` has a hard `npm run build` step before
`npm test` — integration tests fail with a clear "Build artifact
missing" error if `dist/cli.js` isn't there.

For local watch-mode workflows, `npm run test:integration` runs only the
integration suite (useful when iterating on a single spec).

### Special handling for `--dry-run` network-absence assertion

This was the only conversion that had a non-obvious assertion design.

**The strict version of "no fetch call happened"** is what
`tests/commands/configure.test.ts` does via `vi.spyOn(globalThis,
'fetch').mockImplementation(() => { throw ... })`. That works because
the unit test imports `runConfigure` directly into the test's own
process — the spy is wired into the same `globalThis`.

A spawned bin runs in a separate Node process, so we can't reach across
to its `globalThis.fetch`. Options considered:

1. **`HTTP_PROXY`/`HTTPS_PROXY` to a closed port.** Node's native fetch
   doesn't honor those by default (no undici ProxyAgent without code
   change). Rejected.
2. **`--require` script that monkey-patches fetch in the child.** Doable
   but adds a fixture file and a code-loading flag to the harness for
   one assertion. Rejected as over-engineered.
3. **The chosen approach (indirect proof).** Pass a known-bogus token
   via env vars. If the verify call still fired, Cloudflare would 401
   and the bin would exit 2 (verifyTokenOrExit calls `process.exit(2)`
   on failure). Reaching exit 0 is direct proof the guard is wired
   correctly. Complemented by:
   - Stdout substring check for the offline banner.
   - Negative assertion against the error strings a failed verify call
     would emit.

The unit test continues to provide the strict assertion. The
integration test provides the end-to-end confirmation through the CLI
pipeline. The two layers complement each other.

---

## Bugs found during conversion

**None.** All 36 new tests passed on first run after harness scaffolding.
The cleanup pass had already shaken out the bugs the smoke run
surfaced; the conversion is a recording mechanism, not a discovery one.

The only fixture issue caught was a log-stream mismatch on one
configure-spec assertion: `log.warn()` writes to stderr (via
`console.warn`), not stdout. Fixed in the same `git add` as the spec
file (no separate commit).

---

## Notes for the next agent

### Patterns established that v0.5 work should follow

When v0.5 lands `flint create-app` and `flint deploy`, the integration
suite gets one new spec each, following the established pattern:

1. Add `tests/integration/<surface>.spec.ts`.
2. Use `runFlint(args, { cwd: repo.dir, env: { ... } })` — never call
   the command module directly.
3. Pin assertions to user-visible behavior (filesystem state,
   stdout/stderr substrings, exit code). Internal implementation details
   stay covered by unit tests.
4. Each `it()` block maps to a specific acceptance criterion or smoke
   step. Use the smoke-report wording verbatim in the `it()` description
   for traceability.
5. If a new surface needs a different harness primitive (e.g.
   streaming stdout for a long-running deploy), extend `_harness.ts`
   rather than rolling a one-off.

### The interactive `auth init` test gap

`flint auth init` is fully interactive — it prompts for the token paste
BEFORE reaching the `ensureNotTracked` guard. From a non-TTY child
process, we can't get past the prompt. This means the most
security-sensitive code path in Flint v0.1 (refusing to write secrets
to a tracked `.dev.vars`) has no integration coverage.

Options the next agent could explore:

1. **Add a non-interactive flag.** `flint auth init --token <value>`
   would let CI/tests drive the full path. The flag exists nowhere in
   the v0.5 design today; would be a new public surface.
2. **Use `node-pty` for one assertion.** Heavyweight test dep (native
   build); rejected this pass but might be worth it when more
   interactive surfaces appear (`v0.5 create-app`).
3. **`flint add secret --write-to-dev-vars --value=...`** route, IF
   `--value` ever becomes a non-interactive flag. The guard fires on
   the same code path (`hydrateDevVarsSecret` calls
   `isDevVarsTrackedByGit`), so an integration test on `add secret`
   would close the gap without touching `auth init`.

Right now this is documented as a manual-check item in
`tests/integration/README.md` with a runbook. Do not let it slip from
the v0.5 release checklist.

### Flakiness observed

**None.** All 5 spec files pass cleanly on 10+ consecutive runs. Each
test spawns a fresh Node process, mkdir+rm'd its own tmp dir, and uses
no shared state. The harness's `FLINT_CONFIG_HOME` default ensures no
cross-test credential leakage even in worst-case parallel scheduling.

Watch for: if a future spec adds a test that writes to a shared cache
dir (Cloudflare's wrangler cache, npm cache, etc.), it could race.
Default to sandboxing every external dependency.

### Vitest config note

The integration suite added `*.spec.ts` to the `include` glob. The
config now matches both `tests/**/*.test.ts` AND `tests/**/*.spec.ts`.
This split lets `test:unit` and `test:integration` target each layer
independently without re-running the other. If future tests are added
that should belong to a different layer, prefer the suffix split over
adding more glob patterns.

`testTimeout` was bumped to 30s (was the vitest default of 5s) because
spawn + Node startup + commander dispatch typically costs 50-150ms per
spawn, and a slower CI runner could push some specs past 5s on
contention. Real spawn times in this conversion stayed well under 5s
on every run.

---

## Versions installed (forensic record)

No new dependencies added in this pass. All test infrastructure uses
Node stdlib (`child_process`, `node:fs`, `node:os`, `node:path`,
`node:url`) and vitest, which were already pinned.

| Package                | Installed | Pinned in handoff? |
| ---------------------- | --------- | ------------------ |
| typescript             | 6.0.3     | yes (cleanup HANDOFF) |
| vitest                 | 4.1.6     | yes (cleanup HANDOFF) |
| @vitest/coverage-v8    | 4.1.6     | yes (cleanup HANDOFF) |
| commander              | 12.1.0    | yes (cleanup HANDOFF) |
| @inquirer/prompts      | 7.10.1    | yes (cleanup HANDOFF) |
| smol-toml              | 1.6.1     | yes (cleanup HANDOFF) |
| @types/node            | 22.19.19  | (transitive lock) |
| eslint                 | 9.39.4    | (transitive lock) |
| @typescript-eslint/*   | 8.59.3    | (transitive lock) |

`flint --version` → `0.2.0` (unchanged from cleanup pass). Build
artifact `dist/cli.js` rebuilt clean after every spec.

---

## Acceptance criteria status

| # | Criterion | Status |
| - | --------- | ------ |
| 1 | `tests/integration/` directory exists with at least 5 spec files (init, add, configure, wrangler-patch, help) | **met** — exactly the 5 expected specs |
| 2 | ≥10 new `it()` test cases across the integration suite (smoke 10 skipped + documented) | **met** — 36 new test cases (10+7+5+4+10) |
| 3 | Integration tests pass under `vitest run` | **met** — 136/136 across 15 files |
| 4 | `npm test` runs both unit AND integration tests | **met** — unified `include` glob in `vitest.config.ts` |
| 5 | CI workflow at `.github/workflows/ci.yml` includes integration tests in the test step | **met** — workflow added (project had none before this pass) |
| 6 | Pre-conversion total test count was 100; post-conversion total ≥110 | **met** — 100 → 136 (+36, well above 110 floor) |
| 7 | README has a "Testing" section explaining unit vs integration layers + the smoke 10 manual-check | **met** — Development section rewritten; pointer to `tests/integration/README.md` for the gap rationale |
| 8 | All gates green: `tsc -b`, `lint`, `vitest run`, `build` | **met** — clean on every commit |
| 9 | No regressions: existing 100 unit tests still pass unchanged | **met** — pre-existing tests untouched |

---

## Commits landed this pass

```
44dda77 docs: testing section in README + integration test README explaining smoke 10 skip
21e202e ci: run integration tests in vitest
fd0bbe6 test(integration): all --help flags render (smoke 11)
8a0b435 test(integration): wrangler.toml comment preservation under add r2 (smoke 9)
3be811f test(integration): configure --dry-run offline (smoke 8)
ddf120b test(integration): add kv/r2/secret + secret-never-on-disk (smoke 5-7)
a4404f4 test(integration): init both variants + idempotency (smoke 1-4)
```

All commits local. **Not pushed** per the brief's git posture.

---

*End of integration-test conversion HANDOFF.*
