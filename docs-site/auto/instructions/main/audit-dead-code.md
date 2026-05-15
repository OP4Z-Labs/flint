---
action: dead-code
command: audit
schema_version: 1
description: Unreachable code, unused exports, orphan files, and unused dependencies across the codebase.
---

# Audit: Dead Code

Run a per-stack dead-code detector across your codebase, categorize the
findings (REMOVE / KEEP_FUTURE / INVESTIGATE / FALSE_POSITIVE), and emit
both a human-readable report and a JSON sidecar so trend analysis works.

## Inputs

- Optional `--scope` to limit to a stack: `frontend | backend | all` (default: `all`).
- Optional `--min-confidence <N>` to tune the detector threshold.

## Output

- `auto/audits/dead-code/YYYY-MM-DD.md`
- `auto/audits/dead-code/latest.json`

## Block 1: Pre-flight

- Verify the per-stack tooling is installed:
  - TypeScript / JavaScript: `knip` (or `ts-prune`, `unimported`).
  - Python: `vulture`.
  - Go: `deadcode` (golang.org/x/tools).
  - Rust: `cargo +nightly udeps` (heavier; opt-in).
- Load the previous sidecar at `auto/audits/dead-code/latest.json` for
  baseline diff.

## Block 2: Discovery

Count the universe of files you're scanning:

- Source files per stack
- Test files (these usually export fixtures the detector will flag)
- Generated files (these should be excluded — see whitelist below)

## Block 3: Run Detectors

### TypeScript / JavaScript

Configure `knip` (or the equivalent) to scan your source roots. The four
categories knip reports map cleanly:

- **Unused files** — never imported
- **Unused exports** — exported but no consumer
- **Unused dependencies** — declared in `package.json` but not imported
- **Unused devDependencies** — declared but not used in any script

### Python

`vulture` with `--min-confidence 70` is a good default. Categories:

- **Unused functions / methods**
- **Unused classes**
- **Unused variables / imports**

### Whitelist (always-skip)

Before emitting a finding, check if any apply (mark `FALSE_POSITIVE`):

- File is a re-exporting barrel (`export * from ...`) — those exist
  precisely to forward identifiers the local file doesn't use.
- Identifier is consumed via dynamic import (`import(...)` or
  `importlib.import_module(...)`).
- File is part of a public package API meant for external consumption.
- File is generated (e.g. matches `**/__generated__/**`, `**/dist/**`).
- File is a scaffold template (e.g. `templates/`, `cookiecutter/`).

## Block 4: Categorize Findings

| Category         | Action                                                                   | Severity      |
| ---------------- | ------------------------------------------------------------------------ | ------------- |
| `REMOVE`         | Confirmed dead, safe to delete                                           | low (cleanup) |
| `KEEP_FUTURE`    | Pre-built for upcoming feature; must link to an open task tracking it    | low           |
| `INVESTIGATE`    | Unclear; needs human review                                              | medium        |
| `FALSE_POSITIVE` | Add to the detector's ignore list (e.g. `knip.json`, `vulture` ignores)  | low           |

The categorization step is the value-adding work — running the detector
is the easy part.

## Block 5: Diff vs Baseline

Compare findings against the previous sidecar:

- **New dead code** introduced this iteration → regression, surface it.
- **Resolved dead code** → celebrate; the report should call this out.
- **Persistent dead code** still here from last time → escalate after
  three consecutive runs.

## Block 6: Score

Dead code is mostly cleanup, not correctness, so weight it gently:

- Score = max(0, 100 − 2·REMOVE − 1·INVESTIGATE)
- Gate: pass (≥ 90), conditional (≥ 75), fail (< 75)

## Block 7: Report

The Markdown report should split per stack and per category. For each
finding include:

- File and line
- Why the detector flagged it
- Suggested action (REMOVE / KEEP_FUTURE → linked task / etc.)

Include a "Cleanup Commands" block at the bottom listing the exact
shell commands to apply the REMOVE actions (so humans can apply them
with a single review pass).

## Block 8: Followups

```
=== Dead Code Audit Complete ===
TypeScript:  N unused files, N unused exports, N unused deps
Python:      N unused functions, N unused classes
Persistent:  N findings present in last 3 runs

Next:
  1. Open a focused task to remove dead code from the highest cluster.
  2. Add false positives to the detector's ignore list.
  3. Re-run: substrate audit --type dead-code.
```

## Rules

**Do:** run BOTH stacks where applicable; categorize every finding; track persistence across runs.
**Don't:** auto-delete without explicit user approval; skip the whitelist (high false-positive rate); leave findings unclassified.
