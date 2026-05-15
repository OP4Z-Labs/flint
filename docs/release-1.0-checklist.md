# Release 1.0 checklist

This is the canonical checklist for publishing `@op4z/flint@1.0.0` (and any
future MAJOR/MINOR release). The release itself is run by Beau — this doc
documents the steps so they're reproducible.

## Pre-publish

### 1. All gates green

```bash
npm run build
npm run lint
npm run typecheck
npm test
```

Expected: zero errors, all tests pass (current target: 354 passing + 1 skipped on Linux).

### 2. Test against the three target apps (cross-check)

For each of the three rescaffold reports, run the rescaffold once more on
a fresh COPY of each target app (never touch the originals — assumes the
three apps live as sibling directories alongside this repo):

```bash
SRC=<directory containing your portfolio, chorus, blaze repos>
DST=<scratch directory for release-test copies>
for app in portfolio chorus blaze; do
  cp -r "$SRC/$app" "$DST/$app"
  cd "$DST/$app"
  npm install
  flint upgrade --check
  flint upgrade --accept-current
  flint upgrade --check  # should report clean
  npm run build && npm test
done
```

If any of the three regresses, do NOT publish. Investigate first.

### 3. Smoke-test on Node 20, 22, 24

```bash
nvm use 20 && npm test
nvm use 22 && npm test
nvm use 24 && npm test
```

All three should pass.

### 4. CHANGELOG.md reviewed

```bash
cat CHANGELOG.md | head -100
```

Verify the `[1.0.0]` entry lists every shipped change, categorized as
Added / Changed / Fixed / Removed. Tone should match prior entries.

### 5. Version bumped

```bash
grep '"version"' package.json
# Expected: "version": "1.0.0",

grep '"private"' package.json
# Expected: NOT present (or set to false)
```

If `private: true` is still in `package.json`, npm will refuse to publish.
Remove it (or set to `false`) before continuing.

### 6. `npm pack` review

```bash
npm pack --dry-run
```

This prints the tarball contents without writing it. Verify:

- `dist/` is included
- `templates/` is included
- `README.md` and `LICENSE` are included
- `CHANGELOG.md` is included
- `node_modules/`, `tests/`, `coverage/`, `.git/`, `docs-site/` are NOT included
- Total size is reasonable (under 5 MB)

To actually inspect the contents:

```bash
npm pack
tar -tzf op4z-flint-1.0.0.tgz | sort
rm op4z-flint-1.0.0.tgz
```

### 7. `npm publish --dry-run`

```bash
npm publish --dry-run --access public
```

Verify the printed plan: name, version, tag (`latest`), access (`public`),
registry (`https://registry.npmjs.org/`).

### 8. Doctor on a clean checkout

```bash
cd /tmp
git clone https://github.com/beau-g/flint.git flint-release-test
cd flint-release-test
npm install
npm run build
node ./dist/cli.js doctor
```

`doctor` should report all green (with a yellow on the wrangler check if
wrangler isn't installed locally — that's fine).

## Publish

### 9. Publish to npm

```bash
npm publish --access public
```

Wait for the success message. The first-publish flow on a scoped package
requires `--access public` because npm defaults scoped packages to private.

### 10. Verify on npm

```bash
npm view @op4z/flint version
# Expected: 1.0.0

npm view @op4z/flint dist-tags
# Expected: { latest: '1.0.0' }
```

Browse https://www.npmjs.com/package/@op4z/flint to verify the README,
keywords, and version badge.

### 11. Tag the git release

```bash
git tag -a v1.0.0 -m "v1.0.0 — first stable release"
git push origin v1.0.0
```

### 12. GitHub release

Open https://github.com/beau-g/flint/releases/new?tag=v1.0.0 and paste the
`[1.0.0]` section of `CHANGELOG.md` as the release notes.

## Post-publish

### 13. Verify global install

On a clean machine (or a fresh user account):

```bash
npm install -g @op4z/flint
flint --version
# Expected: 1.0.0
flint doctor
```

### 14. Announce

- Update https://flint.op4z.dev (deploy `docs-site/` to Cloudflare Pages).
- Post to social as desired.

### 15. Monitor for early bugs

Watch https://github.com/beau-g/flint/issues for the first 48 hours.
Any "install fails on Node X" or "wrong path on Windows" reports should
get same-day patches.

## Rollback

If a critical bug is reported within the first hour:

```bash
npm unpublish @op4z/flint@1.0.0
```

(npm only allows unpublish within 72 hours; after that, publish a patch
that supersedes the broken version.)

## Future releases

The same checklist applies for `1.x.y` and `2.0.0`. Adjust:

- **MINOR (1.x.0)**: section 1 + 2 + 3 + 4 + 5 + 6 + 7 + 9 + 10 + 11 + 12 + 15.
- **PATCH (1.0.x)**: section 1 + 4 + 5 + 6 + 9 + 10 + 11 + 15.
- **MAJOR (2.0.0)**: full checklist + a fresh migration doc.
