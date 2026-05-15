# Integration tests

These suites spawn the **real built `flint` binary** (`dist/cli.js`) against
isolated tmp-dir targets and assert on filesystem state, stdout/stderr, and
exit codes. They run on every commit alongside the unit tests under
`vitest run`.

## Why a separate layer

The unit tests under `tests/commands/`, `tests/cloudflare/`, etc. import the
command modules directly and exercise the programmatic API. That's fast and
the right place to cover branching logic — but it bypasses:

- the `cli.ts` commander dispatch + `parseAsync` error handling
- the ESM `import.meta.url` entry-point guard
- the `bin` shebang + symlink resolution path
- the `templates/` resolution from `dist/commands/init.js`

The 2026-05-14 cross-project smoke run caught a P0 in the sibling Cadence
project where the global-bin symlink silently no-op'd because of a missing
realpath resolution. Flint doesn't have that exact bug, but the **class** of
bug (CLI-entry / binary-layout) is invisible to direct-import unit tests.
These integration tests close that gap.

## Mapping to the smoke checklist

Each spec file's `it()` blocks map 1:1 to a step in `.agent/SMOKE-2026-05-14.md`
so the integration suite IS the smoke checklist, automated:

| Spec file              | Smoke steps covered |
| ---------------------- | ------------------- |
| `init.spec.ts`         | 1, 2, 3, 4          |
| `add.spec.ts`          | 5, 6, 7             |
| `configure.spec.ts`    | 8                   |
| `wrangler-patch.spec.ts` | 9                 |
| `help.spec.ts`         | 11                  |

## Smoke step 10 (`.dev.vars` git-tracked hard-block) — MANUAL ONLY

Smoke step 10 verifies that `flint auth init` refuses to write `.dev.vars`
when the file is already tracked by git. This guard is implemented at
`src/cloudflare/dev-vars.ts:ensureGitignored` and the `DevVarsTrackedError`
fires before any disk write.

**It cannot be driven from a non-interactive test harness** because
`flint auth init` is fully interactive: it prompts for the token paste
BEFORE reaching the disk-write where the guard fires. Without a real TTY OR
a fake-bin override for the inquirer prompts, the hard-block code path is
unreachable.

**Options considered for closing this gap:**

1. **`expect`-style TTY automation (e.g. `node-pty`)** — adds a heavyweight
   test dependency for one assertion. Rejected.
2. **Fake `@inquirer/prompts` via module mocking inside a spawned child** —
   would require shipping a test-only bin variant. Rejected; conflates test
   harness with production code.
3. **Move the guard up the call stack so it fires before the token prompt**
   — would change the UX (refusing to start the flow before the user even
   sees the prompt for what to paste). Out of scope for the v0.2.1 patch.

**Where the guard IS tested:**

- Unit coverage of `isDevVarsTrackedByGit` and `ensureGitignored` lives in
  `tests/cloudflare/dev-vars.test.ts`. Those tests prove the guard function
  itself works as designed.
- The `flint add secret --write-to-dev-vars` path calls the same guard
  (`hydrateDevVarsSecret` in `src/commands/add.ts`) and would be a
  promising integration-test surface for the guard if `--value` ever
  becomes a non-interactive flag. Tracked as a future enhancement.

**Manual-check runbook (for release smoke):**

```bash
# Inside a real git repo with `.dev.vars` tracked:
cd /tmp/flint-tracked-test
git init && echo "TEST=1" > .dev.vars && git add .dev.vars && git commit -m "leak"
flint auth init   # interactive — paste any value
# EXPECT: "Refusing to write secrets — .dev.vars is tracked by git."
# EXPECT: exit code != 0
```

This is part of the v0.5 release smoke checklist; do not regress.

## Harness pattern

Each spec uses the helpers in `_harness.ts`:

- `runFlint(args, opts)` — spawns `node dist/cli.js <args>` and returns
  `{ stdout, stderr, status }`. Never throws; tests assert on `status`.
- `createTempRepo({ seedPackageJson })` — mkdtemp + optional seed
  `package.json`. Returns `{ dir, cleanup }`.
- `readRepoFile(repo, rel)` / `writeRepoFile(repo, rel, str)` — sugar.

All tests share these conventions:

- **`FLINT_CONFIG_HOME` is always set to a sandbox path.** The harness
  defaults it to a per-process scratch dir so the developer's real
  credentials never participate.
- **`NO_COLOR=1` is forced** so substring assertions against stdout don't
  break on ANSI escapes.
- **Tmp dirs are cleaned up in `afterEach`**, even on test failure.
- **No global `npm link`** — all tests point at the in-repo `dist/cli.js`.

## Adding a new integration test

1. Pick the right spec file (or create a new one for a new surface area).
2. In `beforeAll`, do nothing — `dist/cli.js` is built once per CI run via
   `npm test` (which depends on `prepare`). Locally, run `npm run build`
   first.
3. In `beforeEach`, create your tmp repo.
4. Spawn `flint` with `runFlint(...)`, supplying `cwd: repo.dir`.
5. Assert on `status`, then on filesystem state and/or stdout/stderr.
6. Clean up in `afterEach`.

Keep timeouts conservative — flint's commands return in <1s. If a test
needs more than 5s, that's a signal something is wrong.
