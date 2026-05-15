// Unit coverage for the asset-budget guard.
//
// We stage a synthetic `dist/` tree under a tmp dir and assert:
//   - Empty / missing dist → warnings + exceeded = true
//   - Small assets under budget → no warnings
//   - Inflated JS chunk → per-chunk warning
//   - Inflated total → per-bundle warning
//   - flint.config.json overrides the default thresholds
//
// We use highly-compressible content (repeated 'a') so the gzipped size
// stays predictable: ~1KB of gzipped output for ~100KB raw. To trigger the
// chunk warning we generate uncompressible data (random buffer).

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomBytes } from 'node:crypto';
import {
  DEFAULT_BUDGET,
  inspectAssetBudget,
  loadBudgetConfig,
} from '../../src/util/asset-budget.js';

const KB = 1024;

describe('inspectAssetBudget', () => {
  let tmp: string;
  let dist: string;

  beforeEach(() => {
    tmp = mkdtempSync(join(tmpdir(), 'flint-budget-'));
    dist = join(tmp, 'dist');
  });
  afterEach(() => {
    rmSync(tmp, { recursive: true, force: true });
  });

  it('returns an error report when dist/ is missing', () => {
    const report = inspectAssetBudget(dist);
    expect(report.exceeded).toBe(true);
    expect(report.warnings.length).toBeGreaterThan(0);
    expect(report.warnings[0]).toMatch(/not found/);
  });

  it('accepts a small dist with no warnings', () => {
    mkdirSync(dist, { recursive: true });
    // ~50KB JS file, highly compressible (gzipped is well under 500KB).
    writeFileSync(join(dist, 'index.js'), 'a'.repeat(50 * KB));
    writeFileSync(join(dist, 'index.html'), '<html>hi</html>');
    const report = inspectAssetBudget(dist);
    expect(report.exceeded).toBe(false);
    expect(report.warnings).toEqual([]);
    expect(report.fileCount).toBe(2);
    expect(report.chunks).toHaveLength(1);
  });

  it('warns when a single JS chunk exceeds the per-chunk gzipped budget', () => {
    mkdirSync(dist, { recursive: true });
    // Random bytes don't compress — 600KB raw → ~600KB gzipped > 500KB budget.
    writeFileSync(join(dist, 'big.js'), randomBytes(600 * KB));
    writeFileSync(join(dist, 'index.html'), '<html>hi</html>');
    const report = inspectAssetBudget(dist);
    expect(report.exceeded).toBe(true);
    expect(report.warnings.some((w) => w.includes('big.js') && w.includes('per-chunk'))).toBe(
      true,
    );
  });

  it('warns when total dist size exceeds the bundle budget', () => {
    mkdirSync(dist, { recursive: true });
    // Two highly-compressible JS files; total ~6MB > 5MB bundle budget.
    // Use enough size that gzip doesn't shrink below the threshold.
    writeFileSync(join(dist, 'a.js'), 'a'.repeat(3 * 1024 * 1024));
    writeFileSync(join(dist, 'b.js'), 'b'.repeat(3 * 1024 * 1024));
    const report = inspectAssetBudget(dist);
    expect(report.exceeded).toBe(true);
    expect(report.warnings.some((w) => w.includes('Total dist/'))).toBe(true);
  });

  it('sorts chunks largest-first in the report', () => {
    mkdirSync(dist, { recursive: true });
    writeFileSync(join(dist, 'small.js'), randomBytes(10 * KB));
    writeFileSync(join(dist, 'huge.js'), randomBytes(200 * KB));
    writeFileSync(join(dist, 'mid.js'), randomBytes(50 * KB));
    const report = inspectAssetBudget(dist);
    expect(report.chunks[0]!.path).toBe('huge.js');
    expect(report.chunks[1]!.path).toBe('mid.js');
    expect(report.chunks[2]!.path).toBe('small.js');
  });

  it('honors a tighter custom chunk budget', () => {
    mkdirSync(dist, { recursive: true });
    // 50KB random → ~50KB gzipped. Default 500KB chunk budget passes;
    // tight 10KB budget fails.
    writeFileSync(join(dist, 'app.js'), randomBytes(50 * KB));
    expect(inspectAssetBudget(dist, DEFAULT_BUDGET).exceeded).toBe(false);
    const tighter = inspectAssetBudget(dist, { maxBundleMB: 5, maxChunkKB: 10 });
    expect(tighter.exceeded).toBe(true);
    expect(tighter.warnings[0]).toMatch(/per-chunk/);
  });

  it('walks nested subdirectories', () => {
    mkdirSync(join(dist, 'assets'), { recursive: true });
    writeFileSync(join(dist, 'assets', 'nested.js'), 'a'.repeat(KB));
    writeFileSync(join(dist, 'index.html'), '<html>hi</html>');
    const report = inspectAssetBudget(dist);
    expect(report.fileCount).toBe(2);
    expect(report.chunks).toHaveLength(1);
    expect(report.chunks[0]!.path).toContain('nested.js');
  });
});

describe('loadBudgetConfig', () => {
  let tmp: string;
  beforeEach(() => {
    tmp = mkdtempSync(join(tmpdir(), 'flint-budget-config-'));
  });
  afterEach(() => {
    rmSync(tmp, { recursive: true, force: true });
  });

  it('returns DEFAULT_BUDGET when flint.config.json is missing', () => {
    expect(loadBudgetConfig(tmp)).toEqual(DEFAULT_BUDGET);
  });

  it('reads custom thresholds from flint.config.json', () => {
    writeFileSync(
      join(tmp, 'flint.config.json'),
      JSON.stringify({ assetBudget: { maxBundleMB: 10, maxChunkKB: 250 } }),
    );
    expect(loadBudgetConfig(tmp)).toEqual({ maxBundleMB: 10, maxChunkKB: 250 });
  });

  it('falls back to defaults when flint.config.json is malformed', () => {
    writeFileSync(join(tmp, 'flint.config.json'), '{not valid json');
    expect(loadBudgetConfig(tmp)).toEqual(DEFAULT_BUDGET);
  });

  it('keeps defaults for keys not specified in flint.config.json', () => {
    writeFileSync(
      join(tmp, 'flint.config.json'),
      JSON.stringify({ assetBudget: { maxBundleMB: 12 } }),
    );
    const config = loadBudgetConfig(tmp);
    expect(config.maxBundleMB).toBe(12);
    expect(config.maxChunkKB).toBe(DEFAULT_BUDGET.maxChunkKB);
  });
});
