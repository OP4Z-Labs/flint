---
title: Telemetry transparency
description: Complete reference for what Flint records, where it stores it, and how to opt in or out.
---

Flint ships an opt-in, off-by-default anonymous telemetry feature. This document is the **complete, authoritative reference** for what Flint records, where it stores the data, how to inspect it, and how to disable it.

## TL;DR

- **Default: OFF.** Flint never sends telemetry unless you explicitly opt in.
- **Local first.** Events are written to a file on your machine. Nothing is POSTed unless you also pass `--telemetry-endpoint <url>`.
- **No identifying data.** No paths, no tokens, no project names, no user identifiers, no error messages.
- **You own the log.** Inspect it (`flint telemetry show`), delete it (`flint telemetry purge`), or export it (`flint telemetry export <file>`).

## When does Flint ask?

On the first invocation that runs a real command (not `--help`, not `--version`, not `flint config`), Flint prompts:

> Help improve Flint by sharing anonymous usage stats? (no project info, no token info) (y/N)

The default is **no**. Your answer is persisted to `~/.config/flint/telemetry.json` and Flint never asks again. To change your mind: `flint config --telemetry on` or `flint config --telemetry off`.

If stdin is not a TTY (CI, piped invocations, `--json` mode), Flint **silently records "off"** and proceeds — it never asks in non-interactive contexts.

## What does Flint record?

Every telemetry event is a JSON object with exactly these fields:

| Field | Type | Always present? | Notes |
| --- | --- | --- | --- |
| `event` | string | yes | The subcommand name. `init`, `deploy`, `add`, etc. No arguments. |
| `variant` | string | only on `init` / `create-app` | The template variant chosen (`pages-functions`, `pages-fullstack`, `static-spa`). |
| `errorType` | string | only on errors | Error name or code, e.g. `WranglerTomlNotFoundError`, `ENOENT`. NEVER the error message. |
| `context` | object | rare | Small ad-hoc dict for event-specific data (e.g. `{ "scoped": true }`). |
| `flintVersion` | string | yes | The Flint version that emitted the event. |
| `os` | string | yes | `process.platform` — `linux`, `darwin`, `win32`. |
| `node` | string | yes | Node major version only, e.g. `"20"`. |
| `ts` | string | yes | ISO 8601 timestamp with milliseconds. |

**Example event:**

```json
{"event":"init","variant":"pages-fullstack","flintVersion":"1.0.0","os":"linux","node":"20","ts":"2026-05-14T12:34:56.789Z"}
```

## What does Flint **never** record?

These are asserted in the unit tests (`tests/util/telemetry.test.ts`) and locked as part of the public contract. Removing them is a **major version change**.

- File system paths (project root, cwd, file names, error paths)
- User identifiers (username, email, hostname, machine ID, MAC, IP)
- Credentials (Cloudflare API tokens, account IDs, secret values)
- Error message bodies (only `errorType` — the structured name/code — is included)
- Command arguments (only the bare subcommand name)
- Environment variable values

## Where is data stored?

| Path | What lives there |
| --- | --- |
| `~/.config/flint/telemetry.json` | Your preference (`{enabled, installed, sink}`) |
| `~/.config/flint/telemetry.log` | Append-only JSONL log of every event emitted |

On Linux, `~/.config/flint/` follows the XDG base-directory spec (set `XDG_CONFIG_HOME` to relocate). On macOS, the same path applies (Flint deliberately uses `~/.config/` rather than `~/Library/...` for consistency). On Windows, the equivalent is `%APPDATA%\flint\`.

## Remote endpoints (`--telemetry-endpoint <url>`)

Pass `--telemetry-endpoint https://your-endpoint.example/events` to also POST each event to a custom URL. The local log is still written.

- Failures are silent (telemetry must never break a user command).
- The exact same JSON payload that's written to the local log is sent in the POST body.
- There is **no** Beau-hosted endpoint at v1.0. Self-hosters who want aggregated insights can stand up a small Cloudflare Worker that accepts `POST application/json`.

To make the endpoint setting permanent for your shell, export the env var: `export FLINT_TELEMETRY_ENDPOINT=https://...`.

## Inspecting + managing the log

```bash
# Show every event Flint has recorded.
flint telemetry show

# Show as JSON envelope (useful for scripting).
flint --json telemetry show

# Delete the log file. Preference is preserved.
flint telemetry purge

# Copy the log to a file for archiving / sharing.
flint telemetry export ./flint-events.jsonl
flint telemetry export ./flint-events.jsonl --force   # overwrite
```

`flint telemetry show` works even when telemetry is **disabled** — the log may exist from a previous enabled session, and you have a right to inspect it.

## Disabling telemetry

```bash
# Disable. Preference is persisted.
flint config --telemetry off

# Re-enable.
flint config --telemetry on

# View current setting (no change).
flint config
```

Or delete the preference file by hand: `rm ~/.config/flint/telemetry.json`. Flint will prompt again on next invocation (defaulting to "off").

## Verifying the contract

The event shape is locked by unit tests in `tests/util/telemetry.test.ts`. If a future Flint version adds or removes a field, the tests fail in CI before the change can land. Adding fields is fine; renaming or removing fields requires a major version bump.

You can also inspect the source: see `src/util/telemetry.ts` — particularly `buildEventPayload()`, which constructs the wire shape.
