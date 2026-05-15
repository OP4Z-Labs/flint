// Unit coverage for parseTemplateUrl. The applyTemplate path is exercised
// in the integration test (it shells out to real `git clone`).

import { describe, expect, it } from 'vitest';
import { parseTemplateUrl } from '../../src/util/template-url.js';

describe('parseTemplateUrl', () => {
  it('rejects URLs without git+ prefix', () => {
    expect(() => parseTemplateUrl('https://github.com/x/y')).toThrow(/git\+/);
  });

  it('parses a plain repo URL', () => {
    const r = parseTemplateUrl('git+https://github.com/user/repo');
    expect(r.repoUrl).toBe('https://github.com/user/repo');
    expect(r.ref).toBeUndefined();
    expect(r.subdirectory).toBeUndefined();
  });

  it('parses #ref syntax', () => {
    const r = parseTemplateUrl('git+https://github.com/user/repo#main');
    expect(r.repoUrl).toBe('https://github.com/user/repo');
    expect(r.ref).toBe('main');
    expect(r.subdirectory).toBeUndefined();
  });

  it('parses @ref syntax (npm style)', () => {
    const r = parseTemplateUrl('git+https://github.com/user/repo@v1.0.0');
    expect(r.repoUrl).toBe('https://github.com/user/repo');
    expect(r.ref).toBe('v1.0.0');
    expect(r.subdirectory).toBeUndefined();
  });

  it('parses #ref with subdirectory', () => {
    const r = parseTemplateUrl(
      'git+https://github.com/user/repo#main/templates/saas',
    );
    expect(r.repoUrl).toBe('https://github.com/user/repo');
    expect(r.ref).toBe('main');
    expect(r.subdirectory).toBe('templates/saas');
  });

  it('parses @ref with subdirectory', () => {
    const r = parseTemplateUrl(
      'git+https://github.com/user/repo@main/templates/saas',
    );
    expect(r.repoUrl).toBe('https://github.com/user/repo');
    expect(r.ref).toBe('main');
    expect(r.subdirectory).toBe('templates/saas');
  });

  it('does NOT treat @ inside userinfo as a ref', () => {
    const r = parseTemplateUrl('git+https://user:pat@host/owner/repo');
    expect(r.repoUrl).toBe('https://user:pat@host/owner/repo');
    expect(r.ref).toBeUndefined();
  });

  it('treats @ after the path AND inside userinfo correctly together', () => {
    const r = parseTemplateUrl('git+https://user:pat@host/owner/repo@main');
    expect(r.repoUrl).toBe('https://user:pat@host/owner/repo');
    expect(r.ref).toBe('main');
  });

  it('throws on empty repo component', () => {
    expect(() => parseTemplateUrl('git+')).toThrow(/no repository/);
  });
});
