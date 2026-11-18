# opendoc-desktop

opendoc-desktop is a desktop app for [OpenDoc](https://github.com/RyanYahya/OpenDoc) on Linux and macOS, built with Electron on top of the original OpenDoc project. It opens one workspace at a time in a window and carries its own runtime, so users install no Node or npm. This page describes the app's shell: the Electron main process. The package lives in [`desktop/`](../desktop/README.md); OpenDoc's npm packages do not include it.

Status: the shell talks to OpenDoc through a temporary adapter (a service child process on a local port). When `createOpenDocService` merges, only `transport.mjs` changes; see [Moving to the service](#moving-to-the-service).

## Run it from a checkout

```sh
pnpm install --frozen-lockfile
nice -n 19 ionice -c 3 pnpm package:pack --edition normal      # the OpenDoc package the runtime is made from
```

The app looks for its runtime (a folder with `node_modules/opendoc`, `package.json` and `build-info.json`) in the folder named by `OPENDOC_DESKTOP_RUNTIME`, else in `desktop/build/runtime/<platform>-<arch>`. Packaged builds carry it in `resources/runtime`. The runtime is only needed to create a new workspace and to show the build number: opening a workspace uses the `node_modules/opendoc` inside that workspace.

```sh
cd desktop
env -u ELECTRON_FORCE_IS_PACKAGED -u ELECTRON_RUN_AS_NODE node_modules/.bin/electron src/main/index.mjs
```

Once `desktop/package.json` has `"main": "src/main/index.mjs"`, `electron .` does the same. Environment variables that tests and development builds read: `OPENDOC_DESKTOP_RUNTIME` (runtime folder) and `OPENDOC_DESKTOP_HEALTH_MS` (how often the service is checked, default 5000).

## What the main process does

`desktop/src/main/`:

| File | Job |
|---|---|
| `index.mjs` | Entry point: app name and profile folder, single-instance lock, quit handling (the service stops in `will-quit`, never `before-quit`). |
| `desktop-shell.mjs` | Which workspace is open: the open flow, the picker, the crash screen, the menu actions and the calls the app's own pages may make. |
| `transport.mjs` | The one module that carries requests to the OpenDoc service (see below). |
| `supervisor.mjs` | Restarts the service when it exits or stops answering; gives up after three restarts in two minutes. |
| `session-policy.mjs` | Rules for every Electron session: permissions, allowed requests, downloads, the content security policy, "Show in folder". |
| `windows.mjs` | Window security settings, the navigation and new-window rules, the unsaved-edits guard, window state. |
| `policy.mjs` | The rules above as pure functions (tested without Electron). |
| `config.mjs`, `desktop-record.mjs`, `lock.mjs`, `service-session.mjs`, `window-state.mjs` | The files the app reads and writes, each with its own tests. |
| `menu.mjs`, `about.mjs` | The application menu and the About dialog. |
| `runtime.mjs`, `process-info.mjs`, `identity.mjs`, `shell-pages.mjs` | Where the runtime is and how to run its CLI; questions about other processes; names; the app's own pages. |

`desktop/src/renderer/` holds the app's own pages (workspace picker, crash screen). They are served from `app://shell/` by the main process, never from `file://`, and get a small API from `desktop/src/preload/shell.cjs`. Workspace pages get no preload API at all.

## Opening a workspace

Everything below happens before the window loads, in this order, and any failure stops the open with a message the picker (or a dialog, for menu actions) shows:

1. The folder must hold `.opendoc/workspace.json`.
2. `.opendoc/desktop.json` (C3): a live opendoc-desktop on it means "already open elsewhere"; a stale one (its pid is gone, or now belongs to another program) is removed.
3. `.opendoc/server.json`: a running browser-edition service means the workspace is refused, with a button that runs `opendoc stop`.
4. The workspace lock (`.opendoc/update.lock`, the CLI's own lock): taken while the workspace opens. A stale lock (its pid is gone) is reported and cleared only when the user asks; a live or damaged one is never offered for clearing.
5. Another workspace that is open is closed first (with the unsaved-edits question), then its service stops.
6. The service starts as a run-as-Node child of the app's executable, with the workspace as its working directory, `OPENDOC_PORT=0` and an IPC channel; the address comes from `.opendoc/server.json`. It runs in its own process group: when the channel closes (the app was killed) the host exits and takes the group with it, so the render workers it started never outlive it, and the app sweeps the group after a normal stop too.
7. `desktop.json` is written, the workspace becomes `defaultWorkspace` and heads `recentWorkspaces` in `config.json`, the window opens, the lock is released.

On quit, the service stops (SIGTERM, then SIGKILL after 8 seconds), `desktop.json` is removed and the lock is released. After a `kill -9` of the main process the service exits by itself when its IPC channel closes, the Chromium helpers follow, and `desktop.json` stays behind, stale, for the next launch to remove.

## Files

- `config.json` in the profile folder (`~/.config/opendoc-desktop/` on Linux, `~/Library/Application Support/opendoc-desktop/` on macOS): `defaultWorkspace`, `recentWorkspaces` (at most 10, newest first), and the keys of other parts of the app. Written atomically with mode 0600; unknown keys are kept. Opening a workspace makes it the default, because the router skill and the agents use the default.
- `window-state.json` beside it: size, position and maximised state of the workspace window. A saved position off every connected display is dropped.
- `logs/workspace-<id>.log` beside it: what the service printed, and when the app started and restarted it. The crash screen and the Help menu link to it.
- Per workspace: `.opendoc/desktop.json` (`{ pid, startedAt, version, build }`) while it is open.
- `config.json` also holds `commandLineNotices` (`{ path, foreign }`): which one-time notices about the `opendoc` command were shown (see "The `opendoc` command").

## Hardening

- Every window: `contextIsolation`, renderer sandbox, no Node integration anywhere, `webSecurity`, no `<webview>`, safe dialogs. The preload script exposes an API only to `app://shell` pages, and the main process checks the caller's address and frame again on every call.
- Content security policy on every workspace response, added by the main process: scripts only from the service's origin (plus WebAssembly for pdf.js), no plugins, no framing, connections only to that origin.
- Every request a page makes is checked: the service's origin, the app's own pages, `data:` and `blob:`. Anything else (other hosts, `file:`) is cancelled.
- Navigation stays on the origin. A web link (`http`, `https`, `mailto`) goes to the system browser through `shell.openExternal`; anything else is dropped. Dropping a file on the window does not navigate.
- `window.open` and `target="_blank"`: a file the service serves under `/api/` (an exported PDF, a specimen) opens in a small app window with Chromium's viewer; everything else is denied; web links go to the system browser.
- Permissions are denied, except `clipboard-sanitized-write` (the copy buttons). Spell checking is off, because it downloads dictionaries.
- Downloads arrive in a temporary file, then a save dialog asks where they go; a cancelled dialog discards them. A window opened only to start a download closes itself.
- No `file://` page and no cookies: the session token travels in a header, as in the browser edition.
- The service hands its token to any caller of `GET /api/session` and does not check Origin. So the main process lets a request that changes something (any method but GET and HEAD under `/api/`) through only when the app's own page made it: Electron's web request hook reports the starting origin as `initiatorOrigin` (it does not pass the Origin header to a protocol handler), and a request with none, or with another one, is cancelled. Every answer from a transport is wrapped: a throw becomes a 500, and a transport that was stopped answers 503.
- One session partition per workspace (`persist:ws-<hash of the path>`), so workspaces never share browser storage. Decision D-e (which window may call the service): on the temporary adapter every request already passes through the main process, which answers only the one session that belongs to the open workspace; the `app://` caller check is the next bullet's rule, which stays when the transport changes.

## Window behaviour

- Closing the window (or quitting) while the page holds an unsaved text draft (a `sessionStorage` key starting `opendoc:text-draft:`) asks Leave or Stay (decision D-d). Stay keeps the window, the service and the draft.
- The page's own `beforeunload` prompt (registered only when a draft could not be stored) is answered with the same question. Without an answer, Electron would ignore every close and quit.
- "Show in folder" is answered by the main process with `shell.showItemInFolder`, so the service never starts a program with its own environment.
- The window title is the page title followed by `opendoc-desktop`.

## Menus

File: Open Workspace, New Workspace (a new or empty folder, made with the CLI's `init`), Open Recent, Reveal Workspace, Show Log, Quit. Edit: the standard roles (macOS needs them for copy and paste). View: zoom and full screen only, with no reload and no developer tools. Window. Help: a link to the original project; About opendoc-desktop shows the version, the build number and commit, and credits the original OpenDoc project with its link. Where the install updates itself, the Help menu (the app menu on macOS) also has "Check for Updates…", the checkbox "Check for Updates Automatically", and "Restart to Update" while a downloaded update is waiting.

## The `opendoc` command

Agents run `opendoc`, not `npx opendoc`, so the app puts a command on the user's machine. Each one runs the CLI inside the app's runtime with the app's own executable as Node (`ELECTRON_RUN_AS_NODE=1`), so no system Node or npm is needed, and it works with the app open or closed.

- **Linux packages (deb, rpm, pacman):** `resources/cli/opendoc` is installed as `/usr/bin/opendoc`. It finds the app in `$OPENDOC_DESKTOP_HOME` (tests), beside itself (`resources/cli/../..`, which also covers a symlink to it), or in `/opt/opendoc-desktop`, and replaces itself with the CLI (`exec`), so arguments, standard input, signals and exit codes pass through.
- **AppImage:** an AppImage's files exist only while it runs, so the app writes `~/.local/bin/opendoc` at every launch from `resources/cli/opendoc-appimage.sh`, with the AppImage's path filled in (`cli-shim.mjs`, `command-line-tool.mjs`). The file is written atomically (a temp file in the same folder, then a rename), only if it is absent or already ours (the words "opendoc-desktop agent command" mark it); a command that is not ours is never replaced, and the user is told once. Each call mounts the AppImage with its own `--appimage-mount` under `setpriv --pdeathsig TERM` (running `AppRun` fails on Ubuntu 24.04), makes the runtime copy under `~/.local/share/opendoc-desktop/runtime/<version>-<build>/` when it is missing or from another build, and runs the CLI; a moved or deleted AppImage gets a message saying to open the app once. The app checks that `~/.local/bin` is on the PATH the app has, a login shell has or an interactive shell has, and tells the user once, with the line to add, when it is on none of them.
- **macOS:** the app menu offers "Install Command-Line Tool". It writes a small launcher into `/usr/local/bin` when that is writable without administrator rights, otherwise `~/.local/bin`, refuses to replace an `opendoc` that is not ours, refuses when the app runs translocated, and explains a PATH problem in the same dialog. At launch an installed command is pointed at the app's current place.
- Neither the app nor the launchers use flags that start with `--appimage-` (the AppImage runtime reserves them).

## Updates

The app updates itself where it can (`src/main/updater/`, built on electron-updater 6.8.11). What it does depends on how it was installed, found in this order:

1. `resources/update-disabled` exists (a managed install, such as a distribution package that updates through its package manager): no updater, no network, no menu items.
2. `config.json` has `"checkForUpdates": false`: no checks and no network. The checkbox in the menu changes this value and takes effect at once (a running download is cancelled, the timer is stopped).
3. macOS.
4. The `APPIMAGE` variable is set: AppImage.
5. `resources/package-type` says `deb`, `rpm` or `pacman`.
6. Anything else (a development run, a directory build) is inactive. A development run checks only when `OPENDOC_DESKTOP_UPDATE_RESOURCES` names a folder standing in for `resources/` (tests only).

**When it checks.** Once at launch and then once a day while the app is open, and when the user chooses "Check for Updates…". Nothing is sent while the app is closed. A background check is silent unless there is something to do; a manual one always answers.

**Where it looks.** The address in `resources/app-update.yml` (the fork's GitHub releases) unless `config.json` has `"updateFeed"`. The value is one of: a `https://github.com/<owner>/<repo>` address, a folder address ending in `/` that holds `latest-linux.yml` (or `latest-mac.yml`) and the files, or, for tests, `http://127.0.0.1:<port>/github-like`. Only `https:` is accepted, plus `http:` for 127.0.0.1, localhost and [::1]; anything else (other schemes, an address with a user name or password) is refused, logged and never contacted.

**What counts as an update.** A higher version always does. The same version does when the metadata's top-level `build:` is a whole number above the running build (`resources/runtime/build-info.json`), so a rebuilt release replaces an older build of the same version. The metadata must also list a file for this install type (`.AppImage`, `.deb`, `.rpm`, `.pacman`, or the macOS `.zip`) with a SHA-512; a release without one is not offered, and the reason goes to the log.

**What happens next, by install type.**

- **AppImage:** the file is downloaded in the background (a differential download when the feed supports ranges) and swapped in when the app quits, so the next launch is the new build, with no prompt. The file keeps its name (it has no version in it), so `~/.local/bin/opendoc` keeps working; if a build ever renames it, the shim is pointed at the new path. At launch the app checks that the AppImage's folder is writable; if it is not, nothing is downloaded and the user is told once.
- **deb, rpm, pacman:** the file is downloaded in the background and "Restart to Update" is offered (a dialog, and a menu item that stays until used). It runs one asynchronous `pkexec` call, so the window never freezes behind the password prompt. The call copies the file to a root-owned folder, checks its SHA-512 again as root (the checksum comes from the metadata the app already verified), then runs `dpkg -i` (and `apt-get install -f -y` to settle dependencies), the `zypper`, `dnf`, `yum` or `rpm` equivalent, or `pacman -U --noconfirm`. A cancelled password prompt (exit 126 or 127) says "Update cancelled" and keeps the download; a failure shows the command to run by hand. The app then restarts itself.
- **macOS:** unpacks the downloaded zip with `ditto`, checks its signature and bundle identifier, and replaces the bundle in place through a small helper that waits for the app to quit and puts the old bundle back if the swap fails. It does this only when the app is not running translocated and its folder is writable; otherwise the user gets a notice with a button to the release page. (Only its decisions are unit-tested; see "Tests".)

Every download is checked against the SHA-512 in the update metadata before it is used. A file that does not match is deleted and refused.

**After an update** the first launch shows "opendoc-desktop was updated to <version>, build <build>" once, with a button that opens `https://github.com/<owner>/<repo>/releases/tag/desktop-v<version>-<build>` in the browser. `config.json` keeps `lastRun` for this, and `updateNotices` for the notices that are shown once. Other code can listen for an update with `onUpdated(callback)` on the shell's updater. The updater's log is `<userData>/logs/updater.log`.

## Tests

The shell tests open real Electron windows, so they run only on a virtual display, through one script:

```sh
node desktop/tests/shell/run.mjs            # Playwright (Electron under Xvfb), niced, with a time limit
node desktop/tests/shell/run.mjs --grep NAME
node desktop/tests/shell/run.mjs --unit     # unit tests, no Electron
```

`run.mjs` starts everything as `nice -n 19 ionice -c 3 timeout -s KILL <limit> xvfb-run -a env -u ... playwright test`, removes the display and Electron variables the Claude desktop app sets, refuses to run without the virtual-display marker, and kills every leftover process of this worktree's Electron afterwards (matched by executable path). The tests use scratch workspaces made with `opendoc init` under `tmp/shell-tests/`, a fresh profile folder each, and replace the native dialogs and "open in the OS" calls in the main process with recorders; nothing touches a real workspace.

The first run builds the OpenDoc package (`pnpm package:pack --edition normal`, or the tarball named by `OPENDOC_SHELL_TEST_TARBALL`), a runtime folder from it, and a template workspace. Creating a workspace runs `npm install` from the npm cache; the first build needs the registry.

Not covered by the tests (they need a person on a real display): native Wayland and fractional scaling, the GPU, input methods, the real clipboard, the real file chooser and file manager, and dropping a file from a file manager.

The agent command has its own spec, `command.spec.mjs`, run against a linux-unpacked layout (this worktree's Electron renamed `opendoc-desktop`, the test runtime in `resources/runtime`, the launchers in `resources/cli`). Point `OPENDOC_SHELL_TEST_UNPACKED` at a real `linux-unpacked` folder to test a real build instead (it is copied, never changed). Every command test uses a scratch `HOME`, and a tripwire `node`, `npm` and `npx` first on the PATH proves that no system Node is used.

The updater has its own unit tests and Electron specs, a local feed server and a hand-run AppImage update (build 1 to build 2); `desktop/README.md` ("Testing updates") says how to run them. They use loopback feeds only, never GitHub. The macOS swap is covered only by tests of its decisions, because it needs a Mac.

## Moving to the service

When `createOpenDocService` merges (U3), `transport.mjs` is the only file that changes:

- The host child imports the service and answers requests over its IPC channel (`serialization: 'advanced'`); `origin` becomes `app://opendoc`, `scheme` becomes `app`, `handle(request)` forwards over IPC and `onChange` events are sent to the window.
- `session-policy.mjs` already registers one handler for `app://` (the shell pages) and one for the transport's scheme, and adds the policy headers to everything the transport returns. The `app://opendoc` host check is added there.
- The page's WebSocket (`/api/events`) is replaced by a preload event, as S3's prototype did; that needs a small change in `src/app/main.tsx`.

What the shell must still do around `createOpenDocService().handle()` (the U3 review), and where each point stands:

- Any host other than `app://opendoc` answers 403. Already true: `forward` compares the request's origin with the transport's, so the change is the transport's `origin` value.
- Only the app's own page may change things: the `initiatorOrigin` rule above applies unchanged to `app://opendoc`.
- `onChange` pushes go only to the workspace window's main frame (`webContents.mainFrame.send`), and only while that frame's origin is `app://opendoc`. To do with the service transport.
- No cookies and no token in a URL: already true (header only; the shell's own pages carry no token).
- Each `handle()` call is wrapped (a throw answers 500) and a stopped transport answers 503. Already true.
- `close()` runs once, in `will-quit` (`shutdown()` is guarded), and nothing is sent to a closed transport. Already true for `stop()`; the service transport keeps the same rule.
- The host runs with the workspace as its working directory. Already true and tested.
- The renderer needs a "service gone" signal. The page has no "Connection lost" state today; the bridge should offer one (`window.opendocDesktop.onHostState`) and `src/app/main.tsx` should show its own message while the shell restarts the host. Until then the shell shows its crash screen when restarting stops helping, and reloads the window when the address changes.
