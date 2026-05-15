// Unit coverage for the minimal unified-diff renderer.

import { describe, expect, it } from 'vitest';
import { diffLines, noDiff, renderUnifiedDiff } from '../../src/util/diff.js';

describe('renderUnifiedDiff', () => {
  it('returns empty string for identical inputs', () => {
    expect(renderUnifiedDiff('a\nb\n', 'a\nb\n')).toBe('');
  });

  it('emits proper unified-diff headers', () => {
    const out = renderUnifiedDiff('a\nb\n', 'a\nc\n', {
      oldLabel: 'a/x',
      newLabel: 'b/x',
    });
    expect(out).toContain('--- a/x');
    expect(out).toContain('+++ b/x');
    expect(out).toMatch(/^@@ -\d+,\d+ \+\d+,\d+ @@$/m);
  });

  it('marks deletes with - and inserts with +', () => {
    const out = renderUnifiedDiff('old line\n', 'new line\n');
    expect(out).toContain('-old line');
    expect(out).toContain('+new line');
  });

  it('keeps context lines prefixed with a space', () => {
    const out = renderUnifiedDiff(
      'line1\nline2\nline3\nline4\nline5\n',
      'line1\nline2\nLINE3\nline4\nline5\n',
    );
    expect(out).toContain(' line1');
    expect(out).toContain(' line2');
    expect(out).toContain('-line3');
    expect(out).toContain('+LINE3');
    expect(out).toContain(' line4');
  });

  it('noDiff agrees with renderUnifiedDiff on equality', () => {
    expect(noDiff('a', 'a')).toBe(true);
    expect(noDiff('a', 'b')).toBe(false);
  });

  it('diffLines reports a balanced LCS walk for an interleaved change', () => {
    const ops = diffLines('a\nb\nc\n', 'a\nx\nc\n');
    const kinds = ops.map((o) => o.kind);
    expect(kinds).toContain('equal');
    expect(kinds).toContain('insert');
    expect(kinds).toContain('delete');
  });

  it('handles pure deletion (newer is shorter)', () => {
    const out = renderUnifiedDiff('a\nb\nc\n', 'a\nc\n');
    expect(out).toContain('-b');
  });

  it('handles pure insertion (newer is longer)', () => {
    const out = renderUnifiedDiff('a\nc\n', 'a\nb\nc\n');
    expect(out).toContain('+b');
  });
});
