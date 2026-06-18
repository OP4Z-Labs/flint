// Programmatic API for `@op4z/flint`.
//
// Anything imported from `@op4z/flint` (rather than invoked via the CLI binary)
// is part of the v1.0 public API surface. Keep this list intentional —
// every exported symbol is a contract.
//
// Layered surface:
//   1. Top-level command runners — `init`, `addFeature`, `configure`, `deploy`,
//      `upgrade`. These match the CLI subcommands one-to-one and accept the
//      same option shapes (sans Commander parsing).
//   2. Atomic write helpers — `writeFileAtomic`, `writeJsonAtomic`. These
//      are the same primitives the CLI uses, exposed so library callers can
//      build their own scaffolders without re-implementing the convention.
//   3. Manifest types — `Manifest`, `ManifestFileEntry`, etc. Tools that
//      inspect a Flint-managed project (CI gates, monorepo tooling) read
//      the manifest, so its shape is part of the contract.
//   4. Telemetry types — `TelemetryEvent`, `TelemetryPrefs`. Same rationale:
//      anyone parsing `telemetry.log` reads these shapes.
//
// What's NOT exported (deliberately):
//   - The Cloudflare REST client (`src/cloudflare/api.ts`). Specific to
//     Flint's needs; not a general CF client.
//   - The interactive prompt machinery. Library callers should pass
//     pre-resolved options, not be subject to TTY-detection logic.
//   - The CLI Commander wiring. That's the CLI's concern.

export { runInit as init } from './commands/init.js';
export type { InitOptions, InitVariant } from './commands/init.js';

export { runCreateApp as createApp } from './commands/create-app.js';
export type { CreateAppOptions } from './commands/create-app.js';

// ─── Template-pack registry (additive, generic-engine seam) ─────────────────
// An external pack (e.g. the Client Site Kit) contributes templates without
// putting business logic into Flint. These exports let library callers load /
// validate packs and scaffold from them programmatically.
export { runCreateAppFromPack as createAppFromPack } from './commands/create-app-pack.js';
export type { CreateAppFromPackOptions } from './commands/create-app-pack.js';
export {
  loadPack,
  validatePack,
  resolvePackVars,
  applyTransform,
  findTemplate,
  PackValidationError,
  FLINT_PACK_FORMAT,
} from './util/pack.js';
export type {
  Pack,
  PackVar,
  PackTemplate,
  PackTemplateBindings,
  VarTransform,
  PackRendering,
} from './util/pack.js';
export {
  TemplateRegistry,
  BUILTIN_VARIANTS,
  BUILTIN_VARIANT_DESCRIPTIONS,
  isBuiltinVariant,
} from './util/registry.js';
export type { RegistryEntry, BuiltinVariant } from './util/registry.js';

export { runConfigure as configure } from './commands/configure.js';
export type { ConfigureOptions } from './commands/configure.js';

export { runDeploy as deploy } from './commands/deploy.js';
export type { DeployOptions } from './commands/deploy.js';

export { runUpgrade as upgrade } from './commands/upgrade.js';
export type { UpgradeOptions } from './commands/upgrade.js';

export { runAddKv as addKv } from './commands/add.js';
export { runAddR2 as addR2 } from './commands/add.js';
export { runAddD1 as addD1 } from './commands/add.js';
export { runAddSecret as addSecret } from './commands/add.js';
export type {
  AddKvOptions,
  AddR2Options,
  AddD1Options,
  AddSecretOptions,
} from './commands/add.js';

export { runAddPwa as addPwa } from './commands/add-features.js';
export { runAddAuth as addAuth } from './commands/add-features.js';
export { runAddRateLimit as addRateLimit } from './commands/add-features.js';
export type {
  AddPwaOptions,
  AddAuthOptions,
  AddRateLimitOptions,
} from './commands/add-features.js';

/**
 * Convenience entrypoint that dispatches on a string feature name. Mirrors
 * `flint add <feature>` for callers who already have the feature as a
 * variable rather than at the type level.
 */
export async function addFeature(
  feature: 'pwa' | 'auth' | 'rate-limit',
  options: { force?: boolean; yes?: boolean } = {},
): Promise<void> {
  const { runAddPwa, runAddAuth, runAddRateLimit } = await import('./commands/add-features.js');
  const force = options.force === true;
  const yes = options.yes === true;
  if (feature === 'pwa') return runAddPwa({ force, yes });
  if (feature === 'auth') return runAddAuth({ force, yes });
  if (feature === 'rate-limit') return runAddRateLimit({ force, yes });
  // Exhaustiveness check — TS forbids ever hitting this branch, but the
  // runtime guard catches typos from JS callers.
  throw new Error(`[flint] addFeature: unknown feature "${String(feature)}" — valid feature names: pwa, auth, rate-limit.`);
}

export { runConfig as config } from './commands/config.js';
export type { ConfigOptions } from './commands/config.js';

// ─── Auth helpers ──────────────────────────────────────────────────────────
export {
  authInit,
  authStatus,
  authDoctor,
  authRotate,
  authPurge,
} from './commands/auth.js';

// ─── Atomic write helpers ──────────────────────────────────────────────────
export { writeFileAtomic, writeJsonAtomic } from './util/atomic-write.js';
export type { AtomicWriteOptions } from './util/atomic-write.js';

// ─── Manifest types + classification ───────────────────────────────────────
export {
  readManifest,
  writeManifest,
  classifyAll,
  classifyFile,
  MANIFEST_FILENAME,
  MANIFEST_SCHEMA_VERSION,
  MANIFEST_SCHEMA_URL,
} from './util/manifest.js';
export type {
  Manifest,
  ManifestFileEntry,
  ManifestHistoryEntry,
  FileState,
  ClassifiedFile,
} from './util/manifest.js';

// ─── Telemetry types ───────────────────────────────────────────────────────
export {
  buildEventPayload,
  emitEvent,
  readTelemetryPrefs,
  setTelemetryEnabled,
  telemetryPath,
  telemetryLogPath,
} from './util/telemetry.js';
export type { TelemetryEvent, TelemetryPrefs } from './util/telemetry.js';

// ─── Package version ───────────────────────────────────────────────────────
export { readPackageVersion as version } from './util/version.js';
