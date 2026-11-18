---
name: opendoc
description: Find the user's OpenDoc workspace and drive it with the `opendoc` command. Use for any request to create, write, revise, review, comment on, organize or export a document, report, letter, proposal, presentation, slide deck, PDF or PowerPoint with OpenDoc, or whenever the user mentions OpenDoc, from any folder.
---

This skill only locates the user's OpenDoc workspace and points you at the guidance that ships with it. It holds no authoring instructions of its own: the workspace's installed skills are version-matched to its OpenDoc runtime, so follow those.

## 1. Find the workspace

The OpenDoc desktop app records the workspace it uses in its config file:

- Linux: `~/.config/opendoc-desktop/config.json`
- macOS: `~/Library/Application Support/opendoc-desktop/config.json`

Read it with a shell command such as `cat`, and take the `defaultWorkspace` key: an absolute folder path. Never edit the file; the app owns it. If the user's request names a different workspace, use that one instead.

Ask the user which workspace to use, and stop until they answer, when:

- the file or the `defaultWorkspace` key is missing (the app has not been set up, or no workspace was chosen yet), or
- the folder does not exist or has no `.opendoc/workspace.json` inside it.

Do not create a workspace, and do not guess one from the current folder.

## 2. Run `opendoc` with that workspace

Every command is `opendoc --workspace <path> <command>`, so it works from any folder. Quote the path. Use `--json` where you need structured output, and `opendoc --help` or `<command> --help` for syntax.

`opendoc` is the command the desktop app installs. If it is not on the `PATH`, tell the user and stop. Do not substitute `npx opendoc`, which would fetch or run a different version than the one the app manages.

## 3. Read the workspace guidance, then follow its skills

1. Read `<workspace>/AGENTS.md` completely. Its table says which skill fits the request.
2. Read the matching skill at `<workspace>/node_modules/opendoc/.agents/skills/<skill-name>/SKILL.md` and follow it. Guide links inside a skill are relative to that skill's own folder.
3. Where those files say `npx opendoc`, run `opendoc --workspace <path>` instead. Everything else they say stays the same, including how to review output and which files to deliver.
4. Never copy these skills out of `node_modules/opendoc`, and never edit anything under it. Author content in the workspace's own folders (`documents/`, `themes/`, `templates/`, `assets/`), using absolute paths under the workspace.

If `<workspace>/node_modules/opendoc` is missing, tell the user the workspace is not fully installed and ask how to proceed.

## 4. When the app has the workspace open

The desktop app may have the workspace open. Authoring, `check`, `review`, `export`, `comments` and `history` commands work regardless. `start`, `update` and `packs install` refuse while the app owns the workspace: that is expected. Tell the user to use the app for those (open the workspace, update the app, Import), and do not try to stop the app or work around the refusal.
