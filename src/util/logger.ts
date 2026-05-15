// Minimal logger with ANSI colors. Avoids a chalk/picocolors dep so the CLI
// stays small and fast to install. NO_COLOR support follows the convention
// at https://no-color.org/ — any non-empty value disables colors.

type Color = 'green' | 'yellow' | 'red' | 'cyan' | 'gray' | 'bold' | 'dim';

const CODES: Record<Color, [string, string]> = {
  green: ['\x1b[32m', '\x1b[39m'],
  yellow: ['\x1b[33m', '\x1b[39m'],
  red: ['\x1b[31m', '\x1b[39m'],
  cyan: ['\x1b[36m', '\x1b[39m'],
  gray: ['\x1b[90m', '\x1b[39m'],
  bold: ['\x1b[1m', '\x1b[22m'],
  dim: ['\x1b[2m', '\x1b[22m'],
};

function colorEnabled(): boolean {
  if (process.env.NO_COLOR && process.env.NO_COLOR.length > 0) return false;
  if (process.env.FORCE_COLOR && process.env.FORCE_COLOR.length > 0) return true;
  return process.stdout.isTTY ?? false;
}

export function color(c: Color, s: string): string {
  if (!colorEnabled()) return s;
  const [open, close] = CODES[c];
  return `${open}${s}${close}`;
}

// When the CLI is in `--json` mode, all human-readable output is routed to
// stderr so the structured result on stdout remains parseable by a pipe.
// Callers set this via setJsonMode(true) once at entry; the logger's stdout-
// flavoured methods then redirect.
let jsonMode = false;
export function setJsonMode(enabled: boolean): void {
  jsonMode = enabled;
}
function out(msg: string): void {
  if (jsonMode) {
    process.stderr.write(msg + '\n');
  } else {
    console.log(msg);
  }
}

export const log = {
  info: (msg: string): void => out(msg),
  ok: (msg: string): void => out(`${color('green', '✓')} ${msg}`),
  warn: (msg: string): void => console.warn(`${color('yellow', '!')} ${msg}`),
  err: (msg: string): void => console.error(`${color('red', '✗')} ${msg}`),
  step: (msg: string): void => out(`${color('cyan', '›')} ${msg}`),
  dim: (msg: string): void => out(color('dim', msg)),
  heading: (msg: string): void => out(`\n${color('bold', msg)}`),
  blank: (): void => out(''),
};
