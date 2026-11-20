#!/usr/bin/env bash
# Regenerate every raster icon from the SVG sources in this folder. Needs rsvg-convert and python3.
set -euo pipefail
cd "$(dirname "$0")"
command -v rsvg-convert >/dev/null || { echo "rsvg-convert is required (librsvg)" >&2; exit 1; }

mkdir -p linux web
for size in 16 24 32; do rsvg-convert -w "$size" -h "$size" opendoc-desktop-small.svg -o "linux/${size}x${size}.png"; done
for size in 48 64 128 256 512; do rsvg-convert -w "$size" -h "$size" opendoc-desktop.svg -o "linux/${size}x${size}.png"; done
rsvg-convert -w 1024 -h 1024 opendoc-desktop.svg -o icon.png
for size in 32 64; do rsvg-convert -w "$size" -h "$size" opendoc-desktop-small.svg -o "web/favicon-${size}.png"; done
cp opendoc-desktop-small.svg web/favicon.svg

tmp=$(mktemp -d)
trap 'rm -rf "$tmp"' EXIT
for size in 16 32 64 128 256 512 1024; do rsvg-convert -w "$size" -h "$size" opendoc-desktop-macos.svg -o "$tmp/$size.png"; done
python3 - "$tmp" <<'PY'
import os, struct, sys
folder = sys.argv[1]
# PNG-based icns entries (macOS 10.7 and later): OSType, pixel size.
entries = [("icp4", 16), ("icp5", 32), ("icp6", 64), ("ic07", 128), ("ic08", 256), ("ic09", 512), ("ic10", 1024),
           ("ic11", 32), ("ic12", 64), ("ic13", 256), ("ic14", 512)]
body = b""
for ostype, size in entries:
    data = open(os.path.join(folder, f"{size}.png"), "rb").read()
    body += ostype.encode() + struct.pack(">I", 8 + len(data)) + data
open("icon.icns", "wb").write(b"icns" + struct.pack(">I", 8 + len(body)) + body)
PY
echo "icons rebuilt"
