---
action: dependencies
command: audit
schema_version: 1
description: Outdated packages, known CVEs, license compliance, abandoned dependencies, and version skew across services.
---

# Audit: Dependencies

Cross-stack health check for your direct and transitive dependencies.
Targets six independent failure modes — each gets its own pass so a
single broken detector doesn't take the whole audit down.

## Inputs

- Optional `--scope` to limit to a stack: `python | node | all` (default: `all`).
- Optional `--include-pre` to include pre-release versions in upgrade suggestions.

## Output

- `auto/audits/dependencies/YYYY-MM-DD.md`
- `auto/audits/dependencies/latest.json` (sidecar for trend tracking)

## Block 1: Pre-flight

- Verify the package managers for each stack you scan are on `PATH`
  (e.g. `npm`, `poetry`, `pip-audit`, `cargo`, `go`).
- Locate every manifest file in scope: `package.json`, `pyproject.toml`,
  `Cargo.toml`, `go.mod`, etc.
- Load the previous sidecar at `auto/audits/dependencies/latest.json` so
  diff-vs-baseline (Block 5) can fire.

## Block 2: Discovery

Count the units of work so the report has a denominator:

- Number of packages per stack
- Number of services / apps that have their own lockfile
- Total direct dependencies (not transitive)

## Block 3: Run Detectors

### Pass A — Outdated (informational)

Run the package manager's outdated query per workspace. Categorize by
semver gap:

- Major outdated → low (informational; humans decide)
- Minor outdated → low
- Patch outdated → low (autobump candidate)

### Pass B — Known CVEs

Run a vulnerability scanner per stack (e.g. `npm audit`, `pip-audit`,
`cargo audit`). Map severity to the cadence scale:

- Vendor critical → critical
- Vendor high → high
- Vendor moderate → medium
- Vendor low → low

### Pass C — License Compliance

Extract the license field for every direct dependency.

**Disallow (severity high):**

- `GPL-*` or `AGPL-*` inside proprietary projects without explicit dual-license
- Commercial-restricted licenses

**Tag for review (severity medium):**

- `WTFPL`, `Beerware`, `Unknown`, missing-license

### Pass D — Abandoned Packages

For each direct dependency, look up the last-release date from the
registry. If older than ~24 months and there's no maintenance branch,
emit a finding (severity medium) with a suggested replacement when
known.

### Pass E — Version Skew

For shared libraries used by multiple services in a monorepo, surface
services on different majors. Each cross-service major mismatch is
severity high — performance, security, and behavior drift compound.

### Pass F — Lockfile Drift

For every manifest, check that the corresponding lockfile is in sync:

- `npm ci --dry-run` (Node)
- `poetry check --lock` (Python)
- Equivalent for other stacks

Any drift → severity medium.

## Block 4: Score + Gate

Standard score formula. Three hard gates regardless of score:

- Any **critical CVE** in a production runtime dependency → fail
- Any **GPL / AGPL** finding in proprietary code → fail
- Lockfile drift in a deployable artifact → fail

## Block 5: Diff vs Baseline

Compare against the previous sidecar:

- New CVEs introduced since last run
- Resolved CVEs (good — surface them)
- Persistent CVEs older than 7 days (escalate)
- Newly-outdated packages
- Newly-abandoned packages

## Block 6: Report

The Markdown report should at minimum include:

- Critical CVEs table (package, version, CVE ID, fixed-in, affected services)
- Outdated majors (package, current, latest, upgrade risk)
- License issues (package, license, verdict)
- Abandoned (package, last release, suggested replacement)
- Version skew (library, conflicting services, recommended pin)
- Lockfile drift (manifest, status)

The JSON sidecar mirrors the same data in machine-readable form for
trend visualization.

## Block 7: Followups

```
=== Dependency Audit Complete ===
CVEs:           N critical, N high, N medium
Outdated:       N majors, N minors
Abandoned:      N
License issues: N

Next:
  1. Open a task to upgrade <package> to fix <CVE>.
  2. Schedule monthly: substrate audit --type dependencies.
  3. Pin shared majors across services (see Version Skew section).
```

## Rules

**Do:** run all six passes; track CVE persistence; cross-service skew check is high-value.
**Don't:** auto-upgrade — humans decide; ignore license findings (legal risk); skip the lockfile drift gate.
