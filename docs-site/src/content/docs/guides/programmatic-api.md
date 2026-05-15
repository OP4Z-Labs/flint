---
title: Programmatic API
description: Import @op4z/flint from Node scripts and CI workflows to call Flint commands without the CLI binary.
---

Flint v1.0 ships a stable programmatic API in addition to the `flint` CLI binary. Any code that imports `@op4z/flint` consumes the contract documented here.

## Install

```bash
npm install @op4z/flint
# or pnpm / bun / yarn equivalents
```

The package's `main` and `types` point at `dist/index.js` / `dist/index.d.ts`. The CLI binary remains at `dist/cli.js` (resolved via `bin`).

## Surface

```typescript
import {
  // Top-level command runners — mirror the CLI subcommands.
  init,
  createApp,
  configure,
  deploy,
  upgrade,
  config,

  // Add commands.
  addKv,
  addR2,
  addSecret,
  addPwa,
  addAuth,
  addRateLimit,
  addFeature,   // dispatcher that takes a string feature name

  // Auth runners.
  authInit,
  authStatus,
  authDoctor,
  authRotate,
  authPurge,

  // Atomic write primitives.
  writeFileAtomic,
  writeJsonAtomic,

  // Manifest types + classification.
  readManifest,
  writeManifest,
  classifyAll,
  classifyFile,
  MANIFEST_FILENAME,
  MANIFEST_SCHEMA_VERSION,
  MANIFEST_SCHEMA_URL,
  type Manifest,
  type ManifestFileEntry,

  // Telemetry types.
  buildEventPayload,
  emitEvent,
  readTelemetryPrefs,
  setTelemetryEnabled,
  type TelemetryEvent,
  type TelemetryPrefs,

  // Package version helper.
  version,
} from '@op4z/flint';
```

## Quick examples

### Scaffold a new app from a Node script

```typescript
import { createApp } from '@op4z/flint';

await createApp({
  appName: 'my-app',
  variant: 'pages-fullstack',
  noInstall: true,
  noGit: false,
  provision: false,
  yes: true,
});
```

### Run a drift check in CI

```typescript
import { classifyAll, readManifest } from '@op4z/flint';

const manifest = readManifest(process.cwd());
if (!manifest) {
  console.error('No flint.manifest.json — run `flint upgrade` to backfill.');
  process.exit(1);
}
const classified = classifyAll(process.cwd(), manifest);
const drift = classified.filter((c) =>
  c.state.kind === 'modified' || c.state.kind === 'missing'
);
if (drift.length > 0) {
  console.error(`${drift.length} drifted file(s):`);
  for (const d of drift) console.error(`  - ${d.relPath} (${d.state.kind})`);
  process.exit(1);
}
console.log('In sync with current Flint templates.');
```

### Atomic file writes for your own scaffolders

```typescript
import { writeFileAtomic, writeJsonAtomic } from '@op4z/flint';

writeFileAtomic('build/output.html', '<!doctype html>...', { mode: 0o644 });
writeJsonAtomic('build/manifest.json', { hash: 'abc123' });
```

### Build a custom telemetry collector

The telemetry event shape is part of the contract — see `docs/telemetry-transparency.md` for the field list. If you self-host an endpoint:

```typescript
import { buildEventPayload } from '@op4z/flint';

const payload = buildEventPayload({ event: 'my-custom-event' });
// payload now contains flintVersion, os, node, ts — and your event name.
```

## What's NOT exported (and why)

- The Cloudflare REST client (`src/cloudflare/api.ts`). Specific to Flint's needs. Use a general-purpose Cloudflare client if you want one.
- Interactive prompt machinery. Library callers should pass pre-resolved options, not be subject to TTY-detection logic.
- The CLI Commander wiring. That's the CLI's concern; the programmatic API is option-shape-first.

## Stability guarantees

All names exported from `@op4z/flint` follow semver:

- **MINOR releases** may add new exports.
- **PATCH releases** never change the export surface.
- **MAJOR releases** are the only place where exports may be renamed or removed.

The same applies to type signatures. Adding optional fields to an options interface is a minor bump; removing or renaming a field is major.
