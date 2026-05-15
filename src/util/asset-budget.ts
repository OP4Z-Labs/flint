// Asset budget guard for `flint deploy`.
//
// Walks the build output directory (default `dist/`) and totals the size of
// every file. Flags two thresholds:
//
//   - Total dist/ size:        warns if greater than maxBundleMB (default 5)
//   - Single JS chunk size:    warns if greater than maxChunkKB (default 500)
//
// We measure chunk size **gzipped** because that's what users actually pay
// for over the wire — uncompressed JS sizes are misleading on a modern
// HTTP/2 + brotli stack. `node:zlib.gzipSync` is fine for one-shot sizing
// (every chunk is read into a Buffer first anyway).
//
// Configuration sources, in priority order:
//   1. CLI flags passed to `flint deploy` (--max-bundle-mb, --max-chunk-kb)
//   2. `flint.config.json` at the project root
//   3. Defaults below
//
// Why introduce `flint.config.json` now: asset budgets are the only thing
// users will realistically want to tune (every repo has different limits).
// The file stays optional and minimal. Broader config-as-file is deferred
// to v0.9.

import { gzipSync } from 'node:zlib';
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { extname, join, relative } from 'node:path';

export interface AssetBudgetConfig {
  /** Maximum total `dist/` size, in megabytes. Default 5. */
  maxBundleMB: number;
  /** Maximum single JS chunk size, gzipped, in kilobytes. Default 500. */
  maxChunkKB: number;
}

export const DEFAULT_BUDGET: AssetBudgetConfig = {
  maxBundleMB: 5,
  maxChunkKB: 500,
};

export interface AssetBudgetReport {
  /** Total `dist/` size in bytes (un-gzipped). */
  totalBytes: number;
  /** Number of files inspected. */
  fileCount: number;
  /** Per-chunk gzipped sizes for JS files, sorted descending. */
  chunks: Array<{ path: string; bytes: number; gzippedBytes: number }>;
  /** Warnings raised against the active budget. */
  warnings: string[];
  /** True if at least one warning was raised. */
  exceeded: boolean;
}

/** Read `flint.config.json` from `cwd` if present; return defaults otherwise. */
export function loadBudgetConfig(cwd: string): AssetBudgetConfig {
  const path = join(cwd, 'flint.config.json');
  if (!existsSync(path)) return { ...DEFAULT_BUDGET };
  try {
    const raw = readFileSync(path, 'utf8');
    const parsed = JSON.parse(raw) as { assetBudget?: Partial<AssetBudgetConfig> };
    const budget = parsed.assetBudget ?? {};
    return {
      maxBundleMB:
        typeof budget.maxBundleMB === 'number' ? budget.maxBundleMB : DEFAULT_BUDGET.maxBundleMB,
      maxChunkKB:
        typeof budget.maxChunkKB === 'number' ? budget.maxChunkKB : DEFAULT_BUDGET.maxChunkKB,
    };
  } catch {
    // Malformed config: fall back to defaults rather than failing the deploy.
    return { ...DEFAULT_BUDGET };
  }
}

/**
 * Inspect `distDir` and produce a budget report. Returns the warnings list,
 * which is empty when nothing exceeded the active thresholds.
 */
export function inspectAssetBudget(
  distDir: string,
  budget: AssetBudgetConfig = DEFAULT_BUDGET,
): AssetBudgetReport {
  if (!existsSync(distDir)) {
    return {
      totalBytes: 0,
      fileCount: 0,
      chunks: [],
      warnings: [`Build output directory not found: ${distDir}`],
      exceeded: true,
    };
  }

  let totalBytes = 0;
  let fileCount = 0;
  const chunks: AssetBudgetReport['chunks'] = [];
  walk(distDir);

  const maxBundleBytes = budget.maxBundleMB * 1024 * 1024;
  const maxChunkBytes = budget.maxChunkKB * 1024;
  const warnings: string[] = [];

  if (totalBytes > maxBundleBytes) {
    warnings.push(
      `Total dist/ size ${formatMB(totalBytes)} exceeds budget ${budget.maxBundleMB} MB.`,
    );
  }
  for (const c of chunks) {
    if (c.gzippedBytes > maxChunkBytes) {
      warnings.push(
        `${c.path}: gzipped ${formatKB(c.gzippedBytes)} exceeds per-chunk budget ` +
          `${budget.maxChunkKB} KB.`,
      );
    }
  }

  // Sort largest-first for printing.
  chunks.sort((a, b) => b.gzippedBytes - a.gzippedBytes);

  return {
    totalBytes,
    fileCount,
    chunks,
    warnings,
    exceeded: warnings.length > 0,
  };

  function walk(dir: string): void {
    for (const entry of readdirSync(dir)) {
      const abs = join(dir, entry);
      const stat = statSync(abs);
      if (stat.isDirectory()) {
        walk(abs);
        continue;
      }
      totalBytes += stat.size;
      fileCount += 1;
      if (extname(abs) === '.js') {
        const buf = readFileSync(abs);
        const gz = gzipSync(buf);
        chunks.push({
          path: relative(distDir, abs),
          bytes: buf.length,
          gzippedBytes: gz.length,
        });
      }
    }
  }
}

export function formatMB(bytes: number): string {
  return `${(bytes / (1024 * 1024)).toFixed(2)} MB`;
}
export function formatKB(bytes: number): string {
  return `${(bytes / 1024).toFixed(1)} KB`;
}
