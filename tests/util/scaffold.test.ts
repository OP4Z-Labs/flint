// Unit coverage for the glob matcher backing pack core-tree exclusion.

import { describe, it, expect } from 'vitest';
import { globToRegExp } from '../../src/util/scaffold.js';

describe('globToRegExp', () => {
  it('**/*.test.ts matches test files at any depth and at the root', () => {
    const re = globToRegExp('**/*.test.ts');
    expect(re.test('edge/storage.test.ts')).toBe(true);
    expect(re.test('storage.test.ts')).toBe(true);
    expect(re.test('a/b/c/x.test.ts')).toBe(true);
    expect(re.test('edge/storage.ts')).toBe(false);
    expect(re.test('edge/storage.test.tsx')).toBe(false);
  });

  it('* stays within a single path segment', () => {
    const re = globToRegExp('*.ts');
    expect(re.test('storage.ts')).toBe(true);
    expect(re.test('edge/storage.ts')).toBe(false);
  });

  it('**/__tests__/** matches files inside a __tests__ dir at any depth', () => {
    const re = globToRegExp('**/__tests__/**');
    expect(re.test('edge/__tests__/x.ts')).toBe(true);
    expect(re.test('__tests__/x.ts')).toBe(true);
    expect(re.test('edge/x.ts')).toBe(false);
  });

  it('escapes regex specials in literal segments', () => {
    const re = globToRegExp('a.b+c');
    expect(re.test('a.b+c')).toBe(true);
    expect(re.test('axbxc')).toBe(false);
  });
});
