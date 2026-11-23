# opendoc-desktop

opendoc-desktop is a desktop app for [OpenDoc](https://github.com/RyanYahya/OpenDoc) on Linux and on macOS with Apple Silicon, built with Electron on top of the original OpenDoc project. It opens one workspace at a time in a window and carries its own runtime, so users install no Node or npm. The package lives in [`desktop/`](../desktop/README.md) (build and release instructions are there); OpenDoc's npm packages do not include it.

This page starts with what a user needs: how to [install](#install) the app, what happens at the [first run](#first-run), how it [updates](#updates), which workspaces it [opens](#which-workspaces-open), the [`opendoc` command](#the-opendoc-command), how to [connect AI apps](#ai-apps) and how to [uninstall](#uninstall) it completely. How the app works inside, and how to build, test and release it, is on the [developer page](../desktop/README.md#how-the-app-works).

## Install

Releases are on the repository's releases page, `https://github.com/Raed-Alghamdi/OpenDoc-Desktop/releases`. A release is named `desktop-v<version>-<build>` (for example `desktop-v0.6.1-2`). The version is OpenDoc's own. The build number is raised when the app is rebuilt without a new OpenDoc version.

| System | File to download |
|---|---|
| Linux, any distribution (x86_64) | `opendoc-desktop-x86_64.AppImage` |
| Debian, Ubuntu (x86_64) | `opendoc-desktop_<version>-<build>_amd64.deb` |
| Fedora, openSUSE (x86_64) | `opendoc-desktop-<version>-<build>.x86_64.rpm` |
| Arch Linux (x86_64) | the AUR package `opendoc-desktop-bin` (below), or `opendoc-desktop-<version>-<build>-x64.pacman` |
| macOS, Apple Silicon (M1 or newer; there is no Intel Mac build) | `opendoc-desktop-<version>-<build>-arm64.dmg` (or `.zip`) |

Every release also holds `latest-linux.yml` and `latest-mac.yml`: the update information the app reads. You never need them.

Every installer in a release (AppImage, deb, rpm, pacman, dmg and zip) has a signature file beside it, `<file>.sig`: the 64 raw bytes of an Ed25519 signature over the whole file, made with the release key. The public key is `desktop/resources/updater/release-key.pem` in this repository, and the deb, rpm and Arch packages install a copy as `/opt/opendoc-desktop/resources/updater/release-key.pem`. To check a download by hand (OpenSSL 3): `openssl pkeyutl -verify -pubin -inkey release-key.pem -rawin -in <file> -sigfile <file>.sig`, which prints "Signature Verified Successfully". Before you install a pacman file by hand, move its `.sig` out of the folder (or delete it): `pacman -U` reads a `<file>.sig` beside a package as the package's PGP signature and refuses it with "invalid or corrupted package (PGP signature)". The app's own updater does this check for deb, rpm and Arch updates (see [Updates](#updates)).

The packages carry no signature of their own that your package manager knows (no GPG key, no distribution signature), so some systems ask for a flag when you install them by hand (shown below). Each release's `latest-*.yml` also lists the SHA-512 of every file, which you can compare with `openssl dgst -sha512 -binary <file> | base64 -w0` (the same base64 form).

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

The package installs the app in `/opt/opendoc-desktop/`, a menu entry "OpenDoc Desktop" (Office), the `opendoc-desktop` link in `/usr/bin` and the `opendoc` command as `/usr/bin/opendoc`. Where AppArmor is on (Ubuntu 24.04 and later), it also installs `/etc/apparmor.d/opendoc-desktop`, which lets the app's sandbox work. It depends on `libgtk-3-0`, `libnotify4`, `libnss3`, `libxss1`, `libxtst6`, `xdg-utils`, `libatspi2.0-0`, `libuuid1` and `libsecret-1-0`, which `apt` installs for you.

### rpm (Fedora, openSUSE)

```sh
sudo dnf install --nogpgcheck ./opendoc-desktop-<version>-<build>.x86_64.rpm           # Fedora
sudo zypper install --allow-unsigned-rpm ./opendoc-desktop-<version>-<build>.x86_64.rpm   # openSUSE
```

The flags are needed because the rpm has no signature your package manager knows (the release's `.sig` file is a different thing, checked by the app's updater before it installs, and by you with `openssl` as shown above). This is also how the app's own updater installs an rpm, after it has checked the release signature. The layout is the deb's: `/opt/opendoc-desktop/`, the menu entry, `/usr/bin/opendoc`.

### Arch Linux

The AUR package is `opendoc-desktop-bin`. It repackages a release's pacman file, so it carries its own Electron and OpenDoc and uses no shared `electron` package.

```sh
yay -S opendoc-desktop-bin        # or paru, or: git clone the AUR repository and run makepkg -si
```

> The AUR package is not published yet; its first publication waits for the maintainer. Until then use the pacman file of a release.

Its version is OpenDoc's and its `pkgrel` is the build number. It switches the app's own updater off (see [Updates](#updates)): pacman owns updates, so `yay -Syu` or your usual system update brings new builds. It conflicts with a hand-installed `opendoc-desktop` package.

To install a release's pacman file by hand instead (for example before the AUR package exists):

```sh
sudo pacman -U ./opendoc-desktop-<version>-<build>-x64.pacman
```

Keep the release's `.sig` for it in another folder (see [Install](#install)): pacman would take it for a PGP signature and refuse the package.

That install updates itself through the app (see below), unlike the AUR package.

### macOS

The app needs a Mac with Apple Silicon (M1 or newer). Open the `.dmg` and drag opendoc-desktop to the Applications folder (or unzip the `.zip` and move the app there). Do not run it from the disk image or from the Downloads folder: macOS then runs it from a temporary read-only copy, which cannot update itself and cannot install the `opendoc` command.

The app is signed ad hoc and is not notarized (there is no Apple developer account behind it), so macOS blocks the first launch. To open it anyway:

1. Open the app from Applications. macOS says it cannot verify the app. Close that message.
2. Open System Settings, then Privacy & Security, and scroll down to the Security section.
3. Next to "opendoc-desktop was blocked", click **Open Anyway**, confirm with your password or Touch ID, and click **Open**.

On macOS 14 and earlier, Control-click the app, choose **Open**, then **Open** again. You do this once; later launches do not ask again.

## First run

1. Start OpenDoc Desktop (the menu entry, `opendoc-desktop` in a terminal for a package install, or the AppImage file). With an AppImage the first start takes a few seconds longer while it copies its runtime.
2. A window titled "Choose a workspace" asks for a folder. A workspace is a folder that holds your documents, themes and templates; the app opens one at a time.
   - **Create new workspace...** asks for a new or empty folder, and creates the workspace there with OpenDoc's own `init` command. It needs no network and no npm: the new folder's `node_modules` is a link to the app's runtime, and its marker file `.opendoc/workspace.json` says `"managed": true`.
   - **Open existing workspace...** opens a folder that already is one. A folder synced from another device (it has a `package.json` pinning OpenDoc but no `.opendoc/workspace.json` yet) is adopted after a question, "Use this workspace on this device?". A real `node_modules` folder in it is never deleted without asking. [Which workspaces open](#which-workspaces-open) says what happens when its OpenDoc version differs from the app's.
3. The workspace opens in the window: the library of documents, the editor, comments, export. Nothing listens on a network port; the window talks to OpenDoc inside the app.
4. The folder you opened becomes the default workspace (`defaultWorkspace` in `config.json`). The next start opens it again, and the [AI apps' skill](#ai-apps) uses it. File > Open Recent switches workspace.

While a workspace is open the app writes `.opendoc/desktop.json` in it, so the `opendoc` command knows the app has it, and removes it when you quit. A workspace is open in only one place at a time: if a browser-edition `opendoc start` is running on the same folder, the app refuses and offers to run `opendoc stop`.

The File menu also has Reveal Workspace, Workspace Backups... and Show Log (the service's log, the first place to look when something goes wrong).

## Updates

The app checks for a new build only while it is open: once at launch, then once a day. Nothing runs while it is closed. The address it asks is this repository's releases, unless `config.json` has an `updateFeed` (https only). A release is an update when its version is higher, or when it is the same version with a higher build number. What the app does next depends on how it was installed:

| Install | What you do | What happens |
|---|---|---|
| AUR package | Nothing in the app. Update the system as usual (`yay -Syu`). | The package carries an empty file `resources/update-disabled`, so the in-app updater does not exist and the app makes no update requests. |
| AppImage | Nothing. | The new file is downloaded in the background (only the changed blocks, when the server allows it) and replaces the AppImage when you quit. The next start is the new build, with no password. The `opendoc` command keeps working. The AppImage's folder must be writable and have room for another copy; if not, nothing is downloaded and you are told once. |
| deb, rpm, or a pacman file installed by hand | Click **Restart to Update** (a dialog, and a menu item that stays until used), then type your system password. | The package is downloaded in the background, together with the release's signature for it (`<package>.sig`). Installing a system package needs administrator rights, so the password prompt (polkit `pkexec`) cannot be avoided. As root, the installer checks the package against its SHA-512 and its signature against the release key, and installs it only if both hold. A release without a signature for the file is not installed (the app says so, and asks for no password); you can download it from the release page and install it by hand. Cancelling the prompt keeps the download and offers it again. |
| macOS | Click **Restart to Update**. | The app downloads the new build, checks it, replaces itself and restarts. It does this only when it runs from a writable folder such as Applications and not from a temporary copy; otherwise a notice offers a button to the release page, and you download, drag it to Applications and use Open Anyway again. |

Rules that hold for every install:

- A download is accepted only from the configured address, over HTTPS, and only when it matches the SHA-512 in that release's update information. The checksum proves the file is the one the release names; it does not prove who published it.
- A deb, rpm or pacman update is also installed only when its signature verifies: the release publishes `<file>.sig` (an Ed25519 signature made with the release key, whose public half ships with the app), and the root-owned helper checks it before any package tool runs. A feed, a cache folder or a release asset that was changed therefore cannot get a package of its own installed as root. AppImage and macOS updates are checked against the SHA-512 only: they install without administrator rights, so they gain no privilege, and the macOS app checks the bundle's own signature and identifier as before.
- A release offers an update to an install type only when its update information lists a file for that type.
- To turn automatic checks off, clear **Check for Updates Automatically** (in the Help menu, and in the app menu on macOS) or set `"checkForUpdates": false` in `config.json`. **Check for Updates...** then still runs one check when you click it.
- After an update, the first start says once "OpenDoc Desktop was updated to <version>, build <build>", with a link to the release.
- The details (install type detection, redirects, failures) are in [How the updater works](../desktop/README.md#how-the-updater-works).

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
- **What it shows.** A list that opens at once, because nothing on it runs an app's own commands: one row each for Claude Code, Codex, Antigravity, Cursor and Copilot CLI, then "Other app". A row says whether the app is installed, and, from this app's own record, whether OpenDoc is connected in it ("Connected", or for Claude Code "Connected in 1 of 2 folders"), "Needs attention" (a connect that did not finish, or an app that is gone) and "Update available". The app is looked up on your search path and never run to find out. The list reads your login shell once and reuses what it learned for a minute; **Check again** reads it afresh.
- **An app's page.** Each row opens a page for that app (a **Back** button returns to the list). It says where the app is installed (and with what, for example mise); an app that is not installed says where to get it and offers **Check again**. The read-only check "is OpenDoc connected?" runs here, for this app only, under a "Checking..." line while the page stays usable, and again for this app only after each Connect, Disconnect, Update or Forget. Folders you can connect have a tick box, and nothing is ticked at the start (an app with one folder has it ticked, since you came here to connect it). Nothing is changed until you press **Connect**, and every result is shown. After a connect, a **Try it** box offers a prompt to paste (with a Copy button): start a new session of that app in any folder and paste it.
- **Other app.** For an agent the screen does not know, this page shows the folder of the plain skill the app ships (`desktop/integrations/skills/opendoc` in a checkout, `<resources>/integrations/skills/opendoc` in an installed app) and the `opendoc` command, if it is on your search path, each with a Copy button. Point your agent at that skill, or copy the folder to where it reads skills; the agent must be able to run `opendoc`. Chat apps that cannot run programs on your computer, such as ChatGPT or the chat in the Claude app, cannot use OpenDoc.
- **What Connect does** for each ticked app, through the app's own commands:
  - Claude Code and Codex: registers a marketplace called `opendoc` from a copy of the files kept in the app's data folder, and installs the plugin `opendoc@opendoc`.
  - Antigravity: `agy plugin install` of the same plugin.
  - Cursor and Copilot CLI: copies the one skill file into the one folder each reads. It never runs either program.
  - It then asks the app whether OpenDoc is really there, and undoes everything it added if not.
- **The result.** Each app gets a line: connected, blocked, or did not work. For a result that is not connected, the screen shows the app's own words from the step that failed (an organisation's policy can block plugins; the message is the vendor's, unchanged). Under **Details** it lists every step with the exact command that ran and its output.
- **Disconnect** is the undo, in the row of each connected app. It uses the same commands and the record of what was added, and it leaves alone anything it did not add: a file you changed is kept and reported, and an OpenDoc that was already installed some other way is shown as "Already set up elsewhere" and never touched. **Forget** appears for an app that has been uninstalled since: it drops the app's record without running anything. A connect that was cut short shows as "Needs attention", and Disconnect cleans it up.
- **Which settings folder.** Codex may keep its settings somewhere other than the default (`CODEX_HOME`): the app asks your login shell first, then uses its own environment, then the default folder, and uses the same folder when it disconnects. Claude Code can be connected in more than one folder, each with its own record, Connect and Disconnect: `~/.claude` (the one the `claude` command in a terminal uses, unless `CLAUDE_CONFIG_DIR` is set), every `~/.claude-<name>` folder that holds Claude Code settings (a `settings.json`, `projects`, `plugins`, `.credentials.json`, `CLAUDE.md` or similar; an empty folder or a plain file is not one; the Claude desktop app keeps a profile in a folder like this), and the folder `CLAUDE_CONFIG_DIR` names when it is none of those. The commands for a folder run with `CLAUDE_CONFIG_DIR` set to it (and without it for `~/.claude`). A record made before this existed still works as the `~/.claude` one. The page sends the app an id for a folder, never a path, and the app accepts only the folders it found or has a record of.
- **What the app keeps.** `integrations.json` and the folder `integrations/` in the app's data folder (`~/.local/share/opendoc-desktop` on Linux, `~/Library/Application Support/opendoc-desktop` on macOS). They go away with the last Disconnect.
- **Staying current.** At launch the app checks whether its own integration files changed (an app update brings new ones) and brings what is connected up to date. Claude Code reads the files in place, in every folder it is connected in, so only the records move on; Codex and Antigravity are installed again; Cursor and Copilot CLI get the file again. It says nothing when it works or when nothing is connected. If it fails for an app that is still connected, a message says so and offers the screen; a row that still has older files shows "Update available", and its page has an **Update** button.

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
codex plugin list --marketplace opendoc

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

- **Double-click** it in the file manager (Linux; works from the deb, rpm and Arch packages). They register the pack file type with the system, so the file manager offers OpenDoc Desktop; the path reaches the app as a launch argument, or goes to the app that is already running (a second launch hands the file over and exits). The file manager may pass a path or a `file://` address (the `.desktop` file's `Exec` uses `%U`); the app accepts both. The AppImage carries the same `.desktop` entry but cannot install the shared-mime type, so a double-click goes to the archive manager unless a desktop integrator for AppImages registers it, or you add the type yourself: copy `opendoc-desktop.xml` (in a checkout, `desktop/resources/mime/`) to `~/.local/share/mime/packages/` and run `update-mime-database ~/.local/share/mime`. Otherwise use File > Import, drop the file on the window, or Open With (choosing the AppImage), which work with every install.
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
| deb | `sudo apt remove opendoc-desktop` | `/opt/opendoc-desktop/` (with the update helper `resources/updater/install-update`), `/usr/bin/opendoc`, the `/usr/bin/opendoc-desktop` link, the menu entry and icons, the polkit action `/usr/share/polkit-1/actions/io.github.ryanyahya.opendocdesktop.install-update.policy`, and `/etc/apparmor.d/opendoc-desktop` (the package's removal script unloads and deletes it). `purge` adds nothing to the files: the package has no configuration files. Until you purge, dpkg lists the package as `rc`; and the compiled AppArmor cache is not deleted by either (see step 4). |
| rpm | `sudo dnf remove opendoc-desktop` (Fedora) or `sudo zypper remove opendoc-desktop` (openSUSE) | The same files as the deb, including the update helper and the polkit action. |
| AppImage | Delete the `.AppImage` file. | Only that file. Its other traces are in the table below. |
| macOS | Quit the app, then drag opendoc-desktop from Applications to the Trash. | Only the app. Its other traces are in the table below. |

**4. What stays behind, and how to remove it.** Nothing here is needed by anything else, and nothing runs. Linux paths follow the XDG variables when you set them; the macOS paths come after the semicolon.

| What | Where (Linux; macOS) | Remove with |
|---|---|---|
| The app's settings and logs: `config.json` (default workspace, recent workspaces, update switches, notices), `window-state.json`, `logs/` (`workspace-<id>.log`, `updater.log`), and the engine's own files for the app (`Partitions/`, `Crashpad/`, caches) | `${XDG_CONFIG_HOME:-$HOME/.config}/opendoc-desktop/`; `~/Library/Application Support/opendoc-desktop/` | `rm -rf "${XDG_CONFIG_HOME:-$HOME/.config}/opendoc-desktop"` |
| The runtime copy an AppImage made (about 185 MB per build, `runtime/<version>-<build>/`, and the link `runtime/current` that workspaces point at). Packages and macOS make none. | `${XDG_DATA_HOME:-$HOME/.local/share}/opendoc-desktop/runtime/` | `rm -rf "${XDG_DATA_HOME:-$HOME/.local/share}/opendoc-desktop/runtime"` |
| The stable copy of the plugin files and the app's record of what it connected, if you connected an AI app (Disconnect removes both) | `.../opendoc-desktop/integrations/` and `integrations.json` in the data folder | `rm -rf "${XDG_DATA_HOME:-$HOME/.local/share}/opendoc-desktop/integrations" "${XDG_DATA_HOME:-$HOME/.local/share}/opendoc-desktop/integrations.json"` |
| **Workspace backups**, one folder per upgrade or restore: `backups/<workspace>-<date and time>/` (a `workspace/` copy and `backup.json`). These are your files: look before you delete. | `.../opendoc-desktop/backups/` in the data folder | `ls "${XDG_DATA_HOME:-$HOME/.local/share}/opendoc-desktop/backups"`, then `rm -rf` the ones you do not need, or the whole folder |
| The private working folder the AI apps module runs vendor commands from, if you connected an AI app (the last Disconnect removes it) | `.../opendoc-desktop/integrations-work/` in the data folder | `rmdir "${XDG_DATA_HOME:-$HOME/.local/share}/opendoc-desktop/integrations-work"` |
| The data folder itself, once it is empty | `${XDG_DATA_HOME:-$HOME/.local/share}/opendoc-desktop/` | `rmdir "${XDG_DATA_HOME:-$HOME/.local/share}/opendoc-desktop"` |
| Downloaded updates (the installer the updater fetched, under `pending/`). Only an app that updates itself has this. | `${XDG_CACHE_HOME:-$HOME/.cache}/opendoc-desktop-updater/`; `~/Library/Caches/opendoc-desktop-updater/` | `rm -rf "${XDG_CACHE_HOME:-$HOME/.cache}/opendoc-desktop-updater"` |
| The `opendoc` command an AppImage or a Mac wrote itself (a shell script). A package install has none: its `/usr/bin/opendoc` went with the package. | `~/.local/bin/opendoc` (AppImage; the app creates `~/.local/bin` itself if it was missing, and leaves that folder after removing the script); `/usr/local/bin/opendoc` or `~/.local/bin/opendoc` (macOS) | Only if it is ours: `grep -q 'opendoc-desktop agent command' ~/.local/bin/opendoc && rm ~/.local/bin/opendoc`. A file without those words is somebody else's: leave it. |
| Node's compile cache, written by the processes that run on the app's executable as Node (the CLI, the service host, render workers). Shared by name, so it is the same folder for any user of the machine who ran them. | `/tmp/node-compile-cache/` (Linux; `$TMPDIR/node-compile-cache` on macOS) | `rm -rf /tmp/node-compile-cache` (a reboot also clears it where `/tmp` is a memory disk) |
| The deb's compiled AppArmor profile cache. `apt remove` and `apt purge` unload and delete `/etc/apparmor.d/opendoc-desktop`, but the cache `apparmor_parser` wrote stays. It is root-owned, so removing it needs root. Only on distributions with AppArmor (Debian, Ubuntu). | `/var/cache/apparmor/<hash>/opendoc-desktop`, where `<hash>` is a folder named by the system | As root: `find /var/cache/apparmor -name opendoc-desktop -type f` to see it, then delete what that lists (`sudo find /var/cache/apparmor -name opendoc-desktop -type f -delete`). Harmless if left. |
| The dpkg record of a removed deb: after `apt remove`, `dpkg -l opendoc-desktop` shows state `rc` (removed, configuration records kept) until you purge. | dpkg's database | `sudo apt purge opendoc-desktop` (it removes no files of yours; the package has no configuration files) |
| The AI integration, if you did not undo it in step 1 | Claude Code: each config folder you connected (`~/.claude`, a `~/.claude-<name>` folder, or `$CLAUDE_CONFIG_DIR`), the marketplace `opendoc` and plugin `opendoc@opendoc`. Codex: `$CODEX_HOME` (default `~/.codex`), the same names. Antigravity: `~/.gemini/config/plugins/opendoc/`. Cursor: `~/.cursor/skills/opendoc/`. Copilot CLI: `~/.copilot/skills/opendoc/`. | The "Undo by hand" list in [AI apps](#ai-apps). Once the app is gone, the `claude` and `codex` commands still work; run the first four lines of that list. |
| Per workspace, see below | Inside each workspace folder | See below |

The same on Linux, in one block (it keeps your backups; add the last line when you are sure):

```sh
rm -rf "${XDG_CONFIG_HOME:-$HOME/.config}/opendoc-desktop"
rm -rf "${XDG_DATA_HOME:-$HOME/.local/share}/opendoc-desktop/runtime" "${XDG_DATA_HOME:-$HOME/.local/share}/opendoc-desktop/integrations" "${XDG_DATA_HOME:-$HOME/.local/share}/opendoc-desktop/integrations-work"
rm -rf "${XDG_CACHE_HOME:-$HOME/.cache}/opendoc-desktop-updater"
grep -q 'opendoc-desktop agent command' ~/.local/bin/opendoc 2>/dev/null && rm ~/.local/bin/opendoc
rmdir "${XDG_DATA_HOME:-$HOME/.local/share}/opendoc-desktop" 2>/dev/null   # works only when backups/ is gone too
# rm -rf "${XDG_DATA_HOME:-$HOME/.local/share}/opendoc-desktop/backups"      # your upgrade backups
rm -rf /tmp/node-compile-cache
sudo apt purge opendoc-desktop          # deb only: ends the dpkg state rc
sudo find /var/cache/apparmor -name opendoc-desktop -type f -delete   # deb only, needs root
```

On a Mac the profile and the data folder are the same folder, `~/Library/Application Support/opendoc-desktop/`, so its `backups/` folder is inside the one you delete for the settings. Move `backups/` out first if you want to keep it.

Other files in your home folder that the app's engine may have made, such as `~/.pki` or `~/.local/share/pki/nssdb` (certificate stores) and graphics shader caches, are shared with other programs. Leave them.

**5. Each workspace you opened.** A workspace is yours; the uninstall never touches it. The app added or changed only these things inside it:

- `node_modules`: a symbolic link to the app's runtime (`/opt/opendoc-desktop/resources/runtime/node_modules` for packages; `.../opendoc-desktop/runtime/current/node_modules` in the data folder for an AppImage). After the uninstall it points at nothing. To go back to plain npm, delete the link and install OpenDoc the usual way, in that workspace: `rm node_modules && npm install` (it needs Node 24 and npm; npm then writes a real `node_modules` and a `package-lock.json`).
- `.opendoc/workspace.json` carries `"managed": true`. Leave it: OpenDoc acts on that flag only when it finds the app's runtime, and otherwise treats the workspace as an npm one.
- `package.json`: the `opendoc` pin may have moved up to the version of the app that opened it. It is never lowered.
- `.opendoc/desktop.json` exists only while the app has the workspace open, and `.opendoc/update.lock` only while a workspace is opening or a command such as `opendoc update` runs. A normal quit leaves neither. If the app was killed, one of them can stay behind, stale and harmless: delete it if the `opendoc` command names it in an error.
- `.opendoc/pack-uploads/` and `.opendoc/locks/`: folders the service makes while it works (it stages uploaded and inspected pack files in the first and keeps lock files for media changes and comments in the second). The app removes them again, when empty, if its session made them in a workspace that had none; one that was there before, or holds a file, stays. They are part of the workspace, not of the app: harmless, and used by `opendoc` itself, so leave them. A `.opendoc/current.json` is the service's record of what you last looked at; it stays too.
- `.claude/skills`, when the workspace has `.agents/skills`: a link to `../.agents/skills`, inside the workspace. It is OpenDoc's own convention. Leave it.

**6. Check that nothing is left.** After removing the items above, this should print only your workspaces and backups (if you kept them), and nothing else of the app's:

```sh
find "${XDG_CONFIG_HOME:-$HOME/.config}" "${XDG_DATA_HOME:-$HOME/.local/share}" "${XDG_CACHE_HOME:-$HOME/.cache}" -maxdepth 2 -iname '*opendoc*' 2>/dev/null
ls -l ~/.local/bin/opendoc /usr/bin/opendoc /usr/bin/opendoc-desktop 2>/dev/null
ls -d /opt/opendoc-desktop /etc/apparmor.d/opendoc-desktop /tmp/node-compile-cache 2>/dev/null
find /var/cache/apparmor -name opendoc-desktop 2>/dev/null
```

On a Mac: `find ~/Library -maxdepth 3 -iname '*opendoc*' 2>/dev/null`.

## For developers

How the app works inside (the main process, how a workspace opens, the files it writes, hardening, the updater and the tests), and how to build, test and release it, is on the [developer page](../desktop/README.md).
