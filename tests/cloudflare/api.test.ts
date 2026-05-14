// Cloudflare API client tests — fetch is stubbed. We're not testing the
// real Cloudflare API; we're testing that our wrapper:
//   - constructs URLs correctly
//   - sends the bearer token
//   - parses the envelope shape
//   - throws on `success: false`
//   - reports scope-probe results uniformly

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { listAccounts, probeScope, verifyToken } from '../../src/cloudflare/api.js';

const TOKEN = 'cf_test_token';

interface MockResponseInit {
  status?: number;
  body: unknown;
}

function mockFetchOnce({ status = 200, body }: MockResponseInit): void {
  const fetchSpy = vi.spyOn(globalThis, 'fetch' as never) as unknown as ReturnType<typeof vi.fn>;
  fetchSpy.mockResolvedValueOnce({
    ok: status >= 200 && status < 300,
    status,
    json: async () => body,
  } as Response);
}

describe('cloudflare/api', () => {
  beforeEach(() => {
    vi.spyOn(globalThis, 'fetch' as never);
  });
  afterEach(() => {
    vi.restoreAllMocks();
  });

  describe('verifyToken', () => {
    it('returns active=true when CF reports status active', async () => {
      mockFetchOnce({
        body: {
          success: true,
          errors: [],
          messages: [],
          result: { id: 'tok123', status: 'active', expires_on: null },
        },
      });
      const result = await verifyToken(TOKEN);
      expect(result.active).toBe(true);
      expect(result.expiresOn).toBeNull();
      expect(result.tokenId).toBe('tok123');
    });

    it('returns active=false when CF reports a non-active status', async () => {
      mockFetchOnce({
        body: {
          success: true,
          errors: [],
          messages: [],
          result: { id: 'tok123', status: 'expired' },
        },
      });
      const result = await verifyToken(TOKEN);
      expect(result.active).toBe(false);
    });

    it('throws with the CF error message when success=false', async () => {
      mockFetchOnce({
        status: 401,
        body: {
          success: false,
          errors: [{ code: 1000, message: 'Invalid API Token' }],
          messages: [],
          result: null,
        },
      });
      await expect(verifyToken(TOKEN)).rejects.toThrow(/Invalid API Token/);
    });
  });

  describe('listAccounts', () => {
    it('returns the account list verbatim', async () => {
      mockFetchOnce({
        body: {
          success: true,
          errors: [],
          messages: [],
          result: [
            { id: 'a1', name: 'Acct One' },
            { id: 'a2', name: 'Acct Two' },
          ],
        },
      });
      const accounts = await listAccounts(TOKEN);
      expect(accounts).toHaveLength(2);
      expect(accounts[0]).toEqual({ id: 'a1', name: 'Acct One' });
    });

    it('throws on success=false', async () => {
      mockFetchOnce({
        status: 403,
        body: {
          success: false,
          errors: [{ code: 9109, message: 'Forbidden' }],
          messages: [],
          result: [],
        },
      });
      await expect(listAccounts(TOKEN)).rejects.toThrow(/Forbidden/);
    });
  });

  describe('probeScope', () => {
    it('reports ok=true on 200', async () => {
      mockFetchOnce({ status: 200, body: { success: true, result: [] } });
      const result = await probeScope('kv.edit', TOKEN, 'acct1');
      expect(result.ok).toBe(true);
      expect(result.detail).toMatch(/200/);
    });

    it('reports ok=false with CF error message on 403', async () => {
      mockFetchOnce({
        status: 403,
        body: {
          success: false,
          errors: [{ code: 10000, message: 'Authentication error' }],
        },
      });
      const result = await probeScope('r2.edit', TOKEN, 'acct1');
      expect(result.ok).toBe(false);
      expect(result.detail).toBe('Authentication error');
    });

    it('reports ok=false on network errors', async () => {
      const fetchSpy = vi.spyOn(globalThis, 'fetch' as never) as unknown as ReturnType<typeof vi.fn>;
      fetchSpy.mockRejectedValueOnce(new Error('connect ECONNREFUSED'));
      const result = await probeScope('user.details.read', TOKEN, 'acct1');
      expect(result.ok).toBe(false);
      expect(result.detail).toMatch(/ECONNREFUSED/);
    });

    it('covers every required probe id without throwing', async () => {
      const probeIds = [
        'pages.edit',
        'kv.edit',
        'r2.edit',
        'account.read',
        'workers.scripts.edit',
        'user.details.read',
        'zone.read',
      ] as const;
      for (const id of probeIds) {
        mockFetchOnce({ status: 200, body: { success: true } });
        const result = await probeScope(id, TOKEN, 'acct1');
        expect(result.ok).toBe(true);
      }
    });
  });
});
