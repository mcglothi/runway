#!/usr/bin/env bash

set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
VERSION="$(node -p "require('${ROOT_DIR}/apps/electron/package.json').version")"
ARM64_DMG=""
X64_DMG=""
OUTPUT_PATH="${ROOT_DIR}/dist/homebrew/runway.rb"

usage() {
  cat <<EOF
Usage:
  bash scripts/generate-homebrew-cask.sh --arm64 <path> --x64 <path> [--output <path>]

Example:
  bash scripts/generate-homebrew-cask.sh \\
    --arm64 dist/Runway-${VERSION}-arm64.dmg \\
    --x64 dist/Runway-${VERSION}-x64.dmg
EOF
}

while [[ $# -gt 0 ]]; do
  case "$1" in
    --arm64)
      ARM64_DMG="${2:-}"
      shift 2
      ;;
    --x64)
      X64_DMG="${2:-}"
      shift 2
      ;;
    --output)
      OUTPUT_PATH="${2:-}"
      shift 2
      ;;
    -h|--help)
      usage
      exit 0
      ;;
    *)
      echo "Unknown argument: $1" >&2
      usage >&2
      exit 1
      ;;
  esac
done

if [[ -z "${ARM64_DMG}" || -z "${X64_DMG}" ]]; then
  echo "Both --arm64 and --x64 DMG paths are required." >&2
  usage >&2
  exit 1
fi

if [[ ! -f "${ARM64_DMG}" ]]; then
  echo "arm64 DMG not found: ${ARM64_DMG}" >&2
  exit 1
fi

if [[ ! -f "${X64_DMG}" ]]; then
  echo "x64 DMG not found: ${X64_DMG}" >&2
  exit 1
fi

ARM64_SHA="$(shasum -a 256 "${ARM64_DMG}" | awk '{print $1}')"
X64_SHA="$(shasum -a 256 "${X64_DMG}" | awk '{print $1}')"

mkdir -p "$(dirname "${OUTPUT_PATH}")"

cat > "${OUTPUT_PATH}" <<EOF
cask "runway" do
  version "${VERSION}"

  if Hardware::CPU.arm?
    sha256 "${ARM64_SHA}"
    url "https://github.com/mcglothi/runway/releases/download/v#{version}/Runway-#{version}-arm64.dmg"
  else
    sha256 "${X64_SHA}"
    url "https://github.com/mcglothi/runway/releases/download/v#{version}/Runway-#{version}-x64.dmg"
  end

  name "Runway"
  desc "Real-time AI quota tracker for the macOS menu bar"
  homepage "https://github.com/mcglothi/runway"

  livecheck do
    url :url
    strategy :github_latest
  end

  app "Runway.app"

  zap trash: [
    "~/Library/Application Support/Runway",
    "~/Library/Logs/Runway",
    "~/Library/Preferences/com.mcglothi.runway.plist",
  ]
end
EOF

echo "Generated ${OUTPUT_PATH}"
