# opendoc-desktop

opendoc-desktop is a desktop app for [OpenDoc](https://github.com/RyanYahya/OpenDoc) on Linux and on macOS with Apple Silicon, built with Electron on top of the original OpenDoc project. It opens one workspace at a time in a window and carries its own runtime, so users install no Node or npm. The package lives in [`desktop/`](../desktop/README.md) (build and release instructions are there); OpenDoc's npm packages do not include it.

This page starts with what a user needs: how to [install](#install) the app, what happens at the [first run](#first-run), how it [updates](#updates-by-install-type), which workspaces it [opens](#which-workspaces-open), the [`opendoc` command](#the-opendoc-command), how to [connect AI apps](#ai-apps) and how to [uninstall](#uninstall) it completely. After those, the page describes how the shell works, for developers: the Electron main process, the files it reads and writes, its hardening and its tests.

Status: the shell runs OpenDoc's service (`createOpenDocService`) in a child process with no port anywhere. The window loads `app://opendoc/`, and the main process carries each request to the service over the child's IPC channel; see [The service host and the bridge](#the-service-host-and-the-bridge).

## Install

Releases are on the repository's releases page, `https://github.com/Raed-Alghamdi/OpenDoc-Desktop/releases`. A release is named `desktop-v<version>-<build>` (for example `desktop-v0.6.1-2`). The version is OpenDoc's own. The build number is raised when the app is rebuilt without a new OpenDoc version.

> Until the first release is published there is nothing to download. Build the installers yourself with [`desktop/README.md`](../desktop/README.md).

| System | File to download |
|---|---|
| Linux, any distribution (x86_64) | `opendoc-desktop-x86_64.AppImage` |
| Debian, Ubuntu (x86_64) | `opendoc-desktop_<version>-<build>_amd64.deb` |
| Fedora, openSUSE (x86_64) | `opendoc-desktop-<version>-<build>.x86_64.rpm` |
| Arch Linux (x86_64) | the AUR package `opendoc-desktop-bin` (below), or `opendoc-desktop-<version>-<build>-x64.pacman` |
| macOS, Apple Silicon (M1 or newer; there is no Intel Mac build) | `opendoc-desktop-<version>-<build>-arm64.dmg` (or `.zip`) |

Every release also holds `latest-linux.yml` and `latest-mac.yml`: the update information the app reads. You never need them.

The packages are not signed, so some systems ask for a flag when you install them (shown below). Each release's `latest-*.yml` lists the SHA-512 of every file, which you can compare with `openssl dgst -sha512 -binary <file> | base64 -w0` (the same base64 form).

### AppImage

```sh
chmod +x opendoc-desktop-x86_64.AppImage
./opendoc-desktop-x86_64.AppImage
```

- An AppImage needs FUSE 2. On Ubuntu 24.04: `sudo apt install libfuse2t64`. The `opendoc` command also uses `setpriv` (part of util-linux, present on most systems).
- Put the file where you can write to its folder and keep it there. The name has no version in it, so an update replaces the file in place when you quit the app. If you do move it, the app points the `opendoc` command at the new place the next time it starts (until then the command says so).
- The app makes no menu entry for an AppImage. Use a tool such as Gear Lever or write your own `.desktop` file.
- The first start copies the runtime (about 185 MB) to `~/.local/share/opendoc-desktop/runtime/<version>-<build>/`, because an AppImage's own files exist only while it runs. Workspaces link to that copy.
- On Ubuntu 24.04, which restricts unprivileged user namespaces, the AppImage's own launcher starts the app without Chromium's sandbox (`--no-sandbox`). The deb ships an AppArmor profile and runs sandboxed, so prefer the deb there.

### deb (Debian, Ubuntu)

```sh
sudo apt install ./opendoc-desktop_<version>-<build>_amd64.deb
```

The package installs the app in `/opt/opendoc-desktop/`, a menu entry "opendoc-desktop" (Office), the `opendoc-desktop` link in `/usr/bin` and the `opendoc` command as `/usr/bin/opendoc`. Where AppArmor is on (Ubuntu 24.04 and later), it also installs `/etc/apparmor.d/opendoc-desktop`, which lets the app's sandbox work. It depends on `libgtk-3-0`, `libnotify4`, `libnss3`, `libxss1`, `libxtst6`, `xdg-utils`, `libatspi2.0-0`, `libuuid1` and `libsecret-1-0`, which `apt` installs for you.

### rpm (Fedora, openSUSE)

```sh
sudo dnf install --nogpgcheck ./opendoc-desktop-<version>-<build>.x86_64.rpm           # Fedora
sudo zypper install --allow-unsigned-rpm ./opendoc-desktop-<version>-<build>.x86_64.rpm   # openSUSE
```

The flags are needed because the package is not signed. This is also how the app's own updater installs an rpm. The layout is the deb's: `/opt/opendoc-desktop/`, the menu entry, `/usr/bin/opendoc`.

### Arch Linux

The AUR package is `opendoc-desktop-bin`. It repackages a release's pacman file, so it carries its own Electron and OpenDoc and uses no shared `electron` package.

```sh
yay -S opendoc-desktop-bin        # or paru, or: git clone the AUR repository and run makepkg -si
```

> The AUR package is not published yet; its first publication waits for the maintainer. Until then use the pacman file of a release.

Its version is OpenDoc's and its `pkgrel` is the build number. It switches the app's own updater off (see [Updates by install type](#updates-by-install-type)): pacman owns updates, so `yay -Syu` or your usual system update brings new builds. It conflicts with a hand-installed `opendoc-desktop` package.

To install a release's pacman file by hand instead (for example before the AUR package exists):

```sh
sudo pacman -U ./opendoc-desktop-<version>-<build>-x64.pacman
```

That install updates itself through the app (see below), unlike the AUR package.

### macOS

The app needs a Mac with Apple Silicon (M1 or newer). Open the `.dmg` and drag opendoc-desktop to the Applications folder (or unzip the `.zip` and move the app there). Do not run it from the disk image or from the Downloads folder: macOS then runs it from a temporary read-only copy, which cannot update itself and cannot install the `opendoc` command.

The app is signed ad hoc and is not notarized (there is no Apple developer account behind it), so macOS blocks the first launch. To open it anyway:

1. Open the app from Applications. macOS says it cannot verify the app. Close that message.
2. Open System Settings, then Privacy & Security, and scroll down to the Security section.
3. Next to "opendoc-desktop was blocked", click **Open Anyway**, confirm with your password or Touch ID, and click **Open**.

On macOS 14 and earlier, Control-click the app, choose **Open**, then **Open** again. You do this once; later launches do not ask again.

## First run

1. Start opendoc-desktop (the menu entry, `opendoc-desktop` in a terminal for a package install, or the AppImage file). With an AppImage the first start takes a few seconds longer while it copies its runtime.
2. A window titled "Choose a workspace" asks for a folder. A workspace is a folder that holds your documents, themes and templates; the app opens one at a time.
   - **Create new workspace...** asks for a new or empty folder, and creates the workspace there with OpenDoc's own `init` command. It needs no network and no npm: the new folder's `node_modules` is a link to the app's runtime, and its marker file `.opendoc/workspace.json` says `"managed": true`.
   - **Open existing workspace...** opens a folder that already is one. A folder synced from another device (it has a `package.json` pinning OpenDoc but no `.opendoc/workspace.json` yet) is adopted after a question, "Use this workspace on this device?". A real `node_modules` folder in it is never deleted without asking. [Which workspaces open](#which-workspaces-open) says what happens when its OpenDoc version differs from the app's.
3. The workspace opens in the window: the library of documents, the editor, comments, export. Nothing listens on a network port; the window talks to OpenDoc inside the app.
4. The folder you opened becomes the default workspace (`defaultWorkspace` in `config.json`). The next start opens it again, and the [AI apps' skill](#ai-apps) uses it. File > Open Recent switches workspace.

While a workspace is open the app writes `.opendoc/desktop.json` in it, so the `opendoc` command knows the app has it, and removes it when you quit. A workspace is open in only one place at a time: if a browser-edition `opendoc start` is running on the same folder, the app refuses and offers to run `opendoc stop`.

The File menu also has Reveal Workspace, Workspace Backups... and Show Log (the service's log, the first place to look when something goes wrong).

## Updates by install type

The app checks for a new build only while it is open: once at launch, then once a day. Nothing runs while it is closed. The address it asks is this repository's releases, unless `config.json` has an `updateFeed` (https only). A release is an update when its version is higher, or when it is the same version with a higher build number. What the app does next depends on how it was installed:

| Install | What you do | What happens |
|---|---|---|
| AUR package | Nothing in the app. Update the system as usual (`yay -Syu`). | The package carries an empty file `resources/update-disabled`, so the in-app updater does not exist and the app makes no update requests. |
| AppImage | Nothing. | The new file is downloaded in the background (only the changed blocks, when the server allows it) and replaces the AppImage when you quit. The next start is the new build, with no password. The `opendoc` command keeps working. The AppImage's folder must be writable and have room for another copy; if not, nothing is downloaded and you are told once. |
| deb, rpm, or a pacman file installed by hand | Click **Restart to Update** (a dialog, and a menu item that stays until used), then type your system password. | The package is downloaded in the background. Installing a system package needs administrator rights, so the password prompt (polkit `pkexec`) cannot be avoided. Cancelling it keeps the download and offers it again. |
| macOS | Click **Restart to Update**. | The app downloads the new build, checks it, replaces itself and restarts. It does this only when it runs from a writable folder such as Applications and not from a temporary copy; otherwise a notice offers a button to the release page, and you download, drag it to Applications and use Open Anyway again. |

Rules that hold for every install:

- A download is accepted only from the configured address, over HTTPS, and only when it matches the SHA-512 in that release's update information. The checksum proves the file is the one the release names; who is trusted rests on HTTPS and on whoever controls the release address. The deb and rpm installs run with package signature checks off, because the packages are not signed.
- A release offers an update to an install type only when its update information lists a file for that type.
- To turn automatic checks off, clear **Check for Updates Automatically** (in the Help menu, and in the app menu on macOS) or set `"checkForUpdates": false` in `config.json`. **Check for Updates...** then still runs one check when you click it.
- After an update, the first start says once "opendoc-desktop was updated to <version>, build <build>", with a link to the release.
- The details (install type detection, redirects, failures) are in [Updates](#updates) below.

## Which workspaces open

A workspace's OpenDoc version is the `opendoc` pin in its `package.json` (`npm:@ryanyahya/opendoc@x.y.z`). The app's version is OpenDoc's. When you open a workspace:

| The workspace is | What happens |
|---|---|
| On the same minor version, same or older patch (the app is 0.6.2, the workspace 0.6.1) | It opens normally, and the pin moves up to the app's version. You see nothing. **The pin only ever moves up.** |
| On the same minor, a newer patch than the app (the workspace 0.6.2, the app 0.6.1) | It opens read-only with "Update the app to edit it." The app never lowers a pin: two devices on different patches would otherwise rewrite a synced file back and forth. |
| On an older minor (0.5 against 0.6) | One dialog: **Upgrade** (a backup first), **Open read-only**, or Cancel. A box, "Upgrade my workspaces without asking from now on", removes the dialog for later releases. |
| On a newer minor than the app (another device's app upgraded it) | It opens read-only with "This workspace was upgraded by OpenDoc x.y. Update the app to edit it." |

Read-only means a banner at the top, and no edits: documents, themes, templates, assets, comments, history and the pin cannot be changed. You can still read, preview and export. The `opendoc` command applies the same table: where the app would upgrade, it says "open this workspace in opendoc-desktop to upgrade it" and never tells you to run `npm install`.

**An upgrade** copies the workspace to a backup first, runs the upgrade steps if the release has any, moves the pin, and then runs `check` and `review` on every document. If all pass, the workspace opens and a message says where the backup is. If a document fails, you see which, and can **Copy prompt for your agent** (to fix it under the new version) or **Restore backup** (the workspace goes back to how it was and opens read-only).

Backups are in the data folder, `~/.local/share/opendoc-desktop/backups/<workspace>-<date and time>/` on Linux and `~/Library/Application Support/opendoc-desktop/backups/` on macOS. A backup holds everything except `node_modules`, `.opendoc`, `output` and the metadata of version control and file sync. The app never deletes a backup by itself. File > Workspace Backups... lists them with their sizes, **Reveal** and **Delete** (to the trash, after a question). To go back to one outside an upgrade, choose Reveal and copy the files in its `workspace` folder over the workspace folder.

Mixed devices: a copy of the workspace on plain npm OpenDoc 0.6.1 keeps working beside the app as long as the pin has not moved up. Once the app has moved it, an npm device fails loudly at its next `npm ci`, which is the signal to install the app there too.

## The `opendoc` command

Agents run `opendoc`, not `npx opendoc`, so the app puts a command on the user's machine. Each one runs the CLI inside the app's runtime with the app's own executable as Node (`ELECTRON_RUN_AS_NODE=1`), so no system Node or npm is needed, and it works with the app open or closed.

- **Linux packages (deb, rpm, pacman):** `resources/cli/opendoc` is installed as `/usr/bin/opendoc`. It finds the app in `$OPENDOC_DESKTOP_HOME` (tests), beside itself (`resources/cli/../..`, which also covers a symlink to it), or in `/opt/opendoc-desktop`, and replaces itself with the CLI (`exec`), so arguments, standard input, signals and exit codes pass through.
- **AppImage:** an AppImage's files exist only while it runs, so the app writes `~/.local/bin/opendoc` at every launch from `resources/cli/opendoc-appimage.sh`, with the AppImage's path filled in (`cli-shim.mjs`, `command-line-tool.mjs`). The file is written atomically (a temp file in the same folder, then a rename), only if it is absent or already ours (the words "opendoc-desktop agent command" mark it); a command that is not ours is never replaced, and the user is told once. Each call mounts the AppImage with its own `--appimage-mount` under `setpriv --pdeathsig TERM` (running `AppRun` fails on Ubuntu 24.04), makes the runtime copy under `~/.local/share/opendoc-desktop/runtime/<version>-<build>/` when it is missing or from another build, and runs the CLI; a moved or deleted AppImage gets a message saying to open the app once. The app checks that `~/.local/bin` is on the PATH the app has, a login shell has or an interactive shell has, and tells the user once, with the line to add, when it is on none of them.
- **macOS:** the app menu offers "Install Command-Line Tool". It writes a small launcher into `/usr/local/bin` when that is writable without administrator rights, otherwise `~/.local/bin`, refuses to replace an `opendoc` that is not ours, refuses when the app runs translocated, and explains a PATH problem in the same dialog. At launch an installed command is pointed at the app's current place.
- Neither the app nor the launchers use flags that start with `--appimage-` (the AppImage runtime reserves them).
- **Check it.** `opendoc --version` prints the version and `opendoc --help` lists the commands. `opendoc --workspace <folder> status --json` says whether a workspace is in use: `{"running":false,"mode":null}` when nothing has it open, and `"mode":"desktop"` while the app does. If `which -a opendoc` lists another `opendoc` first (one from `npm install -g`, for example), that one runs instead. A package's `/usr/bin/opendoc` goes with the package; the file an AppImage or a Mac wrote stays until you delete it (see [Uninstall](#uninstall)). If `/opt/opendoc-desktop` is gone, the package's command exits with 127 and says to reinstall the package.

## AI apps

Coding agents (Claude Code, Codex and others) drive OpenDoc through the `opendoc` command. To let an agent find your workspace from any folder, each app gets one small "router skill": it reads `defaultWorkspace` from the app's `config.json` (`${XDG_CONFIG_HOME:-$HOME/.config}/opendoc-desktop/config.json` on Linux, `~/Library/Application Support/opendoc-desktop/config.json` on macOS), asks you when there is none, then runs `opendoc --workspace <that folder>` and follows that workspace's own `AGENTS.md` and skills. It copies nothing from the workspace. The files are in [`desktop/integrations/`](../desktop/integrations/README.md): a Claude Code plugin and a Codex plugin (marketplace `opendoc`, plugin `opendoc`), and a plain copy of the skill for apps without plugins.

**The easy way: the "Connect your AI apps" screen.** It looks for the apps on your computer, installs OpenDoc's files into the ones you choose, and shows exactly what it did.

- **When it appears.** Once, after the first workspace opens (the app records that it has been shown as `aiAppsOffered` in `config.json`, whatever you chose, so closing it or pressing **Skip** counts too), and at any time from **Connect AI Apps…**: in the app menu on macOS, in the Help menu elsewhere.
- **What it shows.** One row for each of Claude Code, Codex, Antigravity, Cursor and Copilot CLI: found or not found, with the reason in a sentence (for example, "There is no codex command on the search path"), and whether OpenDoc is connected in it now. A spinner shows while it looks (a second or two). Apps it can connect have a tick box, and nothing is ticked at the start. Nothing is changed until you press **Connect**, and every result is shown.
- **What Connect does** for each ticked app, through the app's own commands:
  - Claude Code and Codex: registers a marketplace called `opendoc` from a copy of the files kept in the app's data folder, and installs the plugin `opendoc@opendoc`.
  - Antigravity: `agy plugin install` of the same plugin.
  - Cursor and Copilot CLI: copies the one skill file into the one folder each reads. It never runs either program.
  - It then asks the app whether OpenDoc is really there, and undoes everything it added if not.
- **The result.** Each app gets a line: connected, blocked, or did not work. For a result that is not connected, the screen shows the app's own words from the step that failed (an organisation's policy can block plugins; the message is the vendor's, unchanged). Under **Details** it lists every step with the exact command that ran and its output.
- **Disconnect** is the undo, in the row of each connected app. It uses the same commands and the record of what was added, and it leaves alone anything it did not add: a file you changed is kept and reported, and an OpenDoc that was already installed some other way is shown as "Already set up elsewhere" and never touched. **Forget** appears for an app that has been uninstalled since: it drops the app's record without running anything. A connect that was cut short shows as "Needs attention", and Disconnect cleans it up.
- **Which settings folder.** Claude Code and Codex may keep their settings somewhere other than the default (`CLAUDE_CONFIG_DIR`, `CODEX_HOME`). The app asks your login shell for them first, then uses its own environment, then the default folder, and uses the same folder when it disconnects.
- **What the app keeps.** `integrations.json` and the folder `integrations/` in the app's data folder (`~/.local/share/opendoc-desktop` on Linux, `~/Library/Application Support/opendoc-desktop` on macOS). They go away with the last Disconnect.
- **Staying current.** At launch the app checks whether its own integration files changed (an app update brings new ones) and brings what is connected up to date. Claude Code reads the files in place; Codex and Antigravity are installed again; Cursor and Copilot CLI get the file again. It says nothing when it works or when nothing is connected. If it fails for an app that is still connected, a message says so and offers the screen; a row that still has older files shows "Update available" with an **Update** button.

**By hand.** The screen runs the commands below, so you can do the same yourself (for a script, or for an app the screen cannot see). Before you start, check that `opendoc --version` works in a terminal (see [The `opendoc` command](#the-opendoc-command)) and that you have opened a workspace in the app once, so there is a default.

**1. Put a stable copy where the apps can keep reading it.** Claude Code reads a plugin from the folder you register, in place, so that folder must not be inside an app bundle or an AppImage mount, which move or vanish. The files come with the app: `/opt/opendoc-desktop/resources/integrations` for the deb, rpm and pacman packages, `/Applications/opendoc-desktop.app/Contents/Resources/integrations` on macOS, and `desktop/integrations/` in a checkout of this repository. (An AppImage keeps them inside its image: use the screen, or a checkout.)

```sh
mkdir -p ~/.local/share/opendoc-desktop/integrations
cp -r /opt/opendoc-desktop/resources/integrations/. ~/.local/share/opendoc-desktop/integrations/
```

On macOS the folder is `~/Library/Application Support/opendoc-desktop/integrations` instead. Below, `<copy>` stands for that folder.

**2. Register it in each app you use** (one app, one place; see the table in [`desktop/integrations/README.md`](../desktop/integrations/README.md#one-copy-per-app)). Run these in a shell that has the same `CLAUDE_CONFIG_DIR` or `CODEX_HOME` as the app you use, if you set one:

```sh
# Claude Code
claude plugin marketplace add <copy>/claude
claude plugin install opendoc@opendoc
claude plugin list --json

# Codex
codex plugin marketplace add <copy>/codex
codex plugin add opendoc@opendoc
codex plugin list

# Antigravity (CLI)
agy plugin install <copy>/codex/opendoc

# Cursor and Copilot CLI have no plugin command: copy the skill into the one folder each reads
mkdir -p ~/.cursor/skills/opendoc  && cp <copy>/skills/opendoc/SKILL.md ~/.cursor/skills/opendoc/
mkdir -p ~/.copilot/skills/opendoc && cp <copy>/skills/opendoc/SKILL.md ~/.copilot/skills/opendoc/
```

Never copy the skill into `~/.agents/skills`, `~/.claude/skills` or `~/.codex/skills`: several apps read those folders, so an app could load the skill twice.

**3. Check it** (this applies to the screen too). From a folder that is not the workspace, ask the agent: "Make a one-page PDF with OpenDoc: a short memo titled Test." It should read the config, run commands that start with `opendoc` (never `npx`), read the workspace's `AGENTS.md`, and say where the PDF is. If there is no default workspace it should ask you for one and stop.

**Refreshing by hand after an app update:** run the `cp` line of step 1 again, then `codex plugin add opendoc@opendoc` and `agy plugin install <copy>/codex/opendoc` again; Claude Code picks the new files up at its next start.

**Undo by hand**, for the apps you registered (in this order, the copy last). Connected with the screen, press Disconnect instead:

```sh
claude plugin uninstall opendoc@opendoc
claude plugin marketplace remove opendoc
codex plugin remove opendoc@opendoc
codex plugin marketplace remove opendoc
agy plugin uninstall opendoc                    # Antigravity's copy of the plugin
rm -rf ~/.cursor/skills/opendoc ~/.copilot/skills/opendoc
rm -rf ~/.local/share/opendoc-desktop/integrations ~/.local/share/opendoc-desktop/integrations.json
```

Claude Code's `marketplace remove` also uninstalls its plugins, so the second line alone would do for it.

## Design packs

A design pack is a `.opendoc.zip` file with themes and templates that one workspace exports and another imports (see [PACKS.md](PACKS.md)). The app opens one in the **Import** dialog, at the review step: the pack's name, what is in it, and what would change. Nothing is installed until you tick the trust box and press **Install**.

Ways to open a pack in the app:

- **Double-click** it in the file manager (Linux; works from the deb, rpm and Arch packages). They register the pack file type with the system, so the file manager offers opendoc-desktop; the path reaches the app as a launch argument, or goes to the app that is already running (a second launch hands the file over and exits). The file manager may pass a path or a `file://` address (the `.desktop` file's `Exec` uses `%U`); the app accepts both. The AppImage carries the same `.desktop` entry but cannot install the shared-mime type, so a double-click goes to the archive manager unless a desktop integrator for AppImages registers it, or you add the type yourself: copy `opendoc-desktop.xml` (in a checkout, `desktop/resources/mime/`) to `~/.local/share/mime/packages/` and run `update-mime-database ~/.local/share/mime`. Otherwise use File > Import, drop the file on the window, or Open With (choosing the AppImage), which work with every install.
- **macOS:** the app declares a document type for `.opendoc.zip` and never claims plain `.zip` files, which stay with Archive Utility. macOS matches a file by its last extension only, so Finder may still open a `.opendoc.zip` with Archive Utility. If it does, use one of the others until a check on a Mac says otherwise: right-click the file, **Open With**, opendoc-desktop (or **Other…**), or the two below.
- **File > Import Design Pack…** asks for a file (filtered to `.opendoc.zip`; macOS can only filter on `.zip`). It is available while a workspace is open.
- **Drop** the file on the window.

The app reads a pack file itself and hands the page its name and bytes, at most 64 MiB; a larger file gets a message from the app and is not opened. A pack opened while no workspace is open waits until one is: the workspace picker says so, and the first workspace that opens receives it. The Import dialog reviews one pack at a time, so a pack opened while another is still waiting replaces it.

**Show in folder.** After you export a pack, the result offers **Show in folder** (in the app only; the browser edition shows the path with a copy button). The app reveals a file only when it is a file inside the open workspace's `output/packs/` folder once every link in its path is resolved. Anything else (a path with `..`, a link that leads out, another folder or another workspace) is refused and logged, and nothing opens.

## Uninstall

Removing the app's package leaves your workspaces, their backups and the app's own settings in place on purpose. This section lists exactly what stays, and how to remove each item. Do the steps in this order.

**1. Undo the AI integration first**, while the app and the `opendoc` command still exist: open **Connect AI Apps…** and press **Disconnect** for each connected app, or use the "Undo by hand" list in [AI apps](#ai-apps). If you never connected any, skip this step.

**2. Quit the app** (File > Quit). A quit removes `.opendoc/desktop.json` from the open workspace; no process of the app is left running.

**3. Remove the app itself.**

| Installed as | Command | What it removes |
|---|---|---|
| AUR package | `sudo pacman -Rns opendoc-desktop-bin` | Everything the package installed: `/opt/opendoc-desktop/`, `/usr/bin/opendoc`, `/usr/bin/opendoc-desktop`, the menu entry, the icons and the licence files. |
| pacman file installed by hand | `sudo pacman -Rns opendoc-desktop` | The same, and the AppArmor profile if one was installed. |
| deb | `sudo apt remove opendoc-desktop` | `/opt/opendoc-desktop/`, `/usr/bin/opendoc`, the `/usr/bin/opendoc-desktop` link, the menu entry and icons, and `/etc/apparmor.d/opendoc-desktop` (the package's removal script unloads and deletes it). `purge` adds nothing: the package has no configuration files. |
| rpm | `sudo dnf remove opendoc-desktop` (Fedora) or `sudo zypper remove opendoc-desktop` (openSUSE) | The same files as the deb. |
| AppImage | Delete the `.AppImage` file. | Only that file. Its other traces are in the table below. |
| macOS | Quit the app, then drag opendoc-desktop from Applications to the Trash. | Only the app. Its other traces are in the table below. |

**4. What stays behind, and how to remove it.** Nothing here is needed by anything else, and nothing runs. Linux paths follow the XDG variables when you set them; the macOS paths come after the semicolon.

| What | Where (Linux; macOS) | Remove with |
|---|---|---|
| The app's settings and logs: `config.json` (default workspace, recent workspaces, update switches, notices), `window-state.json`, `logs/` (`workspace-<id>.log`, `updater.log`), and the engine's own files for the app (`Partitions/`, `Crashpad/`, caches) | `${XDG_CONFIG_HOME:-$HOME/.config}/opendoc-desktop/`; `~/Library/Application Support/opendoc-desktop/` | `rm -rf "${XDG_CONFIG_HOME:-$HOME/.config}/opendoc-desktop"` |
| The runtime copy an AppImage made (about 185 MB per build, `runtime/<version>-<build>/`, and the link `runtime/current` that workspaces point at). Packages and macOS make none. | `${XDG_DATA_HOME:-$HOME/.local/share}/opendoc-desktop/runtime/` | `rm -rf "${XDG_DATA_HOME:-$HOME/.local/share}/opendoc-desktop/runtime"` |
| The stable copy of the plugin files and the app's record of what it connected, if you connected an AI app (Disconnect removes both) | `.../opendoc-desktop/integrations/` and `integrations.json` in the data folder | `rm -rf "${XDG_DATA_HOME:-$HOME/.local/share}/opendoc-desktop/integrations" "${XDG_DATA_HOME:-$HOME/.local/share}/opendoc-desktop/integrations.json"` |
| **Workspace backups**, one folder per upgrade or restore: `backups/<workspace>-<date and time>/` (a `workspace/` copy and `backup.json`). These are your files: look before you delete. | `.../opendoc-desktop/backups/` in the data folder | `ls "${XDG_DATA_HOME:-$HOME/.local/share}/opendoc-desktop/backups"`, then `rm -rf` the ones you do not need, or the whole folder |
| The data folder itself, once it is empty | `${XDG_DATA_HOME:-$HOME/.local/share}/opendoc-desktop/` | `rmdir "${XDG_DATA_HOME:-$HOME/.local/share}/opendoc-desktop"` |
| Downloaded updates (the installer the updater fetched, under `pending/`). Only an app that updates itself has this. | `${XDG_CACHE_HOME:-$HOME/.cache}/opendoc-desktop-updater/`; `~/Library/Caches/opendoc-desktop-updater/` | `rm -rf "${XDG_CACHE_HOME:-$HOME/.cache}/opendoc-desktop-updater"` |
| The `opendoc` command an AppImage or a Mac wrote itself (a shell script). A package install has none: its `/usr/bin/opendoc` went with the package. | `~/.local/bin/opendoc` (AppImage); `/usr/local/bin/opendoc` or `~/.local/bin/opendoc` (macOS) | Only if it is ours: `grep -q 'opendoc-desktop agent command' ~/.local/bin/opendoc && rm ~/.local/bin/opendoc`. A file without those words is somebody else's: leave it. |
| The AI integration, if you did not undo it in step 1 | Claude Code: its config folder (`~/.claude`, or `$CLAUDE_CONFIG_DIR`), the marketplace `opendoc` and plugin `opendoc@opendoc`. Codex: `$CODEX_HOME` (default `~/.codex`), the same names. Antigravity: `~/.gemini/config/plugins/opendoc/`. Cursor: `~/.cursor/skills/opendoc/`. Copilot CLI: `~/.copilot/skills/opendoc/`. | The "Undo by hand" list in [AI apps](#ai-apps). Once the app is gone, the `claude` and `codex` commands still work; run the first four lines of that list. |
| Per workspace, see below | Inside each workspace folder | See below |

The same on Linux, in one block (it keeps your backups; add the last line when you are sure):

```sh
rm -rf "${XDG_CONFIG_HOME:-$HOME/.config}/opendoc-desktop"
rm -rf "${XDG_DATA_HOME:-$HOME/.local/share}/opendoc-desktop/runtime" "${XDG_DATA_HOME:-$HOME/.local/share}/opendoc-desktop/integrations"
rm -rf "${XDG_CACHE_HOME:-$HOME/.cache}/opendoc-desktop-updater"
grep -q 'opendoc-desktop agent command' ~/.local/bin/opendoc 2>/dev/null && rm ~/.local/bin/opendoc
rmdir "${XDG_DATA_HOME:-$HOME/.local/share}/opendoc-desktop" 2>/dev/null   # works only when backups/ is gone too
# rm -rf "${XDG_DATA_HOME:-$HOME/.local/share}/opendoc-desktop/backups"      # your upgrade backups
```

On a Mac the profile and the data folder are the same folder, `~/Library/Application Support/opendoc-desktop/`, so its `backups/` folder is inside the one you delete for the settings. Move `backups/` out first if you want to keep it.

Other files in your home folder that the app's engine may have made, such as `~/.pki` or `~/.local/share/pki/nssdb` (certificate stores) and graphics shader caches, are shared with other programs. Leave them.

**5. Each workspace you opened.** A workspace is yours; the uninstall never touches it. The app added or changed only these things inside it:

- `node_modules`: a symbolic link to the app's runtime (`/opt/opendoc-desktop/resources/runtime/node_modules` for packages; `.../opendoc-desktop/runtime/current/node_modules` in the data folder for an AppImage). After the uninstall it points at nothing. To go back to plain npm, delete the link and install OpenDoc the usual way, in that workspace: `rm node_modules && npm install` (it needs Node 24 and npm; npm then writes a real `node_modules` and a `package-lock.json`).
- `.opendoc/workspace.json` carries `"managed": true`. Leave it: OpenDoc acts on that flag only when it finds the app's runtime, and otherwise treats the workspace as an npm one.
- `package.json`: the `opendoc` pin may have moved up to the version of the app that opened it. It is never lowered.
- `.opendoc/desktop.json` exists only while the app has the workspace open, and `.opendoc/update.lock` only while a workspace is opening or a command such as `opendoc update` runs. A normal quit leaves neither. If the app was killed, one of them can stay behind, stale and harmless: delete it if the `opendoc` command names it in an error.
- `.claude/skills`, when the workspace has `.agents/skills`: a link to `../.agents/skills`, inside the workspace. It is OpenDoc's own convention. Leave it.

**6. Check that nothing is left.** After removing the items above, this should print only your workspaces and backups (if you kept them), and nothing else of the app's:

```sh
find "${XDG_CONFIG_HOME:-$HOME/.config}" "${XDG_DATA_HOME:-$HOME/.local/share}" "${XDG_CACHE_HOME:-$HOME/.cache}" -maxdepth 2 -iname '*opendoc*' 2>/dev/null
ls -l ~/.local/bin/opendoc /usr/bin/opendoc /usr/bin/opendoc-desktop 2>/dev/null
ls -d /opt/opendoc-desktop /etc/apparmor.d/opendoc-desktop 2>/dev/null
```

On a Mac: `find ~/Library -maxdepth 3 -iname '*opendoc*' 2>/dev/null`.

## Inside the app

The rest of this page describes how the shell works: for developers and reviewers, not needed to use the app.

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

`pnpm start` (`electron .`) in `desktop/` does the same. Environment variables that tests and development builds read: `OPENDOC_DESKTOP_RUNTIME` (runtime folder), `OPENDOC_DESKTOP_HEALTH_MS` (how often the service is checked, default 5000) and `OPENDOC_DESKTOP_INTEGRATIONS_OPTIONS` (a JSON file of options for the AI apps module: its home, environment, PATH folders and integration files; read only by an app that is not packaged, so a variable in an installed app's environment changes nothing, and it keeps the login shell unread so a test never sees the real Claude Code or Codex settings).

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
| `workspace/` | Linking a workspace to the app's OpenDoc, the version table, the upgrade, backups and the AppImage's runtime copy (see "Workspaces and versions"). |
| `runtime.mjs`, `process-info.mjs`, `identity.mjs`, `shell-pages.mjs` | Where the runtime is and how to run its CLI; questions about other processes; names; the app's own pages. |

`desktop/src/renderer/` holds the app's own pages (workspace picker, crash screen, upgrade progress and result, the backups list). They are served from `app://shell/` by the main process, never from `file://`, and get a small API from `desktop/src/preload/shell.cjs`. The workspace page (`app://opendoc/`, top frame only) gets only the two bridge functions described below.

## Opening a workspace

Everything below happens before the window loads, in this order, and any failure stops the open with a message the picker (or a dialog, for menu actions) shows:

1. The folder must hold `.opendoc/workspace.json`, or a `package.json` (a synced workspace that has not been used on this device yet: see "Workspaces and versions"). On an AppImage whose runtime copy failed, the open is refused here with that error.
2. `.opendoc/desktop.json` (C3): a live opendoc-desktop on it means "already open elsewhere"; a stale one (its pid is gone, or now belongs to another program) is removed.
3. `.opendoc/server.json`: a running browser-edition service means the workspace is refused, with a button that runs `opendoc stop`.
4. The workspace lock (`.opendoc/update.lock`, the CLI's own lock): taken while the workspace opens. A stale lock (its pid is gone) is reported and cleared only when the user asks; a live or damaged one is never offered for clearing.
5. The workspace is prepared (`workspace/prepare.mjs`, see "Workspaces and versions"): marker or adoption, the `node_modules` link, `.claude/skills`, the version table and the upgrade. A refusal at any step releases the lock and leaves the workspace as it was (an empty `.opendoc` folder that the lock made is removed again).
6. Another workspace that is open is closed first (with the unsaved-edits question), then its service stops.
7. The service host starts (see below): a run-as-Node child of the app's executable, with the workspace as its working directory, the runtime's OpenDoc loaded through tsx, and an IPC channel; it has no listener and writes no `server.json`. It runs in its own process group, guarded three ways (see "Never left behind" below). A workspace that must be read-only is started with `readOnly` (see "Workspaces and versions").
8. `desktop.json` is written, the workspace becomes `defaultWorkspace` and heads `recentWorkspaces` in `config.json`, the window opens, the lock is released.

On quit, the service is asked to close (it finishes accepted saves first; SIGKILL after 8 seconds), `desktop.json` is removed and the lock is released. A workspace that is still opening when the app quits is cancelled: its host is killed, its lock released (the shell keeps the pending open, so `shutdown()` does not depend on the open having finished) and nothing is written. After a `kill -9` of the main process the host and everything it started are gone within about a second (see "Never left behind"), and `desktop.json` and, if the app was opening a workspace, `update.lock` stay behind, stale, for the next launch to report (C3: a stale lock is never cleared on its own; the picker offers "Clear stale lock").

## Workspaces and versions

A workspace is a folder the user owns; the OpenDoc that runs it is the app's. Everything here is in `desktop/src/main/workspace/` and runs while a workspace opens (step 5 above), before the host starts.

**Where the runtime is.** The deb, rpm, pacman and macOS builds run from `resources/runtime`, which stays put. An AppImage's resources live in a mount that goes away with the app, so at launch the app copies `resources/runtime` to `<data>/runtime/<version>-<build>/` (`<data>` is `$XDG_DATA_HOME/opendoc-desktop`, else `~/.local/share/opendoc-desktop`; `~/Library/Application Support/opendoc-desktop` on macOS) and runs the service host and `runCli` from the copy. The copy is made in a `.tmp.XXXXXX` folder beside it and renamed, so it is whole or absent (when another process finished the same copy first, that complete copy is kept and the temp is dropped; the agent command follows the same rule); it is skipped when a copy with the same `build-info.json` is there (the agent command makes the same copy by the same rule); a copy that fails (a full disk) is shown when a workspace is opened and is never half-used. Other copies are pruned at every launch, but only `<version>-<build>` folders that hold a `build-info.json` (and stale temps of its own), and never one that a running process uses (`/proc/*/cmdline`, matched as a path and as the percent-encoded `file://` form the service host carries), and a `runtime/current` link, switched atomically, always points at the copy of this build: workspace links name `<data>/runtime/current/node_modules`, so pruning never breaks a workspace. `OPENDOC_DESKTOP_RUNTIME` still names a runtime for development and tests, and the copy is made whenever the `APPIMAGE` variable is set.

**The link.** `node_modules` in a workspace is a symlink to the runtime's `node_modules`, checked on every open: a missing link is made, a dangling or foreign one is replaced (a new link under a temporary name, then a rename). A real `node_modules` folder (or a file with that name) is never deleted without asking: the app asks once, "Use the app's OpenDoc" moves it to the trash and links, "Leave it as it is" leaves it and does not open the workspace. "Create new workspace" runs the runtime's `opendoc init <folder> --no-start` (U1), which needs no npm: `node_modules` is made as a link to the runtime and the marker says `managed`, so the first open finds a correct link and asks nothing (there is no silent replacement of a real `node_modules` any more; a runtime without U1 does not exist, because the app ships its own). On the AppImage `init` runs from the runtime copy and writes the copy's own path (`<data>/runtime/<version>-<build>/node_modules`); the exact check of the first open rewrites it to `runtime/current/node_modules`. `.claude/skills -> ../.agents/skills` is made when `.agents/skills` exists and `.claude/skills` is missing or a dangling link; a real `.claude/skills` folder is never replaced.

**Adoption and the marker.** A folder with a `package.json` that pins OpenDoc but no `.opendoc/workspace.json` (a workspace synced from another device) is offered "Use this workspace on this device". On yes the app writes the marker (`formatVersion` from the runtime's CLI, `edition`, `"managed": true`) and the link. An existing marker without `managed` gets `"managed": true` once the link is in place. `"managed": true` says that `node_modules` is a link to an app's runtime. The workspace's `.gitignore` keeps `.opendoc/workspace.json` in git (`!.opendoc/workspace.json`), so for a git user the flag travels to other devices where there may be no app: the CLI (U1) must act on `managed` only when `managedRuntime()` also finds the app's runtime, and otherwise treat the workspace as an npm one. A workspace of the headless edition is refused (the app opens the normal edition only, and switching edition is not an update); a `package.json` that does not pin `npm:@ryanyahya/opendoc@<exact version>` is refused with that explanation.

**The version table.** The pin is `dependencies.opendoc` in `package.json`; the runtime's version is the app's.

| Workspace pin against the app | What happens |
|---|---|
| Same minor, older or equal patch | Opens; the pin moves up to the app's version when behind. |
| Same minor, newer patch | Read-only: "Update the app to edit it." |
| Older minor (or major) | One dialog: **Upgrade** (backup first), **Open read-only**, or Cancel, with the box "Upgrade my workspaces without asking from now on" (`upgradeWithoutAsking`). |
| Newer minor (or major) | Read-only: "This workspace was upgraded by OpenDoc x.y. Update the app to edit it." |

The pin only ever moves up: `writePin` reads the file again and refuses to lower a pin that another device moved up meanwhile. `package.json` is rewritten atomically (a `package.json.opendoc-<pid>.part` temp, then a rename) with its indentation, key order, line endings, UTF-8 byte order mark and final newline kept, and `package-lock.json` is never touched. A symlinked `package.json` is written through to its real file when that is inside the workspace, and refused otherwise. The workspace format is compared before the version: an older `formatVersion` goes to the upgrade path, a newer one to the read-only path ("created by a newer OpenDoc"), and a read-only outcome writes nothing but the `node_modules` link. Temporary files beside workspace files end in `.part` (on the default exclude lists of the common sync clients, which is not verified here), and the next open removes those whose process is gone.

**Read-only.** The app passes `readOnly: { reason, message }` (`reason` is `newer-patch`, `newer-minor`, `declined-upgrade` or `restored-backup`) to the service's `prepareOpenDocService` on every host start, restarts included. The service refuses every write with 403 and `workspace-read-only`, reports `readOnly` in `GET /api/session` (an absent key means writable), and shows the app's `message` in a banner exactly as given; the app writes every message (`versions.mjs`; the newer-patch and newer-minor wording is the CLI's too). While the workspace is open read-only the app also writes `readOnly: { reason, message }` into `.opendoc/desktop.json`, which the CLI reads: `opendoc check` works, a write command is refused with that message, and the key is gone when the workspace is writable or the app quits. A read-only open writes nothing in the workspace but the `node_modules` link: no marker (a synced folder with no `.opendoc/workspace.json` opens read-only without one, and without the adoption question), no pin, no history. `declined-upgrade` and `restored-backup` exist only while the app holds the workspace; the CLI's own table (a managed workspace, run from the app's runtime) answers for the others, and gives the app's answer for every row of the table. A service says it can do this by returning `readOnlySupported: true` from `prepareOpenDocService`. The app checks that before anything is changed (the runtime's `service.ts` says it), and again inside the host before the service starts: while it is missing, a workspace that would open read-only is refused with the same message and "Back to workspaces", so a workspace is never opened writable by mistake.

**Upgrade.** Back up, run the registry's steps (`workspace/registry.mjs`; empty for now, and a missing entry still upgrades), move the pin, then run `check` and `review` on every document with the workspace as the working directory. The backup is `<data>/backups/<workspace>-<YYYY-MM-DD-HHMMSS>/` (the name never starts with a dot, so a workspace folder called `.notes` still lists) with `backup.json` (source, from and to versions, time, file count, bytes) and `workspace/`, a copy of everything except the top-level `node_modules`, `.opendoc` and `output` and the metadata of version control and file sync, which is neither backed up nor restored (`.git`, `.hg`, `.svn`, `.jj`, `.sync_*.db*`, `._sync_*.db*`, `.csync_journal.db*`, `.owncloudsync.log*`, `.nextcloudsync.log*`, `.~lock.*`, `.stfolder`, `.stignore`, `.stversions`, `.dropbox*`, at any depth: restoring an old `.git` would silently roll back commits); free space is checked first. It is built in `.<name>.partial` and renamed, and a `.partial` folder older than ten minutes (a crash; it is only a copy) is removed when the app starts and when the backups page opens. If everything passes the workspace opens, and a message says where the backup is. Otherwise a result screen lists each failing document with its message and offers **Copy prompt for your agent**, **Restore backup** and Close (and "Open anyway" when only checks and reviews failed). Restore works file by file and never moves a file across filesystems. It checks the free space (for the safety copy and for the new files), then writes `.opendoc/restore-journal.json` before the first change; it copies (never moves) the current version of every file that will change or disappear into a new `before-restore` backup (`scope: "changed-files"`), replaces files one at a time atomically, removes the files the backup lacks, and leaves identical files alone (same inode). If any step fails it rolls back from the safety copy, and the safety copy is deleted only when the rollback fully succeeded; if it did not, the error names the folder that holds it and keeps the journal. Rollback and recovery are one routine that reads the state of each path and does only what is still needed, so they can run again from any state (a kill in the middle of the restore or of the rollback, a file that became a folder or the other way round): the temporary files of the plan's paths are removed at any depth, files that already equal their saved copy are not rewritten (no room needed on a full disk), and a folder the backup lacks that holds version control or sync metadata stays and is named in the result. A journal found at the next open of the workspace, or on the backups page, is acted on: the restore is undone from the safety copy, and the result is shown (a copy that is still needed cannot be deleted from the backups page). If recovery still cannot finish, the open shows a dialog that names the safety copy and offers **Open anyway** (the journal is set aside inside the safety copy, so nothing is rolled back later over new edits) or Cancel (nothing changes); the user is never locked out of the workspace. After a restore the workspace counts as read-only. Backups are never deleted automatically; File > Workspace Backups… lists them with Reveal and Delete (to the trash, after a question). Before the pin moves, the upgrade writes `.opendoc/upgrade-pending.json`, and removes it after `check` and `review`; if it is still there at the next open (a crash after the pin moved), the checks run again and the result screen is shown. A crash before that leaves the backup, and the next open sees the older pin and asks again. The read-only probe (`readOnlySupported`) ignores comments and types in the runtime's `service.ts`.

## Files

- `config.json` in the profile folder (`~/.config/opendoc-desktop/` on Linux, `~/Library/Application Support/opendoc-desktop/` on macOS): `defaultWorkspace`, `recentWorkspaces` (at most 10, newest first), and the keys of other parts of the app. Written atomically with mode 0600; unknown keys are kept. Opening a workspace makes it the default, because the router skill and the agents use the default.
- `window-state.json` beside it: size, position and maximised state of the workspace window. A saved position off every connected display is dropped.
- `logs/workspace-<id>.log` beside it: what the service printed, and when the app started and restarted it. The crash screen and the Help menu link to it.
- The data folder (`$XDG_DATA_HOME/opendoc-desktop`, else `~/.local/share/opendoc-desktop`; on macOS the same folder as the profile, `~/Library/Application Support/opendoc-desktop`): `backups/` (one folder per upgrade or restore), `runtime/` (an AppImage's runtime copies and the `current` link; none elsewhere) `integrations/` (the stable copy of the plugin files) and `integrations.json` (the record of what the AI apps screen connected; see [AI apps](#ai-apps)). `workspace/paths.mjs` decides the location.
- The update cache, which electron-updater makes (`$XDG_CACHE_HOME/opendoc-desktop-updater`, else `~/.cache/opendoc-desktop-updater`; `~/Library/Caches/opendoc-desktop-updater` on macOS): the downloaded installer, under `pending/`. The name comes from `updaterCacheDirName` in the packaged `resources/app-update.yml`.
- The `opendoc` command for an AppImage or a Mac: `~/.local/bin/opendoc`, or on a Mac `/usr/local/bin/opendoc` (see "The `opendoc` command").
- Per workspace: `.opendoc/desktop.json` (`{ pid, startedAt, version, build }`, plus `readOnly: { reason, message }` while it is open read-only) while it is open.
- `config.json` also holds `aiAppsOffered` (a boolean, written `true` when the first-run "Connect your AI apps" screen has been shown, Skip included; absent until then), `upgradeWithoutAsking` (a boolean, false until the user ticks "Upgrade my workspaces without asking from now on") and `commandLineNotices` (`{ path, foreign }`): which one-time notices about the `opendoc` command were shown (see "The `opendoc` command").

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
- "Show in folder" for a document export is the service's own route: the host starts the file manager (`xdg-open`; `open -R` on macOS). The service removes `ELECTRON_RUN_AS_NODE` from the environment of programs it starts for the user (`externalEnv()`, `src/server/external-env.ts`); `workspace-flow.spec.mjs` checks that a stub `xdg-open` does not see it.
- The window title is the page title followed by `opendoc-desktop`.

## Menus

File: Open Workspace, New Workspace (a new or empty folder, made with the CLI's `init`), Open Recent, Import Design Pack… (a `.opendoc.zip`, while a workspace is open), Reveal Workspace, Workspace Backups…, Show Log, Quit. Edit: the standard roles (macOS needs them for copy and paste). View: zoom and full screen only, with no reload and no developer tools. Window. Help: a link to the original project; About opendoc-desktop shows the version, the build number and commit, and credits the original OpenDoc project with its link. Where the install updates itself, the Help menu (the app menu on macOS) also has "Check for Updates…", the checkbox "Check for Updates Automatically", and "Restart to Update" while a downloaded update is waiting. "Connect AI Apps…" (see [AI apps](#ai-apps)) is the last item of the Help menu, and on macOS sits in the app menu after "Install Command-Line Tool…".

## Updates

What a user sees for each install type is in [Updates by install type](#updates-by-install-type); this section is the detail. The app updates itself where it can (`src/main/updater/`, built on electron-updater 6.8.11). What it does depends on how it was installed, found in this order:

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

The first run builds the OpenDoc package (`pnpm package:pack --edition normal`, or the tarball named by `OPENDOC_SHELL_TEST_TARBALL`), a runtime folder from it, and two template workspaces: the one the app makes (`opendoc init --no-start` from the runtime, no npm) and one as npm leaves it (`golden-npm`: a real `node_modules`, a `package-lock.json`, a marker without `managed`; made once with `npm install` from the npm cache, so the first build needs the registry). Creating a workspace in the app needs no npm.

The unit tests include one for the transport that runs a stand-in service in plain Node (`unit/transport.test.mjs`: upload, `Range`, a large answer, changes, abort, a dead and a stopped host, the process group, a failed or hung start, credit and a reader that does not read, a cut-off upload, a bad status, a start cancelled by its signal, and `kill -9` of a parent process while its host is starting, busy in a loop or stopped, a request that is over before its upload is read, and nine ways a broken host can answer, a bad status, header or piece, each a 502 or a failed response with the same host serving the next request) and one for the host's request and response objects (`unit/service-host.test.mjs`, including an upload read with `readable` and `read(n)`), and `unit/sentinel.test.mjs`.

The workspace work has its own tests: `unit/workspace-*.test.mjs` (the version table, pin rewriting, links, adoption, backups and Restore, the registry, the AppImage copy, the open flow with a recording UI, and the read-only handshake with a stand-in service) and `workspace-versions.spec.mjs` (every row of the version table, the upgrade with its backup, the result screen and Restore, adoption, repaired links, the backups list and the AppImage copy, in the app). Every launch gets a scratch `HOME` with its own `XDG_*` folders and npm cache under `tmp/shell-tests/`, so backups and runtime copies never land in a real data folder; a workspace made by `newWorkspace()` is linked to the test runtime and marked `managed`, as the app leaves one (`{ npm: true }` is the npm template; the default also carries that template's `package-lock.json`, which the app must leave byte-identical). The spec covers every read-only row opening read-only (the banner, a refused write, `desktop.json`, a restart of the host, a marker-less folder), Restore opening read-only, Create with no npm on the PATH (also on an AppImage), and the CLI next to the app and on its own.

`packaged.spec.mjs` runs the app as it ships: `desktop/src`, `package.json` and the production dependencies (electron-updater and what it needs) packed into an `app.asar` (with electron-builder's own packer) and started by the same Electron, to prove that the service host (passed to the child as text) and the page work from inside an asar. It does not test the installers; that is the packaging work's.

Not covered by the tests (they need a person on a real display): native Wayland and fractional scaling, the GPU, input methods, the real clipboard, the real file chooser and file manager, and dropping a file from a file manager.

The agent command has its own spec, `command.spec.mjs`, run against a linux-unpacked layout (this worktree's Electron renamed `opendoc-desktop`, the test runtime in `resources/runtime`, the launchers in `resources/cli`). Point `OPENDOC_SHELL_TEST_UNPACKED` at a real `linux-unpacked` folder to test a real build instead (it is copied, never changed). Every command test uses a scratch `HOME`, and a tripwire `node`, `npm` and `npx` first on the PATH proves that no system Node is used.

The AI apps screen has `unit/ai-apps.test.mjs` (the module's options, the rows, Connect, Disconnect, Forget, blocked, failed and absent apps, the refresh at launch and the first-run flag, all with fake `claude`, `codex` and `agy` commands in a scratch home) and `ai-apps.spec.mjs` (the screen in the app: first run, Skip, the menu item, Connect and Disconnect, a blocked result). Every one of those runs keeps the module away from the real home, config folders and login shell (`support/integrations.mjs`); the tests' own `CLAUDE_CONFIG_DIR` and `CODEX_HOME` are scratch folders too. Opening a pack has `unit/pack-import.test.mjs` (arguments, the 64 MiB limit, the queue, and every refusal of Show in folder) and `pack-import.spec.mjs` (a launch argument, a second launch, `open-file`, the File menu, a pack that waits for a workspace, Show in folder).

The updater has its own unit tests and Electron specs, a local feed server and a hand-run AppImage update (build 1 to build 2); `desktop/README.md` ("Testing updates") says how to run them. They use loopback feeds only, never GitHub. The macOS swap is covered only by tests of its decisions, because it needs a Mac.

## The service host and the bridge

**Transport.** `transport.mjs` starts the host as `<app executable> --import <tsx> --import <watchdog> --input-type=module -e <host source> opendoc-service-host <service.ts>` with `ELECTRON_RUN_AS_NODE=1`, `cwd` = the workspace root (the service's themes and documents read the working directory), `serialization: 'advanced'` and a process group of its own. The host's code is passed as text, so the child never reads a file inside `app.asar`. The service comes from the runtime (`node_modules/opendoc/src/server/service.ts`; the repository in development) and is created with `createOpenDocService({ root: cwd, production: true })`; the host tells the main process when it is ready.

**Requests.** `protocol.handle('app')` (one handler per session) serves `app://shell/` itself and forwards `app://opendoc/` to the transport. A request goes to the host as a message (method, path and query, headers with `host: opendoc`); an upload follows as body pieces, an abort as an abort message. The host builds Node's request and response objects (`src/host/service-host.mjs`), calls `service.handle(req, res)` and sends back the status line and headers, then the body in pieces; both directions are flow-controlled by credit: the host writes at most 4 MiB of a response that the page has not taken (the response is a `ReadableStream` whose `pull` sends a `credit` message back, so a slow or stopped reader holds the host to one window of an endless answer), and the main process sends at most 4 MiB of an upload that the service has not read (the host sends `body-credit` as the service reads). When a response ends, is cancelled or fails, the upload loop is cancelled and the host told to abort. What Electron 45 does and does not tell the handler (measured, `integration.spec.mjs` and the unit tests): a page that cancels a download makes it cancel the response stream (so the host is told to abort, though Chromium has by then pulled up to about 8 MB ahead of a slow page, which is why a fast host may have sent a whole 12 MB file before a kill lands); a page that aborts a `fetch` does not set `request.signal` (the listener is kept for other Electron versions), and Electron has already handed over the whole upload body, so the service finishes a request it received in full, as a web server would. Requests made by dedicated and shared workers do not reach the `webRequest` hook at all (the protocol handler sees them, with no origin), so the caller guard cannot police them; what keeps a worker of another origin out is that no page of another origin can start one (the shell's pages have `worker-src 'none'`, and every other page is the workspace itself). Full requests, `Range` headers (a 206 and its `Content-Range` are carried through as the service sent them; today the service ignores `Range` and pdf.js loads PDFs whole), uploads of up to the service's 100 MB cap, and downloads all use this path. Everything the host sends is checked before it is used: a status outside 200 to 599, a header name or value that is not valid, too many or too large headers, an oversize chunk, or a message of the wrong shape answers 502 (the request fails, the host keeps serving). A host that dies fails every request waiting for it (503) and later ones too, until the supervisor has started a new one.

**Bridge.** The service's `onChange` goes to the main process and on to the workspace window's main frame, only while that frame is at `app://opendoc`. The preload exposes, in that frame only and nowhere else (the app's own pages, iframes and other windows get nothing):

- `window.opendocDesktop.onChange(listener)`: called with no arguments whenever the service reports a change.
- `window.opendocDesktop.onHostState(listener)`: called with `{ state }`: `'restarting'` (the host exited or stopped answering; requests fail meanwhile), `'running'` (it is back; the page refetches), or `'failed'` (the shell gave up and is about to show its crash screen).
- `window.opendocDesktop.onImportPack(listener)`: called with `{ name, bytes }` (a `Uint8Array`) when the user opens a design pack from outside the page: a launch argument, a second launch, macOS `open-file`, or File > Import Design Pack…. The main process reads the file (at most 64 MiB), keeps it until the workspace page has loaded, and sends it to that frame; the preload keeps the newest pack until the page has a listener, so one that arrives before the page subscribes is not lost, and it goes to the first listener once. A page that does not use it (the browser edition) never sees one.
- `window.opendocDesktop.showInFolder(path)`: asks the main process to reveal a pack the page saved. It resolves with nothing whatever the answer; the main process checks the caller (the open workspace's top frame) and reveals only a file that, with every link resolved, lies inside the open workspace's `output/packs/` (`revealablePackPath` in `pack-import.mjs`).

The subscriptions return a function that stops listening. `src/app/main.tsx` uses `onChange` instead of its WebSocket when the bridge exists.

**Never left behind.** Three guards, because a host can die of the app's death in three different states. (1) `watchdog.mjs` is loaded first (`--import data:...`, from text, so nothing is read from `app.asar`), before tsx and the service: if the channel is already closed it ends at once, and when the channel closes it kills the host's process group. (2) The same file starts a worker thread that polls the parent id every 300 ms and kills the group when it changes, which works while the host's main thread is stuck in a synchronous loop (where 'disconnect' never runs). (3) The main process starts a small shell sentinel (`/bin/sh`, in its own session; the script is `sentinelScript` in `transport.mjs`, written for every POSIX shell in the one form they all accept, `kill -0 "-$2"` and `kill -KILL "-$2"`: dash, the `/bin/sh` of Debian and Ubuntu, rejects `kill -0 -- -PID` and `kill -s 0 -PID`, and busybox sh rejects any `--`; `unit/sentinel.test.mjs` runs the script under each shell the machine has, which in CI includes dash and busybox on Ubuntu) that checks every second that the app and the host's group are still there and kills the group when the app is gone first; it covers a host that is stopped (SIGSTOP), runs nothing, and the render workers it started, and it exits as soon as the group is gone. The group is signalled only from the sentinel's check and once, from the host's exit event, never later: a group number cannot be given to anything else while any of its members lives. A start in progress is cancelled by an abort signal (the app is quitting, or the supervisor was stopped), which kills the host. Windows has no process groups: the channel and the parent id check remain.

**Supervision.** The supervisor checks that the service answers (a real `GET /api/session` through the channel, every 5 seconds, three misses in a row) and restarts the host when it exits or stops answering, after killing it and its process group. The window keeps its page: the address does not change, and the page fetches a new session token on its own when a write is refused. A restart sends `restarting`, then `running`. After three restarts in two minutes the shell sends `failed` and shows the crash screen, whose "Try again" starts the host again and loads the workspace.

**No port.** Nothing in the app listens: the host has no server, the window loads from the `app` scheme, and the app writes no `.opendoc/server.json`. `robustness.spec.mjs` proves it with `ss -ltnp` and `ss -lunp` while the app runs by itself (Playwright's own driver adds a DevTools port and a Node inspector port, so that test starts the app without it), five seconds after a quit and after a `kill -9` of the main process no process runs from the app's executable path, and the next launch opens the workspace with no cleanup.

What the shell still does around `createOpenDocService().handle()` (the U3 review), all in place and tested: any other host answers 403; only the app's own page may change things (`initiatorOrigin`); change events go to one frame only; no cookies and no token in a URL; a throw answers 500 and a closed or dead transport 503; `close()` runs once, in `will-quit`; the host's working directory is the workspace.
