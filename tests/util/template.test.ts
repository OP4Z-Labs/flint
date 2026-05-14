// Template-renderer tests. The renderer is small but load-bearing: every
// scaffolded file passes through it. We want to fail fast on missing vars
// rather than ship a `{{appName}}` literal into a user's project.

import { describe, expect, it } from 'vitest';
import { extractVarNames, renderString } from '../../src/util/template.js';

describe('renderString', () => {
  it('substitutes simple {{name}} tokens', () => {
    expect(renderString('hello {{name}}', { name: 'world' })).toBe('hello world');
  });

  it('tolerates whitespace inside the brackets', () => {
    expect(renderString('{{ name }}', { name: 'x' })).toBe('x');
  });

  it('substitutes the same variable in multiple places', () => {
    expect(renderString('{{a}}-{{a}}', { a: 'x' })).toBe('x-x');
  });

  it('throws when a variable is missing', () => {
    expect(() => renderString('{{missing}}', {})).toThrow(/missing/);
  });

  it('leaves unrelated braces alone', () => {
    expect(renderString('{ "key": "value" }', {})).toBe('{ "key": "value" }');
  });

  it('does not recurse — substituted values are not re-rendered', () => {
    expect(renderString('{{a}}', { a: '{{b}}', b: 'x' })).toBe('{{b}}');
  });
});

describe('extractVarNames', () => {
  it('returns the unique set of referenced names', () => {
    expect(extractVarNames('{{a}}-{{b}}-{{a}}').sort()).toEqual(['a', 'b']);
  });

  it('returns [] for input with no placeholders', () => {
    expect(extractVarNames('plain text')).toEqual([]);
  });
});
