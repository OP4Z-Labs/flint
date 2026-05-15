// Output format helper for the CLI's `--json` flag.
//
// Every subcommand that produces user-facing output exposes a structured
// result envelope. The CLI side either pretty-prints it (default) or emits
// it as a JSON line on stdout (`--json`).
//
// Convention:
//   - When `--json` is set, the subcommand short-circuits at end-of-work,
//     formatResult emits a single JSON object on stdout, and the subcommand
//     suppresses all incidental log lines (which would otherwise pollute the
//     stdout JSON stream).
//   - Subcommands that ARE long-running and emit progress to stdout in the
//     human-output path must check `opts.json` and route progress to stderr.
//   - Errors thrown from JSON-mode subcommands emit `{ ok: false, error: ... }`
//     instead of the pretty error formatter (cli.ts handles this).
//
// Result envelope shape (locked, public-ish API):
//
//   {
//     "command":  "<subcommand>",       // matches the CLI verb
//     "ok":       true | false,          // success flag
//     "data":     { ... }                // command-specific payload
//   }

export interface CommandResultBase {
  command: string;
  ok: boolean;
}

export interface SuccessResult<T = unknown> extends CommandResultBase {
  ok: true;
  data: T;
}

export interface ErrorResult extends CommandResultBase {
  ok: false;
  error: {
    /** Stable error identifier (NEVER the human message). */
    code: string;
    /** Human-readable message (only safe to log; not for machine routing). */
    message: string;
  };
}

export type CommandResult<T = unknown> = SuccessResult<T> | ErrorResult;

export interface FormatResultOptions {
  /** When true, emit JSON on stdout. When false, no-op (caller already printed). */
  json: boolean;
}

/**
 * Emit a result. In JSON mode, writes one line of JSON to stdout. In default
 * mode, this is a no-op — the subcommand has already done its pretty-print.
 *
 * Always returns the same envelope (so callers can use it for return-value
 * propagation in tests).
 */
export function formatResult<T>(
  result: CommandResult<T>,
  options: FormatResultOptions,
): CommandResult<T> {
  if (options.json) {
    process.stdout.write(JSON.stringify(result) + '\n');
  }
  return result;
}

/** Build a success envelope. */
export function ok<T>(command: string, data: T): SuccessResult<T> {
  return { command, ok: true, data };
}

/** Build an error envelope. */
export function err(command: string, code: string, message: string): ErrorResult {
  return { command, ok: false, error: { code, message } };
}
