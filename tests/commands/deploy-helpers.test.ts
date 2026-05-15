// Unit tests for `flint deploy`'s parsers. The rest of `runDeploy` is
// integration-tested by spawning the bin against a tmp-dir stub. The two
// exported parsers benefit from focused unit coverage so a wrangler v5
// output-format change shows up here first.

import { describe, expect, it } from 'vitest';
import {
  parseDeployStdout,
  parseDeploymentList,
} from '../../src/commands/deploy.js';

describe('parseDeployStdout', () => {
  it('extracts the pages.dev URL from a typical wrangler v4 output', () => {
    const stdout = [
      '✨ Compiled Worker successfully',
      '🌍 Uploading... (12/12)',
      '✨ Success! Uploaded 12 files (1.23s)',
      '✨ Deployment complete! Take a peek over at https://abc12345.flint-smoke.pages.dev',
    ].join('\n');
    const parsed = parseDeployStdout(stdout);
    expect(parsed).not.toBeNull();
    expect(parsed!.url).toBe('https://abc12345.flint-smoke.pages.dev');
  });

  it('strips trailing punctuation off the matched URL', () => {
    const stdout = 'available at https://abc.pages.dev. Run again to redeploy.';
    const parsed = parseDeployStdout(stdout);
    expect(parsed!.url).toBe('https://abc.pages.dev');
  });

  it('captures a deployment UUID when present in the output', () => {
    const stdout =
      'Deployment 12345678-1234-1234-1234-123456789abc deployed to https://abc.pages.dev';
    const parsed = parseDeployStdout(stdout);
    expect(parsed!.deploymentId).toBe('12345678-1234-1234-1234-123456789abc');
  });

  it('returns null when no pages.dev URL is in the output', () => {
    expect(parseDeployStdout('wrangler had a bad day')).toBeNull();
  });
});

describe('parseDeploymentList', () => {
  it('returns rows for every UUID in the table output', () => {
    const sample = [
      'Environment │ Branch │ Source │ Deployment                          │ Status │ URL',
      '────────────┼────────┼────────┼─────────────────────────────────────┼────────┼─────',
      'production  │ main   │ git    │ 11111111-1111-1111-1111-111111111111 │ Active │ https://a.pages.dev',
      'production  │ main   │ git    │ 22222222-2222-2222-2222-222222222222 │ Active │ https://b.pages.dev',
      'preview     │ feat   │ git    │ 33333333-3333-3333-3333-333333333333 │ Active │ https://c.pages.dev',
    ].join('\n');
    const rows = parseDeploymentList(sample);
    expect(rows).toHaveLength(3);
    expect(rows[0]!.id).toBe('11111111-1111-1111-1111-111111111111');
    expect(rows[2]!.id).toBe('33333333-3333-3333-3333-333333333333');
  });

  it('extracts the branch column when separated by whitespace', () => {
    const sample =
      'production main git 11111111-1111-1111-1111-111111111111 Active https://a.pages.dev';
    const rows = parseDeploymentList(sample);
    expect(rows[0]!.branch).toBe('git');
  });

  it('captures an ISO 8601 created timestamp from the line', () => {
    const sample =
      'main 11111111-1111-1111-1111-111111111111 2026-05-14T12:34:56.789Z https://a.pages.dev';
    const rows = parseDeploymentList(sample);
    expect(rows[0]!.created).toBe('2026-05-14T12:34:56.789Z');
  });

  it('returns [] for output with no UUIDs', () => {
    expect(parseDeploymentList('no deployments found')).toEqual([]);
  });
});
