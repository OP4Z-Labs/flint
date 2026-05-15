---
title: Contributing
description: Build, test, and PR flow for contributors to Flint.
---

Thanks for considering a contribution! This document covers the build/test/PR flow.

## Quick start

```bash
git clone https://github.com/<your-fork>/flint.git
cd flint
npm install
npm run build
npm test
```

All four gates must pass before opening a PR:

```bash
npm run build      # TypeScript compile
npm run lint       # ESLint flat config
npm run typecheck  # tsc -b (extra check)
npm test           # Vitest run — 350+ tests across 36 files
```

## Code style

- **TypeScript strict mode.** No `any` without an explicit justification comment.
- **ESM only.** All imports use `import`; never `require()` (the lint rule will flag it).
- **No emojis in code.** Templates may include them in user-facing strings if appropriate; source files do not.
- **Banner comments at the top of every new source file.** Explain *why* the file exists + non-obvious choices. Look at `src/util/manifest.ts` or `src/commands/configure.ts` for the style.
- **Atomic writes everywhere.** Use `writeFileAtomic` / `writeJsonAtomic` from `src/util/atomic-write.ts`, never `writeFileSync` directly.
- **No new prod deps without a documented reason.** The current production dep set is `commander`, `@inquirer/prompts`, `smol-toml`. Adding to this list requires a PR-level discussion.

## Testing

- **Unit tests** live in `tests/{util,commands,cloudflare,templates}/<file>.test.ts`. They mock external deps (file system at `tmpdir`, fetch via vitest spy).
- **Integration tests** live in `tests/integration/<surface>.spec.ts`. They spawn `node dist/cli.js` against a real temp dir + a POSIX fake-bin for wrangler. Skip cleanly on Windows.
- Always add a test when adding behavior. The bar isn't 100% coverage, it's "if this breaks, a test fails."

## Commit messages

Follow the conventional-commits-lite style already in use:

```
<type>(<scope>): <subject>

[optional body]
```

Examples from history:

- `feat(deploy): wrapped deploy with pre-flight + asset budget + rollback`
- `fix(init): handle missing .gitignore`
- `docs: update README with telemetry section`

No `[OP-NNN]` task tags — that's an OP4Z-internal convention; Flint is a public project. Don't add Claude/AI co-authorship lines unless explicitly requested.

## Pull request flow

1. Fork + clone.
2. Branch: `feat/<short-name>` or `fix/<short-name>`.
3. Code + tests.
4. Run all four gates locally (`npm run build && npm run lint && npm run typecheck && npm test`).
5. Open the PR with a description of the change + rationale.
6. CI will re-run the gates on Node 20, 22, 24.

## Signing off

Flint doesn't currently require DCO sign-off (`git commit -s`), but if you're used to that convention, feel free to include it.

## Code of conduct

Be kind. We're all trying to ship good software. Disagreements happen — surface them via the PR comments, not via tone.

## Reporting bugs

Open an issue using the bug-report template at `.github/ISSUE_TEMPLATE/bug-report.md`. Include:

- `flint --version`
- `node --version`
- Your OS + package manager
- The exact command that produced the bug
- The full output (stdout + stderr, scrubbed of any secrets)

## Requesting features

Open an issue using the feature-request template. The bar for new features in v1.x is:

- Solves a real workflow problem (not just "it would be nice")
- Doesn't grow the prod dep surface unnecessarily
- Has a clear test plan

## Requesting templates

A "template" is a new scaffolding variant (`flint init --variant <name>`). The bar for new templates is real production-grade reference apps that exercise the variant. If you've shipped 2+ apps using the would-be variant, file an issue and we'll discuss.
