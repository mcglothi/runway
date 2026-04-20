# Changelog

All notable changes to Runway are documented here. Releases from v0.1.4 onward are auto-generated from merged pull requests.

---

## [0.1.3] — 2026-04-20
- feat: API-equivalent cost estimate per agent window (`~$X est.` in popup)
- feat: update checker — green banner when a new version is available
- fix: rate-limit AIKB quota snapshot writes (was 490+/hour, now ~12/hour)
- fix: popup `runway-col` wrapping for cost estimate display
- fix: author name in package metadata

## [0.1.2] — 2026-04-20
- fix: popup runway column wrapping (intermediate release, superseded by 0.1.3)

## [0.1.1] — 2026-04-19
- feat: auto-trim Gemini telemetry file when it exceeds 50 MB
- fix: crash on launch from 2.8 GB telemetry file
- chore: Electron 34 → 35 upgrade

## [0.1.0] — 2026-04-16
- Initial release: system tray quota widget for Claude, Codex, Gemini, and GitHub Copilot
- Browser extension for session sync (Claude, Gemini)
- AIKB runtime event log integration
