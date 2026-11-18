# opendoc-desktop

A self-contained desktop app for [OpenDoc](https://github.com/RyanYahya/OpenDoc) on Linux and macOS, built with Electron. It carries its own runtime, so users install no Node or npm, and it installs the `opendoc` command for agents.

This package is private to the repository: OpenDoc's npm packages do not include `desktop/`. Build and release instructions arrive with the app itself.

How the app works, what it reads and writes, and how it is hardened: [docs/DESKTOP.md](../docs/DESKTOP.md).

## Layout

- `src/main/`: the Electron main process (the shell).
- `src/preload/`: the preload script. It exposes an API to the app's own pages only.
- `src/renderer/`: the app's own pages (workspace picker, crash screen).
- `resources/cli/`: the `opendoc` command shim (added with the CLI work).
- `tests/shell/`: the shell tests. Run them with `node tests/shell/run.mjs`; they open Electron windows only on a virtual display (Xvfb), never on your screen. `--unit` runs the unit tests without Electron.
