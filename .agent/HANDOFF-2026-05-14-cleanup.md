# Cadence v0.3 + Flint v0.2 — Smoke Cleanup Handoff (2026-05-14)

Tightening pass following the 2026-05-14 smoke run. Fixed every P2
finding the smoke report surfaced (P1 explicitly deferred to v0.5).
Cross-project handoff intentionally mirrored to both repos.

---

## Cleanup summary

- **Fixes applied:** 4 of 5 (#1 audit-list catalog, #2 stub message,
  #4 dry-run offline, #5 version bump). Plus #3 documented as a
  deliberate skip via in-code design-decision comment.
- **Skipped:** 1 (#3 standards `.` alias) — comment-only commit
  recording the canonical-delimiter decision.
- **Time elapsed:** ~25 minutes wall.
- **Final test counts:**
  - Cadence: 85 (was 84, +1 catalog-discovery test)
  - Flint: 100 (was 98, +2 dry-run network-skip tests)
- **Gates:** lint / tsc -b / vitest run / build all green on both repos.

---

## Fixes applied

### Cadence #1 — `audit --list` surfaces the bundled catalog

- **File:** `src/commands/audit.ts`, `tests/audit.test.ts`
- **Commit:** `cbff723` (cadence)
- **What changed:**
  - `runAuditList()` return shape went from `AuditDescriptor[]` to a new
    `AuditListResult = { enabled, catalog }`. Two new exported types
    (`AuditCatalogEntry`, `AuditListResult`).
  - New private helper `discoverCatalog(enabled)` walks
    `templates/audits/` and flags every entry with `scaffolded: boolean`
    so the renderer can split scaffolded vs addable in one pass.
  - Renderer prints two sections by default: "Enabled (scaffolded) — N"
    and "Available (catalog) — M", with a "Run: cadence audit --type ..."
    hint under the first and "Add: cadence add audit <name>" under the
    second. Empty-catalog and empty-enabled branches both handled.
  - `--json` now emits the full `{ enabled, catalog }` envelope.
  - Test coverage extended: catalog count > enabled count, three known
    catalog entries (`backend`, `frontend`, `security`) are listed, and
    the `scaffolded` flag correctly tracks pre-merge (true) vs backend
    (false).
- **Why:** smoke tester had no in-CLI way to discover what audits could
  be scaffolded; the 15-audit catalog was invisible without reading the
  README. Default-shows-both eliminates the discovery gap without
  introducing a new flag.
- **Gates:** lint clean, tsc clean, vitest 85/85, build clean.

### Cadence #2 — `audit --type` stub message updated for v0.5

- **File:** `src/commands/audit.ts`
- **Commit:** `e504ce2` (cadence)
- **What changed:** Stub banner copy. `⚠ v0.1 stub` → `⚠ stub`, body
  text "ships in v0.3" → "is coming in v0.5 — for now this returns the
  loaded instruction stub". Forward-looking text now correctly points
  at v0.5 (where the executor lands per the v0.3 handoff).
- **Why:** the version reference in the message was stale — we're
  already in v0.3, so the line was confusing rather than informative.
- **Gates:** lint clean, tsc clean, vitest 85/85, build clean.

### Cadence #3 — Standards delimiter decision (SKIPPED with comment)

- **File:** `src/commands/add.ts`
- **Commit:** `ae7fede` (cadence)
- **What changed:** Block comment in `addStandard()` recording the
  canonical-`/` decision plus the alternative considered (`.` alias).
  No behavior change.
- **Why skipped:** the existing error message ("must be `<scope>/<area>`
  ... Got `backend.architecture`") is already actionable, and keeping a
  single canonical delimiter form keeps the error/help surface
  predictable. Cheaper to fix the brief than the code.
- **Gates:** lint clean, tsc clean, vitest 85/85.

### Flint #4 — `configure --dry-run` is now offline

- **File:** `src/commands/configure.ts`, `tests/commands/configure.test.ts`
- **Commit:** `c144f34` (flint)
- **What changed:**
  - In `runConfigure()`, the unconditional `await verifyTokenOrExit(creds)`
    is now gated on `!opts.dryRun`. When `--dry-run` is set, a dim
    banner notes the skip and pre-flight proceeds without a network call.
  - Token must still be PRESENT (env / file / `.dev.vars`) — otherwise
    `loadCredentialsOrExit` exits 2 before dry-run has a chance to run.
    This preserves "the user has something to dry-run with" while
    allowing fully offline / CI use.
  - Downstream `listPagesProjects` / `listKvNamespaces` / `listR2Buckets`
    calls inside the resource-config helpers already had try/catch with
    a "could not list" warning, so a fully offline dry-run produces
    plan-only output without crashing.
  - New test file `configure.test.ts` (2 tests):
    1. `--dry-run: true` + token via env vars + all `skip*` flags →
       fetch is never called.
    2. Counter-test: `--dry-run: false` → fetch IS called exactly once,
       URL contains `/user/tokens/verify` (proves the guard didn't
       over-tighten).
- **Why:** the smoke test couldn't reach the planning stage even with
  dummy credentials — verify aborted first. With the guard in place,
  dry-run is genuinely CI-friendly.
- **Gates:** lint clean, tsc clean, vitest 100/100, build clean.

### Flint #5 — Version bumped to 0.2.0

- **File:** `package.json`, `package-lock.json`
- **Commit:** `ef39641` (flint)
- **What changed:** `package.json` `"version": "0.1.0"` → `"0.2.0"`,
  `npm install` regenerated the lockfile (only the embedded version
  field shifted — zero dep churn).
- **Why:** v0.2 had shipped functionally (configure orchestrator,
  add subcommands, wrangler.toml writeback) but `flint --version`
  still reported `0.1.0`. Aligns the version metadata with reality
  before any tag / publish.
- **Gates:** lint clean, tsc clean, vitest 100/100, build clean.

---

## Decisions taken

### Fix #1 — `audit --list` default behavior

**Chosen:** default prints BOTH "Enabled (scaffolded)" and "Available
(catalog)" sections. The `AuditListResult` shape is a structured object
in JSON mode.

**Alternative considered:** add a `--catalog` (or `--available`) flag
that toggles between enabled-only (default) and catalog-only views.
Rejected because:
- The smoke tester's first instinct — and the brief's framing — was
  "show me what's available." Single command, single output, no flag
  to remember.
- Adding `--catalog` later as a *filter* (catalog-only) is a non-
  breaking addition if it turns out users want it. The path is open.

The chosen behavior costs ~30 extra lines of code (the
`discoverCatalog` helper + two-section renderer) versus a one-flag
toggle. Worth it — discovery UX is the load-bearing concern here.

### Fix #3 — `.` delimiter for standards (skip)

**Chosen:** leave the canonical-`/` behavior unchanged. Added an
in-code comment in `addStandard()` explaining the decision and the
rejected alternative (accept both delimiters with normalization).

**Rationale:** the current error message is already actionable.
Accepting both delimiters adds a small ongoing tax (every help-text
example becomes a choice, every grep across the codebase needs to
allow both forms). One canonical form is cheaper. The brief's
recommendation was also to skip; doing so explicitly with a comment
captures the reasoning so the next maintainer doesn't re-litigate.

---

## Notes for the next agent

### Things surfaced during cleanup

- **`runAuditList` shape is now a public type contract.** External
  consumers (custom scripts, `index.ts` re-exports) that destructure
  `AuditDescriptor[]` from the previous return shape will need to switch
  to `{ enabled, catalog }`. The new shape is well-typed and exported
  from `src/commands/audit.ts`. No internal callers were impacted.
- **`configure-helpers.test.ts` and `configure.test.ts` are siblings.**
  Helpers covers the pure functions (id parsing, list endpoints); the
  new file covers the network-skip guard. Keep the split — helpers
  tests don't need to mock-throw fetch, the integration tests do.
- **Cadence stub message is now version-agnostic on the leading label
  (`⚠ stub:`) but version-specific in the body ("coming in v0.5").**
  When v0.5 ships, the body should change once more — keep the label
  drop-in.

### Cautions for the integration-test conversion milestone (next up)

- The `configure.test.ts` file I added is integration-flavored (drives
  `runConfigure` end-to-end with all stages skipped). It's a *useful*
  template for the integration-test conversion: tmp-home + tmp-repo +
  `setupTempHome()` + `vi.spyOn(globalThis, 'fetch')`. Reuse the
  pattern rather than rolling a new one.
- The `process.chdir(tmpRepo)` inside `beforeEach` works because
  `runConfigure` reads `process.cwd()` directly. If the conversion
  moves to injecting `cwd` explicitly, this test will need to update
  alongside.
- Cadence has no equivalent integration harness yet — its tests are all
  unit-scoped, exercising the programmatic API from `src/index.ts`.
  When the conversion lands a CLI-spawn integration layer for cadence
  too, the new `audit --list` catalog branch deserves an integration
  smoke check.

### v0.5 carryovers (unchanged from previous handoff)

- **YAML library swap** (`yaml-mini.ts` → `yaml` by Eemeli Aro). Blocks
  the P1 finding from the smoke report (`knowledge refresh` losing all
  but the first service when a `command: >` block-scalar appears).
- **Audit executor.** `runAuditType` still emits a stub. The new
  message tells the user this — see fix #2.

---

## Versions installed (forensic record)

### Cadence (post-cleanup)

| Package                | Installed |
| ---------------------- | --------- |
| typescript             | 6.0.3     |
| vitest                 | 4.1.6     |
| commander              | 12.1.0    |
| kleur                  | 4.1.5     |
| @inquirer/prompts      | 7.10.1    |
| @types/node            | 22.19.19  |

`cadence --version` → 0.3.0 (unchanged this pass).

### Flint (post-cleanup)

| Package                | Installed |
| ---------------------- | --------- |
| typescript             | 6.0.3     |
| vitest                 | 4.1.6     |
| @vitest/coverage-v8    | 4.1.6     |
| commander              | 12.1.0    |
| @inquirer/prompts      | 7.10.1    |
| smol-toml              | 1.6.1     |

`flint --version` → 0.2.0 (was 0.1.0; bumped by fix #5).

All versions match the pins from the v0.2 / v0.3 handoffs. No new
deps added; no version downgrades. `npm install` after the version
bump touched only the lockfile's embedded version field.

---

## Acceptance criteria status

| # | Criterion | Status |
| - | --------- | ------ |
| 1 | Cadence `audit --list` shows the available 15-audit catalog alongside scaffolded entries | **met** (default behavior; commit `cbff723`) |
| 2 | Cadence `audit --type <name>` stub message updated to reference v0.5 (no more "ships in v0.3") | **met** (commit `e504ce2`) |
| 3 | (Optional) Cadence `add standard` accepts both `.` and `/` delimiters, OR a code comment documents the canonical-delimiter decision | **met — skip path** (comment in `add.ts`; commit `ae7fede`) |
| 4 | Flint `configure --dry-run` doesn't hit the network (no token verify call); test confirms | **met** (2 tests; commit `c144f34`) |
| 5 | Flint `package.json` version reads `0.2.0`; lockfile regenerated cleanly if needed | **met** (commit `ef39641`) |
| 6 | All gates pass on both repos: `tsc -b`, `lint`, `vitest run`, `build` | **met** (cadence 85/85, flint 100/100) |
| 7 | Cross-project HANDOFF written to both `.agent/` directories | **met** (this file mirrored in cadence + flint) |
| 8 | No regressions: pre-cleanup test counts (cadence 84, flint 98) hold or improve | **met** (cadence 85, flint 100 — all pre-existing tests still pass) |

---

## Updated smoke status

The 5 P2 findings in `.agent/SMOKE-2026-05-14.md`:

| Smoke finding (P2) | Status |
| ------------------ | ------ |
| `cadence audit --list` doesn't surface the catalog | **resolved** (fix #1, commit `cbff723`) |
| Stub message references future version ("ships in v0.3") | **resolved** (fix #2, commit `e504ce2`) |
| `cadence add standard` rejects `.` delimiter (brief mismatch) | **skipped with comment** (fix #3, commit `ae7fede`) |
| Flint `configure --dry-run` requires live Cloudflare API for token verify | **resolved** (fix #4, commit `c144f34`) |
| Flint v0.2 `package.json` still reads `version: 0.1.0` | **resolved** (fix #5, commit `ef39641`) |

P1 finding (`cadence knowledge refresh` YAML parser limitations on
block scalars) explicitly **deferred to v0.5**, paired with the planned
`yaml-mini.ts` → `yaml` (Eemeli Aro) library swap.

---

## Commits landed this pass

### Cadence (`~/dev/public/cadence`)

```
ae7fede docs(add): record canonical-delimiter decision for standards (skip dot-alias)
e504ce2 fix(cli): update audit --type stub message to reference v0.5 executor
cbff723 fix(cli): audit --list surfaces catalog alongside scaffolded entries
```

### Flint (`~/dev/public/flint`)

```
ef39641 chore: bump version to 0.2.0
c144f34 fix(configure): skip token verify call under --dry-run
```

All commits local. **Not pushed** per the brief's git posture.

---

*End of cleanup HANDOFF.*
