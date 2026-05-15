// Integration coverage for `flint create-app --template <git+url>`.
//
// We can't depend on the public internet for the happy path, so we set up
// a LOCAL git fixture (a temp repo with a tiny scaffold) and point the
// --template flag at it via `file://`. Real-world git URLs follow the same
// clone path; the only thing we don't exercise is HTTPS specifically.

import { afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { CLI_ENTRY, createTempRepo, runFlint, type TempRepo } from './_harness.js';

interface Fixture {
  /** Absolute path to the local "remote" repo's working tree. */
  remoteDir: string;
  /** file:// URL suitable for `git clone`. */
  url: string;
}

function buildLocalGitFixture(): Fixture {
  const remoteDir = mkdtempSync(join(tmpdir(), 'flint-fixture-'));
  // Initialize an empty repo, add scaffold files, commit.
  spawnSync('git', ['init', '-q', '-b', 'main'], { cwd: remoteDir });
  // Identity for the commit.
  spawnSync('git', ['config', 'user.email', 'fixture@example.local'], {
    cwd: remoteDir,
  });
  spawnSync('git', ['config', 'user.name', 'Flint Fixture'], { cwd: remoteDir });

  writeFileSync(
    join(remoteDir, 'README.md'),
    '# template fixture\n\nLocal git fixture for `flint create-app --template`.\n',
    'utf8',
  );
  writeFileSync(
    join(remoteDir, 'package.json'),
    JSON.stringify(
      {
        name: 'template-fixture',
        version: '0.0.0',
        private: true,
        type: 'module',
        scripts: { test: 'echo no-op' },
      },
      null,
      2,
    ) + '\n',
    'utf8',
  );
  mkdirSync(join(remoteDir, 'src'), { recursive: true });
  writeFileSync(
    join(remoteDir, 'src/main.tsx'),
    "// fixture main\nconsole.log('hello from fixture')\n",
    'utf8',
  );

  spawnSync('git', ['add', '-A'], { cwd: remoteDir });
  const commitRes = spawnSync(
    'git',
    ['commit', '-q', '-m', 'fixture: initial scaffold'],
    { cwd: remoteDir },
  );
  if (commitRes.status !== 0) {
    rmSync(remoteDir, { recursive: true, force: true });
    throw new Error('Failed to commit local git fixture.');
  }
  return { remoteDir, url: `git+file://${remoteDir}` };
}

describe('flint create-app --template <git+url> (integration)', () => {
  let target: TempRepo;
  let fixture: Fixture;

  beforeAll(() => {
    if (!existsSync(CLI_ENTRY)) {
      throw new Error(`Build artifact missing: ${CLI_ENTRY}. Run npm run build.`);
    }
  });

  beforeEach(() => {
    target = createTempRepo();
    fixture = buildLocalGitFixture();
  });

  afterEach(() => {
    target.cleanup();
    rmSync(fixture.remoteDir, { recursive: true, force: true });
  });

  it('clones a local git fixture and copies the scaffold into the new app dir', () => {
    const res = runFlint(
      [
        'create-app',
        'cloned-app',
        '--variant',
        'static-spa',
        '--template',
        fixture.url,
        '--no-install',
        '--no-git',
        '--yes',
      ],
      { cwd: target.dir },
    );
    expect(res.status, `create-app failed:\n${res.stdout}\n${res.stderr}`).toBe(0);

    // Fixture files should be present.
    expect(existsSync(join(target.dir, 'cloned-app/README.md'))).toBe(true);
    expect(existsSync(join(target.dir, 'cloned-app/package.json'))).toBe(true);
    expect(existsSync(join(target.dir, 'cloned-app/src/main.tsx'))).toBe(true);

    // The clone's .git/ directory must NOT survive.
    expect(existsSync(join(target.dir, 'cloned-app/.git'))).toBe(false);

    // Flint manifest should be present and record the cloned files.
    const manifestPath = join(target.dir, 'cloned-app/flint.manifest.json');
    expect(existsSync(manifestPath)).toBe(true);
    const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));
    expect(manifest.files['README.md']).toBeDefined();
    expect(manifest.files['src/main.tsx']).toBeDefined();
    expect(manifest.history[0].command).toMatch(/--template/);
  });

  it('rejects malformed template URLs with a clear error', () => {
    const res = runFlint(
      [
        'create-app',
        'should-fail-app',
        '--variant',
        'static-spa',
        '--template',
        'https://github.com/user/repo', // missing git+ prefix
        '--no-install',
        '--no-git',
        '--yes',
      ],
      { cwd: target.dir },
    );
    expect(res.status).not.toBe(0);
    const combined = `${res.stdout}\n${res.stderr}`;
    expect(combined).toMatch(/git\+/);
  });
});
