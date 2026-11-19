# opendoc-desktop

opendoc-desktop is a desktop app for [OpenDoc](https://github.com/RyanYahya/OpenDoc) on Linux and macOS, built with Electron on top of the original OpenDoc project. It opens one workspace at a time in a window and carries its own runtime, so users install no Node or npm. This page describes the app's shell: the Electron main process. The package lives in [`desktop/`](../desktop/README.md); OpenDoc's npm packages do not include it.

Status: the shell runs OpenDoc's service (`createOpenDocService`) in a child process with no port anywhere. The window loads `app://opendoc/`, and the main process carries each request to the service over the child's IPC channel; see [The service host and the bridge](#the-service-host-and-the-bridge).

## Run it from a checkout

```sh
pnpm install --frozen-lockfile
nice -n 19 ionice -c 3 pnpm package:pack --edition normal      # the OpenDoc package the runtime is made from
```

The app looks for its runtime (a folder with `node_modules/opendoc`, `package.json` and `build-info.json`) in the folder named by `OPENDOC_DESKTOP_RUNTIME`, else in `desktop/build/runtime/<platform>-<arch>`. Packaged builds carry it in `resources/runtime`. The runtime runs the service for every workspace the app opens (its `node_modules/opendoc` and `tsx`), creates new workspaces and shows the build number. In a development checkout without a runtime folder, the repository itself serves as the runtime (`src/server/service.ts` and its `node_modules`; run `pnpm build` first, the service serves the built client).

```sh
cd desktop
env -u ELECTRON_FORCE_IS_PACKAGED -u ELECTRON_RUN_AS_NODE node_modules/.bin/electron src/main/index.mjs
```

`pnpm start` (`electron .`) in `desktop/` does the same. Environment variables that tests and development builds read: `OPENDOC_DESKTOP_RUNTIME` (runtime folder) and `OPENDOC_DESKTOP_HEALTH_MS` (how often the service is checked, default 5000).

## What the main process does

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
| `menu.mjs`, `about.mjs` | The application menu and the About dialog. |
| `runtime.mjs`, `process-info.mjs`, `identity.mjs`, `shell-pages.mjs` | Where the runtime is and how to run its CLI; questions about other processes; names; the app's own pages. |

`desktop/src/renderer/` holds the app's own pages (workspace picker, crash screen). They are served from `app://shell/` by the main process, never from `file://`, and get a small API from `desktop/src/preload/shell.cjs`. The workspace page (`app://opendoc/`, top frame only) gets only the two bridge functions described below.

## Opening a workspace

Everything below happens before the window loads, in this order, and any failure stops the open with a message the picker (or a dialog, for menu actions) shows:

1. The folder must hold `.opendoc/workspace.json`.
2. `.opendoc/desktop.json` (C3): a live opendoc-desktop on it means "already open elsewhere"; a stale one (its pid is gone, or now belongs to another program) is removed.
3. `.opendoc/server.json`: a running browser-edition service means the workspace is refused, with a button that runs `opendoc stop`.
4. The workspace lock (`.opendoc/update.lock`, the CLI's own lock): taken while the workspace opens. A stale lock (its pid is gone) is reported and cleared only when the user asks; a live or damaged one is never offered for clearing.
5. Another workspace that is open is closed first (with the unsaved-edits question), then its service stops.
6. The service host starts (see below): a run-as-Node child of the app's executable, with the workspace as its working directory, the runtime's OpenDoc loaded through tsx, and an IPC channel; it has no listener and writes no `server.json`. It runs in its own process group, guarded three ways (see "Never left behind" below).
7. `desktop.json` is written, the workspace becomes `defaultWorkspace` and heads `recentWorkspaces` in `config.json`, the window opens, the lock is released.

On quit, the service is asked to close (it finishes accepted saves first; SIGKILL after 8 seconds), `desktop.json` is removed and the lock is released. A workspace that is still opening when the app quits is cancelled: its host is killed, its lock released (the shell keeps the pending open, so `shutdown()` does not depend on the open having finished) and nothing is written. After a `kill -9` of the main process the host and everything it started are gone within about a second (see "Never left behind"), and `desktop.json` and, if the app was opening a workspace, `update.lock` stay behind, stale, for the next launch to report (C3: a stale lock is never cleared on its own; the picker offers "Clear stale lock").

## Files

- `config.json` in the profile folder (`~/.config/opendoc-desktop/` on Linux, `~/Library/Application Support/opendoc-desktop/` on macOS): `defaultWorkspace`, `recentWorkspaces` (at most 10, newest first), and the keys of other parts of the app. Written atomically with mode 0600; unknown keys are kept. Opening a workspace makes it the default, because the router skill and the agents use the default.
- `window-state.json` beside it: size, position and maximised state of the workspace window. A saved position off every connected display is dropped.
- `logs/workspace-<id>.log` beside it: what the service printed, and when the app started and restarted it. The crash screen and the Help menu link to it.
- Per workspace: `.opendoc/desktop.json` (`{ pid, startedAt, version, build }`) while it is open.
- `config.json` also holds `commandLineNotices` (`{ path, foreign }`): which one-time notices about the `opendoc` command were shown (see "The `opendoc` command").

## Hardening

- Every window: `contextIsolation`, renderer sandbox, no Node integration anywhere, `webSecurity`, no `<webview>`, safe dialogs. The preload script exposes an API only to `app://shell` pages, and the main process checks the caller's address and frame again on every call.
- Content security policy on every workspace response, added by the main process next to whatever the service sends: scripts only from the page's own address (plus WebAssembly for pdf.js), no plugins, no framing, connections only to that address (no WebSocket: nothing listens). The app's policy is appended as a further policy, never set in place of the service's, so the service's own (`default-src 'none'; sandbox` on SVG assets) still applies, and every other header of the service (`Content-Disposition`, `X-Content-Type-Options`, `Cache-Control`, `Content-Range`) passes through untouched.
- Every request a page makes is checked: `app://opendoc` while a workspace is open, the app's own pages (`app://shell`), `data:` and `blob:`. Anything else (other hosts, any `http:` address, `file:`) is cancelled.
- Navigation stays on the origin. A web link (`http`, `https`, `mailto`) goes to the system browser through `shell.openExternal`; anything else is dropped. Dropping a file on the window does not navigate. The app's own pages (`app://shell`) can be reached only by the main process itself (`loadURL`) and from another shell page: a page, link, form or `window.open` at `app://opendoc` (or a file window, or a blank page) that names `app://shell/...` is dropped, so the workspace window can never become the picker, which has the shell's IPC. The IPC handlers also check the sender's frame: only the top frame of the picker window or of the workspace window at an `app://shell` address.
- `window.open` and `target="_blank"`: a file the service serves under `/api/` (an exported PDF, a specimen) opens in a small app window with Chromium's viewer; everything else is denied; web links go to the system browser.
- Permissions are denied, except `clipboard-sanitized-write` (the copy buttons). Spell checking is off, because it downloads dictionaries.
- Downloads arrive in a temporary file, then a save dialog asks where they go; a cancelled dialog discards them. A window opened only to start a download closes itself.
- No `file://` page and no cookies: the session token travels in a header, as in the browser edition.
- The service hands its token to any caller of `GET /api/session` and does not check Origin. So the main process lets a request that changes something (any method but GET and HEAD under `/api/`) through only when the app's own page made it: Electron's web request hook reports the starting origin as `initiatorOrigin` (it does not pass the Origin header to a protocol handler), and a request with none, or with another one, is cancelled. Every answer from a transport is wrapped: a throw becomes a 500, and a transport that was stopped (or whose host is gone) answers 503. Any host other than `app://opendoc` answers 403.
- One session partition per workspace (`persist:ws-<hash of the path>`), so workspaces never share browser storage. Decision D-e (which window may call the service): every request passes through the main process, which answers only the one session that belongs to the open workspace, and the `initiatorOrigin` rule above decides who may change things.
- **Invariant: the service never serves user-supplied bytes inline as HTML, JavaScript or SVG.** Every file window of a workspace shares the workspace's session (and so its token and its origin, `app://opendoc`), so a user file that ran as a page would run with the full rights of the app. The inline answers the service gives today are only: a PDF the service made itself, PNG, JPEG and WebP images (the logo, cover and media routes, sent with `X-Content-Type-Options: nosniff`), a font (`font/ttf`, `font/otf`), and the app's own files from its `dist` (`client.ts`). Everything else is an attachment: an SVG asset (`attachment` plus `default-src 'none'; sandbox`), a file from a document's media folder (`application/octet-stream`, `attachment`), PPTX and the exports. The service also refuses an `.html`, a `.js` and an `.svg` that carries a script as an upload. `inline-content.spec.mjs` holds the service to it: an `.html`, a `.js` and an `.svg` are added through the logo, font and media routes and put in a media folder by hand, then fetched back through `app://opendoc`, and each answer must be refused, an attachment or a type that cannot run script, with `nosniff`. Known gap, a request for stream U (not editable from the shell): the PDF routes send no `nosniff`; their bytes are generated by the service, not supplied by a user.

## Window behaviour

- Closing the window (or quitting) while the page holds an unsaved text draft (a `sessionStorage` key starting `opendoc:text-draft:`) asks Leave or Stay (decision D-d). Stay keeps the window, the service and the draft.
- The page's own `beforeunload` prompt (registered only when a draft could not be stored) is answered with the same question. Without an answer, Electron would ignore every close and quit.
- "Show in folder" is the service's own route: the host starts the file manager (`xdg-open`; `open -R` on macOS). The service removes `ELECTRON_RUN_AS_NODE` from the environment of programs it starts for the user (`externalEnv()`, `src/server/external-env.ts`); `workspace-flow.spec.mjs` checks that a stub `xdg-open` does not see it.
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
2. `config.json` has `"checkForUpdates": false`: no automatic checks and no network. The checkbox in the menu changes this value and takes effect at once: the timer stops, and a check that is still fetching or downloading is dropped (it neither downloads nor opens a dialog afterwards). The switch governs automatic checks only: "Check for Updates…" still runs one check when clicked, and an update it finds is downloaded and installed the normal way for the install type (an AppImage at quit, a package through "Restart to Update"). It does not turn automatic checks back on. A manual check that is dropped because automatic checks were switched off while it was running ends silently: no download, no dialog.
3. macOS.
4. The `APPIMAGE` variable is set: AppImage.
5. `resources/package-type` says `deb`, `rpm` or `pacman`.
6. Anything else (a development run, a directory build) is inactive. A development run checks only when `OPENDOC_DESKTOP_UPDATE_RESOURCES` names a folder standing in for `resources/` (tests only).

**When it checks.** Once at launch and then once a day while the app is open (when the switch is on), and whenever the user chooses "Check for Updates…". Nothing is sent while the app is closed. A background check is silent unless there is something to do; a manual one always answers.

**Where it looks.** The address in `resources/app-update.yml` (the fork's GitHub releases) unless `config.json` has `"updateFeed"`. The value is one of: a `https://github.com/<owner>/<repo>` address, a folder address ending in `/` that holds `latest-linux.yml` (or `latest-mac.yml`) and the files, or, for tests, `http://127.0.0.1:<port>/github-like`. Only `https:` is accepted, plus `http:` for 127.0.0.1, localhost and [::1]; anything else (other schemes, an address with a user name or password) is refused, logged and never contacted. Redirects are followed only to https (a loopback feed may also be redirected to loopback http); a redirect to plain http is refused and logged. This holds for the metadata, the block maps, the full download and the differential (ranged) download, which GitHub release downloads use: every request is made with manual redirect handling and each redirect is checked before it is followed, and as a catch-all a filter on the updater's own session cancels any request or redirect hop to plain http (except loopback http for a loopback feed). The metadata's file entries must be plain names next to the metadata: a release is not offered when any entry contains whitespace, a control character or a backslash, or when resolving it against the feed (or, for a feed set in `config.json`, against that feed's own address too) would leave the feed's host (an absolute address, `//host/...`, or a scheme such as `file:`). Metadata whose file list has an entry that is not an object with a text address (a YAML list, a number), or whose `path` is not text, is refused as a whole.

**What counts as an update.** A higher version always does. The same version does when the metadata's top-level `build:` is a whole number above the running build (`resources/runtime/build-info.json`), so a rebuilt release replaces an older build of the same version. The metadata must also list a file for this install type (`.AppImage`, `.deb`, `.rpm`, `.pacman`, or the macOS `.zip`) with a SHA-512; a release without one is not offered, and the reason goes to the log.

**What happens next, by install type.**

- **AppImage:** the file is downloaded in the background (a differential download when the feed supports ranges) and swapped in when the app quits, so the next launch is the new build, with no prompt. The swap never leaves the user without an AppImage: the download is copied beside the AppImage under a temporary name, checked against the metadata's SHA-512 again, made executable and synced, and only then renamed over the AppImage (atomic, same folder). Nothing is unlinked first and the new AppImage is never run; on any failure the temporary file is removed and the old AppImage is untouched (the download is kept, and the next check tries again). The reason is recorded in `config.json` (`updateNotices.swapFailed`), and the next launch says so once in a notice that names the folder and the reason, without blocking anything. The file keeps its name (it has no version in it), so `~/.local/bin/opendoc` keeps working; if a build ever renames it, the shim is pointed at the new path. Before downloading, the app checks that the AppImage's folder is writable and has room for another copy (and checks the room again before staging); if not, nothing is downloaded and the user is told once.
- **deb, rpm, pacman:** the file is downloaded in the background and "Restart to Update" is offered (a dialog, and a menu item that stays until used). It runs one asynchronous `pkexec` call, so the window never freezes behind the password prompt. The call copies the file to a root-owned folder, checks its SHA-512 again as root (the checksum comes from the metadata the app already verified), then runs `dpkg -i` (and `apt-get install -f -y` to settle dependencies), the `zypper`, `dnf`, `yum` or `rpm` equivalent, or `pacman -U --noconfirm`. A cancelled password prompt (exit 126 or 127) says "Update cancelled" and keeps the download; a failure shows the command to run by hand. The app then restarts itself.
- **macOS:** unpacks the downloaded zip with `ditto`, checks its signature and bundle identifier, and replaces the bundle in place through a small helper that waits (at most 60 seconds, then gives up without swapping, and logs that to a file the next launch copies into the updater's log; the next check offers the update again) for the app to quit and puts the old bundle back if the swap fails. The new bundle is the one in the zip with the running app's bundle identifier, whatever its file name, and its version and build must be the ones the release announced. It does this only when the app is not running translocated and its folder is writable; otherwise the user gets a notice with a button to the release page. (Only its decisions are unit-tested; see "Tests".)

Every download is checked against the SHA-512 in the update metadata before it is used. A file that does not match is deleted and refused. The SHA-512 proves the file is the one the metadata names; it does not prove who published it. Authenticity rests on TLS and on whoever controls the feed, and the deb and rpm installs run with signature checks off (`dpkg` has none, and the rpm tools get `--nogpgcheck` or `--allow-unsigned-rpm`), because the packages are not signed.

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

The unit tests include one for the transport that runs a stand-in service in plain Node (`unit/transport.test.mjs`: upload, `Range`, a large answer, changes, abort, a dead and a stopped host, the process group, a failed or hung start, credit and a reader that does not read, a cut-off upload, a bad status, a start cancelled by its signal, and `kill -9` of a parent process while its host is starting, busy in a loop or stopped, a request that is over before its upload is read, and nine ways a broken host can answer, a bad status, header or piece, each a 502 or a failed response with the same host serving the next request) and one for the host's request and response objects (`unit/service-host.test.mjs`, including an upload read with `readable` and `read(n)`), and `unit/sentinel.test.mjs`.

`packaged.spec.mjs` runs the app as it ships: `desktop/src`, `package.json` and the production dependencies (electron-updater and what it needs) packed into an `app.asar` (with electron-builder's own packer) and started by the same Electron, to prove that the service host (passed to the child as text) and the page work from inside an asar. It does not test the installers; that is the packaging work's.

Not covered by the tests (they need a person on a real display): native Wayland and fractional scaling, the GPU, input methods, the real clipboard, the real file chooser and file manager, and dropping a file from a file manager.

The agent command has its own spec, `command.spec.mjs`, run against a linux-unpacked layout (this worktree's Electron renamed `opendoc-desktop`, the test runtime in `resources/runtime`, the launchers in `resources/cli`). Point `OPENDOC_SHELL_TEST_UNPACKED` at a real `linux-unpacked` folder to test a real build instead (it is copied, never changed). Every command test uses a scratch `HOME`, and a tripwire `node`, `npm` and `npx` first on the PATH proves that no system Node is used.

The updater has its own unit tests and Electron specs, a local feed server and a hand-run AppImage update (build 1 to build 2); `desktop/README.md` ("Testing updates") says how to run them. They use loopback feeds only, never GitHub. The macOS swap is covered only by tests of its decisions, because it needs a Mac.

## The service host and the bridge

**Transport.** `transport.mjs` starts the host as `<app executable> --import <tsx> --import <watchdog> --input-type=module -e <host source> opendoc-service-host <service.ts>` with `ELECTRON_RUN_AS_NODE=1`, `cwd` = the workspace root (the service's themes and documents read the working directory), `serialization: 'advanced'` and a process group of its own. The host's code is passed as text, so the child never reads a file inside `app.asar`. The service comes from the runtime (`node_modules/opendoc/src/server/service.ts`; the repository in development) and is created with `createOpenDocService({ root: cwd, production: true })`; the host tells the main process when it is ready.

**Requests.** `protocol.handle('app')` (one handler per session) serves `app://shell/` itself and forwards `app://opendoc/` to the transport. A request goes to the host as a message (method, path and query, headers with `host: opendoc`); an upload follows as body pieces, an abort as an abort message. The host builds Node's request and response objects (`src/host/service-host.mjs`), calls `service.handle(req, res)` and sends back the status line and headers, then the body in pieces; both directions are flow-controlled by credit: the host writes at most 4 MiB of a response that the page has not taken (the response is a `ReadableStream` whose `pull` sends a `credit` message back, so a slow or stopped reader holds the host to one window of an endless answer), and the main process sends at most 4 MiB of an upload that the service has not read (the host sends `body-credit` as the service reads). When a response ends, is cancelled or fails, the upload loop is cancelled and the host told to abort. What Electron 45 does and does not tell the handler (measured, `integration.spec.mjs` and the unit tests): a page that cancels a download makes it cancel the response stream (so the host is told to abort, though Chromium has by then pulled up to about 8 MB ahead of a slow page, which is why a fast host may have sent a whole 12 MB file before a kill lands); a page that aborts a `fetch` does not set `request.signal` (the listener is kept for other Electron versions), and Electron has already handed over the whole upload body, so the service finishes a request it received in full, as a web server would. Requests made by dedicated and shared workers do not reach the `webRequest` hook at all (the protocol handler sees them, with no origin), so the caller guard cannot police them; what keeps a worker of another origin out is that no page of another origin can start one (the shell's pages have `worker-src 'none'`, and every other page is the workspace itself). Full requests, `Range` headers (a 206 and its `Content-Range` are carried through as the service sent them; today the service ignores `Range` and pdf.js loads PDFs whole), uploads of up to the service's 100 MB cap, and downloads all use this path. Everything the host sends is checked before it is used: a status outside 200 to 599, a header name or value that is not valid, too many or too large headers, an oversize chunk, or a message of the wrong shape answers 502 (the request fails, the host keeps serving). A host that dies fails every request waiting for it (503) and later ones too, until the supervisor has started a new one.

**Bridge.** The service's `onChange` goes to the main process and on to the workspace window's main frame, only while that frame is at `app://opendoc`. The preload exposes, in that frame only and nowhere else (the app's own pages, iframes and other windows get nothing):

- `window.opendocDesktop.onChange(listener)`: called with no arguments whenever the service reports a change.
- `window.opendocDesktop.onHostState(listener)`: called with `{ state }`: `'restarting'` (the host exited or stopped answering; requests fail meanwhile), `'running'` (it is back; the page refetches), or `'failed'` (the shell gave up and is about to show its crash screen).

Both return a function that stops listening. `src/app/main.tsx` uses `onChange` instead of its WebSocket when the bridge exists.

**Never left behind.** Three guards, because a host can die of the app's death in three different states. (1) `watchdog.mjs` is loaded first (`--import data:...`, from text, so nothing is read from `app.asar`), before tsx and the service: if the channel is already closed it ends at once, and when the channel closes it kills the host's process group. (2) The same file starts a worker thread that polls the parent id every 300 ms and kills the group when it changes, which works while the host's main thread is stuck in a synchronous loop (where 'disconnect' never runs). (3) The main process starts a small shell sentinel (`/bin/sh`, in its own session; the script is `sentinelScript` in `transport.mjs`, written for every POSIX shell in the one form they all accept, `kill -0 "-$2"` and `kill -KILL "-$2"`: dash, the `/bin/sh` of Debian and Ubuntu, rejects `kill -0 -- -PID` and `kill -s 0 -PID`, and busybox sh rejects any `--`; `unit/sentinel.test.mjs` runs the script under each shell the machine has, which in CI includes dash and busybox on Ubuntu) that checks every second that the app and the host's group are still there and kills the group when the app is gone first; it covers a host that is stopped (SIGSTOP), runs nothing, and the render workers it started, and it exits as soon as the group is gone. The group is signalled only from the sentinel's check and once, from the host's exit event, never later: a group number cannot be given to anything else while any of its members lives. A start in progress is cancelled by an abort signal (the app is quitting, or the supervisor was stopped), which kills the host. Windows has no process groups: the channel and the parent id check remain.

**Supervision.** The supervisor checks that the service answers (a real `GET /api/session` through the channel, every 5 seconds, three misses in a row) and restarts the host when it exits or stops answering, after killing it and its process group. The window keeps its page: the address does not change, and the page fetches a new session token on its own when a write is refused. A restart sends `restarting`, then `running`. After three restarts in two minutes the shell sends `failed` and shows the crash screen, whose "Try again" starts the host again and loads the workspace.

**No port.** Nothing in the app listens: the host has no server, the window loads from the `app` scheme, and the app writes no `.opendoc/server.json`. `robustness.spec.mjs` proves it with `ss -ltnp` and `ss -lunp` while the app runs by itself (Playwright's own driver adds a DevTools port and a Node inspector port, so that test starts the app without it), five seconds after a quit and after a `kill -9` of the main process no process runs from the app's executable path, and the next launch opens the workspace with no cleanup.

What the shell still does around `createOpenDocService().handle()` (the U3 review), all in place and tested: any other host answers 403; only the app's own page may change things (`initiatorOrigin`); change events go to one frame only; no cookies and no token in a URL; a throw answers 500 and a closed or dead transport 503; `close()` runs once, in `will-quit`; the host's working directory is the workspace.
