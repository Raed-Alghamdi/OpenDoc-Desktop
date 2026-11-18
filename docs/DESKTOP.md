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
6. The service host starts (see below): a run-as-Node child of the app's executable, with the workspace as its working directory, the runtime's OpenDoc loaded through tsx, and an IPC channel; it has no listener and writes no `server.json`. It runs in its own process group: when the channel closes (the app was killed) the host exits and takes the group with it, so the render workers it started never outlive it, and the app sweeps the group after a normal stop too.
7. `desktop.json` is written, the workspace becomes `defaultWorkspace` and heads `recentWorkspaces` in `config.json`, the window opens, the lock is released.

On quit, the service is asked to close (it finishes accepted saves first; SIGKILL after 8 seconds), `desktop.json` is removed and the lock is released. After a `kill -9` of the main process the service exits by itself when its IPC channel closes, the Chromium helpers follow, and `desktop.json` stays behind, stale, for the next launch to remove.

## Files

- `config.json` in the profile folder (`~/.config/opendoc-desktop/` on Linux, `~/Library/Application Support/opendoc-desktop/` on macOS): `defaultWorkspace`, `recentWorkspaces` (at most 10, newest first), and the keys of other parts of the app. Written atomically with mode 0600; unknown keys are kept. Opening a workspace makes it the default, because the router skill and the agents use the default.
- `window-state.json` beside it: size, position and maximised state of the workspace window. A saved position off every connected display is dropped.
- `logs/workspace-<id>.log` beside it: what the service printed, and when the app started and restarted it. The crash screen and the Help menu link to it.
- Per workspace: `.opendoc/desktop.json` (`{ pid, startedAt, version, build }`) while it is open.
- `config.json` also holds `commandLineNotices` (`{ path, foreign }`): which one-time notices about the `opendoc` command were shown (see "The `opendoc` command").

## Hardening

- Every window: `contextIsolation`, renderer sandbox, no Node integration anywhere, `webSecurity`, no `<webview>`, safe dialogs. The preload script exposes an API only to `app://shell` pages, and the main process checks the caller's address and frame again on every call.
- Content security policy on every workspace response, added by the main process: scripts only from the page's own address (plus WebAssembly for pdf.js), no plugins, no framing, connections only to that address (no WebSocket: nothing listens).
- Every request a page makes is checked: `app://opendoc` while a workspace is open, the app's own pages (`app://shell`), `data:` and `blob:`. Anything else (other hosts, any `http:` address, `file:`) is cancelled.
- Navigation stays on the origin. A web link (`http`, `https`, `mailto`) goes to the system browser through `shell.openExternal`; anything else is dropped. Dropping a file on the window does not navigate.
- `window.open` and `target="_blank"`: a file the service serves under `/api/` (an exported PDF, a specimen) opens in a small app window with Chromium's viewer; everything else is denied; web links go to the system browser.
- Permissions are denied, except `clipboard-sanitized-write` (the copy buttons). Spell checking is off, because it downloads dictionaries.
- Downloads arrive in a temporary file, then a save dialog asks where they go; a cancelled dialog discards them. A window opened only to start a download closes itself.
- No `file://` page and no cookies: the session token travels in a header, as in the browser edition.
- The service hands its token to any caller of `GET /api/session` and does not check Origin. So the main process lets a request that changes something (any method but GET and HEAD under `/api/`) through only when the app's own page made it: Electron's web request hook reports the starting origin as `initiatorOrigin` (it does not pass the Origin header to a protocol handler), and a request with none, or with another one, is cancelled. Every answer from a transport is wrapped: a throw becomes a 500, and a transport that was stopped (or whose host is gone) answers 503. Any host other than `app://opendoc` answers 403.
- One session partition per workspace (`persist:ws-<hash of the path>`), so workspaces never share browser storage. Decision D-e (which window may call the service): every request passes through the main process, which answers only the one session that belongs to the open workspace, and the `initiatorOrigin` rule above decides who may change things.

## Window behaviour

- Closing the window (or quitting) while the page holds an unsaved text draft (a `sessionStorage` key starting `opendoc:text-draft:`) asks Leave or Stay (decision D-d). Stay keeps the window, the service and the draft.
- The page's own `beforeunload` prompt (registered only when a draft could not be stored) is answered with the same question. Without an answer, Electron would ignore every close and quit.
- "Show in folder" is the service's own route: the host starts the file manager (`xdg-open`; `open -R` on macOS). Known item: the host's environment carries `ELECTRON_RUN_AS_NODE=1`, so a program started this way inherits it (an Electron-based file manager would then run as plain Node). Stream U is changing `src/server` so external programs get a clean environment; the shell does not work around it.
- The window title is the page title followed by `opendoc-desktop`.

## Menus

File: Open Workspace, New Workspace (a new or empty folder, made with the CLI's `init`), Open Recent, Reveal Workspace, Show Log, Quit. Edit: the standard roles (macOS needs them for copy and paste). View: zoom and full screen only, with no reload and no developer tools. Window. Help: a link to the original project; About opendoc-desktop shows the version, the build number and commit, and credits the original OpenDoc project with its link.

## The `opendoc` command

Agents run `opendoc`, not `npx opendoc`, so the app puts a command on the user's machine. Each one runs the CLI inside the app's runtime with the app's own executable as Node (`ELECTRON_RUN_AS_NODE=1`), so no system Node or npm is needed, and it works with the app open or closed.

- **Linux packages (deb, rpm, pacman):** `resources/cli/opendoc` is installed as `/usr/bin/opendoc`. It finds the app in `$OPENDOC_DESKTOP_HOME` (tests), beside itself (`resources/cli/../..`, which also covers a symlink to it), or in `/opt/opendoc-desktop`, and replaces itself with the CLI (`exec`), so arguments, standard input, signals and exit codes pass through.
- **AppImage:** an AppImage's files exist only while it runs, so the app writes `~/.local/bin/opendoc` at every launch from `resources/cli/opendoc-appimage.sh`, with the AppImage's path filled in (`cli-shim.mjs`, `command-line-tool.mjs`). The file is written atomically (a temp file in the same folder, then a rename), only if it is absent or already ours (the words "opendoc-desktop agent command" mark it); a command that is not ours is never replaced, and the user is told once. Each call mounts the AppImage with its own `--appimage-mount` under `setpriv --pdeathsig TERM` (running `AppRun` fails on Ubuntu 24.04), makes the runtime copy under `~/.local/share/opendoc-desktop/runtime/<version>-<build>/` when it is missing or from another build, and runs the CLI; a moved or deleted AppImage gets a message saying to open the app once. The app checks that `~/.local/bin` is on the PATH the app has, a login shell has or an interactive shell has, and tells the user once, with the line to add, when it is on none of them.
- **macOS:** the app menu offers "Install Command-Line Tool". It writes a small launcher into `/usr/local/bin` when that is writable without administrator rights, otherwise `~/.local/bin`, refuses to replace an `opendoc` that is not ours, refuses when the app runs translocated, and explains a PATH problem in the same dialog. At launch an installed command is pointed at the app's current place.
- Neither the app nor the launchers use flags that start with `--appimage-` (the AppImage runtime reserves them).

## Tests

The shell tests open real Electron windows, so they run only on a virtual display, through one script:

```sh
node desktop/tests/shell/run.mjs            # Playwright (Electron under Xvfb), niced, with a time limit
node desktop/tests/shell/run.mjs --grep NAME
node desktop/tests/shell/run.mjs --unit     # unit tests, no Electron
```

`run.mjs` starts everything as `nice -n 19 ionice -c 3 timeout -s KILL <limit> xvfb-run -a env -u ... playwright test`, removes the display and Electron variables the Claude desktop app sets, refuses to run without the virtual-display marker, and kills every leftover process of this worktree's Electron afterwards (matched by executable path). The tests use scratch workspaces made with `opendoc init` under `tmp/shell-tests/`, a fresh profile folder each, and replace the native dialogs and "open in the OS" calls in the main process with recorders; nothing touches a real workspace.

The first run builds the OpenDoc package (`pnpm package:pack --edition normal`, or the tarball named by `OPENDOC_SHELL_TEST_TARBALL`), a runtime folder from it, and a template workspace. Creating a workspace runs `npm install` from the npm cache; the first build needs the registry.

The unit tests include one for the transport that runs a stand-in service in plain Node (`unit/transport.test.mjs`: upload, `Range`, a large answer, changes, abort, a dead and a stopped host, the process group, a failed or hung start) and one for the host's request and response objects (`unit/service-host.test.mjs`).

`packaged.spec.mjs` runs the app as it ships: `desktop/src` and `package.json` packed into an `app.asar` (with electron-builder's own packer) and started by the same Electron, to prove that the service host (passed to the child as text) and the page work from inside an asar. It does not test the installers; that is the packaging work's.

Not covered by the tests (they need a person on a real display): native Wayland and fractional scaling, the GPU, input methods, the real clipboard, the real file chooser and file manager, and dropping a file from a file manager.

The agent command has its own spec, `command.spec.mjs`, run against a linux-unpacked layout (this worktree's Electron renamed `opendoc-desktop`, the test runtime in `resources/runtime`, the launchers in `resources/cli`). Point `OPENDOC_SHELL_TEST_UNPACKED` at a real `linux-unpacked` folder to test a real build instead (it is copied, never changed). Every command test uses a scratch `HOME`, and a tripwire `node`, `npm` and `npx` first on the PATH proves that no system Node is used.

## The service host and the bridge

**Transport.** `transport.mjs` starts the host as `<app executable> --import <tsx> --import <watchdog> --input-type=module -e <host source> opendoc-service-host <service.ts>` with `ELECTRON_RUN_AS_NODE=1`, `cwd` = the workspace root (the service's themes and documents read the working directory), `serialization: 'advanced'` and a process group of its own. The host's code is passed as text, so the child never reads a file inside `app.asar`. The service comes from the runtime (`node_modules/opendoc/src/server/service.ts`; the repository in development) and is created with `createOpenDocService({ root: cwd, production: true })`; the host tells the main process when it is ready.

**Requests.** `protocol.handle('app')` (one handler per session) serves `app://shell/` itself and forwards `app://opendoc/` to the transport. A request goes to the host as a message (method, path and query, headers with `host: opendoc`); an upload follows as body pieces, an abort as an abort message. The host builds Node's request and response objects (`src/host/service-host.mjs`), calls `service.handle(req, res)` and sends back the status line and headers, then the body in pieces; a response stops writing while 4 MiB are unsent. Full requests, `Range` headers (a 206 and its `Content-Range` are carried through as the service sent them; today the service ignores `Range` and pdf.js loads PDFs whole), uploads of up to the service's 100 MB cap, and downloads all use this path. A host that dies fails every request waiting for it (503) and later ones too, until the supervisor has started a new one.

**Bridge.** The service's `onChange` goes to the main process and on to the workspace window's main frame, only while that frame is at `app://opendoc`. The preload exposes, in that frame only and nowhere else (the app's own pages, iframes and other windows get nothing):

- `window.opendocDesktop.onChange(listener)`: called with no arguments whenever the service reports a change.
- `window.opendocDesktop.onHostState(listener)`: called with `{ state }`: `'restarting'` (the host exited or stopped answering; requests fail meanwhile), `'running'` (it is back; the page refetches), or `'failed'` (the shell gave up and is about to show its crash screen).

Both return a function that stops listening. `src/app/main.tsx` uses `onChange` instead of its WebSocket when the bridge exists.

**Supervision.** The supervisor checks that the service answers (a real `GET /api/session` through the channel, every 5 seconds, three misses in a row) and restarts the host when it exits or stops answering, after killing it and its process group. The window keeps its page: the address does not change, and the page fetches a new session token on its own when a write is refused. A restart sends `restarting`, then `running`. After three restarts in two minutes the shell sends `failed` and shows the crash screen, whose "Try again" starts the host again and loads the workspace.

**No port.** Nothing in the app listens: the host has no server, the window loads from the `app` scheme, and the app writes no `.opendoc/server.json`. `robustness.spec.mjs` proves it with `ss -ltnp` and `ss -lunp` while the app runs by itself (Playwright's own driver adds a DevTools port and a Node inspector port, so that test starts the app without it), five seconds after a quit and after a `kill -9` of the main process no process runs from the app's executable path, and the next launch opens the workspace with no cleanup.

What the shell still does around `createOpenDocService().handle()` (the U3 review), all in place and tested: any other host answers 403; only the app's own page may change things (`initiatorOrigin`); change events go to one frame only; no cookies and no token in a URL; a throw answers 500 and a closed or dead transport 503; `close()` runs once, in `will-quit`; the host's working directory is the workspace.
