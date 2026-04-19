# Distribution

This project has three distribution states:

1. Available now: clone the repo and build for your platform with `npm run build:*`
2. Ready in repo: tagged GitHub release workflow plus a Homebrew cask template
3. Not live yet: published GitHub release assets and a pushed Homebrew tap

The public docs should only advertise states 1 and 2 until the first release is actually published.

## Current install story

For users today, the supported path is:

```bash
git clone https://github.com/mcglothi/runway.git
cd runway
npm install
npm run build:electron
```

Platform-specific builds:

```bash
npm run build:mac
npm run build:linux
npm run build:win
```

Expected outputs:

- macOS: `dist/Runway-x.y.z-arm64.dmg` and `dist/Runway-x.y.z-x64.dmg`
- Linux: `dist/Runway-x.y.z-x86_64.AppImage` and `.deb`
- Windows: `dist/Runway Setup x.y.z.exe`

## GitHub Releases

The repository already includes a tag-triggered workflow at `.github/workflows/release.yml`.

Release flow:

1. Bump `version` in `apps/electron/package.json`
2. Commit the version bump
3. Create and push a tag like `v0.1.0`

```bash
git add apps/electron/package.json
git commit -m "chore: bump version to x.y.z"
git tag vx.y.z
git push origin main --tags
```

The workflow then builds on macOS, Linux, and Windows and publishes artifacts to the matching GitHub Release.

Until at least one tag has been pushed successfully, the public site should not tell users to install from Releases.

## macOS notarization

Notarization is optional for internal testing and recommended for public distribution.

Set these repository secrets in GitHub:

| Secret | Value |
|--------|-------|
| `APPLE_ID` | Apple ID email |
| `APPLE_APP_SPECIFIC_PASSWORD` | App-specific password from appleid.apple.com |
| `APPLE_TEAM_ID` | Apple Developer Team ID |
| `CSC_LINK` | Base64-encoded `.p12` certificate |
| `CSC_KEY_PASSWORD` | Certificate password |

Without these, the release can still produce a DMG, but macOS will warn on first launch.

## Homebrew cask

Runway should ship as a Homebrew cask, not a formula. A cask is the right fit because the install target is a packaged macOS app bundle delivered as a DMG.

The checked-in cask template lives at `scripts/cask/runway.rb`.

Once the macOS release artifacts exist, generate a finished cask from the local DMGs:

```bash
bash scripts/generate-homebrew-cask.sh \
  --arm64 dist/Runway-x.y.z-arm64.dmg \
  --x64 dist/Runway-x.y.z-x64.dmg
```

That writes `dist/homebrew/runway.rb` with the correct version and SHA256 values.

Then copy the generated cask into your tap repo and push it:

```bash
cp dist/homebrew/runway.rb ~/code/homebrew-tap/Casks/runway.rb
```

Users will eventually install with:

```bash
brew tap mcglothi/tap
brew install --cask runway
```

Do not advertise this in public docs until:

1. GitHub Releases exist
2. The cask has been pushed to the tap
3. `brew install --cask runway` works end-to-end on a clean Mac

## First release checklist

- [ ] `apps/electron/package.json` version bumped
- [ ] Tag pushed and GitHub Release created
- [ ] macOS DMGs uploaded successfully
- [ ] Optional notarization verified
- [ ] `bash scripts/generate-homebrew-cask.sh --arm64 ... --x64 ...` run successfully
- [ ] Generated cask committed to `mcglothi/homebrew-tap`
- [ ] Public docs updated to point at Releases and Brew
