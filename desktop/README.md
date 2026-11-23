# OpenDoc Desktop: developer guide

OpenDoc Desktop is a self-contained desktop app for [OpenDoc](https://github.com/RyanYahya/OpenDoc) on Linux and on macOS (Apple Silicon), built with Electron. It carries its own runtime, so users install no Node or npm, and it installs the `opendoc` command for agents.

This package is private to the repository: OpenDoc's npm packages do not include `desktop/`.

This page is for people who build, test and release the app, and for people who work on its code. What the app does, how to install and remove it, and what it writes to disk is in the user guide, [docs/DESKTOP.md](../docs/DESKTOP.md).

| You want to | Go to |
|---|---|
| Build the installers | [Build](#build) |
| Tag, publish and sign a release | [Versions and build numbers](#versions-and-build-numbers), [Tags and releases](#tags-and-releases), [Signing releases](#signing-releases) |
| Know what CI runs | [What `desktop.yml` runs](#what-desktopyml-runs) and [Release automation](#release-automation-one-time-setup) |
| Run the tests | [Tests](#tests) and [Testing updates](#testing-updates) |
| Run the app from a checkout | [Run it from a checkout](#run-it-from-a-checkout) |
| Understand how the app works | [How the app works](#how-the-app-works) |

## Layout

- `src/main/`: the Electron main process (the shell). `src/main/workspace/` holds the workspace link, the version table, the upgrade with its backups, and the AppImage's runtime copy.
- `src/host/`: the service host, the code that runs in the child process beside the OpenDoc service and carries requests over its IPC channel (no port), and the watchdog that ends it when the app is gone.
- `src/preload/`: the preload script. It gives the app's own pages their calls to the main process, and the workspace page its two bridge functions (`onChange`, `onHostState`).
- `src/renderer/`: the app's own pages (workspace picker, crash screen, upgrade progress and result, the backups list).
- `src/main/updater/`: the in-app updater (install type, build-aware comparison, feed address rules, schedule, package and macOS installs). How it behaves: [How the updater works](#how-the-updater-works).
- `resources/cli/`: the `opendoc` command for agents: `opendoc` (installed as `/usr/bin/opendoc` by the Linux packages) and `opendoc-appimage.sh` (the template the app fills in and writes to `~/.local/bin/opendoc` for an AppImage).
- `runtime/`: the scripts that build the runtime and the installers (see "Build").
- `integrations/`: the plugin and skill files for AI apps ([its README](integrations/README.md)).
- `aur/`: the `opendoc-desktop-bin` package for the Arch User Repository (`PKGBUILD` and its install script).
- `scripts/update-feed-server.py`: a local update feed for tests.
- `tests/shell/`, `tests/packaging/`, `tests/smoke/`: the tests (see "Tests").

## Build

Everything runs from the repository root. Node 24 (the version in `.node-version`) and pnpm are needed. The first step installs the dependencies, including Electron and electron-builder:

```sh
pnpm install --frozen-lockfile
```

Build on the platform you build for. The runtime holds native pieces for one platform and architecture, and electron-builder takes the runtime of the machine it runs on. So a macOS build must run on a Mac (CI uses an Apple Silicon runner; there is no Intel Mac build), and the Linux installers are made on Linux (x86_64 only for now).

### 1. The runtime

```sh
nice -n 19 ionice -c 3 node desktop/runtime/build.mjs --build 1
```

`pnpm --filter ./desktop run runtime` runs the same script (write `run`: pnpm has a command of its own called `runtime`). The script:

1. packs this repository's OpenDoc (`pnpm package:pack --edition normal`);
2. installs that tarball with `npm ci --ignore-scripts` into `desktop/build/runtime/<platform>-<arch>/` (not committed; it needs the npm registry for the dependencies);
3. checks the three native pieces (canvas, resvg, esbuild) and keeps esbuild's executable bit;
4. removes only what nothing loads at run time (source maps and npm's hidden lock file);
5. writes `build-info.json` (`{ build, commit, builtAt }`) and makes the folder read-only.

Options:

- `--build <n>`: the build number, a positive whole number. Without it the script reads `OPENDOC_DESKTOP_BUILD`, then uses 1.
- `--skip-pack`: reuse the tarball already in `output/packages/` instead of packing again.

The folder holds `package.json`, `package-lock.json`, `build-info.json` and `node_modules/` (about 185 MB). To rebuild, run the command again: it makes the old folder writable first. To run the shell from this runtime, set `OPENDOC_DESKTOP_RUNTIME` to it (see [Run it from a checkout](#run-it-from-a-checkout)).

### 2. The installers

```sh
nice -n 19 ionice -c 3 node desktop/runtime/dist.mjs --linux pacman deb rpm AppImage --publish never
```

`pnpm --filter ./desktop run dist --linux deb --publish never` runs the same script. `dist.mjs`:

- reads the build number from the runtime's `build-info.json`, so build the runtime first;
- passes it to electron-builder (`-c.buildNumber`, `-c.mac.bundleVersion`);
- afterwards adds the top-level `build:` and `commit:` lines to every `latest*.yml` in `desktop/dist/`, which the updater needs.

Everything after the script name goes to electron-builder, and `--publish never` is added if you leave `--publish` out. The config is `desktop/electron-builder.yml`, one file for every installer.

**Test builds.** A packaged app ignores the environment switches that tests use (`OPENDOC_DESKTOP_RUNTIME`, `OPENDOC_DESKTOP_UPDATE_RESOURCES`, `OPENDOC_DESKTOP_HEALTH_MS`, `OPENDOC_DESKTOP_INTEGRATIONS_OPTIONS`, `OPENDOC_PACKAGE_TARBALL`) and refuses a plain-http `updateFeed`, so that a variable set for the next launch cannot choose the code or the update source of an installed app. A build that tests need to drive through those switches (for example a real AppImage updating from a feed on 127.0.0.1) is made as a test build, by writing `opendocTestBuild: true` into the `package.json` inside the app archive. `OPENDOC_DESKTOP_TEST_BUILD=1` makes `dist.mjs` pass that to electron-builder (as `-c.extraMetadata.opendocTestBuild=true`, which also works by hand) and print a TEST BUILD warning:

```sh
OPENDOC_DESKTOP_TEST_BUILD=1 nice -n 19 ionice -c 3 node desktop/runtime/dist.mjs --linux AppImage --publish never
```

A release build is made without it (the release workflow does not set it, and `check-release.mjs` fails any installer that carries the field). Never publish or install a test build as your own app. See [Test builds](#test-builds) under "How the app works".

Linux, in `desktop/dist/`:

| Target | File name |
|---|---|
| pacman | `opendoc-desktop-<version>-<build>-x64.pacman` |
| deb | `opendoc-desktop_<version>-<build>_amd64.deb` |
| rpm | `opendoc-desktop-<version>-<build>.x86_64.rpm` |
| AppImage | `opendoc-desktop-x86_64.AppImage` (no version in the name, so an update replaces the file in place) |

Next to them: `latest-linux.yml`, and the unpacked app in `linux-unpacked/`. The pacman and rpm targets need `bsdtar` (package `libarchive-tools` on Debian and Ubuntu) and `rpm` on the build machine. CI installs both.

On macOS:

```sh
node desktop/runtime/dist.mjs --mac zip dmg --arm64 --publish never
```

This makes `opendoc-desktop-<version>-<build>-<arch>.zip` and `.dmg`, and `latest-mac.yml`. The app is signed ad hoc (identity `-`) and not notarized, so the first launch needs "Open Anyway" (see [docs/DESKTOP.md](../docs/DESKTOP.md#install)). `dist.mjs` signs pull request builds too (`CSC_FOR_PULL_REQUEST`, which electron-builder would otherwise leave off), so every build is made the way a release is. codesign writes into the files it signs and the runtime is read-only, so the hooks in `runtime/mac-signing.mjs` (`afterPack` and `afterSign` in `electron-builder.yml`) make the runtime inside the `.app` writable just before signing and read-only again right after, before the zip and the dmg are made.

Check the Linux output with:

```sh
node desktop/tests/packaging/check-artifacts.mjs [--require-rpm]
```

It expects the installers in `desktop/dist/`. Without `--require-rpm`, a missing `.rpm` is not an error (an `rpm` file that is listed must exist); with it, a missing one is. CI uses it. It reads the version and build number from each package's own metadata, and checks that `latest-linux.yml` lists every installer with its checksum. Where the `rpm` tool is not installed it checks the `.rpm` by file name only; `--require-rpm` makes that an error. It also checks that each package carries the integration files (with their dot folders), the shared-mime file for `.opendoc.zip`, and the `.desktop` file's `MimeType` line and menu name (`Name=OpenDoc Desktop`).

Check an unpacked app (`linux-unpacked`, or a macOS `.app`) with `node desktop/tests/packaging/check-packaged.mjs --require linux` (or `--require mac`): the integration files are there, the source `check.mjs` passes against the packaged copy, and on macOS the Info.plist's document type for `.opendoc.zip` is right and the runtime inside the app is read-only (on a Mac, `--release` also runs `codesign --verify --deep --strict` on the app). With `--release` it also fails if the app's `package.json` inside `app.asar` has the `opendocTestBuild` field that `OPENDOC_DESKTOP_TEST_BUILD=1 node desktop/runtime/dist.mjs ...` writes; `node desktop/tests/packaging/check-release.mjs <installer or folder>...` makes the same check on the deb, rpm, pacman, AppImage and macOS zip files themselves (the dmg cannot be read on Linux; its app is in the zip). CI runs both before anything is uploaded, and the release job runs the second on every file it is about to attach, so a release never carries a test build.

### The AUR package

`desktop/aur/PKGBUILD` repackages a release's pacman file (`opendoc-desktop-<pkgver>-<pkgrel>-x64.pacman`) as `opendoc-desktop-bin`: `pkgver` is the OpenDoc version and `pkgrel` the build number. It adds the empty file `resources/update-disabled`, which switches the in-app updater off, because the package manager owns updates. `bash desktop/tests/packaging/aur-local.sh <a pacman file>` builds it from a local file in a scratch folder and checks the result (it needs `makepkg`, and never installs anything). The checksum line holds `SKIP` until the release automation fills it in.

## Versions and build numbers

The app carries exactly OpenDoc's version (the root `package.json`), and `desktop/package.json` must say the same. Nothing in this folder bumps it. Builds of one version differ only by the build number. It becomes the Arch `pkgrel`, the Debian revision, the RPM `Release`, the macOS bundle build number and the number in the file names, and it is recorded in `build-info.json`. `desktop/runtime/ci-meta.mjs` refuses a tag whose version differs from either `package.json`.

## Tags and releases

A desktop release is the tag `desktop-v<version>-<build>`, for example `desktop-v0.6.1-2`. The build number counts up for each version, starting at 1. Upstream's own `v<version>` tags are mirrored as they are and never collide with these.

Pushing such a tag runs `.github/workflows/desktop.yml`. It builds every installer and creates a **draft** release holding all of them and the update metadata (`latest-linux.yml` and `latest-mac.yml`). The workflow never publishes. Read the draft, then publish it in the GitHub interface, or with `gh release edit <tag> --draft=false --repo Raed-Alghamdi/OpenDoc-Desktop`. Installed apps only see a release once it is published.

These wait for the maintainer to publish: the first release, every new minor version, every rebuild of the same version, and any run with a red check or a hand-merged conflict. How an upstream patch release may publish itself is in the release automation section below.

## What `desktop.yml` runs

It runs on a `desktop-v*` tag, on a pull request that touches `desktop/**`, `scripts/pack.mjs` or the workflow itself, and by hand (`workflow_dispatch`, with a `build` input, default 1). The token is read-only except in the release job. Jobs:

- **linux** (`ubuntu-latest`):
  1. installs `rpm`, `libarchive-tools` and `xvfb`;
  2. works out the version and build number (`desktop/runtime/ci-meta.mjs`, which takes the build from the tag);
  3. builds the runtime;
  4. runs `node --test "desktop/tests/packaging/*.test.mjs"` and `node --test desktop/tests/smoke/runtime.test.mjs`;
  5. runs the shell unit tests (`node desktop/tests/shell/run.mjs --unit`; on Ubuntu `/bin/sh` is `dash`, which the launcher and the host's watcher shell must run under);
  6. builds pacman, deb, rpm and AppImage;
  7. runs `check-packaged.mjs --require linux --release` on the unpacked app (it also checks that `resources/updater/release-key.pem` is the repository's file), then `check-artifacts.mjs --require-rpm`, `check-release.mjs --skip-signatures desktop/dist` (no installer is a test build; nothing is signed yet) and the runtime test again inside it;
  8. allows the app sandbox on the runner (Ubuntu 24.04 restricts user namespaces);
  9. runs the packaged-app smoke test (`node desktop/tests/smoke/run.mjs`, under Xvfb);
  10. keeps the files as artifacts for 5 days.
- **integrations** (`ubuntu-latest`): `node desktop/integrations/check.mjs`, which validates the plugin and skill files.
- **mac** (`macos-latest`, Apple Silicon): builds the runtime, runs the same two test groups and the shell unit tests, builds zip and dmg, runs `check-packaged.mjs --require mac --release` and `check-release.mjs --skip-signatures desktop/dist`, runs the smoke test in the runner's own session, and keeps the files for 5 days.
- **release** (tags only; needs `linux` and `mac`): uses the Apple Silicon build's `latest-mac.yml` as it is (there is nothing to merge), runs `check-release.mjs --skip-signatures release` on every downloaded file (it fails if any is a test build), signs every installer (AppImage, deb, rpm, pacman, dmg, zip) with `desktop/release/sign.mjs` and the secret `DESKTOP_SIGNING_KEY` (see "Signing releases"), runs `check-release.mjs release` again (every installer must now have a `.sig` that verifies with `desktop/resources/updater/release-key.pem`), and creates the draft release with `gh release create --draft`, the `.sig` files included. A missing secret fails the job, so no release is ever drafted unsigned.

## Signing releases

Every installer in a release carries a detached signature, `<file>.sig`: the raw 64 bytes of an Ed25519 signature (PureEdDSA) over the whole file. The deb, rpm and pacman updater checks it as root before installing (see [How the updater works](#how-the-updater-works)); AppImage and macOS updates do not use it, but the files are signed the same way and anyone can check one with `openssl pkeyutl -verify -pubin -inkey desktop/resources/updater/release-key.pem -rawin -in <file> -sigfile <file>.sig` (OpenSSL 3).

- **The public key** is `desktop/resources/updater/release-key.pem` (SPKI PEM). It ships in the app next to the root helper (`install-update`) and is checked by `check-packaged.mjs` and `check-artifacts.mjs`.
- **The private key** is the repository secret `DESKTOP_SIGNING_KEY`: an Ed25519 private key in PKCS#8 PEM form (`-----BEGIN PRIVATE KEY-----`). Only the release job of `desktop.yml` reads it, in the environment of its signing step. `upstream-watch.yml` calls `desktop.yml` and passes the secret by name, because a called workflow gets no secrets otherwise. Set it with `gh secret set DESKTOP_SIGNING_KEY --repo <owner>/OpenDoc-Desktop < private-key.pem`.
- **`desktop/release/sign.mjs`** signs the files it is given (`node desktop/release/sign.mjs <file>...`, the key from the variable named by `--key-env`, default `DESKTOP_SIGNING_KEY`), then verifies every signature with the committed public key (or `--public-key <pem>`), so a secret that does not match the committed key fails the job. It refuses a missing or empty variable and a key that is not Ed25519, and never prints the key. `check-release.mjs <folder>` checks that every installer has a `.sig` that verifies (`--public-key <pem>` for a test key, `--skip-signatures` for the builds that are not signed yet).
- **Making a key pair** (keep the private file out of the repository and delete it once it is in the secret store): `openssl genpkey -algorithm ed25519 -out private-key.pem` and `openssl pkey -in private-key.pem -pubout -out desktop/resources/updater/release-key.pem`.
- **Signing a local build** to see the checks pass (use a throwaway key; the file's public half goes to `--public-key`): `DESKTOP_SIGNING_KEY="$(cat throwaway.pem)" node desktop/release/sign.mjs --public-key throwaway-public.pem desktop/dist/*.{deb,pacman,AppImage}`, then `node desktop/tests/packaging/check-release.mjs --public-key throwaway-public.pem desktop/dist`.
- **Rotating the key.** An installed app trusts only the public key it shipped with, so a new key cannot simply start signing: an app that has the old key would refuse every update signed with the new one. Do it in two releases. First commit the new public key as `desktop/resources/updater/release-key.pem` and publish a release that is still signed with the old private key (the old secret stays in place); installed apps update to it, and from then on they trust the new key. Only after that, replace the secret `DESKTOP_SIGNING_KEY` with the new private key, so the next release is signed with it (`sign.mjs` fails the job while the secret and the committed public key do not match, which protects against doing it in the wrong order). Apps that never took the in-between release must be updated by hand from the release page. If the old key leaked, the in-between release is the one an attacker could also sign, so tell users to install it from the release page and check its signature by hand.

## Release automation (one-time setup)

`.github/workflows/upstream-watch.yml` watches OpenDoc upstream once a day (and whenever it is run by hand) and prepares each new app build; `aur-bump.yml` keeps the AUR package in step when a release is published. Neither publishes anything on its own unless the repository variable `DESKTOP_AUTO_PUBLISH` is `true`. Even then a release publishes itself only when all of these hold: it is an upstream patch release, the merge was clean, every check is green, and an earlier release of the same x.y line has already gone out by hand. Everything else (a new minor version, a rebuild, a conflict resolved by hand, a red check) waits as a draft release, with an issue in this repository that mentions the owner. Tags are `desktop-v<version>-<build>`; the build number counts up per version.

`aur-bump.yml` makes the new `PKGBUILD` and `.SRCINFO` from a published release's pacman file and uploads them as an artifact. It pushes them to the AUR only when the secret `AUR_SSH_KEY`, the variable `AUR_HOST_KEY_SHA256` (the AUR host key's fingerprint) and the variable `AUR_PUSH` set to `true` all exist; none does until the first AUR publication is approved.

Two things the fork's owner has to do, because GitHub does not do them:

1. A fork's scheduled workflows start disabled, so the daily schedule (the `schedule:` block in `upstream-watch.yml`) needs `gh workflow enable upstream-watch.yml --repo <owner>/OpenDoc-Desktop` once.
2. GitHub switches a scheduled workflow off after 60 days without repository activity, so make sure something is committed at least every 60 days, or re-enable it with the same command.

`roadmap` is the repository's default branch, which is where GitHub runs schedules from, so the workflow file must be on it. The schedule uses an odd minute because the top of the hour is busy and runs get dropped. A run that stops (a conflict, or a red check) also fails, so GitHub's failure mail reaches the owner.

To rehearse a run without touching `roadmap`, `main` or the real tags, make a stand-in upstream with `desktop/release/fake-upstream.mjs` and use the inputs of `upstream-watch.yml` (`target_branch`, `upstream_ref`). A rehearsal tags everything `dryrun-`, publishes only as a pre-release and never pushes to the AUR.

## Tests

The shell tests open real Electron windows, so they run only on a virtual display, through one script. It wraps everything in `nice`, `ionice`, a hard time limit and `xvfb-run`, and removes the desktop's display and Electron variables:

```sh
node desktop/tests/shell/run.mjs --unit          # unit tests, no Electron, about half a minute
node desktop/tests/shell/run.mjs                 # the Playwright specs (Electron under Xvfb)
node desktop/tests/shell/run.mjs --grep NAME     # one spec or test
```

`pnpm --filter ./desktop run test:shell` and `run test:shell:unit` do the same. The first full run builds the test runtime and two template workspaces under `tmp/shell-tests/` (it needs the npm registry once). Never start Electron for this project in another way on a machine where someone is working: use the `xvfb-run -a env -u ELECTRON_FORCE_IS_PACKAGED -u ELECTRON_RUN_AS_NODE -u ELECTRON_OZONE_PLATFORM_HINT -u WAYLAND_DISPLAY <binary> --ozone-platform=x11` form inside `timeout -s KILL`. What the specs cover, and what only a person on a real display can check, is in [What the tests cover](#what-the-tests-cover).

The packaging, runtime and plugin tests need no display:

```sh
node --test "desktop/tests/packaging/*.test.mjs"      # metadata scripts, the AUR package files
node --test desktop/tests/smoke/runtime.test.mjs      # the runtime under Electron as Node: --version, check, export
node desktop/integrations/check.mjs                   # the plugin and skill files
```

`pnpm --filter ./desktop run test` runs the first two. The packaged-app smoke test (library, a document's PDF, a comment, an export, `opendoc --version`, quit, nothing left running) runs against `desktop/dist` after `dist.mjs`, under Xvfb on Linux:

```sh
node desktop/tests/smoke/run.mjs
```

On Ubuntu 24.04 the unpacked app also needs `sudo sysctl -w kernel.apparmor_restrict_unprivileged_userns=0` (CI does this on its throwaway runner; do not change it on a machine you use).

## Testing updates

Nothing here talks to GitHub: every test uses a feed on 127.0.0.1. The commands in this section run from `desktop/`.

- `node tests/shell/run.mjs --unit` runs the updater's unit tests (`tests/shell/unit/updater-*.test.mjs`).
- `node tests/shell/run.mjs updater-network updater-packages updater-guard` runs the Electron specs in `tests/shell/updater/` on the virtual display. They start a development Electron through `tests/shell/updater/support/entry.mjs` (which stubs the native dialogs), set `OPENDOC_DESKTOP_UPDATE_RESOURCES` to a stand-in `resources/` folder (with `package-type`, `update-disabled` and so on) and point `updateFeed` in `config.json` at the feed. A fake `pkexec`, `dpkg` and `apt-get` record what the deb install runs. The feed serves a `<file>.sig` for each package, made with a throwaway Ed25519 key (`testReleaseKey()` in `tests/shell/support/updater.mjs`), and the stand-in `resources/` folder holds that key's public half as `updater/release-key.pem`, where the app's install script reads the release key; the production helper and key are never changed for a test. The helper's own text is run for real by `tests/shell/unit/updater-privileged-install.test.mjs`, in a folder with the throwaway key beside it.
- `scripts/update-feed-server.py <root> [port]` is the feed: `/generic/<file>` for an `updateFeed` of `http://127.0.0.1:<port>/generic/`, GitHub-shaped URLs for `http://127.0.0.1:<port>/github-like`, Range requests, and a JSON request log in `<root>/requests.log`. Start it by hand to try an update against a real build.
- `node tests/shell/updater/appimage-run.mjs --first <build 1 output> --second <build 2 output> --work <empty scratch folder>` runs the real AppImage update, build 1 to build 2 (a corrupted build 2 that must be refused, and a staging failure at quit that must leave the old AppImage working), on a virtual display with a scratch `HOME`. It needs two AppImages built as test builds (see "Test builds" above: an installed-style build refuses the loopback feed) from electron-builder (a scratch config outside the repository is enough; the script writes the `build:` and `commit:` lines the release build adds to the metadata, replacing the ones `dist.mjs` wrote). It is run by hand, not by the test script. Besides the swap, it checks that `runtime/current` follows the update and that the relaunch empties the updater's `pending/` folder.

Not covered: the macOS swap (only its decisions are unit-tested), a real `pkexec` prompt, a real GitHub release, and a `.sig` made by the real signing key in CI.

## How the app works

This part describes how the shell works, for developers and reviewers. It is not needed to use the app.

Status: the shell runs OpenDoc's service (`createOpenDocService`) in a child process with no port anywhere. The window loads `app://opendoc/`, and the main process carries each request to the service over the child's IPC channel; see [The service host and the bridge](#the-service-host-and-the-bridge).

### Run it from a checkout

```sh
pnpm install --frozen-lockfile
nice -n 19 ionice -c 3 pnpm package:pack --edition normal      # the OpenDoc package the runtime is made from
```

The app looks for its runtime (a folder with `node_modules/opendoc`, `package.json` and `build-info.json`) in the folder named by `OPENDOC_DESKTOP_RUNTIME`, else in `desktop/build/runtime/<platform>-<arch>`. Packaged builds carry it in `resources/runtime`. The runtime runs the service for every workspace the app opens (its `node_modules/opendoc` and `tsx`), creates new workspaces and shows the build number. In a development checkout without a runtime folder, the repository itself serves as the runtime (`src/server/service.ts` and its `node_modules`; run `pnpm build` first, the service serves the built client).

```sh
cd desktop
env -u ELECTRON_FORCE_IS_PACKAGED -u ELECTRON_RUN_AS_NODE node_modules/.bin/electron src/main/index.mjs
```

`pnpm start` (`electron .`) in `desktop/` does the same. Environment variables that tests and development builds read: `OPENDOC_DESKTOP_RUNTIME` (runtime folder), `OPENDOC_DESKTOP_HEALTH_MS` (how often the service is checked, default 5000) and `OPENDOC_DESKTOP_INTEGRATIONS_OPTIONS` (a JSON file of options for the AI apps module: its home, environment, PATH folders and integration files; it keeps the login shell unread so a test never sees the real Claude Code or Codex settings). These switches, `OPENDOC_DESKTOP_UPDATE_RESOURCES` and `OPENDOC_PACKAGE_TARBALL` are honoured only by an unpackaged run and by a test build (below). An installed app removes them from its environment at startup (and so from every process it starts), so a variable set in the environment of an installed app's next launch changes nothing.

#### Test builds

Tests of a packaged app (the updater specs against a real package, the AppImage run) need the switches above, and an installed app must not honour them. So a build is a test build only when its `package.json` inside the app archive has `"opendocTestBuild": true`. Make one with `OPENDOC_DESKTOP_TEST_BUILD=1 node desktop/runtime/dist.mjs --linux AppImage --publish never` (it prints a TEST BUILD warning), or by giving electron-builder the field yourself, which `dist.mjs` passes through: `-c.extraMetadata.opendocTestBuild=true`. A release build has no such field; nothing in the release workflow sets it, and `desktop/tests/packaging/check-release.mjs` (run by the linux and mac jobs before upload and by the release job on every file) fails any installer whose app archive has the field, whatever its value. A test build also accepts a plain-http loopback `updateFeed`; do not install one as your own app.

### What the main process does

`desktop/src/main/`:

| File | Job |
|---|---|
| `index.mjs` | Entry point: app name and profile folder, single-instance lock, quit handling (the service stops in `will-quit`, never `before-quit`). |
| `desktop-shell.mjs` | Which workspace is open: the open flow, the picker, the crash screen, the menu actions and the calls the app's own pages may make. |
| `transport.mjs` | The one module that carries requests to the OpenDoc service: starts the host, forwards each request over its IPC channel, relays change events, stops it. |
| `../host/service-host.mjs` | The code inside the host child: turns each request into Node's request and response objects for `service.handle()`. |
| `supervisor.mjs` | Restarts the service when it exits or stops answering, tells the page (`restarting`, `running`, `failed`); gives up after three restarts in two minutes. |
| `session-policy.mjs` | Rules for every Electron session: permissions, allowed requests, downloads, the content security policy, and the one `app://` handler that serves the shell's pages and forwards the rest to the transport. |
| `windows.mjs` | Window security settings, the navigation and new-window rules, the unsaved-edits guard, window state. |
| `policy.mjs` | The rules above as pure functions (tested without Electron). |
| `config.mjs`, `desktop-record.mjs`, `lock.mjs`, `service-session.mjs`, `window-state.mjs` | The files the app reads and writes, each with its own tests. |
| `menu.mjs`, `about.mjs` | The application menu and the About dialog. The menu items are listed in [Menus](../docs/DESKTOP.md#menus) in the user guide. |
| `workspace/` | Linking a workspace to the app's OpenDoc, the version table, the upgrade, backups and the AppImage's runtime copy (see [Workspaces and versions](#workspaces-and-versions)). |
| `runtime.mjs`, `process-info.mjs`, `identity.mjs`, `shell-pages.mjs` | Where the runtime is and how to run its CLI; questions about other processes; names; the app's own pages. |

`desktop/src/renderer/` holds the app's own pages (workspace picker, crash screen, upgrade progress and result, the backups list). They are served from `app://shell/` by the main process, never from `file://`, and get a small API from `desktop/src/preload/shell.cjs`. The workspace page (`app://opendoc/`, top frame only) gets only the two bridge functions described below.

### Opening a workspace

Everything below happens before the window loads, in this order, and any failure stops the open with a message the picker (or a dialog, for menu actions) shows:

1. The folder must hold `.opendoc/workspace.json`, or a `package.json` (a synced workspace that has not been used on this device yet: see [Workspaces and versions](#workspaces-and-versions)). On an AppImage whose runtime copy failed, the open is refused here with that error.
2. `.opendoc/desktop.json`: a live opendoc-desktop on it means "already open elsewhere"; a stale one (its pid is gone, or now belongs to another program) is removed.
3. `.opendoc/server.json`: a running browser-edition service means the workspace is refused, with a button that runs `opendoc stop`.
4. The workspace lock (`.opendoc/update.lock`, the CLI's own lock): taken while the workspace opens. A stale lock (its pid is gone) is reported and cleared only when the user asks; a live or damaged one is never offered for clearing.
5. The workspace is prepared (`workspace/prepare.mjs`, see [Workspaces and versions](#workspaces-and-versions)): marker or adoption, the `node_modules` link, `.claude/skills`, the version table and the upgrade. A refusal at any step releases the lock and leaves the workspace as it was (an empty `.opendoc` folder that the lock made is removed again).
6. Another workspace that is open is closed first (with the unsaved-edits question), then its service stops.
7. The service host starts (see [The service host and the bridge](#the-service-host-and-the-bridge)): a run-as-Node child of the app's executable, with the workspace as its working directory, the runtime's OpenDoc loaded through tsx, and an IPC channel; it has no listener and writes no `server.json`. It runs in its own process group, guarded three ways (see [Never left behind](#never-left-behind)). A workspace that must be read-only is started with `readOnly` (see [Workspaces and versions](#workspaces-and-versions)).
8. `desktop.json` is written, the workspace becomes `defaultWorkspace` and heads `recentWorkspaces` in `config.json`, the window opens, the lock is released.

On quit, the service is asked to close (it finishes accepted saves first; SIGKILL after 8 seconds), `desktop.json` is removed and the lock is released. A workspace that is still opening when the app quits is cancelled: its host is killed, its lock released (the shell keeps the pending open, so `shutdown()` does not depend on the open having finished) and nothing is written. After a `kill -9` of the main process the host and everything it started are gone within about a second (see [Never left behind](#never-left-behind)), and `desktop.json` and, if the app was opening a workspace, `update.lock` stay behind, stale, for the next launch to report (a stale lock is never cleared on its own; the picker offers "Clear stale lock").

### Workspaces and versions

A workspace is a folder the user owns; the OpenDoc that runs it is the app's. Everything here is in `desktop/src/main/workspace/` and runs while a workspace opens (step 5 above), before the host starts.

#### Where the runtime is

The deb, rpm, pacman and macOS builds run from `resources/runtime`, which stays put.

An AppImage's resources live in a mount that goes away with the app. So at launch the app copies `resources/runtime` to `<data>/runtime/<version>-<build>/` (`<data>` is `$XDG_DATA_HOME/opendoc-desktop`, else `~/.local/share/opendoc-desktop`; `~/Library/Application Support/opendoc-desktop` on macOS) and runs the service host and `runCli` from the copy. The copy follows these rules:

- It is made in a `.tmp.XXXXXX` folder beside it and renamed, so it is whole or absent. When another process finished the same copy first, that complete copy is kept and the temp is dropped. The agent command follows the same rule.
- It is skipped when a copy with the same `build-info.json` is there. The agent command makes the same copy by the same rule.
- A copy that fails (a full disk) is shown when a workspace is opened and is never half-used.
- Other copies are pruned at every launch, but only `<version>-<build>` folders that hold a `build-info.json` (and stale temps of its own), and never one that a running process uses (`/proc/*/cmdline`, matched as a path and as the percent-encoded `file://` form the service host carries).
- A `runtime/current` link, switched atomically, always points at the copy of this build. Workspace links name `<data>/runtime/current/node_modules`, so pruning never breaks a workspace.

`OPENDOC_DESKTOP_RUNTIME` still names a runtime for development and tests, and the copy is made whenever the `APPIMAGE` variable is set.

#### The link

`node_modules` in a workspace is a symlink to the runtime's `node_modules`, checked on every open: a missing link is made, a dangling or foreign one is replaced (a new link under a temporary name, then a rename). A real `node_modules` folder (or a file with that name) is never deleted without asking: the app asks once, "Use the app's OpenDoc" moves it to the trash and links, "Leave it as it is" leaves it and does not open the workspace. "Create new workspace" runs the runtime's `opendoc init <folder> --no-start`, which needs no npm: `node_modules` is made as a link to the runtime and the marker says `managed`, so the first open finds a correct link and asks nothing (there is no silent replacement of a real `node_modules` any more; the app always ships a runtime that can do this). On the AppImage `init` runs from the runtime copy and writes the copy's own path (`<data>/runtime/<version>-<build>/node_modules`); the exact check of the first open rewrites it to `runtime/current/node_modules`. `.claude/skills -> ../.agents/skills` is made when `.agents/skills` exists and `.claude/skills` is missing or a dangling link; a real `.claude/skills` folder is never replaced.

#### Adoption and the marker

A folder with a `package.json` that pins OpenDoc but no `.opendoc/workspace.json` (a workspace synced from another device) is offered "Use this workspace on this device". On yes the app writes the marker (`formatVersion` from the runtime's CLI, `edition`, `"managed": true`) and the link. An existing marker without `managed` gets `"managed": true` once the link is in place. `"managed": true` says that `node_modules` is a link to an app's runtime. The workspace's `.gitignore` keeps `.opendoc/workspace.json` in git (`!.opendoc/workspace.json`), so for a git user the flag travels to other devices where there may be no app: the CLI must act on `managed` only when `managedRuntime()` also finds the app's runtime, and otherwise treat the workspace as an npm one.

#### A folder with no `.opendoc/` is left without one

Taking the workspace lock makes `.opendoc/` (and the service makes `locks/`, `pack-uploads/` and `renders/` inside it while it runs). A workspace that had no `.opendoc/` before the app opened it has none after the app lets go of it (a declined question, a refusal, a failed start, switching to another workspace, closing, quitting even while a question is open), because the app removes those folders when they are empty, with `rmdir` and never recursively. What it never removes: anything that holds a file (the marker after a Yes, a backup journal), a folder that was already there, and the service's own `.opendoc/current.json` (the reader's selection, written while a document is shown, also in a read-only workspace, because `opendoc context` reads it; any device running OpenDoc writes the same file, so a workspace that was really viewed keeps `.opendoc/` with that one file). While a workspace is open, or while the adoption question is on screen, `.opendoc/` exists, and a sync client can pick it up then.

A workspace of the headless edition is refused (the app opens the normal edition only, and switching edition is not an update); a `package.json` that does not pin `npm:@ryanyahya/opendoc@<exact version>` is refused with that explanation.

#### The version table

The pin is `dependencies.opendoc` in `package.json`; the runtime's version is the app's.

| Workspace pin against the app | What happens |
|---|---|
| Same minor, older or equal patch | Opens; the pin moves up to the app's version when behind. |
| Same minor, newer patch | Read-only: "Update the app to edit it." |
| Older minor (or major) | One dialog: **Upgrade** (backup first), **Open read-only**, or Cancel, with the box "Upgrade my workspaces without asking from now on" (`upgradeWithoutAsking`). |
| Newer minor (or major) | Read-only: "This workspace was upgraded by OpenDoc x.y. Update the app to edit it." |

The pin only ever moves up: `writePin` reads the file again and refuses to lower a pin that another device moved up meanwhile. `package.json` is rewritten atomically (a `package.json.opendoc-<pid>.part` temp, then a rename) with its indentation, key order, line endings, UTF-8 byte order mark and final newline kept, and `package-lock.json` is never touched. A symlinked `package.json` is written through to its real file when that is inside the workspace, and refused otherwise. The workspace format is compared before the version: an older `formatVersion` goes to the upgrade path, a newer one to the read-only path ("created by a newer OpenDoc"), and a read-only outcome writes nothing but the `node_modules` link. Temporary files beside workspace files end in `.part` (on the default exclude lists of the common sync clients, which is not verified here), and the next open removes those whose process is gone.

#### Read-only

The app passes `readOnly: { reason, message }` to the service's `prepareOpenDocService` on every host start, restarts included. `reason` is `newer-patch`, `newer-minor`, `declined-upgrade` or `restored-backup`.

What the service does with it:

- It refuses every write with 403 and `workspace-read-only`.
- It reports `readOnly` in `GET /api/session` (an absent key means writable).
- It shows the app's `message` in a banner exactly as given. The app writes every message (`versions.mjs`; the newer-patch and newer-minor wording is the CLI's too).

What the CLI sees: while the workspace is open read-only the app also writes `readOnly: { reason, message }` into `.opendoc/desktop.json`, which the CLI reads. `opendoc check` works, a write command is refused with that message, and the key is gone when the workspace is writable or the app quits. `declined-upgrade` and `restored-backup` exist only while the app holds the workspace; the CLI's own table (a managed workspace, run from the app's runtime) answers for the others, and gives the app's answer for every row of the table.

What a read-only open writes: nothing in the workspace but the `node_modules` link. No marker (a synced folder with no `.opendoc/workspace.json` opens read-only without one, and without the adoption question), no pin, no history.

How the app knows the service can do this: a service says so by returning `readOnlySupported: true` from `prepareOpenDocService`. The app checks that before anything is changed (the runtime's `service.ts` says it), and again inside the host before the service starts. While it is missing, a workspace that would open read-only is refused with the same message and "Back to workspaces", so a workspace is never opened writable by mistake. The probe (`readOnlySupported`) ignores comments and types in the runtime's `service.ts`.

#### Upgrade

Back up, run the registry's steps (`workspace/registry.mjs`; empty for now, and a missing entry still upgrades), move the pin, then run `check` and `review` on every document with the workspace as the working directory.

If everything passes the workspace opens, and a message says where the backup is. Otherwise a result screen lists each failing document with its message and offers **Copy prompt for your agent**, **Restore backup** and Close (and "Open anyway" when only checks and reviews failed).

Before the pin moves, the upgrade writes `.opendoc/upgrade-pending.json`, and removes it after `check` and `review`. If it is still there at the next open (a crash after the pin moved), the checks run again and the result screen is shown. A crash before that leaves the backup, and the next open sees the older pin and asks again.

#### Backups

The backup is `<data>/backups/<workspace>-<YYYY-MM-DD-HHMMSS>/`. The name never starts with a dot, so a workspace folder called `.notes` still lists. It holds:

- `backup.json`: source, from and to versions, time, file count, bytes.
- `workspace/`: a copy of everything except the top-level `node_modules`, `.opendoc` and `output` and the metadata of version control and file sync.

That metadata is neither backed up nor restored: `.git`, `.hg`, `.svn`, `.jj`, `.sync_*.db*`, `._sync_*.db*`, `.csync_journal.db*`, `.owncloudsync.log*`, `.nextcloudsync.log*`, `.~lock.*`, `.stfolder`, `.stignore`, `.stversions`, `.dropbox*`, at any depth. Restoring an old `.git` would silently roll back commits.

Free space is checked first. The backup is built in `.<name>.partial` and renamed. A `.partial` folder older than ten minutes (a crash; it is only a copy) is removed when the app starts and when the backups page opens. Backups are never deleted automatically; File > Workspace Backups… lists them with Reveal and Delete (to the trash, after a question).

#### Restore

Restore works file by file and never moves a file across filesystems. In order:

1. It checks the free space (for the safety copy and for the new files).
2. It writes `.opendoc/restore-journal.json` before the first change.
3. It copies (never moves) the current version of every file that will change or disappear into a new `before-restore` backup (`scope: "changed-files"`).
4. It replaces files one at a time atomically, removes the files the backup lacks, and leaves identical files alone (same inode).

If any step fails it rolls back from the safety copy. The safety copy is deleted only when the rollback fully succeeded; if it did not, the error names the folder that holds it and keeps the journal. After a restore the workspace counts as read-only.

Rollback and recovery are one routine that reads the state of each path and does only what is still needed, so they can run again from any state (a kill in the middle of the restore or of the rollback, a file that became a folder or the other way round). The temporary files of the plan's paths are removed at any depth, files that already equal their saved copy are not rewritten (no room needed on a full disk), and a folder the backup lacks that holds version control or sync metadata stays and is named in the result.

A journal found at the next open of the workspace, or on the backups page, is acted on: the restore is undone from the safety copy, and the result is shown (a copy that is still needed cannot be deleted from the backups page). If recovery still cannot finish, the open shows a dialog that names the safety copy and offers **Open anyway** (the journal is set aside inside the safety copy, so nothing is rolled back later over new edits) or Cancel (nothing changes). The user is never locked out of the workspace.

### Files

- `config.json` in the profile folder (`~/.config/opendoc-desktop/` on Linux, `~/Library/Application Support/opendoc-desktop/` on macOS): `defaultWorkspace`, `recentWorkspaces` (at most 10, newest first), and the keys of other parts of the app. Written atomically with mode 0600; unknown keys are kept. Opening a workspace makes it the default, because the router skill and the agents use the default.
- `window-state.json` beside it: size, position and maximised state of the workspace window. A saved position off every connected display is dropped.
- `logs/workspace-<id>.log` beside it: what the service printed, and when the app started and restarted it. The crash screen and the Help menu link to it.
- The data folder (`$XDG_DATA_HOME/opendoc-desktop`, else `~/.local/share/opendoc-desktop`; on macOS the same folder as the profile, `~/Library/Application Support/opendoc-desktop`): `backups/` (one folder per upgrade or restore), `runtime/` (an AppImage's runtime copies and the `current` link; none elsewhere) `integrations/` (the stable copy of the plugin files) and `integrations.json` (the record of what the AI apps screen connected; see [AI apps](../docs/DESKTOP.md#ai-apps)). `workspace/paths.mjs` decides the location.
- The update cache, which electron-updater makes (`$XDG_CACHE_HOME/opendoc-desktop-updater`, else `~/.cache/opendoc-desktop-updater`; `~/Library/Caches/opendoc-desktop-updater` on macOS): the downloaded installer, under `pending/`. The name comes from `updaterCacheDirName` in the packaged `resources/app-update.yml`.
- The `opendoc` command for an AppImage or a Mac: `~/.local/bin/opendoc`, or on a Mac `/usr/local/bin/opendoc` (see [The `opendoc` command](../docs/DESKTOP.md#the-opendoc-command)).
  - The code for both is in `cli-shim.mjs` (the file work) and `command-line-tool.mjs`, in `src/main/`.
  - Neither the app nor the launchers use flags that start with `--appimage-` (the AppImage runtime reserves them).
- Per workspace: `.opendoc/desktop.json` (`{ pid, startedAt, version, build }`, plus `readOnly: { reason, message }` while it is open read-only) while it is open.
- `config.json` also holds `aiAppsOffered` (a boolean, written `true` when the first-run "Connect your AI apps" screen has been shown, Skip included; absent until then), `upgradeWithoutAsking` (a boolean, false until the user ticks "Upgrade my workspaces without asking from now on") and `commandLineNotices` (`{ path, foreign }`): which one-time notices about the `opendoc` command were shown (see [The `opendoc` command](../docs/DESKTOP.md#the-opendoc-command)).

### Hardening

- Every window: `contextIsolation`, renderer sandbox, no Node integration anywhere, `webSecurity`, no `<webview>`, safe dialogs. The preload script exposes an API only to `app://shell` pages, and the main process checks the caller's address and frame again on every call.
- Content security policy on every workspace response, added by the main process next to whatever the service sends: scripts only from the page's own address (plus WebAssembly for pdf.js), no plugins, no framing, connections only to that address (no WebSocket: nothing listens). The app's policy is appended as a further policy, never set in place of the service's, so the service's own (`default-src 'none'; sandbox` on SVG assets) still applies, and every other header of the service (`Content-Disposition`, `X-Content-Type-Options`, `Cache-Control`, `Content-Range`) passes through untouched.
- Every request a page makes is checked: `app://opendoc` while a workspace is open, the app's own pages (`app://shell`), `data:` and `blob:`. Anything else (other hosts, any `http:` address, `file:`) is cancelled.
- Navigation stays on the origin. A web link (`http`, `https`, `mailto`) goes to the system browser through `shell.openExternal`; anything else is dropped. Dropping a file on the window does not navigate. The app's own pages (`app://shell`) can be reached only by the main process itself (`loadURL`) and from another shell page: a page, link, form or `window.open` at `app://opendoc` (or a file window, or a blank page) that names `app://shell/...` is dropped, so the workspace window can never become the picker, which has the shell's IPC. The IPC handlers also check the sender's frame: only the top frame of the picker window or of the workspace window at an `app://shell` address.
- `window.open` and `target="_blank"`: a file the service serves under `/api/` (an exported PDF, a specimen) opens in a small app window with Chromium's viewer; everything else is denied; web links go to the system browser.
- Permissions are denied, except `clipboard-sanitized-write` (the copy buttons). Spell checking is off, because it downloads dictionaries.
- Downloads arrive in a temporary file, then a save dialog asks where they go; a cancelled dialog discards them. A window opened only to start a download closes itself.
- No `file://` page and no cookies: the session token travels in a header, as in the browser edition.
- The service hands its token to any caller of `GET /api/session` and does not check Origin. So the main process lets a request that changes something (any method but GET and HEAD under `/api/`) through only when the app's own page made it: Electron's web request hook reports the starting origin as `initiatorOrigin` (it does not pass the Origin header to a protocol handler), and a request with none, or with another one, is cancelled. Every answer from a transport is wrapped: a throw becomes a 500, and a transport that was stopped (or whose host is gone) answers 503. Any host other than `app://opendoc` answers 403.
- One session partition per workspace (`persist:ws-<hash of the path>`), so workspaces never share browser storage. Which window may call the service: every request passes through the main process, which answers only the one session that belongs to the open workspace, and the `initiatorOrigin` rule above decides who may change things.
- **Invariant: the service never serves user-supplied bytes inline as HTML, JavaScript or SVG.** Every file window of a workspace shares the workspace's session (and so its token and its origin, `app://opendoc`), so a user file that ran as a page would run with the full rights of the app.
  - The inline answers the service gives today are only: a PDF the service made itself, PNG, JPEG and WebP images (the logo, cover and media routes, sent with `X-Content-Type-Options: nosniff`), a font (`font/ttf`, `font/otf`), and the app's own files from its `dist` (`client.ts`).
  - Everything else is an attachment: an SVG asset (`attachment` plus `default-src 'none'; sandbox`), a file from a document's media folder (`application/octet-stream`, `attachment`), PPTX and the exports. The service also refuses an `.html`, a `.js` and an `.svg` that carries a script as an upload.
  - `inline-content.spec.mjs` holds the service to it: an `.html`, a `.js` and an `.svg` are added through the logo, font and media routes and put in a media folder by hand, then fetched back through `app://opendoc`, and each answer must be refused, an attachment or a type that cannot run script, with `nosniff`.
  - Known gap (the service is not editable from the shell): the PDF routes send no `nosniff`; their bytes are generated by the service, not supplied by a user.

#### Accepted risks

- **The app executable can run as Node.** OpenDoc Desktop keeps Electron's `runAsNode` fuse on, because the command line tool, the service host and the render workers run on the app's own executable, so you need no separate Node. Any program that can already start the app as your user can therefore run JavaScript with your rights, which it could do with any interpreter. On macOS, such a process also inherits permissions macOS granted to OpenDoc; OpenDoc asks for none beyond the Electron defaults. `NODE_OPTIONS` is switched off. The `--inspect` flags are not blocked in this mode.
- **Opening a workspace runs its code.** A workspace can contain themes, templates and the workspace's own `opendoc` command. OpenDoc runs them in the service process when you open or render the workspace. Open workspaces and install packs only from sources you trust. Installing a pack always asks you to confirm, and inspecting a pack never runs it.
- **Update address.** The updater uses the built-in address unless you set `updateFeed` in `config.json`, and anything that can write your `config.json` can choose where updates come from. An installed app accepts only an `https` address there: the test switches and a plain-http loopback address are ignored unless the build is a test build (see [Test builds](#test-builds)), and when the address is not the built-in one the restart prompt (and the AppImage's "update is ready" notice) names it. A deb, rpm or pacman update is installed only when its Ed25519 release signature verifies with the public key that ships with the app, so a changed address cannot get its own package installed as root; the SHA-512 alone proves the file is the one the feed names, not who published it, and that is all an AppImage or macOS update is checked with (see the next two points). Keep `config.json` private to your account, and switch updates off with Check for updates in the menu if you do not want any request.
- **An older signed build can still be offered.** The signature proves a build came from the release key, not that it is the newest. Whoever controls the update address can offer a genuinely signed older build (as a build number above yours if they edit the metadata), and the helper installs it. A rollback is therefore possible for someone who controls the address; the signing key is what protects against a package nobody at the project made.
- **AppImage and macOS updates check the SHA-512 only.** They are written by the app as your user, with no administrator password and no root helper, so a bad one gains no privilege; but nothing there proves who published the file beyond HTTPS and the controller of the address. The release still carries `.sig` files for them, which you can check by hand.
- **The release key.** The private half is a secret of the project's repository, used only by the release workflow. If it leaks, the key has to be replaced: see [Rotating the key](#signing-releases). Until a build that ships the new public key is installed, updates signed with the new key are refused.
- **Linux integrity checks.** ASAR integrity validation is enforced by Electron on macOS and Windows only. On Linux the package manager's own checks and the file permissions of the install folder are the protection.
- **Styles.** The page allows inline styles. Scripts are limited to the app's own files and one hashed boot script.
- **AI apps.** The AI apps module only runs the vendor commands it lists, with fixed arguments. The skill it installs is text that your AI app reads; content from documents you open can try to steer that app, so keep the app's own permission prompts on. It starts those commands from a private working folder (`integrations-work` in the data folder, mode 0700, removed with the last disconnect), with `PATH` made only of absolute folders.
- **Restoring a backup** and **opening a file** are checked: a restore refuses a backup whose entries would resolve (through links) outside the workspace, and the "open with" handler passes on only `.zip` pack files.

### Window behaviour

- Closing the window (or quitting) while the page holds an unsaved text draft (a `sessionStorage` key starting `opendoc:text-draft:`) asks Leave or Stay. Stay keeps the window, the service and the draft.
- The page's own `beforeunload` prompt (registered only when a draft could not be stored) is answered with the same question. Without an answer, Electron would ignore every close and quit.
- "Show in folder" for a document export is the service's own route: the host starts the file manager (`xdg-open`; `open -R` on macOS). The service removes `ELECTRON_RUN_AS_NODE` from the environment of programs it starts for the user (`externalEnv()`, `src/server/external-env.ts`); `workspace-flow.spec.mjs` checks that a stub `xdg-open` does not see it.
- The window title is the page title followed by `OpenDoc Desktop`, the name the app shows people in titles, About, the menus and its messages (`displayName` in `identity.mjs`). Files, folders, the process and the package keep `opendoc-desktop` (`appName`). On macOS the app menu's title comes from the bundle's name, which is still `opendoc-desktop`.
- The window cannot be made smaller than 640 by 480, the same floor a saved size is restored with.

### How the updater works

What a user sees for each install type is in [Updates](../docs/DESKTOP.md#updates); this section is the detail. The app updates itself where it can (`src/main/updater/`, built on electron-updater 6.8.11). What it does depends on how it was installed, found in this order:

1. `resources/update-disabled` exists (a managed install, such as a distribution package that updates through its package manager): no updater, no network, no menu items.
2. `config.json` has `"checkForUpdates": false`: no automatic checks and no network. The checkbox in the menu changes this value and takes effect at once: the timer stops, and a check that is still fetching or downloading is dropped (it neither downloads nor opens a dialog afterwards). The switch governs automatic checks only: "Check for Updates…" still runs one check when clicked, and an update it finds is downloaded and installed the normal way for the install type (an AppImage at quit, a package through "Restart to Update"). It does not turn automatic checks back on. A manual check that is dropped because automatic checks were switched off while it was running ends silently: no download, no dialog.
3. macOS.
4. The `APPIMAGE` variable is set: AppImage.
5. `resources/package-type` says `deb`, `rpm` or `pacman`.
6. Anything else (a development run, a directory build) is inactive. A development run checks only when `OPENDOC_DESKTOP_UPDATE_RESOURCES` names a folder standing in for `resources/` (tests only; an installed app that is not a test build ignores the variable).

#### When it checks

Once at launch and then once a day while the app is open (when the switch is on), and whenever the user chooses "Check for Updates…". Nothing is sent while the app is closed. A background check is silent unless there is something to do; a manual one always answers.

#### Where it looks

The address in `resources/app-update.yml` (the fork's GitHub releases) unless `config.json` has `"updateFeed"`. The value is one of:

- a `https://github.com/<owner>/<repo>` address;
- a folder address ending in `/` that holds `latest-linux.yml` (or `latest-mac.yml`) and the files;
- for tests, `http://127.0.0.1:<port>/github-like`.

Which schemes are accepted:

- `https:` is accepted everywhere.
- Plain `http:` for 127.0.0.1, localhost and [::1] is accepted only by an unpackaged run or a test build (see [Test builds](#test-builds)). An installed app refuses it, logs that, and never contacts it.
- Anything else (other schemes, an address with a user name or password) is refused, logged and never contacted.

When the feed is not the built-in address (the `updateFeed` of `config.json`), the app's own "Restart to Update" prompt and the AppImage's "update is ready" notice name it (its origin, or `https://github.com/<owner>/<repo>`), so a changed address is visible before the user agrees to an install.

Redirects are followed only to https (a loopback feed may also be redirected to loopback http); a redirect to plain http is refused and logged. This holds for the metadata, the block maps, the full download and the differential (ranged) download, which GitHub release downloads use: every request is made with manual redirect handling and each redirect is checked before it is followed, and as a catch-all a filter on the updater's own session cancels any request or redirect hop to plain http (except loopback http for a loopback feed).

The metadata's file entries must be plain names next to the metadata. A release is not offered when:

- any entry contains whitespace, a control character or a backslash; or
- resolving it against the feed (or, for a feed set in `config.json`, against that feed's own address too) would leave the feed's host (an absolute address, `//host/...`, or a scheme such as `file:`).

Metadata whose file list has an entry that is not an object with a text address (a YAML list, a number), or whose `path` is not text, is refused as a whole.

#### What counts as an update

A higher version always does. The same version does when the metadata's top-level `build:` is a whole number above the running build (`resources/runtime/build-info.json`), so a rebuilt release replaces an older build of the same version. The metadata must also list a file for this install type (`.AppImage`, `.deb`, `.rpm`, `.pacman`, or the macOS `.zip`) with a SHA-512; a release without one is not offered, and the reason goes to the log.

#### What happens next, by install type

##### AppImage

The file is downloaded in the background (a differential download when the feed supports ranges) and swapped in when the app quits, so the next launch is the new build, with no prompt.

Before downloading, the app checks that the AppImage's folder is writable and has room for another copy (and checks the room again before staging). If not, nothing is downloaded and the user is told once.

The swap never leaves the user without an AppImage:

1. The download is copied beside the AppImage under a temporary name, checked against the metadata's SHA-512 again, made executable and synced.
2. Only then is it renamed over the AppImage (atomic, same folder).

Nothing is unlinked first and the new AppImage is never run. On any failure the temporary file is removed and the old AppImage is untouched (the download is kept, and the next check tries again). The reason is recorded in `config.json` (`updateNotices.swapFailed`), and the next launch says so once in a notice that names the folder and the reason, without blocking anything.

The file keeps its name (it has no version in it), so `~/.local/bin/opendoc` keeps working; if a build ever renames it, the shim is pointed at the new path.
##### deb, rpm, pacman

The file is downloaded in the background and "Restart to Update" is offered (a dialog, and a menu item that stays until used). It runs one asynchronous `pkexec` call, so the window never freezes behind the password prompt.

**The signature file.** Once electron-updater has downloaded and checked the package, the app fetches `<the package's own address>.sig` under the same rules as the package (https only, a loopback feed only in a test build, the guarded redirects). It checks that the file is 64 bytes and stores it beside the download as `<package>.ed25519.sig` (not `<package>.sig`, which `pacman -U` would take for a PGP signature if the file is installed by hand).

If the signature cannot be had then, "Restart to Update" tries once more. If it still cannot, nothing is installed, `pkexec` is never started and the app says "This update has no signature, so it was not installed. Download it from the release page and install it by hand."

**The install call.** The call copies the file and its signature to a root-owned folder and then:

1. checks the file's SHA-512 again as root (the checksum comes from the metadata the app already verified);
2. checks the signature against the release public key with `openssl pkeyutl -verify -pubin -inkey release-key.pem -rawin`;
3. runs `dpkg -i` (and `apt-get install -f -y` to settle dependencies), the `zypper`, `dnf`, `yum` or `rpm` equivalent, or `pacman -U --noconfirm`.

Exit codes of the helper:

| Exit | Meaning | Result |
|---|---|---|
| 70 | The SHA-512 check failed | Nothing is installed. |
| 71 | The signature does not verify, or the key file is missing | Nothing is installed. |
| 72 | There is no `openssl` | Nothing is installed. |
| 126 or 127 | The password prompt was cancelled | The app says "Update cancelled" and keeps the download. |

A failure shows the command to run by hand, except when the signature was missing or did not verify: that file is not one to install by hand.

**The helper.** The deb, rpm and Arch packages (which depend on `openssl`) install three things:

- a root-owned helper, `/opt/opendoc-desktop/resources/updater/install-update`;
- the release public key beside it (`release-key.pem`, read by the helper from its own folder);
- a polkit action, `/usr/share/polkit-1/actions/io.github.ryanyahya.opendocdesktop.install-update.policy`.

`pkexec` runs the helper through that action, and the password prompt reads "Authentication is required to install an OpenDoc Desktop update." Both files are removed with the package. The AUR package has neither (its updater is off, so it never asks).

An install without the helper (a build older than the helper) still shows the long command in the prompt, which then holds the release public key text as well. The app reads the key from its own resources and the script writes it to its root-owned temporary folder itself; no value from the feed or the cache reaches the key.

**Cleanup.** After a successful install the downloaded installer and its `update-info.json` are deleted from the updater's `pending/` folder (so a root-installed package does not sit in your cache), and the next check that finds nothing newer clears it too. The AppImage and macOS updates use the same cleanup at that next check, which removes what their swap left in `pending/` (the AppImage's `update-info.json`, the macOS zip). A download that still waits to be installed is never cleared. The app then restarts itself.
##### macOS

The app unpacks the downloaded zip with `ditto`, checks its signature and bundle identifier, and replaces the bundle in place through a small helper.

- The helper waits for the app to quit, for at most 60 seconds. Then it gives up without swapping, and logs that to a file the next launch copies into the updater's log. The next check offers the update again.
- It puts the old bundle back if the swap fails.
- The new bundle is the one in the zip with the running app's bundle identifier, whatever its file name, and its version and build must be the ones the release announced.

It does this only when the app is not running translocated and its folder is writable; otherwise the user gets a notice with a button to the release page. (Only its decisions are unit-tested; see [What the tests cover](#what-the-tests-cover).)

Every download is checked against the SHA-512 in the update metadata before it is used. A file that does not match is deleted and refused. The SHA-512 proves the file is the one the metadata names; it does not prove who published it. For deb, rpm and pacman the release signature does (above): the package tools themselves still run with their own signature checks off (`dpkg` has none, and the rpm tools get `--nogpgcheck` or `--allow-unsigned-rpm`), because the packages carry no signature those tools know, and the helper has already verified the release key's signature on the exact copy it installs. The AppImage and macOS updates rest on the SHA-512, TLS and whoever controls the feed (they install without administrator rights).

#### After an update

The first launch shows "OpenDoc Desktop was updated to <version>, build <build>" once, with a button that opens `https://github.com/<owner>/<repo>/releases/tag/desktop-v<version>-<build>` in the browser. `config.json` keeps `lastRun` for this, and `updateNotices` for the notices that are shown once. Other code can listen for an update with `onUpdated(callback)` on the shell's updater. The updater's log is `<userData>/logs/updater.log`.

### What the tests cover

The shell tests open real Electron windows, so they run only on a virtual display, through one script:

```sh
node desktop/tests/shell/run.mjs            # Playwright (Electron under Xvfb), niced, with a time limit
node desktop/tests/shell/run.mjs --grep NAME
node desktop/tests/shell/run.mjs --unit     # unit tests, no Electron
```

`run.mjs` starts everything as `nice -n 19 ionice -c 3 timeout -s KILL <limit> xvfb-run -a env -u ... playwright test`, removes the display and Electron variables the Claude desktop app sets, refuses to run without the virtual-display marker, and kills every leftover process of this worktree's Electron afterwards (matched by executable path). The tests use scratch workspaces made with `opendoc init` under `tmp/shell-tests/`, a fresh profile folder each, and replace the native dialogs and "open in the OS" calls in the main process with recorders; nothing touches a real workspace.

The first run builds the OpenDoc package (`pnpm package:pack --edition normal`, or the tarball named by `OPENDOC_SHELL_TEST_TARBALL`), a runtime folder from it, and two template workspaces: the one the app makes (`opendoc init --no-start` from the runtime, no npm) and one as npm leaves it (`golden-npm`: a real `node_modules`, a `package-lock.json`, a marker without `managed`; made once with `npm install` from the npm cache, so the first build needs the registry). Creating a workspace in the app needs no npm.

The unit tests include one for the transport that runs a stand-in service in plain Node (`unit/transport.test.mjs`: upload, `Range`, a large answer, changes, abort, a dead and a stopped host, the process group, a failed or hung start, credit and a reader that does not read, a cut-off upload, a bad status, a start cancelled by its signal, and `kill -9` of a parent process while its host is starting, busy in a loop or stopped, a request that is over before its upload is read, and nine ways a broken host can answer, a bad status, header or piece, each a 502 or a failed response with the same host serving the next request) and one for the host's request and response objects (`unit/service-host.test.mjs`, including an upload read with `readable` and `read(n)`), and `unit/sentinel.test.mjs`.

The workspace work has its own tests: `unit/workspace-*.test.mjs` (the version table, pin rewriting, links, adoption, backups and Restore, the registry, the AppImage copy, the open flow with a recording UI, and the read-only handshake with a stand-in service) and `workspace-versions.spec.mjs` (every row of the version table, the upgrade with its backup, the result screen and Restore, adoption, repaired links, the backups list and the AppImage copy, in the app). Every launch gets a scratch `HOME` with its own `XDG_*` folders and npm cache under `tmp/shell-tests/`, so backups and runtime copies never land in a real data folder; a workspace made by `newWorkspace()` is linked to the test runtime and marked `managed`, as the app leaves one (`{ npm: true }` is the npm template; the default also carries that template's `package-lock.json`, which the app must leave byte-identical). The spec covers every read-only row opening read-only (the banner, a refused write, `desktop.json`, a restart of the host, a marker-less folder), Restore opening read-only, Create with no npm on the PATH (also on an AppImage), and the CLI next to the app and on its own.

`packaged.spec.mjs` runs the app as it ships: `desktop/src`, `package.json` and the production dependencies (electron-updater and what it needs) packed into an `app.asar` (with electron-builder's own packer) and started by the same Electron, to prove that the service host (passed to the child as text) and the page work from inside an asar. It does not test the installers; that is the packaging work's.

Not covered by the tests (they need a person on a real display): native Wayland and fractional scaling, the GPU, input methods, the real clipboard, the real file chooser and file manager, and dropping a file from a file manager.

The agent command has its own spec, `command.spec.mjs`, run against a linux-unpacked layout (this worktree's Electron renamed `opendoc-desktop`, the test runtime in `resources/runtime`, the launchers in `resources/cli`). Point `OPENDOC_SHELL_TEST_UNPACKED` at a real `linux-unpacked` folder to test a real build instead (it is copied, never changed). Every command test uses a scratch `HOME`, and a tripwire `node`, `npm` and `npx` first on the PATH proves that no system Node is used.

The AI apps screen has three test files:

- `unit/ai-apps.test.mjs` (the module's options, the rows and badges, Connect, Disconnect, Forget, blocked, failed and absent apps, the refresh at launch and the first-run flag, all with fake `claude`, `codex` and `agy` commands in a scratch home);
- `unit/integrations-targets.test.mjs` (the list that runs no vendor command and reads the login shell once, which Claude Code folders are found, connecting in a second folder, records from before folders were targets, ids a page may not invent, the refresh with two folders);
- `ai-apps.spec.mjs` (the screen in the app: first run, Skip, the menu item, the list showing while a fake vendor command is slow, Claude Code with two folders, Try it, the Other app page, Connect and Disconnect, a blocked result).

Every one of those runs keeps the module away from the real home, config folders and login shell (`support/integrations.mjs`); the tests' own `CLAUDE_CONFIG_DIR` and `CODEX_HOME` are scratch folders too.

Opening a pack has two test files:

- `unit/pack-import.test.mjs` (arguments, the 64 MiB limit, the queue, and every refusal of Show in folder);
- `pack-import.spec.mjs` (a launch argument, a second launch, `open-file`, the File menu, a pack that waits for a workspace, Show in folder).

The updater has its own unit tests and Electron specs, a local feed server and a hand-run AppImage update (build 1 to build 2); [Testing updates](#testing-updates) says how to run them. They use loopback feeds only, never GitHub. The macOS swap is covered only by tests of its decisions, because it needs a Mac.

### The service host and the bridge

#### Transport

`transport.mjs` starts the host as `<app executable> --import <tsx> --import <watchdog> --input-type=module -e <host source> opendoc-service-host <service.ts>` with `ELECTRON_RUN_AS_NODE=1`, `cwd` = the workspace root (the service's themes and documents read the working directory), `serialization: 'advanced'` and a process group of its own. The host's code is passed as text, so the child never reads a file inside `app.asar`. The service comes from the runtime (`node_modules/opendoc/src/server/service.ts`; the repository in development) and is created with `createOpenDocService({ root: cwd, production: true })`; the host tells the main process when it is ready.

#### Requests

`protocol.handle('app')` (one handler per session) serves `app://shell/` itself and forwards `app://opendoc/` to the transport. Full requests, `Range` headers (a 206 and its `Content-Range` are carried through as the service sent them; today the service ignores `Range` and pdf.js loads PDFs whole), uploads of up to the service's 100 MB cap, and downloads all use this path.

A request goes to the host as a message (method, path and query, headers with `host: opendoc`); an upload follows as body pieces, an abort as an abort message. The host builds Node's request and response objects (`src/host/service-host.mjs`), calls `service.handle(req, res)` and sends back the status line and headers, then the body in pieces.

Both directions are flow-controlled by credit. The host writes at most 4 MiB of a response that the page has not taken (the response is a `ReadableStream` whose `pull` sends a `credit` message back, so a slow or stopped reader holds the host to one window of an endless answer). The main process sends at most 4 MiB of an upload that the service has not read (the host sends `body-credit` as the service reads). When a response ends, is cancelled or fails, the upload loop is cancelled and the host told to abort.

What Electron 45 does and does not tell the handler (measured, `integration.spec.mjs` and the unit tests):

- A page that cancels a download makes it cancel the response stream (so the host is told to abort, though Chromium has by then pulled up to about 8 MB ahead of a slow page, which is why a fast host may have sent a whole 12 MB file before a kill lands).
- A page that aborts a `fetch` does not set `request.signal` (the listener is kept for other Electron versions), and Electron has already handed over the whole upload body, so the service finishes a request it received in full, as a web server would.

Requests made by dedicated and shared workers do not reach the `webRequest` hook at all (the protocol handler sees them, with no origin), so the caller guard cannot police them; what keeps a worker of another origin out is that no page of another origin can start one (the shell's pages have `worker-src 'none'`, and every other page is the workspace itself).

Everything the host sends is checked before it is used: a status outside 200 to 599, a header name or value that is not valid, too many or too large headers, an oversize chunk, or a message of the wrong shape answers 502 (the request fails, the host keeps serving). A host that dies fails every request waiting for it (503) and later ones too, until the supervisor has started a new one.

#### Bridge

The service's `onChange` goes to the main process and on to the workspace window's main frame, only while that frame is at `app://opendoc`. The preload exposes, in that frame only and nowhere else (the app's own pages, iframes and other windows get nothing):

- `window.opendocDesktop.onChange(listener)`: called with no arguments whenever the service reports a change.
- `window.opendocDesktop.onHostState(listener)`: called with `{ state }`: `'restarting'` (the host exited or stopped answering; requests fail meanwhile), `'running'` (it is back; the page refetches), or `'failed'` (the shell gave up and is about to show its crash screen).
- `window.opendocDesktop.onImportPack(listener)`: called with `{ name, bytes }` (a `Uint8Array`) when the user opens a design pack from outside the page: a launch argument, a second launch, macOS `open-file`, or File > Import Design Pack…. The main process reads the file (at most 64 MiB), keeps it until the workspace page has loaded, and sends it to that frame; the preload keeps the newest pack until the page has a listener, so one that arrives before the page subscribes is not lost, and it goes to the first listener once. A page that does not use it (the browser edition) never sees one.
- `window.opendocDesktop.showInFolder(path)`: asks the main process to reveal a pack the page saved. It resolves with nothing whatever the answer; the main process checks the caller (the open workspace's top frame) and reveals only a file that, with every link resolved, lies inside the open workspace's `output/packs/` (`revealablePackPath` in `pack-import.mjs`).

The subscriptions return a function that stops listening. `src/app/main.tsx` uses `onChange` instead of its WebSocket when the bridge exists.

#### Never left behind

Three guards, because a host can die of the app's death in three different states.

1. **The watchdog.** `watchdog.mjs` is loaded first (`--import data:...`, from text, so nothing is read from `app.asar`), before tsx and the service. If the channel is already closed it ends at once, and when the channel closes it kills the host's process group.
2. **The parent check.** The same file starts a worker thread that polls the parent id every 300 ms and kills the group when it changes. This works while the host's main thread is stuck in a synchronous loop (where 'disconnect' never runs).
3. **The sentinel.** The main process starts a small shell sentinel (`/bin/sh`, in its own session). It checks every second that the app and the host's group are still there, and kills the group when the app is gone first. It covers a host that is stopped (SIGSTOP), runs nothing, and the render workers it started, and it exits as soon as the group is gone.

The sentinel's script is `sentinelScript` in `transport.mjs`, written for every POSIX shell in the one form they all accept, `kill -0 "-$2"` and `kill -KILL "-$2"`. dash, the `/bin/sh` of Debian and Ubuntu, rejects `kill -0 -- -PID` and `kill -s 0 -PID`, and busybox sh rejects any `--`. `unit/sentinel.test.mjs` runs the script under each shell the machine has, which in CI includes dash and busybox on Ubuntu.

The group is signalled only from the sentinel's check and once, from the host's exit event, never later: a group number cannot be given to anything else while any of its members lives. A start in progress is cancelled by an abort signal (the app is quitting, or the supervisor was stopped), which kills the host. Windows has no process groups: the channel and the parent id check remain.

#### Supervision

The supervisor checks that the service answers (a real `GET /api/session` through the channel, every 5 seconds, three misses in a row) and restarts the host when it exits or stops answering, after killing it and its process group. The window keeps its page: the address does not change, and the page fetches a new session token on its own when a write is refused. A restart sends `restarting`, then `running`. After three restarts in two minutes the shell sends `failed` and shows the crash screen, whose "Try again" starts the host again and loads the workspace.

#### No port

Nothing in the app listens: the host has no server, the window loads from the `app` scheme, and the app writes no `.opendoc/server.json`. `robustness.spec.mjs` proves it with `ss -ltnp` and `ss -lunp` while the app runs by itself (Playwright's own driver adds a DevTools port and a Node inspector port, so that test starts the app without it), five seconds after a quit and after a `kill -9` of the main process no process runs from the app's executable path, and the next launch opens the workspace with no cleanup.

What the shell still does around `createOpenDocService().handle()` (all in place and tested): any other host answers 403; only the app's own page may change things (`initiatorOrigin`); change events go to one frame only; no cookies and no token in a URL; a throw answers 500 and a closed or dead transport 503; `close()` runs once, in `will-quit`; the host's working directory is the workspace.
