# Error messages

This document is the contract for error messages emitted by Flint. Every
`throw new Error(...)` and `log.err(...)` in `src/` follows the shape below.
Contributors adding new error sites must follow it too.

## The shape

```
[flint] <subsystem>: <what happened> — <actionable next step>
```

Three slots:

1. **`[flint]`** — literal prefix. Lets `grep '\[flint\]'` find every
   Flint-originated line in mixed-tool output (CI logs, journald, etc.).
2. **`<subsystem>`** — the area that produced the failure. Examples:
   `init`, `create-app`, `deploy`, `configure`, `add`, `auth`, `upgrade`,
   `doctor`, `uninstall`, `cloudflare-api`, `wrangler-toml`, `template-url`,
   `template`, `package-manager`, `config`. Pick the smallest accurate scope.
3. **`<what happened>`** — the specific failure, with relevant context
   embedded (file path, exit status, parsed reason). Avoid vague verbs like
   "failed" without elaboration.
4. **`<actionable next step>`** — what the user should DO. Always present.
   If you genuinely cannot suggest an action, write "file an issue with the
   <X> attached" — that is itself an action.

The em-dash (`—`) separates the description from the action. Use a real
em-dash (U+2014), not two hyphens.

## Before / after examples

### Vague → specific

```diff
- throw new Error(`Templates directory not found: ${candidate}`);
+ throw new Error(
+   `[flint] init: templates directory not found at ${candidate} — your Flint install is broken; reinstall with \`npm install -g @op4z/flint\`.`,
+ );
```

### Missing the action

```diff
- log.err(`Could not extract namespace id from wrangler output:\n${res.output}`);
+ log.err(`[flint] configure: could not extract namespace id from wrangler output — this is a wrangler-output-format change Flint should adapt to. File an issue with the output below.\n${res.output}`);
```

### Confusing on Windows (path separator)

```diff
- throw new Error('App name must not contain path separators.');
+ throw new Error('[flint] create-app: app name must not contain path separators — pass a plain directory name like `my-app`.');
```

### "Generic" Cloudflare API failure

```diff
- throw new Error(`Listing R2 buckets failed: ${reason}`);
+ throw new Error(`[flint] cloudflare-api: listing R2 buckets failed (${reason}) — verify the token has R2:Edit on this account.`);
```

### Auth doctor scope failures

```diff
- log.err(`${failures} scope(s) missing. Edit the token at ${DASHBOARD_URL} and add the missing rows above.`);
+ log.err(`[flint] auth: ${failures} scope(s) missing — edit the token at ${DASHBOARD_URL} and add the missing rows above.`);
```

## Contributor checklist

Before merging a PR that adds a new error message, verify:

- [ ] Starts with `[flint] <subsystem>: ...`
- [ ] Uses lowercase after the colon (sentence case is fine, but match the
      conventions of the surrounding messages — usually one of: "no", "unknown",
      "failed", a noun phrase).
- [ ] Contains an em-dash (`—`) followed by an actionable next step.
- [ ] No double-period at the end (just one period or none).
- [ ] If the failure has structured context (exit status, error code, parsed
      reason), embed it.
- [ ] If the error is user-recoverable, suggest the specific command or fix.
      If it's a Flint bug, say so explicitly: "this is a Flint bug, please
      file an issue".

## What about the `Error` constructor name vs `log.err`?

`throw new Error(...)` is for failures that should propagate to a caller
(library code, programmatic API). `log.err(...)` is for user-facing CLI
output that doesn't terminate the process — typically inside an
`if (status !== 0)` branch where we set `process.exitCode` and return.

Both follow the shape. The message itself is the contract; the dispatch
mechanism is implementation detail.

## What about `log.warn` and `log.info`?

`log.warn` (yellow, non-fatal) and `log.info` (neutral) are advisory — they
do not follow the strict shape because they're not failures. However, the
`[flint] <subsystem>:` prefix is encouraged for consistency in long sessions
where multiple tools log to the same stream. See `src/util/logger.ts`.

## See also

- `src/util/logger.ts` — the log helpers (`log.err`, `log.warn`, `log.info`, `log.ok`, `log.step`, `log.heading`, `log.dim`).
- `docs/compatibility.md` — the Windows audit which surfaced several pre-1.0 error message rewrites.
- `CHANGELOG.md` — the 1.0 entry lists "polish: standardize error message shape across all commands".
