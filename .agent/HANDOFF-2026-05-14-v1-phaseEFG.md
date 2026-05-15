# Flint v1.0 — Phases E + F + G Handoff (2026-05-14)

**v1.0 milestone complete.** Phases E (Windows audit), F (Astro docs site
with Cadence dogfood), and G (error message polish, CHANGELOG, version
bump) all landed. Version bumped from **0.9.0 → 1.0.0**. `private: true`
removed from `package.json`.

All gates green: `npm run build`, `npm run lint`, `npm run typecheck`,
`npm test` (354 passing + 1 skipped on Linux, ~21s). Docs site builds
cleanly (`docs-site/`, 11 pages, ~3s).

**Not pushed. Not published.** Per standing rules. Beau runs `npm publish`
and the GitHub tag per `docs/release-1.0-checklist.md`.

---

## Completed in this run

### Phase E — Windows compatibility audit

Five categories of fixes landed; one explicitly documented as deferred.

**1. Manifest path separators (POSIX-clean across hosts).**

`src/commands/init.ts` and `src/commands/create-app.ts` `walk()` helpers
now build relative paths with hardcoded `/` instead of `path.join`. The
manifest contract has always been "POSIX separators" (see
`src/util/manifest-tracker.ts:51`) but on Windows `path.join('a','b')`
returns `a\b`, which:

- Broke `.startsWith('.github/')` glob filters (so `--no-ci` would not
  filter the workflow file on Windows).
- Would have produced manifest files with backslash-keyed entries,
  causing drift between Windows + POSIX contributors on the same repo.

`src/commands/upgrade.ts` was already POSIX-clean (uses
`.split(/[\\/]/).join('/')` normalization), so the same project will read
correctly from a manifest produced on either host.

**2. Editor merge tempfile.**

`src/commands/upgrade.ts:openEditorMerge()` previously used
`process.env.TMPDIR ?? '/tmp'` — Windows uses `%TEMP%`/`%TMP%`. Switched
to `os.tmpdir()` which is the cross-platform answer.

**3. Editor fallback (POSIX `vi` → Windows `notepad`).**

Same function: `process.env.EDITOR ?? process.env.VISUAL ?? 'vi'` would
fail on Windows where `vi` doesn't exist. Platform-aware fallback now
picks `notepad` on Windows (`process.platform === 'win32'`), `vi`
elsewhere. Notepad has understood `\n` line endings since the Windows 10
May 2018 Update.

**4. Package-manager `.cmd` shim resolution on Windows.**

Node's `spawnSync` without `shell: true` does NOT auto-resolve a bare
`npm` to `npm.cmd` on Windows. (`.exe` does auto-resolve via PATHEXT, but
npm-installed shims are `.cmd`, not `.exe`.) Fixed in:

- `src/util/package-manager.ts`: new `resolvePackageManagerBin()` helper.
  `installCommand()`, `runScriptCommand()`, `execCommand()`,
  `probePackageManagerVersion()` all use it. Returns `npm.cmd` etc. on
  Windows, bare names on POSIX.
- `src/cloudflare/wrangler-runner.ts:resolveWranglerBin()`: probes
  `wrangler.cmd` (then `wrangler.ps1`) in `node_modules/.bin/` on Windows;
  falls back to `wrangler.cmd` from PATH. POSIX path unchanged.
- `src/commands/deploy.ts`: new `npmBin()` / `npxBin()` helpers; previously
  hardcoded `'npm'` and `'npx'`.
- `src/commands/add-features.ts:detectPackageManager()`: appends `.cmd`
  on Windows.

We deliberately avoid `shell: true` to keep glob/quoting hazards out of
the spawn surface.

**5. spawn audit.**

Every `spawnSync` / `spawn` call in `src/**/*.ts` was inspected. All use
the array form (no shell interpretation). No `shell: true` anywhere. `git`
spawns are fine on Windows (`.exe` auto-resolves via PATHEXT). The only
shims that needed Windows-specific resolution are the npm-family + wrangler
(handled above). `browser.ts` and `clipboard.ts` already had Windows
branches.

**Tests updated:**

- `tests/util/package-manager.test.ts`: `installCommand` / `runScriptCommand` /
  `execCommand` tests now assert platform-resolved bins via a small
  `X = process.platform === 'win32' ? '.cmd' : ''` constant. On Linux/macOS,
  unchanged expected values; on Windows-native they would assert `.cmd`.
- `tests/cloudflare/wrangler-runner.test.ts`: existing
  "finds node_modules/.bin/wrangler in cwd" test now POSIX-only
  (`it.skipIf(process.platform === 'win32')`); new Windows-only sibling test
  for `.cmd` probe. "Falls back to bare wrangler" test asserts the right
  bin per platform. The 1 skipped test on Linux runs is the new
  Windows-only sibling.
- `tests/cloudflare/wrangler-toml.test.ts`: regex relaxed in
  "throws a clear error when binding does not exist" test (was `/No \[\[…/`,
  now `/\[\[…/` — accommodates the canonicalized error message shape).
- `tests/integration/deploy.spec.ts`: regex updated in
  "--rollback prints an error when wrangler list exits non-zero" test
  (was `/wrangler.*status 1/i`, now `/wrangler.*exited 1/i` — matches new
  error message).
- `tests/integration/help.spec.ts`: `smoke 11` version assertion now `1.0.0`.

**Compatibility doc rewrite:**

`docs/compatibility.md` got a full "Windows-native audit (v1.0)" section
listing the five fixes above plus the explicit "known limitations" list:

- Deploy / auth init not validated on Windows-native (WSL2/Linux/macOS only).
- keytar opt-in is untested on Windows but should work if keytar is installed independently.
- Fake-bin test harness is POSIX-only (skipped on Windows).
- CI matrix does not include `windows-latest` (defer to v1.1).

Plus a "Quick Windows-native verification" walkthrough.

**Out of scope for E (per brief, confirmed deferred):**

- Adding `windows-latest` to the CI matrix.
- Rewriting keytar integration to use Windows Credential Manager directly.
- Actually testing on a Windows-native host (no Windows machine available).

### Phase F — Astro Starlight docs site at `docs-site/`

**Scaffold:**

- `docs-site/package.json` — pins `astro@6.3.3`, `@astrojs/starlight@0.39.2`,
  `sharp@^0.34.0`. `engines.node: ">=22.12.0"` (Astro 6 requires Node 22+;
  Flint itself still supports Node 20+, so docs-site is a separate Node
  requirement that only matters at docs-build time).
- `docs-site/astro.config.mjs` — Starlight integration with `site:
  https://flint.op4z.dev`, GitHub social link, three-section sidebar (Start
  here / Guides / Contributing).
- `docs-site/src/content.config.ts` — Astro 6 / Starlight 0.39 requires
  an explicit content collection config; uses Starlight's `docsLoader` +
  `docsSchema` helpers.
- `docs-site/tsconfig.json` — extends `astro/tsconfigs/strict`.
- `docs-site/.gitignore` — covers `dist/`, `.astro/`, `node_modules/`, env files.
- `docs-site/wrangler.toml` — pre-configured Cloudflare Pages output dir.
  NOT deployed by this run; Beau deploys at publish time.

**Content pages (10 total + 1 index):**

| Path | Source | Notes |
| --- | --- | --- |
| `index.mdx` | NEW | Splash hero + 4-card overview + install snippet |
| `start/getting-started.md` | NEW | 5-min install + scaffold + deploy walkthrough |
| `start/commands.md` | NEW | Every command + flag, with regenerate-from-`--help` instructions |
| `start/templates.md` | NEW | 3-variant comparison table + custom-template contract |
| `guides/migration-from-0x.md` | NEW | Pre-0.9 → 1.0 upgrade path (also `docs/migration-from-0.x.md` at repo root) |
| `guides/compatibility.md` | port of `docs/compatibility.md` | + Starlight frontmatter |
| `guides/deploy-environments.md` | port of `docs/deploy-environments.md` | + Starlight frontmatter |
| `guides/programmatic-api.md` | port of `docs/programmatic-api.md` | + Starlight frontmatter |
| `guides/telemetry-transparency.md` | port of `docs/telemetry-transparency.md` | + Starlight frontmatter |
| `contributing/contributing.md` | port of `CONTRIBUTING.md` | + Starlight frontmatter |

**Build verification:** `cd docs-site && npm install && npm run build`
produces 11 pages in ~3s. Pagefind index built (Starlight's built-in
search). Sitemap emitted.

**Cadence dogfooding:** SUCCEEDED. `node ~/dev/public/cadence/packages/cadence/dist/cli.js init --name flint-docs-site --short-code FDOC --stack typescript --quiet`
ran cleanly inside `docs-site/`. Produced:

- `docs-site/cadence.config.json` with `version: 1.0.0`, stacks: `["typescript"]`
- `docs-site/auto/` directory tree with audits/standards/instructions scaffolded
- 4 audit instruction files (`audit-dead-code.md`, `audit-dependencies.md`,
  `audit-pre-merge.md`)

No bugs surfaced in Cadence during dogfood. The dogfood is purely informational
for now — the docs site doesn't run audits on its own content. But the framework
is in place for future use.

**ESLint scope:** added `docs-site/**` to the root `eslint.config.js`
`ignores` list. Without this, ESLint chokes on Astro's bundled JS that
references `window`/`document` globals.

**Out of scope for F (per brief, confirmed deferred):**

- Actually deploying the docs site to Cloudflare Pages.
- Custom theming beyond Starlight defaults.
- Search infrastructure (Starlight ships Pagefind out of the box).

### Phase G — Error message review + release prep + version bump

**1. Error message standardization.**

Every `throw new Error(...)` and `log.err(...)` in `src/` was reviewed and
rewritten to follow the canonical shape:

```
[flint] <subsystem>: <what happened> — <actionable next step>
```

Files touched (rewrites only; no behavior changes):

- `src/commands/init.ts` — 4 rewrites
- `src/commands/create-app.ts` — 5 rewrites
- `src/commands/add-features.ts` — 3 rewrites
- `src/commands/add.ts` — 4 rewrites
- `src/commands/auth.ts` — 11 rewrites
- `src/commands/configure.ts` — 7 rewrites
- `src/commands/deploy.ts` — 9 rewrites
- `src/commands/doctor.ts` — 1 rewrite
- `src/commands/uninstall.ts` — 2 rewrites
- `src/commands/upgrade.ts` — 2 rewrites
- `src/cloudflare/api.ts` — 6 rewrites
- `src/cloudflare/wrangler-toml.ts` — 3 rewrites
- `src/util/template.ts` — 1 rewrite
- `src/util/template-url.ts` — 5 rewrites
- `src/index.ts` — 1 minor (period-to-dash)

Pre-existing canonical messages in `src/commands/telemetry.ts`,
`src/commands/uninstall.ts:52`, `src/commands/config.ts:40`, `src/commands/deploy.ts:94/106/115`,
`src/util/package-manager.ts:155`, `src/cloudflare/dev-vars.ts:42` were
LEFT as-is (already correct).

**2. `docs/error-messages.md`.**

Documents the shape, the contributor checklist, and 5 before/after examples.

**3. `docs/release-1.0-checklist.md`.**

15-step publish checklist covering: gates green, three-app cross-check
(Portfolio/Chorus/Blaze), Node 20/22/24 smoke, CHANGELOG review,
`npm pack --dry-run`, `npm publish --dry-run`, doctor on clean checkout,
`npm publish`, npm verification, git tag, GitHub release, install verification,
announcement, monitoring window, and rollback procedure. Beau runs this.

**4. `CHANGELOG.md`.**

Created at repo root. Keep-a-Changelog format. Sections:
- `[1.0.0]` — 2026-05-14, with Added / Changed / Fixed / Removed / Documentation subsections covering every Phase A → G addition.
- `[0.9.0]`, `[0.5.0]`, `[0.2.0]`, `[0.1.0]` — brief historical entries (not published).

**5. `docs/migration-from-0.x.md`.**

States explicitly that **0.9 → 1.0 has zero breaking changes**. Covers
the 0.5–0.8 → 1.0 migration (manifest schema introduction, requires
`flint upgrade --check && flint upgrade --accept-current`). Also lives
in the docs site at `guides/migration-from-0x.md`.

**6. `package.json` version bump.**

- `"version": "0.9.0"` → `"version": "1.0.0"`
- `"private": true` removed entirely (line deleted, not flipped to false).

This is the LAST irreversible step before publish. Verified via grep:

```
grep '"version"' package.json   # → "version": "1.0.0",
grep '"private"' package.json   # → (no output)
```

**7. `README.md` update.**

- Status line: "v0.9 (upgrade + add subcommands + telemetry first ship)"
  → "v1.0 — first stable release. Manifest schema, CLI surface, and
  programmatic API are frozen."
- "Install (v0.1: local only)" section replaced with canonical
  `npm install -g @op4z/flint` / `npx @op4z/flint create-app …` block.
- "Token storage model": removed "OS keychain storage is NOT supported in v0.1"
  language; documented the v0.9 `--keychain` opt-in flag.
- "Current limitations": removed obsolete items (npm publish, Windows
  compat, real telemetry endpoint). Kept the deliberate ones (custom domain,
  edge-content extraction, Windows-native deploy).
- "Roadmap" renamed to "Release history"; v1.0.0 row added; the "Asset
  budget guard shipped in v0.5 (moved up from v0.9)" addendum removed
  since it's historical noise post-1.0.

The doc-internal version markers like "_(v0.5)_" and "_(v0.2)_" inside
the "What Flint ships today" surfaces list are intentionally kept — they
describe *when each surface was introduced*, which is still useful context.

**8. Final gates.**

```
npm run build      ✓
npm run lint       ✓
npm run typecheck  ✓
npm test           ✓ — 354 passed | 1 skipped (Windows-only test)
docs-site build    ✓ — 11 pages in ~3s
```

**Out of scope for G (per brief, confirmed deferred to Beau):**

- Running `npm publish`. Documented in `docs/release-1.0-checklist.md`.
- Pushing to GitHub. Same.
- Tagging the git release. Same.

---

## Files changed (full list)

### Source code (Phase E + G mixed)

| Path | Reason | Phases |
| --- | --- | --- |
| `src/commands/init.ts` | POSIX path normalization in walk(); error messages | E + G |
| `src/commands/create-app.ts` | Same | E + G |
| `src/commands/upgrade.ts` | tmpdir(), notepad fallback; error messages | E + G |
| `src/commands/add-features.ts` | Windows .cmd in detectPackageManager(); error messages | E + G |
| `src/commands/add.ts` | Error messages only | G |
| `src/commands/auth.ts` | Error messages only | G |
| `src/commands/configure.ts` | Error messages only | G |
| `src/commands/deploy.ts` | npmBin()/npxBin() Windows helpers; error messages | E + G |
| `src/commands/doctor.ts` | Error message only | G |
| `src/commands/uninstall.ts` | Error messages only | G |
| `src/cloudflare/wrangler-runner.ts` | Windows `wrangler.cmd` probe; path.join | E |
| `src/cloudflare/wrangler-toml.ts` | Error messages only | G |
| `src/cloudflare/api.ts` | Error messages only | G |
| `src/util/package-manager.ts` | resolvePackageManagerBin() helper + Windows .cmd | E |
| `src/util/template-url.ts` | Error messages only | G |
| `src/util/template.ts` | Error message only | G |
| `src/index.ts` | One error message punctuation | G |

### Tests

| Path | Reason | Phases |
| --- | --- | --- |
| `tests/util/package-manager.test.ts` | Platform-resolved bin assertions | E |
| `tests/cloudflare/wrangler-runner.test.ts` | Windows skipIf + new Windows-only test | E |
| `tests/cloudflare/wrangler-toml.test.ts` | Regex relaxed for new error shape | E/G |
| `tests/integration/deploy.spec.ts` | Regex updated for new error shape | G |
| `tests/integration/help.spec.ts` | Version assertion 0.9.0 → 1.0.0 | G |

### Docs

| Path | Status |
| --- | --- |
| `docs/compatibility.md` | Updated with v1.0 Windows audit findings |
| `docs/error-messages.md` | NEW — error message contract |
| `docs/release-1.0-checklist.md` | NEW — publish checklist |
| `docs/migration-from-0.x.md` | NEW — pre-0.9 → 1.0 migration |
| `CHANGELOG.md` | NEW (at repo root) — Keep-a-Changelog format |
| `README.md` | Status / install / limitations sections refreshed |

### Docs site (entire `docs-site/` is new)

| Path | Status |
| --- | --- |
| `docs-site/package.json` | NEW |
| `docs-site/astro.config.mjs` | NEW |
| `docs-site/tsconfig.json` | NEW |
| `docs-site/.gitignore` | NEW |
| `docs-site/wrangler.toml` | NEW |
| `docs-site/src/content.config.ts` | NEW |
| `docs-site/src/content/docs/index.mdx` | NEW (splash) |
| `docs-site/src/content/docs/start/{getting-started,commands,templates}.md` | NEW (3 files) |
| `docs-site/src/content/docs/guides/{migration-from-0x,compatibility,deploy-environments,programmatic-api,telemetry-transparency}.md` | NEW + ported (5 files) |
| `docs-site/src/content/docs/contributing/contributing.md` | NEW (ported from `CONTRIBUTING.md`) |
| `docs-site/auto/` + `docs-site/cadence.config.json` | NEW (via `cadence init`) |

### Config

| Path | Status |
| --- | --- |
| `package.json` | version 0.9.0 → 1.0.0; `private: true` removed |
| `eslint.config.js` | Added `docs-site/**` to ignores |

---

## Test count growth

- Start of run: 354 passed, 0 skipped
- End of run: 354 passed, 1 skipped (Windows-only `resolveWranglerBin`
  test that runs on Windows-native and is skipped on Linux/macOS)

Net same number of "active" tests; +1 skipped test added for forensic
record. Brief did not ask for new test count growth in E/F/G beyond what
Phase A/B/C already added.

---

## Pending / next up

### Beau's responsibilities (post-handoff)

Per `docs/release-1.0-checklist.md`:

1. Review the commits + diffs (this handoff covers the why).
2. Run gates one more time on a clean checkout.
3. `npm publish --dry-run --access public` to verify the plan.
4. `npm publish --access public` to ship.
5. `git tag v1.0.0` + push.
6. GitHub release with CHANGELOG snippet.
7. Deploy `docs-site/dist/` to Cloudflare Pages → https://flint.op4z.dev.
8. Announce.
9. Watch for early bug reports.

### Optional v1.x candidates (not blocking publish)

- **Windows CI runner.** Add `windows-latest` to the GH Actions matrix.
  Doubles CI minutes; deferred to v1.1.
- **Auto-regenerating `start/commands.md` from `--help` output.** Currently
  hand-maintained. A small `scripts/regenerate-commands-doc.ts` would shell
  out to `node ./dist/cli.js <cmd> --help` for each subcommand and stamp
  the markdown. Mentioned in a tip-box on the page already.
- **Adoption-gap detection** (carried over from Phase C). When backfill
  classifies a project as `pages-fullstack` but the project is missing
  template files (e.g. `functions/_shared/ratelimit.ts`), surface them
  as "Flint can scaffold these for you" suggestions.
- **Add `windows-latest` smoke test.** Even one job that runs `init` +
  `add` + `configure --dry-run` on Windows-native would catch regressions
  fast.
- **Programmatic API integration tests on Node 20/22/24.** Currently only
  the CLI is matrix-tested.

---

## Open questions for the user

1. **Should `_flint-test/` working dirs from Phase C be deleted?** Phase C
   handoff recommended retaining; this run did not touch them. Decision:
   leave as-is unless Beau wants to clean up.

2. **Should the docs site deploy from CI on tag?** Currently it's a manual
   `cd docs-site && npm run build && wrangler pages deploy dist`. A GH
   Actions workflow tied to `v*` tags would automate. Not blocking 1.0;
   file as a v1.1 candidate.

3. **Should we add a `cadence audit` to the docs site as part of CI?**
   Cadence is dogfooded but its audits don't run on the docs content yet.
   Useful but not blocking; v1.1+ candidate.

---

## Notes for the next agent

### The version bump was the LAST thing

Per the brief's hard rule: don't bump until E + F are done and all gates
green. Followed exactly. Bumping created two test failures (the version
assertion in help.spec.ts and one regex test for an updated error message)
which were fixed immediately.

### "private: true" was removed, not flipped

The brief said "remove the field (or set to false)". I removed the line
entirely. npm treats absence as `private: false`, so this is equivalent
to the flip. Removal is the cleaner state for a published package.

### Error messages: I rewrote the shape, not the meaning

For every error message rewrite, the underlying check + control flow is
unchanged. Only the user-facing string was edited. So the only test
breakage was the two regex assertions that matched the old prose. Both
are now fixed to match the canonical shape's invariants (the subsystem
slug + key keyword) rather than the exact prose, which is less brittle.

### Astro Starlight version pinning

`astro@6.3.3` and `@astrojs/starlight@0.39.2` are pinned (not ^). Per
brief: "Verify dependency versions before pinning." Confirmed with
`npm view astro version` (6.3.3) and `npm view @astrojs/starlight version`
(0.39.2). Verified `@astrojs/starlight` peers `astro: ^6.0.0`, so they
match. Verified `astro` engines `node: '>=22.12.0'` — Flint itself stays
on Node 20+, but the docs-site is a separate package with its own Node
requirement that only matters at docs-build time. Beau (or CI) needs
Node 22+ to build the docs.

### Cadence dogfooding: clean success

`cadence init` worked first try inside `docs-site/`. No bugs surfaced.
The brief said "best effort"; this was effort well-spent. The
`docs-site/auto/` tree is committed (it's the standards/audit framework
that future maintainers can extend).

### `os.tmpdir()` matters more than it looks

The brief specifically mentioned this. It was tempting to skip — the
existing code "works" on Linux because `process.env.TMPDIR` is set to
`/tmp` on most distros. But Windows doesn't set TMPDIR; it uses
`TEMP`/`TMP`. `os.tmpdir()` is the cross-platform answer that Node ships
specifically for this case. One-line fix, large quality-of-life win.

### Windows audit: I didn't actually test on Windows

Per brief: "Actually testing on Windows" is explicitly out of scope. The
fixes are based on the well-known Node.js behaviors (`.cmd` shim
resolution, `path.join` separator), which means a Windows user should
have a much better experience than 0.9 would have given them. But the
end-to-end deploy/auth flows on Windows-native remain documented as
best-effort, not first-class.

### The `start/commands.md` page is hand-maintained

I noted this in a Starlight `:::tip[Regenerating this page]:::` directive
at the top. A future task: write `scripts/regenerate-commands-doc.ts`
that pulls `commander`'s help machinery directly via the programmatic API.
Estimated 50 LOC + ~30 min.

### eslint.config.js change is forensic

I added `docs-site/**` to the ignores. Without this, ESLint walked into
`docs-site/node_modules/astro/dist/runtime/client/...` and produced 1473
errors. Other approaches considered:

- Make `eslint.config.js` only lint `src/` + `tests/`. More restrictive;
  rejected because it could silently miss new top-level files.
- Add an `.eslintignore` file. Older config style; Flat config doesn't
  parse it.

The `docs-site/**` ignore is the right shape — `docs-site/` is a
separate package with its own lint expectations.

---

## Versions installed (forensic record)

### Flint (root)

No new dependencies in this run. From `package.json`:

| Package | Version |
| --- | --- |
| `typescript` | ^6.0.3 |
| `vitest` | ^4.1.6 |
| `commander` | ^12.1.0 |
| `@inquirer/prompts` | ^7.2.0 |
| `smol-toml` | ^1.6.1 |
| `@types/node` | ^22.10.0 |
| `eslint` | ^9.17.0 |

Resolved versions in `node_modules/`:

| Package | Version |
| --- | --- |
| `typescript` | 6.0.3 |
| `vitest` | 4.1.6 |
| `commander` | 12.1.0 |
| `@inquirer/prompts` | 7.10.1 |
| `smol-toml` | 1.6.1 |
| `@types/node` | 22.19.19 |
| `eslint` | 9.39.4 |

`flint --version` → **`1.0.0`**

### docs-site (new)

From `docs-site/package.json` (pinned):

| Package | Version |
| --- | --- |
| `astro` | 6.3.3 (pinned) |
| `@astrojs/starlight` | 0.39.2 (pinned) |
| `sharp` | ^0.34.0 |

After `npm install`: 346 packages total in `docs-site/node_modules/`.
Cadence was invoked from `~/dev/public/cadence/packages/cadence/dist/cli.js`
at version `1.0.0`.

---

## Acceptance criteria status

### Phase E

| Criterion | Status |
| --- | --- |
| Path-separator audit complete; findings + fixes documented | **met** (init.ts + create-app.ts walk() helpers) |
| Line-ending audit complete | **met** (all writes use `\n`; Git autocrlf handles Windows) |
| `spawnSync` audit complete (verify no shell-glob risk) | **met** (no `shell: true` anywhere; all calls use array form) |
| Windows `EDITOR` fallback in place | **met** (notepad on win32, vi on POSIX) |
| `docs/compatibility.md` updated with audit findings | **met** |

### Phase F

| Criterion | Status |
| --- | --- |
| `docs-site/` Astro Starlight scaffold builds cleanly | **met** (11 pages in 3s) |
| All required sections present | **met** (10 pages + 1 splash index) |
| Cadence dogfooding attempted | **met** — succeeded |
| `docs-site/wrangler.toml` configured (not deployed) | **met** |

### Phase G

| Criterion | Status |
| --- | --- |
| Every error message follows the documented shape | **met** |
| `docs/error-messages.md` documents the convention | **met** |
| `docs/release-1.0-checklist.md` documents the publish process | **met** |
| `CHANGELOG.md` exists at repo root with [1.0.0] entry | **met** |
| `docs/migration-from-0.x.md` exists | **met** |
| `package.json` version is `1.0.0` | **met** |
| `private: true` is removed | **met** (removed entirely) |
| `README.md` reflects v1.0 | **met** |

### Cross-cutting

| Criterion | Status |
| --- | --- |
| All gates green | **met** — build, lint, typecheck, test all pass |
| Test count growth documented (starting at 354) | **met** — 354 passed + 1 skipped (Windows-only) |
| v1.0 final HANDOFF written | **met** — see `.agent/HANDOFF-2026-05-14-v1.md` |

---

*End of Phase E/F/G HANDOFF.*
