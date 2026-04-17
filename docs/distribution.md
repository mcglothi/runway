# Distribution

## Releasing a new version

### 1. Bump the version

Update `version` in `apps/electron/package.json` and commit:

```bash
# Edit apps/electron/package.json — set "version": "x.y.z"
git add apps/electron/package.json
git commit -m "chore: bump version to x.y.z"
git tag vx.y.z
git push origin main --tags
```

The GitHub Actions `release.yml` workflow triggers on version tags. It builds
macOS (arm64 + x64 DMGs), Linux (AppImage), and Windows (NSIS installer), then
attaches all artifacts to a GitHub release automatically.

### 2. Notarization (optional, recommended for public distribution)

Set these repository secrets in GitHub → Settings → Secrets and variables:

| Secret | Value |
|--------|-------|
| `APPLE_ID` | Your Apple ID email |
| `APPLE_APP_SPECIFIC_PASSWORD` | App-specific password from appleid.apple.com |
| `APPLE_TEAM_ID` | Your Apple Developer Team ID |
| `CSC_LINK` | Base64-encoded .p12 certificate |
| `CSC_KEY_PASSWORD` | Certificate password |

Without these, the build still produces a DMG — macOS will show a Gatekeeper
warning on first launch that the user must dismiss via System Preferences.

### 3. Homebrew Cask (personal tap)

Create a tap repo at `mcglothi/homebrew-tap`, then copy the cask formula and
update the SHA256 checksums:

```bash
# After the release artifacts are available:
curl -L https://github.com/mcglothi/runway/releases/download/vX.Y.Z/Runway-X.Y.Z-arm64.dmg -o /tmp/runway-arm64.dmg
shasum -a 256 /tmp/runway-arm64.dmg

curl -L https://github.com/mcglothi/runway/releases/download/vX.Y.Z/Runway-X.Y.Z-x64.dmg -o /tmp/runway-x64.dmg
shasum -a 256 /tmp/runway-x64.dmg
```

Edit `scripts/cask/runway.rb`, fill in the checksums, then copy to your tap:

```bash
cp scripts/cask/runway.rb ~/code/homebrew-tap/Casks/runway.rb
# commit + push homebrew-tap
```

Users then install with:

```bash
brew tap mcglothi/tap
brew install --cask runway
```

## Manual build (local DMG)

```bash
cd apps/electron
npm run build:mac
# output: ../../dist/Runway-x.y.z-arm64.dmg
```
