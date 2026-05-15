---
action: pre-merge
command: audit
schema_version: 1
description: Diff-only fast gate. Audits files changed in the current branch and blocks regressions without re-auditing the whole codebase.
---

# Audit: Pre-Merge (Diff-Mode)

A short, sharp gate that runs in under 30 seconds and is meant to be wired
into your PR workflow (manual invocation, pre-push hook, or CI). It looks
**only** at files changed since the base branch and flags **only** issues
introduced by the current branch.

## When to run

- Before opening a pull request: `cadence audit --type pre-merge`
- As a pre-push git hook (see `Integration` below)
- As a required CI check on PR open / update

## Output

- Console summary (default — gate-mode, no persistent report)
- Optional `auto/audits/pre-merge/<branch>-YYYY-MM-DDTHHMM.md` when `--write-report` is passed

## Block 1: Pre-flight

- Verify `git` and `ripgrep` (or your project's equivalent grep) are on `PATH`.
- Determine `BASE_BRANCH` (default `main`; respect `--base <ref>`).
- Collect the changed-file list: `git diff --name-only --diff-filter=ACMR $BASE_BRANCH...HEAD`.
- If the list is empty, exit 0 with `No changes vs <base> — nothing to audit`.

## Block 2: Discovery

Bucket the changed files so downstream rules can scope quickly:

- Source files by language (python / typescript / go / ...)
- Test files (`*test*`, `*spec*`)
- Migration files (`*/migrations/*`, `*/db/migrate/*`)
- Configuration (`*.json`, `*.yaml`, `Dockerfile*`)
- Documentation (`*.md`)

## Block 3: Run Diff-Scoped Detectors

For every rule defined in your project's RULES registry whose detector is
content-pattern based (ripgrep / equivalent), restrict the search to the
intersection of the rule's path globs and the changed-file list.

**Cheap detectors run in pre-merge:** lint subset, simple greps, secret
scanning on the diff only.

**Expensive detectors deferred:** full test suite, full type-check, full
dependency CVE scan, bundle analyzers. These belong in the full audit.

## Block 4: Special Pre-Merge Checks

These are gates that don't fit the rule-registry shape:

1. **Tests added when code added** — if a non-test source file in a
   tested area changed, at least one test file should also be in the
   diff. Severity: medium.
2. **Migrations have downgrade** — any new migration file must have a
   non-empty downgrade / rollback section. Severity: high.
3. **No secrets in diff** — run a secrets scanner against the diff.
   Any finding: severity critical, gate fail.
4. **No new TODO without owner** — added `TODO` lines should include
   a name or task ID. Severity: low.
5. **Lockfile drift** — if `package.json` / `pyproject.toml` changed,
   the corresponding lockfile must be in the diff. Severity: medium.

## Block 5: Subtract Pre-Existing Findings

For each finding fired:

- Re-run the same detector against `$BASE_BRANCH` HEAD.
- If the finding already exists there, mark it `pre-existing, not blocking`.
- Otherwise it is `introduced by this branch` and counts toward the gate.

This is the critical move: pre-merge should only flag what *this PR*
adds. Pre-existing debt is the full-audit's job.

## Block 6: Score + Gate

- Score = 100 − Σ(severity × weight). Suggested weights: critical=20, high=8, medium=3, low=1.
- Gate: pass (≥ 90), conditional (≥ 75), fail (< 75).
- **Any introduced critical finding → fail.**
- **Any introduced high → conditional (requires explicit ack to merge).**

## Block 7: Console Output

```
=== Pre-Merge Audit ===
Branch:   feature/foo
Base:     main
Changed:  14 files
Runtime:  3.2s

Findings introduced by this branch:
  Critical: 0   High: 1   Medium: 2   Low: 4

[HIGH] SEC-001  Secret detected in source
  src/config/keys.ts:12
  Fix: move to environment variable, rotate the leaked value.

=== Gate: CONDITIONAL ===
Resolve HIGH findings or ack with: --ack-high
```

## Block 8: Followups

- Resolve the introduced findings shown above.
- Re-run `cadence audit --type pre-merge`.
- Once the gate passes, open the PR.

## Integration

Install as a pre-push hook:

```bash
ln -sf "$(pwd)/auto/scripts/hooks/pre-push.sh" .git/hooks/pre-push
chmod +x .git/hooks/pre-push
```

Where the hook simply invokes:

```bash
cadence audit --type pre-merge --json | jq -e '.gate != "fail"'
```

## Rules

**Do:** scope detectors to changed files only; subtract pre-existing findings; keep total runtime under 30s.
**Don't:** run expensive checks (full test suite, full type-check); rewrite full reports — pre-merge is gate-mode, not report-mode.
