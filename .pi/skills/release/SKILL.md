---
name: release
description: Create a GitHub release with changelog. Use when asked to release, publish, or bump this package.
---

# Release

Release only from the canonical repository `https://github.com/domainus/pi-interactive-subagents`.

## 1. Establish a release-ready branch

1. Read `package.json` and the newest version tags.
2. Resolve the user-requested patch/minor/major or exact semver without `npm version`.
3. Inspect `git branch --show-current`, `git status --short`, and recent commits.
4. Require all intended feature/documentation changes to be reviewed and committed before the version bump. Stop on unrelated or unexplained changes. A previously documented protected `package-lock.json` modification may remain unstaged only when its expected SHA-256 is known and reverified.
5. Never stage, regenerate, or modify `package-lock.json` unless the user separately requests it. Preserve `LICENSE` byte-for-byte.

Record protected hashes with:

```bash
shasum -a 256 package-lock.json LICENSE
```

## 2. Pre-bump verification

```bash
npm test
git diff --check
```

When an integration-harness mux and authenticated test model are available, also follow the `run-integration-tests` skill and run `npm run test:integration`. Report any unavailable, skipped, or timed-out real-model coverage honestly.

## 3. Prepare release notes

Generate commits since the newest tag and group conventional commits under Features, Bug Fixes, Refactoring, and Other Changes. Begin the notes with:

````markdown
Install:

```bash
pi install git:github.com/domainus/pi-interactive-subagents@v<VERSION>
```

Or latest:

```bash
pi install git:github.com/domainus/pi-interactive-subagents
```
````

Create and verify the notes file before invoking `gh`:

```bash
NOTES_FILE=$(mktemp "${TMPDIR:-/tmp}/pi-interactive-subagents-release.XXXXXX")
NOTES_PATH_FILE=$(git rev-parse --git-path pi-release-notes-path)
printf '%s\n' "$NOTES_FILE" > "$NOTES_PATH_FILE"
# Write the reviewed install block and changelog to "$NOTES_FILE".
test -s "$NOTES_FILE"
```

## 4. Bump and verify before committing

Edit only the `version` field in `package.json`; do not use `npm version`. Then run:

```bash
npm test
git diff --check
shasum -a 256 package-lock.json LICENSE
git diff -- package.json
```

If an integration run was required for this release, run it against the bumped tree too. Confirm that the only newly intended uncommitted release change is `package.json` (apart from the separately documented, unstaged protected lockfile state).

## 5. Commit, tag, publish

Only after explicit user authorization:

```bash
git add package.json
# Confirm package-lock.json is not staged.
! git diff --cached --name-only | grep -qx package-lock.json
git commit -m "chore(release): v<VERSION>"
git tag v<VERSION>
git push origin HEAD
git push origin v<VERSION>
NOTES_PATH_FILE=$(git rev-parse --git-path pi-release-notes-path)
NOTES_FILE=$(cat "$NOTES_PATH_FILE")
test -s "$NOTES_FILE"
gh release create v<VERSION> --repo domainus/pi-interactive-subagents \
  --title "v<VERSION>" --notes-file "$NOTES_FILE"
```

Do not use `git push --tags`, which could publish unrelated local tags. After `gh release create` succeeds, remove both `"$NOTES_FILE"` and `"$NOTES_PATH_FILE"`.

## 6. Verify

```bash
gh release view v<VERSION> --repo domainus/pi-interactive-subagents
```

Report the tag and `https://github.com/domainus/pi-interactive-subagents/releases/tag/v<VERSION>`, test results, integration coverage or limitation, and final protected hashes.
