// Unit coverage for `flint doctor`.
//
// We run doctor against real temp dirs (no creds, no wrangler.toml, no
// manifest) and assert on the structured JSON output. The check categories
// are stable; the detail messages are intentionally not asserted on
// (they're human-facing and may evolve).

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runDoctor } from '../../src/commands/doctor.js';

let workDir: string;
let originalCwd: string;
let originalConfigHome: string | undefined;
let stdoutSpy: ReturnType<typeof vi.spyOn>;
let captured: string[];

beforeEach(() => {
  workDir = mkdtempSync(join(tmpdir(), 'flint-doctor-'));
  originalCwd = process.cwd();
  process.chdir(workDir);
  // Point credentials home at a fresh empty dir so the doctor sees "no creds".
  originalConfigHome = process.env.FLINT_CONFIG_HOME;
  process.env.FLINT_CONFIG_HOME = mkdtempSync(join(tmpdir(), 'flint-doctor-home-'));
  captured = [];
  stdoutSpy = vi.spyOn(process.stdout, 'write').mockImplementation(((
    chunk: string | Uint8Array,
  ) => {
    captured.push(typeof chunk === 'string' ? chunk : Buffer.from(chunk).toString('utf8'));
    return true;
  }) as typeof process.stdout.write);
});

afterEach(() => {
  stdoutSpy.mockRestore();
  process.chdir(originalCwd);
  if (process.env.FLINT_CONFIG_HOME) rmSync(process.env.FLINT_CONFIG_HOME, { recursive: true, force: true });
  if (originalConfigHome === undefined) delete process.env.FLINT_CONFIG_HOME;
  else process.env.FLINT_CONFIG_HOME = originalConfigHome;
  rmSync(workDir, { recursive: true, force: true });
});

function readJson(): {
  ok: boolean;
  data: {
    cwd: string;
    checks: Array<{ category: string; name: string; status: 'green' | 'yellow' | 'red'; detail: string }>;
    counts: { green: number; yellow: number; red: number };
  };
} {
  return JSON.parse(captured.join('')) as ReturnType<typeof readJson>;
}

describe('flint doctor', () => {
  it('reports node, flint, and package-manager checks', async () => {
    await runDoctor({ json: true });
    const json = readJson();
    expect(json.ok).toBe(true);
    const names = json.data.checks.map((c) => c.name);
    expect(names).toContain('node');
    expect(names).toContain('flint');
    expect(names).toContain('package-manager');
  });

  it('marks node check green on a supported runtime', async () => {
    await runDoctor({ json: true });
    const node = readJson().data.checks.find((c) => c.name === 'node');
    expect(node).toBeDefined();
    // Tests run on Node 20+ (CI matrix). The result will be green or yellow
    // depending on whether the running major is in the explicit support
    // matrix; both are acceptable here.
    expect(['green', 'yellow']).toContain(node?.status);
  });

  it('reports wrangler.toml as yellow when missing', async () => {
    await runDoctor({ json: true });
    const wt = readJson().data.checks.find((c) => c.name === 'wrangler.toml');
    expect(wt?.status).toBe('yellow');
  });

  it('reports wrangler.toml as green when present', async () => {
    writeFileSync(join(workDir, 'wrangler.toml'), 'name = "test"\n');
    captured.length = 0;
    await runDoctor({ json: true });
    const wt = readJson().data.checks.find((c) => c.name === 'wrangler.toml');
    expect(wt?.status).toBe('green');
  });

  it('reports cloudflare-token as yellow when no credentials are stored', async () => {
    await runDoctor({ json: true });
    const tok = readJson().data.checks.find((c) => c.name === 'cloudflare-token');
    expect(tok?.status).toBe('yellow');
  });

  it('marks manifest as yellow when missing', async () => {
    await runDoctor({ json: true });
    const m = readJson().data.checks.find((c) => c.name === 'manifest');
    expect(m?.status).toBe('yellow');
  });

  it('marks manifest as green when present + valid', async () => {
    const manifest = {
      $schema: 'https://flint.op4z.dev/manifest.schema.v1.json',
      version: 1,
      flintVersion: '1.0.0',
      createdAt: '2026-01-01T00:00:00.000Z',
      updatedAt: '2026-01-01T00:00:00.000Z',
      variant: 'pages-functions',
      vars: {},
      history: [],
      files: {},
    };
    writeFileSync(join(workDir, 'flint.manifest.json'), JSON.stringify(manifest));
    captured.length = 0;
    await runDoctor({ json: true });
    const m = readJson().data.checks.find((c) => c.name === 'manifest');
    expect(m?.status).toBe('green');
  });

  it('aggregates counts correctly', async () => {
    await runDoctor({ json: true });
    const { counts, checks } = readJson().data;
    expect(counts.green + counts.yellow + counts.red).toBe(checks.length);
  });

  it('returns lockfile-source PM detection when a lockfile is present', async () => {
    writeFileSync(join(workDir, 'pnpm-lock.yaml'), '');
    captured.length = 0;
    await runDoctor({ json: true });
    const pm = readJson().data.checks.find((c) => c.name === 'package-manager');
    expect(pm?.detail).toMatch(/pnpm/);
  });

  // Suppress an unused variable to ensure the helper is recognised by lint.
  void mkdirSync;
});
