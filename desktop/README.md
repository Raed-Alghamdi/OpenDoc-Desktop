# opendoc-desktop

A self-contained desktop app for [OpenDoc](https://github.com/RyanYahya/OpenDoc) on Linux and on macOS (Apple Silicon), built with Electron. It carries its own runtime, so users install no Node or npm, and it installs the `opendoc` command for agents.

This package is private to the repository: OpenDoc's npm packages do not include `desktop/`.

What the app does, how to install and remove it, what it reads and writes, and how it is hardened: [docs/DESKTOP.md](../docs/DESKTOP.md). This page is for people who build, test and release it.

## Layout

- `src/main/`: the Electron main process (the shell). `src/main/workspace/` holds the workspace link, the version table, the upgrade with its backups, and the AppImage's runtime copy.
- `src/host/`: the service host, the code that runs in the child process beside the OpenDoc service and carries requests over its IPC channel (no port), and the watchdog that ends it when the app is gone.
- `src/preload/`: the preload script. It gives the app's own pages their calls to the main process, and the workspace page its two bridge functions (`onChange`, `onHostState`).
- `src/renderer/`: the app's own pages (workspace picker, crash screen, upgrade progress and result, the backups list).
- `src/main/updater/`: the in-app updater (install type, build-aware comparison, feed address rules, schedule, package and macOS installs). How it behaves: [docs/DESKTOP.md](../docs/DESKTOP.md#updates).
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

The folder holds `package.json`, `package-lock.json`, `build-info.json` and `node_modules/` (about 185 MB). To rebuild, run the command again: it makes the old folder writable first. To run the shell from this runtime, set `OPENDOC_DESKTOP_RUNTIME` to it (see [Run it from a checkout](../docs/DESKTOP.md#run-it-from-a-checkout)).

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

A release build is made without it (the release workflow does not set it, and `check-release.mjs` fails any installer that carries the field). Never publish or install a test build as your own app. See [Test builds](../docs/DESKTOP.md#run-it-from-a-checkout) in the desktop guide.

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

Every installer in a release carries a detached signature, `<file>.sig`: the raw 64 bytes of an Ed25519 signature (PureEdDSA) over the whole file. The deb, rpm and pacman updater checks it as root before installing (see "Updates" in [docs/DESKTOP.md](../docs/DESKTOP.md)); AppImage and macOS updates do not use it, but the files are signed the same way and anyone can check one with `openssl pkeyutl -verify -pubin -inkey desktop/resources/updater/release-key.pem -rawin -in <file> -sigfile <file>.sig` (OpenSSL 3).

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

`pnpm --filter ./desktop run test:shell` and `run test:shell:unit` do the same. The first full run builds the test runtime and two template workspaces under `tmp/shell-tests/` (it needs the npm registry once). Never start Electron for this project in another way on a machine where someone is working: use the `xvfb-run -a env -u ELECTRON_FORCE_IS_PACKAGED -u ELECTRON_RUN_AS_NODE -u ELECTRON_OZONE_PLATFORM_HINT -u WAYLAND_DISPLAY <binary> --ozone-platform=x11` form inside `timeout -s KILL`. What the specs cover, and what only a person on a real display can check, is in [docs/DESKTOP.md](../docs/DESKTOP.md#tests).

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
