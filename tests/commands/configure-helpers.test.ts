// Tests for the parseable, pure helpers inside `configure.ts`. The bulk
// of `runConfigure` is interactive and shells out to wrangler, which we
// don't reach in unit tests. But the helpers that extract ids from
// wrangler's output and the cloudflare list endpoints are pure — and
// regressions in either will silently break provisioning.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { extractKvIdFromOutput } from '../../src/commands/configure.js';
import {
  listKvNamespaces,
  listPagesProjects,
  listR2Buckets,
} from '../../src/cloudflare/api.js';

const TOKEN = 'cf_test_token';
const ACCOUNT = 'acct1234';

function mockFetchOnce(body: unknown, status = 200): void {
  const fetchSpy = vi.spyOn(globalThis, 'fetch' as never) as unknown as ReturnType<typeof vi.fn>;
  fetchSpy.mockResolvedValueOnce({
    ok: status >= 200 && status < 300,
    status,
    json: async () => body,
  } as Response);
}

describe('extractKvIdFromOutput', () => {
  it('returns null for empty output', () => {
    expect(extractKvIdFromOutput('')).toBeNull();
  });

  it('extracts id from JSON-shaped output', () => {
    const out = '{"id":"abcdef0123456789abcdef0123456789","title":"my-ns"}';
    expect(extractKvIdFromOutput(out)).toBe('abcdef0123456789abcdef0123456789');
  });

  it('extracts id from a TOML snippet', () => {
    const out = `Add the following to your wrangler.toml:\n[[kv_namespaces]]\nbinding = "X"\nid = "deadbeefdeadbeef1111222233334444"\n`;
    expect(extractKvIdFromOutput(out)).toBe('deadbeefdeadbeef1111222233334444');
  });

  it('extracts id from a sentence-style line', () => {
    const out = 'Created namespace with title "X" and id "112233445566778899aabbccddeeff00"';
    expect(extractKvIdFromOutput(out)).toBe('112233445566778899aabbccddeeff00');
  });

  it('returns null when no id-shaped substring is present', () => {
    expect(extractKvIdFromOutput('something went wrong')).toBeNull();
  });

  it('does not match shorter hex strings (avoids false positives)', () => {
    // 12 chars — should NOT match (we require 16+).
    expect(extractKvIdFromOutput('id = "deadbeef1234"')).toBeNull();
  });
});

describe('listPagesProjects', () => {
  beforeEach(() => {
    vi.spyOn(globalThis, 'fetch' as never);
  });
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('returns the project list', async () => {
    mockFetchOnce({
      success: true,
      errors: [],
      messages: [],
      result: [
        { name: 'proj1', production_branch: 'main', subdomain: 'proj1.pages.dev' },
        { name: 'proj2', production_branch: 'develop' },
      ],
    });
    const projects = await listPagesProjects(TOKEN, ACCOUNT);
    expect(projects).toHaveLength(2);
    expect(projects[0]!.name).toBe('proj1');
    expect(projects[1]!.production_branch).toBe('develop');
  });

  it('defaults production_branch to "main" when missing', async () => {
    mockFetchOnce({
      success: true,
      errors: [],
      messages: [],
      result: [{ name: 'no-branch' }],
    });
    const projects = await listPagesProjects(TOKEN, ACCOUNT);
    expect(projects[0]!.production_branch).toBe('main');
  });

  it('throws when CF returns success=false', async () => {
    mockFetchOnce(
      {
        success: false,
        errors: [{ code: 9109, message: 'Forbidden' }],
        result: [],
      },
      403,
    );
    await expect(listPagesProjects(TOKEN, ACCOUNT)).rejects.toThrow(/Forbidden/);
  });
});

describe('listKvNamespaces', () => {
  beforeEach(() => {
    vi.spyOn(globalThis, 'fetch' as never);
  });
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('maps to {id, title}', async () => {
    mockFetchOnce({
      success: true,
      errors: [],
      messages: [],
      result: [
        { id: 'aabbccddeeff00112233445566778899', title: 'my-ns' },
        { id: '00aa11bb22cc33dd44ee55ff66778899', title: 'other-ns' },
      ],
    });
    const ns = await listKvNamespaces(TOKEN, ACCOUNT);
    expect(ns).toHaveLength(2);
    expect(ns[0]).toEqual({ id: 'aabbccddeeff00112233445566778899', title: 'my-ns' });
  });

  it('returns empty array when result is missing', async () => {
    mockFetchOnce({
      success: true,
      errors: [],
      messages: [],
      result: null,
    });
    const ns = await listKvNamespaces(TOKEN, ACCOUNT);
    expect(ns).toEqual([]);
  });
});

describe('listR2Buckets', () => {
  beforeEach(() => {
    vi.spyOn(globalThis, 'fetch' as never);
  });
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('unwraps the nested result.buckets envelope', async () => {
    mockFetchOnce({
      success: true,
      errors: [],
      messages: [],
      result: {
        buckets: [
          { name: 'b1', creation_date: '2026-01-01T00:00:00.000Z' },
          { name: 'b2' },
        ],
      },
    });
    const buckets = await listR2Buckets(TOKEN, ACCOUNT);
    expect(buckets).toHaveLength(2);
    expect(buckets[0]!.name).toBe('b1');
    expect(buckets[0]!.creation_date).toBe('2026-01-01T00:00:00.000Z');
  });

  it('returns empty array when result.buckets is missing', async () => {
    mockFetchOnce({
      success: true,
      errors: [],
      messages: [],
      result: {},
    });
    const buckets = await listR2Buckets(TOKEN, ACCOUNT);
    expect(buckets).toEqual([]);
  });

  it('throws on success=false', async () => {
    mockFetchOnce(
      {
        success: false,
        errors: [{ code: 10000, message: 'Authentication error' }],
        result: { buckets: [] },
      },
      403,
    );
    await expect(listR2Buckets(TOKEN, ACCOUNT)).rejects.toThrow(/Authentication error/);
  });
});
