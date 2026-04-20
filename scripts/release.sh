#!/usr/bin/env bash
# Runway release script
#
# Usage:
#   npm run release            # patch bump (0.1.3 → 0.1.4)
#   npm run release:minor      # minor bump (0.1.3 → 0.2.0)
#   npm run release:major      # major bump (0.1.3 → 1.0.0)
#   DRY=true npm run release   # dry-run: preview without making changes
#
# What this does:
#   1. Validates clean working tree + main branch + up-to-date with origin
#   2. Bumps version in apps/electron/package.json and root package.json
#   3. Commits as "chore: release vX.Y.Z" and creates a git tag
#   4. Pushes commit + tag → GitHub Actions takes over:
#      - Builds macOS (arm64 + x64), Linux, Windows in parallel
#      - Uploads artifacts to a GitHub Release
#      - Generates release notes from merged PRs
#      - Publishes the release automatically
#
# Prerequisites:
#   - gh CLI authenticated (gh auth status)
#   - On main branch, clean and up-to-date

set -euo pipefail

BUMP="${1:-patch}"
DRY="${DRY:-false}"
REPO="mcglothi/runway"

# ── Validate bump argument ────────────────────────────────────────────────────
case "$BUMP" in
  patch|minor|major) ;;
  *) echo "✗ Invalid bump type: '$BUMP'. Use patch, minor, or major." >&2; exit 1 ;;
esac

# ── Guards ────────────────────────────────────────────────────────────────────
if [[ -n "$(git status --porcelain)" ]]; then
  echo "✗ Working tree is dirty. Commit or stash changes first." >&2
  exit 1
fi

BRANCH="$(git rev-parse --abbrev-ref HEAD)"
if [[ "$BRANCH" != "main" ]]; then
  echo "✗ Must be on main branch (currently on '$BRANCH')." >&2
  exit 1
fi

git fetch origin main --tags -q
LOCAL="$(git rev-parse HEAD)"
REMOTE="$(git rev-parse origin/main)"
if [[ "$LOCAL" != "$REMOTE" ]]; then
  echo "✗ Local main is out of sync with origin/main. Run 'git pull' first." >&2
  exit 1
fi

# ── Bump version ──────────────────────────────────────────────────────────────
npm version "$BUMP" -w apps/electron --no-git-tag-version -q

VERSION="$(node -p "require('./apps/electron/package.json').version")"

# Keep root package.json version in sync
node -e "
  const fs = require('fs');
  const pkg = JSON.parse(fs.readFileSync('package.json', 'utf8'));
  pkg.version = process.argv[1];
  fs.writeFileSync('package.json', JSON.stringify(pkg, null, 2) + '\n');
" "$VERSION"

echo "→ Preparing release v$VERSION ($BUMP bump)"

if [[ "$DRY" == "true" ]]; then
  echo ""
  echo "[dry-run] Would:"
  echo "  git commit -m 'chore: release v$VERSION'"
  echo "  git tag v$VERSION"
  echo "  git push origin main --follow-tags"
  echo "  → CI builds macOS/Linux/Windows and publishes the GitHub release"
  echo ""
  echo "Reverting version bump (dry-run)..."
  git checkout apps/electron/package.json package.json
  exit 0
fi

# ── Commit, tag, push ─────────────────────────────────────────────────────────
git add apps/electron/package.json package.json
git commit -m "chore: release v$VERSION"
git tag "v$VERSION"
git push origin main --follow-tags

echo ""
echo "✓ v$VERSION tagged and pushed."
echo ""
echo "  CI is now building all platform releases."
echo "  Track progress: https://github.com/$REPO/actions"
echo "  Release page:   https://github.com/$REPO/releases/tag/v$VERSION"
