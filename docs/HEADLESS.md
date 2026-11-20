# OpenDoc Headless

OpenDoc Headless is the complete document-production workflow for agents running remotely. Ask the agent for a report, presentation, theme, or template; it authors, renders, reviews, and revises the work, then returns the finished files. The recipient opens the PDF or PowerPoint on any device and does not need OpenDoc installed.

Both editions come from the same open-source repository, use the same version and rendering implementation, and include the full starter library: editable templates, themes, fonts, and welcome examples. Headless omits the browser interface and its service dependencies. It has no embedded AI, hosted service, or messaging connector. The host agent supplies the model, task context, filesystem access, and delivery channel.

## Install in the agent's environment

Requires Node.js 24 or newer and npm on macOS or Linux. Run:

```sh
npx --yes @ryanyahya/opendoc-headless init ./workspace --json
cd ./workspace
npx opendoc --help
```

Supply a new or empty destination. Headless initialization is noninteractive and never opens a browser or starts a service. It installs an exact version, copies the full editable starter library, and writes the workspace's project records and versioned agent-guide pointers. Installation and updates need network access; rendering local content does not.

Run subsequent commands from the initialized workspace or one of its subfolders. Use `--workspace /absolute/path/to/workspace` to target it from elsewhere. The `.opendoc/workspace.json` marker records `edition: "headless"`. Its package dependency uses an npm alias, for example:

```json
{
  "dependencies": {
    "opendoc": "npm:@ryanyahya/opendoc-headless@<version>"
  }
}
```

Normal OpenDoc similarly aliases `opendoc` to `npm:@ryanyahya/opendoc@<version>`. These aliases keep `npx opendoc`, `node_modules/opendoc/`, and authoring imports such as `opendoc/assets` identical in both editions. Do not add the normal package to obtain document components. Edit the workspace's `documents/`, `themes/`, `templates/`, and `assets/`; installed package files are application code and versioned guidance.

The agent may retain this workspace for later requests or create a disposable one for a single job. A command exits after its work; no persistent OpenDoc process is required. Retain the source and resources before discarding a workspace when future revisions or reusable designs are part of the request.

## Agent setup

Give your agent [the README](../README.md#installation) and the brief. It can install dependencies in its own execution environment, initialize Headless, read the new workspace's `AGENTS.md`, and complete the work. Reuse an existing workspace for revisions or recurring work. A shell command changing directories does not necessarily refresh the host's instructions, so read the guide explicitly after installation.

| Agent | Shared setup |
| --- | --- |
| Codex | Start in the workspace; use `AGENTS.md` and `.agents/skills/`. |
| Claude Code | `CLAUDE.md` imports `@AGENTS.md`; `.claude/skills` links to the shared `.agents/skills` directory. |
| Cursor, including Cloud Agents | Use the same `AGENTS.md` and `.agents/skills/`. Keep these files in the environment where the agent runs; a local skill installation alone does not make it available remotely. |
| Hermes | Read the workspace guide directly. If using native skill discovery, use Hermes's supported project trust or profile registration; registration is optional for following the guide. |
| Grok Bot | Give the Bot this setup and production workflow on its cloud computer. It can follow the guide directly or save the workflow as a skill through its Cursor-compatible skill/plugin support. |
| Other agents | Read `AGENTS.md` and the matching linked skill, then use the CLI. |

These are shared files and documented setup paths; no agent-specific plugin is required. The host needs file access, terminal execution, a way to inspect page images, and a way to return files. Use the host's existing tools for those steps. No particular model or tool-call name is required.

For workspaces created by an older release, add `@AGENTS.md` to `CLAUDE.md` if it is missing, preserving any existing instructions. Where `.claude/skills` does not already exist, create a relative directory link to `../.agents/skills`. If it already contains skills, preserve them and expose only the missing OpenDoc skills. Runtime updates deliberately preserve workspace instructions rather than replacing user edits. Any agent can also read `node_modules/opendoc/AGENTS.md` and its linked skills directly.

On shared remote machines, use an explicit workspace and project/document IDs for each task, and coordinate changes to the same document. Return the actual final files to the user through the host's attachment or download mechanism; a path inside a remote machine is not sufficient.

## Author, inspect, revise, deliver

Follow [AGENTS.md](../AGENTS.md) and its matching skills. All shared writing, design, provenance, stable-identity, media, font, and export rules apply. Resolve document and project IDs from the request and workspace catalogs; an old `.opendoc/current.json` is not current remote task context. Do not start the browser to resolve a target.

For example, discover the available designs and create a project and document:

```sh
npx opendoc themes list --json
npx opendoc templates list --json
npx opendoc projects create client-work --name "Client work" --theme neutral --json
npx opendoc create my-report --project client-work --title "Project report" --json
```

Honor the user's design choices; when choosing is delegated, use judgment. An existing project can be reused. Creation makes a scaffold, project membership, `theme.tsx`, and exact `assets.json` bindings. The agent then writes the actual report in `documents/my-report/index.tsx` using the [authoring API](AUTHORING.md). A scaffold is not a finished deliverable.

After authoring:

```sh
npx opendoc check --json
npx opendoc review my-report --json
```

`check` typechecks workspace source. `review` renders fresh saved source and produces the PDF, readable page PNGs, extracted page text, and a `review.json` manifest. For documents and presentations these live under `output/reviews/documents/<id>/`; theme and template specimens use `output/reviews/themes/<id>/` and `output/reviews/templates/<id>/`. Use the returned paths instead of guessing filenames. The same command works in normal OpenDoc; save intended browser text corrections before reviewing saved source there.

The result identifies the exact PDF hash, output paths, page count and dimensions, page images/text, render issues, and stable block/source information. `status: "ready"` and exit code 0 mean the review artifacts were prepared and technical render/layout checks passed. **They do not mean visual or factual review is complete.** The manifest keeps `visualReview` and `factualReview` as `"required"`.

Each page also includes `elements` for diagnosing placement: rendered bounds, parent bounds, local offsets, clipping ancestors, line counts, and block/source identity. See [layout diagnostics](AUTHORING.md) for explicit label line limits and keep-together controls. Presentation styling limitations appear in `issues` with `format: "pptx"`; the PDF can still be reviewed even when editable export needs corrections.

After a revision, `changes.changedPages` lists pages whose rendered PNG or extracted text differs from the preceding successful review. `changes.removedPages` identifies removed trailing pages; `previousHash` identifies that prior PDF. The first review, or an older manifest without page hashes, marks every page changed. Comparison is by page position, so inserting a page can mark subsequent pages changed. This helps focus a repeat review; it neither records human approval nor compares PDF with native PowerPoint rendering.

### Prepare the complete delivery set in one command

```sh
npx opendoc review my-report --export --json
npx opendoc review project-deck --export --json
```

`--export` typechecks the workspace, renders the selected document once, prepares page images and text, and publishes the PDF plus editable PPTX for presentations as one review set. Use `outputs.pdf` and, when present, `outputs.pptx` for delivery after inspection. These files live in the review directory; this command does not create the separate `output/<id>.pdf` exports or browser export-history receipts. It works on saved source in both editions and does not use a browser session. Theme/template specimens use ordinary `review` without `--export`.

If typechecking, layout, PPTX preparation, or source-freshness checks fail, the command exits unsuccessfully and retains the previous set. Use ordinary `review` to inspect a valid PDF while fixing PPTX-only limitations. `powerpointVisualReview: "required"` explicitly records that creating an editable deck does not verify its appearance in native PowerPoint. Subsequent ordinary review replaces the set with PDF review artifacts only, so use `--export` again after the final revision when both formats are needed.

The agent must inspect every page image at a readable scale, examine representative extracted text, and check the content against the brief and sources. Fix clipping, missing glyphs, awkward breaks, bad crops, incorrect claims, and other material defects. A character that no font covers prints as `?` and appears in `issues` as `missing-glyphs`; Arabic text needs no font setup ([Authoring](AUTHORING.md#arabic-and-right-to-left-text)). After changing source, regenerate the review artifacts and inspect affected pages and adjacent breaks. The [review skill](../.agents/skills/opendoc-review-document/SKILL.md) defines the full pass. If the agent cannot inspect images, report that concrete limitation; generating PNGs is not visual inspection.

Headless keeps the same [version history](HISTORY.md) as normal OpenDoc in `documents/<id>/.history/`. With no file watcher, `create`, `check`, `review`, `export`, `comments`, `documents`, and `history` record each document's changed source as an Agent change before they run, so running `check` after each round of edits gives every round its own version. Use `npx opendoc history list|show|block <id>` to find earlier wording and `history restore` to bring it back.

Render and source-freshness failures return a nonzero exit status and structured diagnostics when available. They leave the previous successful review files intact, so those files must not be represented as the failed revision's output. Inspect the current command result before using an existing path.

When the final revision is ready:

```sh
npx opendoc export my-report --json
```

This writes `output/my-report.pdf`. Export renders fresh in Headless, independently of any browser session or stale server state. Keep source unchanged between final review and export, and use the exported file for delivery.

Each export is kept in the document's export history:

```sh
npx opendoc export history list my-report
npx opendoc export history reveal <export-id>
npx opendoc export history delete <export-id>
npx opendoc export history restore <export-id>
```

`list` shows the newest first and marks an entry unavailable when its file was moved, removed, or changed outside OpenDoc. `reveal` prints the file's path; add `--open` to also show it in the system file manager. `delete` removes the receipt and the output file when the file is untouched, and prints the `restore` command that undoes it.

## Presentations

Create a slide scaffold with `--format presentation`, or use a presentation template whose format is inferred:

```sh
npx opendoc create project-deck --project client-work --title "Project update" --format presentation --json
```

Author `Presentation` and explicit `Slide` components, preserving one 960 × 540 PDF page per slide. Complete the same check/review/revise cycle, then export both formats from the same final source:

```sh
npx opendoc export project-deck --json
npx opendoc export project-deck --format pptx --json
```

Deliver both `output/project-deck.pdf` and `output/project-deck.pptx` unless the user requests a single format. Review the PDF even for a PowerPoint-only request because it supplies the layout used for export. Follow [PowerPoint delivery](AUTHORING.md#powerpoint-delivery) for supported effects, editable objects, font embedding, package/content checks, and native inspection when available.

A remote environment need not have Microsoft PowerPoint installed. Complete available PDF and PPTX package/content checks and state when native PowerPoint appearance was not verified; that limitation alone does not prevent delivery of a valid requested file. A failed PPTX export is a separate incomplete format and must be reported and corrected within scope.

## Manage documents

Headless has no library menu; use the same commands for document lifecycle and grouping:

```sh
npx opendoc documents list --json
npx opendoc documents show my-report --json
npx opendoc documents rename my-report "Quarterly report"
npx opendoc documents duplicate my-report --id my-report-q3 --title "Q3 report" --json
npx opendoc documents delete my-report-q3
npx opendoc documents trash --json
npx opendoc documents restore my-report-q3
npx opendoc projects assign my-report client-work
```

`list` prints one line per document (`--json` prints an array): its `id`, `title` (the name given in OpenDoc, else the title the source states, else the ID), `path`, `format`, `projectId` and `project`, `type`, custom `tags`, `documentStatus`, `language` and `updatedAt` (when its source files last changed; comments don't count). `show <id>` adds `meta` (the `title`, `description` and `kind` the source states as plain text), the source `files` the document is built from (index, theme, data, and the like, with size and time) and its `media`. Both read the saved files and never render, so they are quick and run no authored code: a title the source computes shows as `authoredTitle: null` until you `review` the document, and the app's render state (`status`, `revision`, the page list) is not part of the answer. They work beside the app and the browser service, and in a read-only workspace.

`delete` moves the document to Trash with its history, comments, tags, and status, and prints its restore command; `restore` takes that restore ID, or the document ID when Trash holds one copy. A duplicate starts its own history and has no status. [Projects](PROJECTS.md#commands) describes each command.

## Edit a media item's details

`media edit` changes the details the app's media editor changes: a media item's title, description, kind, alt text, attribution and sources, through the same code as the app, so the media browser shows the change at once:

```sh
npx opendoc media edit my-report harbour --title "Harbour at dawn" --alt "Fishing boats at dawn"
npx opendoc media edit my-report harbour --source "Field notes" --source "https://example.com/survey" --json
npx opendoc media edit documents/my-report/media/harbour/image.png --clear-alt
```

Name the item by document and media ID, or by the path of its image, `meta.json` or folder (relative to the current folder). A field you don't name keeps its value, and so do `file`, `data` and `recipe`. `--source` replaces the whole list, once per source; `--clear-alt`, `--clear-attribution` and `--clear-sources` remove a field. `--expected-revision <revision>` refuses the edit with code `conflict` when the item changed since you read its `metadataRevision` (from `media list`); without it the edit applies to the record as it is now. The result is `{ documentId, id, metadataRevision, changed, file, meta }`, where `meta` is the saved record. Editing details never records a generated visual as reviewed (`media record` does). Without `--json` the command prints a one-line summary and the new revision. See [Media](MEDIA.md) for the fields.

## Leave and apply feedback

Headless has no reader; comments go through the same `comments` command:

```sh
npx opendoc comments add my-report report-summary "Cite the survey here." --phrase "grew 12%"
npx opendoc comments list my-report --anchors
npx opendoc comments edit my-report <comment-id> "Cite the 2025 survey here."
npx opendoc comments resolve my-report <comment-id>
```

`add` checks the block against a fresh render of saved source. `--phrase` anchors the comment to one occurrence of those words in the block, such as one table cell; add `--target <field-id>` when the words appear in more than one text field. `list --anchors` adds `anchorStatus` (`attached`, `changed`, or `missing`) and `targetAvailable` to each comment, so after a revision the agent can see which feedback still finds its text. `edit` replaces the text of an open or resolved comment and keeps the earlier text in the comment's history; add `--expected-version N` to refuse the edit when the comment has changed since you read its `version`. `delete` keeps the record and prints its `comments restore` command, and `list --deleted` shows comments deleted in the last 90 days. Resolve a comment only after making and verifying the change; [opendoc-apply-comments](../.agents/skills/opendoc-apply-comments/SKILL.md) covers the workflow.

One comment can cover several places. Give the first block as usual and add `--also <block-id>` for each further block, one `--also` per block:

```sh
npx opendoc comments add my-report report-summary "Use the same figure in all three." --also report-findings --also report-table --also-phrase "12%"
```

An `--also-phrase "exact words"` (and an `--also-target <field-id>`, needed only when the words appear in more than one text field) belongs to the `--also` just before it. `list --anchors` shows each place under `targets`, and the comment's own `anchorStatus` is the worst of them. `--also-phrase` is refused while the browser edition's service is running (run `npx opendoc stop` first); with opendoc-desktop open, or with nothing running, it works. While the service runs, `--also` takes whole blocks only.

## Create themes and templates remotely

Use [opendoc-create-theme](../.agents/skills/opendoc-create-theme/SKILL.md) or [opendoc-create-template](../.agents/skills/opendoc-create-template/SKILL.md). Author the reusable bundle in its workspace catalog, then inspect its real specimen without a browser:

```sh
npx opendoc review --theme my-theme --json
npx opendoc review --template my-template --json
```

Each produces the same page-image, text, PDF, and manifest evidence as a document review. Specimens stay outside the document library and need no project membership. The lighter `themes check <id>` and `templates check <id>` commands validate and render without exporting a specimen. `themes preview <id>` writes `output/themes/<id>.pdf`; `templates preview <id>` writes `output/templates/<id>.pdf`.

Verify catalog discovery with `themes inspect <id>` or `templates inspect <id>`, inspect every specimen page, and exercise representative content and affected instances as required by the skill. Keep the completed theme or template in the remote workspace for reuse. Return its reviewed specimen PDF to show the design. If the user requests a portable bundle, include its source, guide, specimen source, and required local dependencies/assets with their licenses; a specimen PDF alone is not a reusable theme or template.

## Deliver through the host agent

OpenDoc produces files and machine-readable results. The agent sends the requested artifacts through its existing attachment, download, or storage capabilities, within the user's requested destination and scope. For example, a messaging agent may attach the PDF to its current conversation; another agent may expose a downloadable file.

Return accessible artifacts, not a remote-only filesystem path the recipient cannot open. Do not send internal review manifests, source material, or unrelated workspace files unless requested. Keep the final response focused on the deliverables and any concrete unresolved limits. The recipient should never need to install OpenDoc, start its GUI, or repeat the agent's review to complete the requested production workflow.

## Command line reference

Every command accepts `--json` for a structured result and `--workspace <folder>` to choose the workspace. `<command> --help` prints that command's usage, and `--help --json` prints `{ "usage": "..." }`.

### Machine-readable help

`npx opendoc help --json` prints the whole catalogue, built from the same list that the argument parsers are tested against:

```json
{ "version": "...", "edition": "headless", "commands": [{ "path": ["comments", "add"], "summary": "...", "args": [{ "name": "doc", "required": true, "repeatable": false }], "options": [{ "name": "phrase", "type": "string", "repeatable": false, "required": false, "description": "..." }], "json": true }], "globalOptions": [{ "name": "json", "...": "..." }, { "name": "workspace", "...": "..." }] }
```

An agent can read it instead of parsing usage text. `edition` says which commands exist: `start`, `status`, `stop` and `context` are listed only in normal OpenDoc. `npx opendoc --version --json` prints `{ "version": "..." }`, and adds `build: { build, commit, builtAt }` when the runtime is the desktop app's, which records its build.

### Failures and exit codes

A failed command with `--json` prints one object on standard output (the text of the error also goes to standard error):

```json
{ "ok": false, "error": "No OpenDoc workspace found ...", "code": "no-workspace" }
```

`error` is the message for people; `code` is stable, so match on it rather than on the wording. Exit status 2 means a usage error (code `usage`: an unknown command or option, a missing argument); every other failure exits 1. A document that fails to render in `review` or `export` is reported as `status: "error"` in the result instead. A failure that fits no other code has code `failed`.

| Code | Meaning |
| --- | --- |
| `usage` | The command line is wrong. Exit status 2. |
| `unsupported-runtime` | This Node.js version cannot run OpenDoc. |
| `unsupported-edition` | The command does not exist in this edition, such as `start` in Headless. |
| `no-workspace` | No workspace was found from the current folder or `--workspace`. |
| `workspace-invalid` | The folder is not an initialized workspace, or its marker, format or edition is not supported. |
| `installation-invalid` | The workspace's installed OpenDoc is missing or does not match its pin. |
| `workspace-locked` | Another OpenDoc command holds the workspace, or its lock is unreadable. |
| `desktop-owns-workspace` | opendoc-desktop has the workspace open and the command needs it closed. |
| `service-running` | The browser edition's service is running and the command needs it stopped. |
| `service-unavailable` | The recorded service did not answer. |
| `owner-shutting-down` | The previous OpenDoc session is still finishing its shutdown. |
| `workspace-read-only` | The workspace is read-only and the command writes. The message says why. |
| `owner-unconfirmed` | A session record (`.opendoc/server.json` or `desktop.json`) is unreadable, or its owner could not be confirmed. |
| `timeout` | The command waited for something that did not happen in time. |
| `invalid-record` | A workspace file the command reads, such as `.opendoc/current.json`, is not valid. |
| `not-found` | A document, comment, version, theme, template, asset, export or file does not exist. |
| `conflict` | The item changed since it was read, or it already exists. |
| `invalid-input` | A value was refused: a bad ID, a bad option value, a refused change. |
| `restore-refused` | A history restore was refused because it would lose work or does not apply. |
| `document-changed` | The source changed while the command was working, so nothing was published. |
| `render-failed` | A document, theme or template did not render; `issues` lists what is wrong. |
| `typecheck-failed` | The workspace did not typecheck. |
| `already-exists` | The thing to create already exists. |
| `unsafe-path` | A location is not a regular workspace folder, so nothing was written. |
| `permission-denied` | The operating system refused access to a file or folder. |
| `failed` | Any other failure. |

### Commands for normal OpenDoc

Normal OpenDoc has four commands that Headless does not, because they concern an app or a service, and `init` takes two more options:

```sh
npx --yes @ryanyahya/opendoc init ./workspace --no-start
npx opendoc status --json
npx opendoc stop
npx opendoc context --json
```

- `init [folder] --no-start` creates the workspace and stops there, without starting OpenDoc or a browser; `--no-open` starts OpenDoc without opening a browser. Without a folder, `init` asks for one at a terminal and refuses when input is not interactive.
- `status` reports who has the workspace open: `{ "running": true, "mode": "service", "pid": 1234, "origin": "http://127.0.0.1:4310" }` for the browser edition, `{ "running": true, "mode": "desktop", "pid": 1234 }` for opendoc-desktop, and `{ "running": false, "mode": null }` when nothing does.
- `stop` stops the service that `opendoc start` began. It refuses for opendoc-desktop (`desktop-owns-workspace`: close the app instead), and reports that nothing is running when that is so.
- `context` prints what the app last recorded in `.opendoc/current.json`: the open document, the selection, unsaved text edits and pending comments, with `stale: true` when nothing has the workspace open or the document has moved on since. The plain-text form names only the document, the active block and the first selection's quote; `--json` prints the whole record, including every place of a multi-place selection in `selections`. It fails with `not-found` before the app has written a record.

### While opendoc-desktop or the browser service has the workspace open

Commands that only read, or that write the workspace's own files (`create`, `documents`, `media edit`, `tags`, `check` and the like), work in every state: the app's file watcher picks the changes up. These behave differently depending on who has the workspace open:

| Command | Nothing running (and Headless) | Browser service running | opendoc-desktop open |
| --- | --- | --- | --- |
| `comments add` | Renders the saved source and writes the comment | Posts to the service, which checks its live preview; `--also-phrase` is refused | Works directly, as with nothing running; the app refreshes its window |
| `export` | Renders fresh and writes `output/` | Exports the service's ready preview | Works directly with its own render |
| History recorded by other commands | Recorded before the command runs | Skipped; the service's watcher records it | Skipped; the app records it |
| `history restore` | Restores | Refuses while `.opendoc/current.json` shows unsaved text edits in that document | The same refusal, using the record the app writes |
| `packs install` | Installs | Refuses: stop OpenDoc first | Refuses: use Import in the app, or close it |
| `update` (one that would install) | Installs | Refuses until the service is stopped | Refuses: update the app instead |
| `update --check` | Reports the available versions | Reports them | Reports them; in a workspace the app manages (see Update) it says so instead |
| `start` | Starts the service | Reuses the running service | Refuses: the workspace is open in opendoc-desktop |
| `stop` | Reports that nothing is running | Stops the service | Refuses: close opendoc-desktop |
| `status` | `running: false` | `mode: "service"` | `mode: "desktop"` |
| `review --export` | Works | Works | Works |

Every refusal that names opendoc-desktop ends with the way out of a stale record: if opendoc-desktop is not running, delete `.opendoc/desktop.json` and try again. A record whose process is gone, or is not opendoc-desktop, is ignored on its own.

### Read-only workspaces

opendoc-desktop opens a workspace read-only when a newer version of OpenDoc made it, when you declined its upgrade, or after you restored a backup. In a workspace that the app manages, the command line follows the same rule for a workspace on a newer patch or minor version than the app. A command that writes then fails with code `workspace-read-only` and a message that says why, for example:

```json
{ "ok": false, "error": "This workspace was upgraded by OpenDoc 0.7. Update the app to edit it.", "code": "workspace-read-only" }
```

Commands that read, render or export keep working: every `list`, `inspect`, `show`, `find`, `trash` and `block` subcommand, `check`, `review`, `export` and `export history`, `templates check|preview`, `themes check|preview`, `media check`, `packs export` and `packs inspect`, `create --list`, `update --check`, `context`, `status`, `stop`, `start` and `help`. Every other command, such as `create`, `comments add`, `history restore` and `packs install`, is refused, and so is any command added later until someone decides it is safe. For the reasons `declined-upgrade` and `restored-backup`, only the open app holds the workspace read-only: once it quits, the commands write again.

A workspace made by an older minor version than the app is the app's to upgrade. Commands that open it stop with "This workspace was made with OpenDoc <old> and this app has <new>. Open this workspace in opendoc-desktop to upgrade it." (code `failed`, exit status 1). `--version` still answers.

### Every command

| Command | What it does |
| --- | --- |
| `help` | Print the commands, or with --json the catalogue of every command, its arguments and options. |
| `init [folder]` | Create a workspace and open OpenDoc; `--no-start` stops after creating it and `--no-open` starts without a browser. Headless has `init <folder>`, which creates a workspace without a server. |
| `start [folder]` | Start the workspace's installed runtime and open it in the browser. Normal OpenDoc only. |
| `create [id]` | Create a document or presentation, or list the starters with --list. |
| `projects list` | List projects and their theme defaults. |
| `projects create <id>` | Create a project. |
| `projects update <id>` | Rename a project or change its theme defaults. |
| `projects assign <document-id> <project-id>` | Move a document into a project. |
| `projects delete <project-id>` | Delete an empty project. |
| `documents list` | List every document: title, path, project, type, tags, status, language and when it last changed. Reads the saved files and does not render. |
| `documents show <id>` | Show one document's metadata, the source files it is built from, and its media. |
| `documents rename <id> <title...>` | Change the name OpenDoc shows for a document. |
| `documents duplicate <id>` | Copy a document into a new one with its own history. |
| `documents delete <id>` | Move a document to Trash and print its restore command. |
| `documents trash` | List deleted documents, most recent first. |
| `documents restore <restore-id>` | Restore a document from Trash. |
| `templates list` | List templates. |
| `templates inspect <id>` | Show a template's descriptor, paths and guide. |
| `templates check <id>` | Render a template's preview and report issues. |
| `templates preview <id>` | Write a template's preview PDF. |
| `themes list` | List themes. |
| `themes inspect <id>` | Show a theme's description, palette, paths and guide size. |
| `themes check <id>` | Render a theme's preview and report issues. |
| `themes preview <id>` | Write a theme's preview PDF. |
| `themes folders list` | List theme folders and the themes in them. |
| `themes folders create <name>` | Create a theme folder. |
| `themes folders rename <name> <new-name>` | Rename a theme folder. |
| `themes folders delete <name>` | Delete a theme folder; its themes become unfiled. |
| `themes assign <theme-id> <folder>` | File a theme in a folder, or none to unfile it. |
| `themes tags <theme-id>` | Show or change a theme's tags (kept for scripts; opendoc tags covers every kind). |
| `tags list` | List the types, statuses, languages and custom tags in use, with counts. |
| `tags show <kind> <id>` | Show one item's type, status, language and tags. |
| `tags add <kind> <id> <tag...>` | Add types or custom tags to an item. |
| `tags remove <kind> <id> <tag...>` | Remove tags from an item. |
| `tags set <kind> <id> [tag...]` | Replace an item's tags. |
| `tags status <document-id> [status]` | Show or set a document's status: draft, in-review, final or archived. |
| `tags find [tag...]` | Find documents, presentations, themes and templates by tag, type, status or language. |
| `tags create <custom-tag>` | Create a custom tag. |
| `tags delete <custom-tag>` | Delete a custom tag. |
| `assets list [kind]` | List logos and fonts. |
| `assets inspect <kind> <id>` | Show an asset and its current revision. |
| `assets import logo` | Import a logo from an SVG or PNG file. |
| `assets import font` | Import a font family from TTF or OTF files. |
| `assets revise <kind> <id>` | Change an asset's metadata from a JSON file. |
| `assets add-variation <logo-id>` | Add a variation to a logo. |
| `assets add-faces <font-id>` | Add faces to a font family. |
| `assets archive <kind> <id>` | Archive an asset. |
| `assets restore <kind> <id>` | Restore an archived asset. |
| `assets defaults <theme-id>` | Show or change a theme's default assets. |
| `assets bind <document-id> <slot> <asset-id>` | Bind an asset to a document's logo, body font or heading font. |
| `assets unbind <document-id> <slot>` | Remove a binding from a document. |
| `media list [document]` | List the media of one document, or of every document. |
| `media import <document> <media-id>` | Import an image into a document. |
| `media edit <document> [media-id]` | Change a media item's title, description, kind, alt text, attribution or sources. Name the item by document and media ID, or by the path of its image, meta.json or folder. |
| `media record <document> <media-id>` | Record the generation inputs of reviewed media. |
| `media check <document> <media-id>` | Report whether recorded media is fresh, stale or unrecorded. |
| `comments list <doc>` | List a document's comments. |
| `comments resolve <doc> <comment-id>` | Resolve a comment. |
| `comments reopen <doc> <comment-id>` | Reopen a resolved comment. |
| `comments delete <doc> <comment-id>` | Delete a comment; it stays restorable for 90 days. |
| `comments restore <doc> <comment-id>` | Restore a deleted comment. |
| `comments add <doc> <block-id> <text...>` | Add a comment on a block, or on exact words in it, or on several places. |
| `comments edit <doc> <comment-id> <text...>` | Replace the text of an open or resolved comment. |
| `history list <doc>` | List a document's versions, newest first. |
| `history show <doc> <version>` | Show what a version changed compared with the current source. |
| `history block <doc> <block-id>` | Show one block's earlier versions. |
| `history restore <doc> <version>` | Restore a version, one block, or one section. |
| `packs export` | Export themes and templates as a pack file. |
| `packs inspect <file>` | Inspect a pack without running its code. |
| `packs install <file>` | Check or install a pack's themes and templates. |
| `export [document-id...]` | Export documents as PDF or editable PowerPoint. |
| `export history list <doc>` | List a document's earlier exports, newest first. |
| `export history delete <export-id>` | Delete an earlier export and its file. |
| `export history restore <export-id>` | Undo the deletion of an earlier export. |
| `export history reveal <export-id>` | Print an earlier export's file path. |
| `review [document-id]` | Generate page images, text and review issues for a document, theme or template. |
| `check` | Typecheck workspace documents, themes and templates. |
| `update` | Check for, or explicitly install, a compatible OpenDoc version. |
| `context` | Show what the OpenDoc app has selected. Normal OpenDoc only. |
| `status` | Show whether OpenDoc is running for this workspace. Normal OpenDoc only. |
| `stop` | Stop the OpenDoc service started with opendoc start; it does not stop opendoc-desktop. Normal OpenDoc only. |

## Update

From the workspace:

```sh
npx opendoc update --check --json
npx opendoc update --json
```

Updates stay on `@ryanyahya/opendoc-headless` and pin the selected exact version while preserving authored documents, templates, themes, assets, feedback, and project records. They update the installed application and its guidance together; they do not overwrite local catalogs with newly shipped examples. See the [update rules](../README.md#update-an-existing-workspace) for compatible versions and explicit version selection.

In a workspace the desktop app manages, the app brings the runtime and updates it, so `update` is refused ("Update the app instead") even with the app closed. `update --check` changes nothing and does not ask the npm registry there: it exits 0 and prints that the app manages the workspace's OpenDoc and updates it (Help > Check for Updates..., or the package manager for the AUR build). With `--json` it prints `{ "status": "managed", "managed": true, "currentVersion": "...", "check": true, "explicit": false, "message": "..." }`, with no target or latest versions.

The workspace runs trusted TSX code. Render workers contain crashes and timeouts, not hostile code. The host agent's environment owns its own isolation and access controls; see [Security](../SECURITY.md).
