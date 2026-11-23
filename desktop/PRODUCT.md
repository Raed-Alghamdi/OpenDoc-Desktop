# Product

<!-- impeccable:product-schema 1 -->

## Platform

web

## Users

People who write and review documents (reports, letters, proposals, slide decks, PDFs) together with an AI agent such as Claude Code or Codex. They want OpenDoc as an installed app on Linux (x86_64) or an Apple Silicon Mac, with no Node, no npm and no browser tab. The agent writes and revises through the `opendoc` command; the person reads, comments and exports in the window.

## Product Purpose

OpenDoc Desktop packages [OpenDoc](https://github.com/RyanYahya/OpenDoc), an open-source document workspace where people and agents write documents in TSX, render them, review them with comments and export them, as one self-contained desktop app. Success means a person installs one file, opens a workspace, and the whole loop (write, render, comment, revise, export) works with nothing else installed, while the app keeps itself up to date.

## Positioning

OpenDoc's write, review, comment and export loop as one installed app. It carries its own runtime, opens no network port, leaves nothing running when it closes, and gives agents the same `opendoc` command beside the open window: with the app open, the command works on the workspace files directly and the window refreshes from its file watcher.

## Operating Context

- One window and one workspace at a time; opening another workspace closes the current one.
- The agent runs in a terminal or an AI app and drives the workspace with `opendoc` commands while the person reviews in the window. Connect AI Apps (in the Help menu; the app menu on macOS) installs a thin router skill and plugins through each AI app's own command line (no MCP server).
- Theme and template packs (`.opendoc.zip`) are exported and imported from the galleries. Opening a pack from the file manager opens the Import dialog, which shows previews and conflicts and asks for an explicit step when a pack contains code.
- A comment can cover several places at once (Shift or Ctrl-click, or a Shift-drag box), with a marker and anchor status for each place.
- Installers: AppImage, deb, rpm and pacman on Linux (an AUR package later), dmg and zip on Apple Silicon. Each install type updates the way its platform expects, and release files are signed.
- A workspace pinned to a newer OpenDoc opens read-only with a prompt to update the app. A workspace on an older minor version gets one Upgrade dialog, with a backup first.

## Capabilities and Constraints

- Electron app. The window loads OpenDoc's own web UI from `app://opendoc/`, and the main process carries each request to OpenDoc's service over IPC, so no port is opened anywhere. The desktop package adds its own windows and dialogs (workspace choice, Connect AI Apps, About, update prompts) around that UI.
- Versions follow OpenDoc's exactly. Builds of one version differ only by a build number; release tags are `desktop-v<version>-<build>`.
- Platforms: Linux x86_64 and macOS on Apple Silicon. There is no Intel Mac build and no Windows build.
- The macOS build is signed ad hoc and not notarized, so its first launch needs "Open Anyway".
- OpenDoc's authoring API (`opendoc`, `opendoc/themes`, `opendoc/template`, `opendoc/assets`) does not change.
- Names: the app shows itself as "OpenDoc Desktop"; files, folders, the process and the package are `opendoc-desktop`; the agent command is `opendoc`; the app ID is `io.github.ryanyahya.OpenDocDesktop`.
- Undecided: whether the release configuration (update feed, publish target, package maintainer) moves to the original OpenDoc repository at the handover, and whether packs get a "replace" mode.

## Brand Commitments

- The app is shown as OpenDoc Desktop. The README, About and the release notes credit and link the original OpenDoc project.
- The desktop screens follow OpenDoc's existing black-and-white look and UI rather than a separate identity, so every feature can be reviewed and merged upstream on its own.
- The app icon (a page with the O, `desktop/resources/icons/`) is drawn in the style of OpenDoc's black-and-white wordmark, since OpenDoc has only a wordmark. The OpenDoc maintainer may adjust or replace it.

## Evidence on Hand

- User guide: `docs/DESKTOP.md`. Build, test and release: `desktop/README.md`. Icons and marks: `desktop/resources/icons/`.
- Releases are published on this repository's releases page; the first is `desktop-v0.6.1-1`.
- There are no testimonials, user numbers, reviews or press. Do not invent them.

## Product Principles

1. Nothing beyond the app: no Node, no npm, no browser, no port, and nothing left running after it closes.
2. Agents are first-class: everything the window does has an `opendoc` command, and the command works beside the open app.
3. Upstream first: every change stays reviewable and mergeable into OpenDoc on its own, in OpenDoc's style and look.
4. Safe by default: pack code needs an explicit step, updates are checked before they install, and a workspace is never silently moved to another version.
