// Integration coverage for `flint upgrade --pack <dir>` — the headline
// "stamp, don't depend; upgrade keeps sites current for years" promise for
// PACK-stamped sites (e.g. the Client Site Kit).
//
// Flow:
//   1. Build a local pack fixture (pack.json + core tree + template tree).
//   2. `create-app --pack` to scaffold a real site with a `pack:` manifest.
//   3. Simulate an UPSTREAM pack fix (edit a core file in the pack).
//   4. Assert:
//        - WITHOUT --pack: pack files are skipped + a loud warning is emitted
//          (proves the gap is real and the fix is opt-in/safe).
//        - WITH --pack --diff: a user-modified pack file re-renders against the
//          current pack (no "Skipping" — the old broken behavior).
//        - WITH --pack --apply: the upstream fix auto-propagates into an
//          UNMODIFIED site file, while a user-MODIFIED site file is NOT
//          auto-clobbered (left for interactive resolution → local edit
//          survives a non-interactive apply).

import { afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { CLI_ENTRY, createTempRepo, runFlint, type TempRepo } from './_harness.js';

interface PackFixture {
  dir: string;
  cleanup: () => void;
}

/**
 * A pack that maps `_core/edge` → `kit/edge` (like the Client Site Kit), plus a
 * template tree with a `.tmpl` config file. Two core files let us exercise both
 * the unmodified-auto-update and modified-preserve paths in one scaffold.
 */
function buildPackFixture(): PackFixture {
  const dir = mkdtempSync(join(tmpdir(), 'flint-upg-pack-'));
  const manifest = {
    flintPackFormat: 1,
    name: '@op4z/upgkit',
    version: '0.1.0',
    core: [{ from: '_core/edge', to: 'kit/edge' }],
    vars: [
      { name: 'siteName', required: true },
      { name: 'siteSlug', from: 'siteName', transform: 'kebab' },
    ],
    templates: [
      {
        id: 'onepager',
        title: 'One pager',
        path: 'templates/onepager',
        rendering: 'spa',
        bindings: { kv: true },
      },
    ],
  };
  writeFileSync(join(dir, 'pack.json'), JSON.stringify(manifest, null, 2), 'utf8');

  mkdirSync(join(dir, '_core/edge'), { recursive: true });
  // response.ts — we will edit THIS upstream and leave the site copy untouched
  // → upgrade must auto-propagate the fix.
  writeFileSync(join(dir, '_core/edge/response.ts'), 'export const responseVersion = 1;\n', 'utf8');
  // helper.ts — the user will edit the SITE copy → upgrade must NOT clobber it.
  writeFileSync(join(dir, '_core/edge/helper.ts'), 'export const helper = () => 0;\n', 'utf8');

  mkdirSync(join(dir, 'templates/onepager/src'), { recursive: true });
  writeFileSync(
    join(dir, 'templates/onepager/wrangler.toml.tmpl'),
    ['name = "{{siteSlug}}"', 'compatibility_date = "2026-05-01"', ''].join('\n'),
    'utf8',
  );
  writeFileSync(
    join(dir, 'templates/onepager/src/site.config.ts.tmpl'),
    'export const siteName = "{{siteName}}";\n',
    'utf8',
  );

  return { dir, cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}

/** Scaffold a site from the fixture pack into `target/site`. Returns the site dir. */
function scaffold(target: TempRepo, pack: PackFixture): string {
  const res = runFlint(
    [
      'create-app',
      'site',
      '--pack',
      pack.dir,
      '--template',
      'onepager',
      '--var',
      'siteName=Acme Cafe',
      '--yes',
    ],
    { cwd: target.dir },
  );
  if (res.status !== 0) {
    throw new Error(`create-app --pack failed:\n${res.stdout}\n${res.stderr}`);
  }
  return join(target.dir, 'site');
}

describe('flint upgrade --pack (integration)', () => {
  let target: TempRepo;
  let pack: PackFixture;

  beforeAll(() => {
    if (!existsSync(CLI_ENTRY)) {
      throw new Error(`Build artifact missing: ${CLI_ENTRY}. Run npm run build.`);
    }
  });

  beforeEach(() => {
    target = createTempRepo();
    pack = buildPackFixture();
  });

  afterEach(() => {
    target.cleanup();
    pack.cleanup();
  });

  it('records pack files with pack: templateSources', () => {
    const site = scaffold(target, pack);
    const manifest = JSON.parse(readFileSync(join(site, 'flint.manifest.json'), 'utf8'));
    expect(manifest.files['kit/edge/response.ts'].templateSource).toBe(
      'pack:@op4z/upgkit/core:_core/edge/response.ts',
    );
  });

  it('WITHOUT --pack: warns and skips pack files on a modified pack file', () => {
    const site = scaffold(target, pack);
    // User edits a pack-stamped file → it classifies as modified.
    const p = join(site, 'kit/edge/response.ts');
    writeFileSync(p, readFileSync(p, 'utf8') + '\n// user edit\n', 'utf8');

    const diff = runFlint(['upgrade', '--diff'], { cwd: site });
    const combined = `${diff.stdout}\n${diff.stderr}`;
    // The up-front warning fires (project has pack sources, no --pack given).
    expect(combined).toContain('scaffolded from a template pack');
    expect(combined).toContain('--pack');
    // And the modified pack file is skipped (cannot re-render without the pack).
    expect(combined).toMatch(/Skipping .*kit\/edge\/response\.ts/);
  });

  it('WITH --pack --diff: re-renders a user-modified pack file (no skip)', () => {
    const site = scaffold(target, pack);
    const p = join(site, 'kit/edge/response.ts');
    writeFileSync(p, 'export const responseVersion = 99; // user changed\n', 'utf8');

    const diff = runFlint(['upgrade', '--diff', '--pack', pack.dir], { cwd: site });
    expect(diff.status, `${diff.stdout}\n${diff.stderr}`).toBe(0);
    const combined = `${diff.stdout}\n${diff.stderr}`;
    expect(combined).toContain('# kit/edge/response.ts');
    // The diff is between the user's version and the CURRENT pack content.
    expect(combined).toMatch(/^@@\s/m);
    expect(combined).not.toMatch(/Skipping .*response\.ts/);
  });

  it('WITH --pack --apply: auto-propagates an upstream fix into an UNMODIFIED site file', () => {
    const site = scaffold(target, pack);
    // The site copy is untouched (unmodified). Land a kit fix upstream.
    writeFileSync(
      join(pack.dir, '_core/edge/response.ts'),
      'export const responseVersion = 2; // upstream kit fix\n',
      'utf8',
    );

    // --apply auto-updates UNMODIFIED files with no prompt; close stdin so the
    // (absent) interactive path can't hang.
    const apply = runFlint(['upgrade', '--apply', '--pack', pack.dir], {
      cwd: site,
      input: '',
    });
    expect(apply.status, `${apply.stdout}\n${apply.stderr}`).toBe(0);

    const onDisk = readFileSync(join(site, 'kit/edge/response.ts'), 'utf8');
    expect(onDisk).toContain('responseVersion = 2');
    expect(onDisk).toContain('upstream kit fix');

    // Manifest re-baselined to the new content → subsequent --check is in sync.
    const recheck = runFlint(['upgrade', '--check', '--pack', pack.dir], { cwd: site });
    expect(`${recheck.stdout}\n${recheck.stderr}`).toMatch(/modified:\s+0/);
  });

  it('WITH --pack --apply: does NOT auto-clobber a user-MODIFIED site file', () => {
    const site = scaffold(target, pack);
    // User edits the SITE copy of helper.ts (now modified vs baseline).
    const helper = join(site, 'kit/edge/helper.ts');
    const localMark = '// LOCAL EDIT — must survive\n';
    writeFileSync(helper, readFileSync(helper, 'utf8') + localMark, 'utf8');
    // And an upstream fix lands on a DIFFERENT, unmodified file.
    writeFileSync(
      join(pack.dir, '_core/edge/response.ts'),
      'export const responseVersion = 2; // upstream\n',
      'utf8',
    );

    // Non-interactive apply: the modified helper.ts hits the interactive prompt.
    // With stdin closed, inquirer aborts rather than taking a destructive
    // action, so the user's edit is never overwritten.
    const apply = runFlint(['upgrade', '--apply', '--pack', pack.dir], {
      cwd: site,
      input: '',
    });
    // SAFETY INVARIANT: a user-modified file is never auto-clobbered by upgrade.
    // (A real interactive run would offer keep / take-new / merge / eject.)
    expect(readFileSync(helper, 'utf8')).toContain('LOCAL EDIT — must survive');
    void apply;
  });
});
