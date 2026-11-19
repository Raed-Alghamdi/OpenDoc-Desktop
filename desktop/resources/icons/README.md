# opendoc-desktop icons

The app icon is a page with OpenDoc's **O**: a dark sheet with a folded corner on a white tile, and the wordmark's O set in white on the sheet. It uses the wordmark's ink colour (`#21211F`) and nothing else, so it reads as OpenDoc next to `assets/brand/wordmark.png`. The OpenDoc project may adjust or replace it, and may use the small version as the browser edition's favicon.

## Files

| File | Use |
|---|---|
| `opendoc-desktop.svg` | Master and the Linux scalable icon (`hicolor/scalable/apps`). An 824 px tile on a 1024 px canvas (Apple's icon grid), with a faint edge so the white tile shows on white panels |
| `opendoc-desktop-macos.svg` | The same artwork with the macOS drop shadow; source of `icon.icns` |
| `opendoc-desktop-small.svg` | 16 to 32 px: less padding, a thicker O, and a plain cut corner instead of the grey fold, drawn on a 16 px grid |
| `opendoc-desktop-symbolic.svg` | GNOME symbolic icon, one colour on a 16 px grid |
| `mark-black.svg`, `mark-white.svg` | One-colour marks without the tile, for light and dark backgrounds |
| `icon.png` | 1024 px PNG from the master |
| `icon.icns` | macOS icon (PNG entries 16 to 1024, including the @2x sizes) |
| `linux/<N>x<N>.png` | Linux sizes 16, 24, 32 (from the small version) and 48, 64, 128, 256, 512 (from the master) |
| `web/favicon.svg`, `web/favicon-32.png`, `web/favicon-64.png` | Favicon candidates for the browser edition (not wired in) |

## Wiring

electron-builder takes `mac.icon: resources/icons/icon.icns` and `linux.icon: resources/icons/linux` (a folder of `<N>x<N>.png` files). The Linux packages also install `opendoc-desktop.svg` as the scalable icon and `opendoc-desktop-symbolic.svg` under `hicolor/symbolic/apps`. The window icon on Linux is `linux/512x512.png`.

## Rules

- **Clear space:** keep the tile's own margin (100 px of 1024) around the tile; around a one-colour mark, keep at least the width of the O's stroke.
- **Minimum size:** use `opendoc-desktop-small.svg` below 48 px; the symbolic icon at 16 px in GNOME's symbolic contexts.
- **Don't:** recolour the sheet or the O, add a gradient or a second colour, outline the O, rotate the page, put the master on a busy photo, or set the wordmark inside the icon.

## Rebuilding

Edit the SVGs, then run `./build.sh` in this folder (needs `rsvg-convert` and `python3`). It regenerates `icon.png`, `icon.icns`, the `linux/` sizes and the `web/` PNGs.
