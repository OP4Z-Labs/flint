// Minimal unified-diff renderer. Zero deps — we don't pull in `diff` for what
// amounts to a side-by-side line walk with a small Myers-like LCS.
//
// Output format approximates GNU diff -u:
//
//   --- a/wrangler.toml (current)
//   +++ b/wrangler.toml (new)
//   @@ -1,3 +1,3 @@
//    name = "foo"
//   -compatibility_date = "2026-01-01"
//   +compatibility_date = "2026-05-14"
//    pages_build_output_dir = "dist"
//
// Hunk boundaries: we coalesce runs of changes separated by ≤ 2 unchanged
// lines and surround each hunk with 3 lines of context, matching `diff -u`
// default. This keeps `flint upgrade --diff` output legible for small drift.

const CONTEXT = 3;

interface DiffOp {
  kind: 'equal' | 'insert' | 'delete';
  oldLine?: number; // 1-indexed
  newLine?: number; // 1-indexed
  text: string;
}

/** Compute a sequence of diff operations between two strings. */
export function diffLines(oldText: string, newText: string): DiffOp[] {
  const a = oldText.split('\n');
  const b = newText.split('\n');
  // Trailing-newline handling: a trailing "" element from split('\n') means
  // the original ended with a newline. We keep it as an empty line so the
  // LCS walks over it; the renderer skips an empty trailing line at the end.
  const lcs = computeLcs(a, b);
  // Walk back to construct the operation list.
  const ops: DiffOp[] = [];
  let i = a.length;
  let j = b.length;
  while (i > 0 && j > 0) {
    if (a[i - 1] === b[j - 1]) {
      ops.unshift({ kind: 'equal', oldLine: i, newLine: j, text: a[i - 1]! });
      i -= 1;
      j -= 1;
    } else if (lcs[i - 1]![j]! >= lcs[i]![j - 1]!) {
      ops.unshift({ kind: 'delete', oldLine: i, text: a[i - 1]! });
      i -= 1;
    } else {
      ops.unshift({ kind: 'insert', newLine: j, text: b[j - 1]! });
      j -= 1;
    }
  }
  while (i > 0) {
    ops.unshift({ kind: 'delete', oldLine: i, text: a[i - 1]! });
    i -= 1;
  }
  while (j > 0) {
    ops.unshift({ kind: 'insert', newLine: j, text: b[j - 1]! });
    j -= 1;
  }
  return ops;
}

/** Compute LCS table in O(n*m). Returns table[i][j] = LCS length of a[..i], b[..j]. */
function computeLcs(a: string[], b: string[]): number[][] {
  const table: number[][] = Array.from({ length: a.length + 1 }, () =>
    new Array<number>(b.length + 1).fill(0),
  );
  for (let i = 1; i <= a.length; i += 1) {
    for (let j = 1; j <= b.length; j += 1) {
      if (a[i - 1] === b[j - 1]) {
        table[i]![j] = table[i - 1]![j - 1]! + 1;
      } else {
        table[i]![j] = Math.max(table[i - 1]![j]!, table[i]![j - 1]!);
      }
    }
  }
  return table;
}

export interface RenderDiffOptions {
  oldLabel?: string;
  newLabel?: string;
  /** Number of context lines around each hunk. Defaults to 3 ("diff -u"). */
  context?: number;
}

/** Return true if old and new are byte-identical. */
export function noDiff(oldText: string, newText: string): boolean {
  return oldText === newText;
}

/**
 * Render a unified diff string. Returns an empty string if the inputs are
 * identical — callers can early-out on `if (diff)`.
 */
export function renderUnifiedDiff(
  oldText: string,
  newText: string,
  opts: RenderDiffOptions = {},
): string {
  if (oldText === newText) return '';
  const oldLabel = opts.oldLabel ?? 'a';
  const newLabel = opts.newLabel ?? 'b';
  const ctx = opts.context ?? CONTEXT;
  const ops = diffLines(oldText, newText);
  const hunks = groupIntoHunks(ops, ctx);
  if (hunks.length === 0) return '';
  const out: string[] = [`--- ${oldLabel}`, `+++ ${newLabel}`];
  for (const hunk of hunks) {
    const oldStart = hunk.oldStart;
    const newStart = hunk.newStart;
    out.push(`@@ -${oldStart},${hunk.oldLen} +${newStart},${hunk.newLen} @@`);
    for (const op of hunk.ops) {
      switch (op.kind) {
        case 'equal':
          out.push(` ${op.text}`);
          break;
        case 'delete':
          out.push(`-${op.text}`);
          break;
        case 'insert':
          out.push(`+${op.text}`);
          break;
      }
    }
  }
  return out.join('\n') + '\n';
}

interface Hunk {
  ops: DiffOp[];
  oldStart: number;
  newStart: number;
  oldLen: number;
  newLen: number;
}

function groupIntoHunks(ops: DiffOp[], context: number): Hunk[] {
  // Walk ops; emit a hunk for each cluster of changes with `context` lines
  // of leading/trailing surrounding context.
  const hunks: Hunk[] = [];
  let i = 0;
  while (i < ops.length) {
    // Skip leading equal runs.
    while (i < ops.length && ops[i]!.kind === 'equal') i += 1;
    if (i >= ops.length) break;
    // Found a change; back up to `context` leading equal lines.
    let start = i;
    let lead = 0;
    while (start > 0 && lead < context && ops[start - 1]!.kind === 'equal') {
      start -= 1;
      lead += 1;
    }
    // Extend until we see `context*2+1` consecutive equals (merge gap closed).
    let end = i;
    while (end < ops.length) {
      if (ops[end]!.kind === 'equal') {
        // count run of equals
        let run = 0;
        let k = end;
        while (k < ops.length && ops[k]!.kind === 'equal') {
          run += 1;
          k += 1;
        }
        if (k === ops.length || run > context * 2) {
          // close the hunk after `context` trailing equals.
          end = end + Math.min(run, context);
          break;
        }
        end = k;
      } else {
        end += 1;
      }
    }
    if (end > ops.length) end = ops.length;
    const slice = ops.slice(start, end);
    let oldStart = 0;
    let newStart = 0;
    for (const op of slice) {
      if (op.oldLine !== undefined && oldStart === 0) oldStart = op.oldLine;
      if (op.newLine !== undefined && newStart === 0) newStart = op.newLine;
      if (oldStart !== 0 && newStart !== 0) break;
    }
    const oldLen = slice.filter((o) => o.kind !== 'insert').length;
    const newLen = slice.filter((o) => o.kind !== 'delete').length;
    hunks.push({
      ops: slice,
      oldStart: oldStart === 0 ? 1 : oldStart,
      newStart: newStart === 0 ? 1 : newStart,
      oldLen,
      newLen,
    });
    i = end;
  }
  return hunks;
}
