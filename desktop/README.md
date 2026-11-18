# opendoc-desktop

A self-contained desktop app for [OpenDoc](https://github.com/RyanYahya/OpenDoc) on Linux and macOS, built with Electron. It carries its own runtime, so users install no Node or npm, and it installs the `opendoc` command for agents.

This package is private to the repository: OpenDoc's npm packages do not include `desktop/`. Build and release instructions arrive with the app itself.

How the app works, what it reads and writes, and how it is hardened: [docs/DESKTOP.md](../docs/DESKTOP.md).

## Layout

- `src/main/`: the Electron main process (the shell).
- `src/preload/`: the preload script. It exposes an API to the app's own pages only.
- `src/renderer/`: the app's own pages (workspace picker, crash screen).
- `src/main/updater/`: the in-app updater (install type, build-aware comparison, feed address rules, schedule, package and macOS installs). How it behaves: [docs/DESKTOP.md](../docs/DESKTOP.md#updates).
- `resources/cli/`: the `opendoc` command for agents: `opendoc` (installed as `/usr/bin/opendoc` by the Linux packages) and `opendoc-appimage.sh` (the template the app fills in and writes to `~/.local/bin/opendoc` for an AppImage).
- `tests/shell/`: the shell tests. Run them with `node tests/shell/run.mjs`; they open Electron windows only on a virtual display (Xvfb), never on your screen. `--unit` runs the unit tests without Electron.

## Testing updates

Nothing here talks to GitHub: every test uses a feed on 127.0.0.1.

- `node tests/shell/run.mjs --unit` runs the updater's unit tests (`tests/shell/unit/updater-*.test.mjs`).
- `node tests/shell/run.mjs updater-network updater-packages updater-guard` runs the Electron specs in `tests/shell/updater/` on the virtual display. They start a development Electron through `tests/shell/updater/support/entry.mjs` (which stubs the native dialogs), set `OPENDOC_DESKTOP_UPDATE_RESOURCES` to a stand-in `resources/` folder (with `package-type`, `update-disabled` and so on) and point `updateFeed` in `config.json` at the feed. A fake `pkexec`, `dpkg` and `apt-get` record what the deb install runs.
- `scripts/update-feed-server.py <root> [port]` is the feed: `/generic/<file>` for an `updateFeed` of `http://127.0.0.1:<port>/generic/`, GitHub-shaped URLs for `http://127.0.0.1:<port>/github-like`, Range requests, and a JSON request log in `<root>/requests.log`. Start it by hand to try an update against a real build.
- `node tests/shell/updater/appimage-run.mjs --first <build 1 output> --second <build 2 output> --work <empty scratch folder>` runs the real AppImage update, build 1 to build 2 (a corrupted build 2 that must be refused, and a staging failure at quit that must leave the old AppImage working), on a virtual display with a scratch `HOME`. It needs two AppImages from electron-builder (a scratch config outside the repository is enough; the script adds the `build:` and `commit:` lines the release build adds to the metadata). It is run by hand, not by the test script.

Not covered: the macOS swap (only its decisions are unit-tested), a real `pkexec` prompt, and a real GitHub release.
