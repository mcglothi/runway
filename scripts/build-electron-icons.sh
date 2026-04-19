#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "$0")/.." && pwd)"
ASSET_DIR="$ROOT_DIR/apps/electron/build-assets"
SVG_PATH="$ASSET_DIR/icon.svg"
PNG_1024="$ASSET_DIR/icon-1024.png"
ICONSET_DIR="$ASSET_DIR/icons.iconset"
LINUX_DIR="$ASSET_DIR/icons"

mkdir -p "$ICONSET_DIR" "$LINUX_DIR"

qlmanage -t -s 1024 -o "$ASSET_DIR" "$SVG_PATH" >/dev/null
mv "$SVG_PATH.png" "$PNG_1024"

for size in 16 32 64 128 256 512; do
  sips -z "$size" "$size" "$PNG_1024" --out "$LINUX_DIR/${size}x${size}.png" >/dev/null
done

sips -z 16 16 "$PNG_1024" --out "$ICONSET_DIR/icon_16x16.png" >/dev/null
sips -z 32 32 "$PNG_1024" --out "$ICONSET_DIR/icon_16x16@2x.png" >/dev/null
sips -z 32 32 "$PNG_1024" --out "$ICONSET_DIR/icon_32x32.png" >/dev/null
sips -z 64 64 "$PNG_1024" --out "$ICONSET_DIR/icon_32x32@2x.png" >/dev/null
sips -z 128 128 "$PNG_1024" --out "$ICONSET_DIR/icon_128x128.png" >/dev/null
sips -z 256 256 "$PNG_1024" --out "$ICONSET_DIR/icon_128x128@2x.png" >/dev/null
sips -z 256 256 "$PNG_1024" --out "$ICONSET_DIR/icon_256x256.png" >/dev/null
sips -z 512 512 "$PNG_1024" --out "$ICONSET_DIR/icon_256x256@2x.png" >/dev/null
sips -z 512 512 "$PNG_1024" --out "$ICONSET_DIR/icon_512x512.png" >/dev/null
cp "$PNG_1024" "$ICONSET_DIR/icon_512x512@2x.png"
cp "$LINUX_DIR/512x512.png" "$ASSET_DIR/icon.png"

iconutil -c icns "$ICONSET_DIR" -o "$ASSET_DIR/icon.icns"
ffmpeg -y -i "$PNG_1024" -vf scale=256:256 "$ASSET_DIR/icon.ico" >/dev/null 2>&1

echo "Updated Electron icons in $ASSET_DIR"
