# Agent integrations

Files that let a coding agent find the user's OpenDoc workspace from any folder and drive it with the `opendoc` command. The desktop app installs them into the agent apps it detects (the integration module) and can undo that. Its "Connect your AI apps" window lists the apps at once (nothing on the list runs a vendor command), opens a page for each app that checks that app only and connects it per settings folder, and has an "Other app" page that shows `skills/opendoc` and the `opendoc` command for any other agent. The calls behind it (`overview`, `checkApp`, `connect`, `disconnect`, `status`, `refresh`) are described at the top of `desktop/src/main/integrations/index.mjs`.

```
integrations/
├─ claude/.claude-plugin/marketplace.json      Claude Code marketplace "opendoc"
├─ claude/opendoc/.claude-plugin/plugin.json   Claude Code plugin "opendoc"
├─ claude/opendoc/skills/opendoc/SKILL.md      the router skill
├─ codex/.agents/plugins/marketplace.json      Codex marketplace "opendoc"
├─ codex/opendoc/plugin.json                   Codex plugin "opendoc" (portable manifest)
├─ codex/opendoc/skills/opendoc/SKILL.md       the router skill
├─ skills/opendoc/SKILL.md                     plain copy for apps without a plugin command
└─ check.mjs                                   checks all of the above
```

## The router skill

`SKILL.md` is deliberately thin. It reads `defaultWorkspace` from the app's `config.json` (Linux `${XDG_CONFIG_HOME:-$HOME/.config}/opendoc-desktop/config.json`, which the agent expands in the shell, macOS `~/Library/Application Support/opendoc-desktop/config.json`) and asks the user when there is none. It then tells the agent to run `opendoc --workspace <path>`, read that workspace's `AGENTS.md`, follow the version-matched skills under `<workspace>/node_modules/opendoc/.agents/skills/`, and run `opendoc` wherever those skills say `npx opendoc`. It never copies them.

The skill exists three times (the plugin for each vendor plus the plain copy) because each plugin folder must be self-contained and the app copies the folder as plain files, so symbolic links are not used. `check.mjs` keeps the copies identical: edit one, then copy it over the other two.

## Check

```sh
node desktop/integrations/check.mjs
```

Plain Node (24 or newer), no install step, exit code 1 with a list of problems. It validates the shape of both marketplaces and both plugin manifests (names, relative paths, policy fields, matching versions), the skill's frontmatter, that the three skill copies are byte-identical, and that the folder holds no symbolic links.

The vendors' own validators go further and need the vendor CLI, so they are a manual step, not part of `check.mjs`:

```sh
claude plugin validate --strict desktop/integrations/claude          # the marketplace and its plugin
claude plugin validate desktop/integrations/claude/opendoc           # the plugin alone
agy plugin validate --strict desktop/integrations/codex/opendoc      # Antigravity reads the portable plugin.json
```

Run vendor commands with a scratch `CLAUDE_CONFIG_DIR`, `CODEX_HOME` or `HOME`, never a real configuration folder.

Claude Code can keep its settings in several folders (the `claude` command in a terminal uses `~/.claude` unless `CLAUDE_CONFIG_DIR` is set; the Claude desktop app uses a folder of its own, such as `~/.claude-Work`). A plugin is installed per folder, so run the three Claude Code commands below once for each folder you use, with `CLAUDE_CONFIG_DIR=<folder>` set for that run. The app's window does this for each folder you tick.

## Register from the stable copy

The app copies this folder to its data folder (`~/.local/share/opendoc-desktop/integrations/`) and registers that copy, never a path inside the app bundle or an AppImage mount. With `<copy>` standing for that folder:

```sh
claude plugin marketplace add <copy>/claude
claude plugin install opendoc@opendoc
claude plugin list --json

codex plugin marketplace add <copy>/codex
codex plugin add opendoc@opendoc
codex plugin list

agy plugin install <copy>/codex/opendoc
agy plugin list --json
```

What was observed when refreshing the copy (Claude Code 2.1.327, Codex 0.170.0, Antigravity 1.5.11):

- Claude Code reads a plugin from a local-path marketplace in place (`readFromFolder` in `claude plugin list --json`), so a refreshed copy takes effect at the next session start without reinstalling.
- Codex copies the plugin into its own cache when it is added. Running `codex plugin add opendoc@opendoc` again re-copies it even though the version is unchanged. `codex plugin marketplace upgrade` refuses a local marketplace ("not configured as a Git marketplace").
- Antigravity copies the plugin into `~/.gemini/config/plugins/opendoc` when it is installed, so a refresh means installing again.

## One copy per app

Several apps read the same shared skill folders, so writing a skill into one of them can load it twice in another app. The rule: each app gets exactly one place of its own, and the shared folders `~/.agents/skills`, `~/.claude/skills` and `~/.codex/skills` are never written.

| App | The one place | How | Also reads (so never write there) |
| --- | --- | --- | --- |
| Claude Code | The plugin `opendoc@opendoc`; its skill is `opendoc:opendoc` | `claude plugin marketplace add`, then `claude plugin install` | `~/.claude/skills` (personal skills) |
| Codex | The plugin `opendoc@opendoc` | `codex plugin marketplace add`, then `codex plugin add` | `~/.agents/skills` (user skills) |
| Cursor | `~/.cursor/skills/opendoc/SKILL.md` | Copy `skills/opendoc/SKILL.md` | `~/.agents/skills`, `~/.claude/skills`, `~/.codex/skills` |
| Copilot CLI | `~/.copilot/skills/opendoc/SKILL.md` | Copy `skills/opendoc/SKILL.md` | `~/.agents/skills` |
| Antigravity | The plugin, installed to `~/.gemini/config/plugins/opendoc/` | `agy plugin install <copy>/codex/opendoc` | `~/.gemini/config/skills`, `~/.gemini/antigravity-cli/skills`, `~/.gemini/skills`, and the IDE's legacy `~/.gemini/antigravity/skills` |

Where each place comes from (vendor documentation, read 2026-11-18):

- **Claude Code:** the plugin route is [Create a marketplace](https://code.claude.com/docs/en/plugin-marketplaces) and the [marketplace reference](https://code.claude.com/docs/en/plugins/marketplace-reference.md); personal skills live in `~/.claude/skills/<skill-name>/SKILL.md` and plugin skills in `<plugin>/skills/<skill-name>/SKILL.md` ([Skills](https://code.claude.com/docs/en/skills)). Everything, including plugins, follows `CLAUDE_CONFIG_DIR` ([Environment variables](https://code.claude.com/docs/en/env-vars)). The skills page does not list `~/.agents/skills`.
- **Codex:** plugin layout and the `.agents/plugins/marketplace.json` marketplace are in [Build plugins](https://developers.openai.com/codex/plugins/build); user skills are read from `$HOME/.agents/skills` ([Build skills](https://learn.chatgpt.com/docs/build-skills), where `developers.openai.com/codex/skills` now redirects). Skills inside a plugin are loaded from the plugin, not from those folders.
- **Cursor:** skills load from `.agents/skills/` and `.cursor/skills/` in a project and from `~/.agents/skills/` and `~/.cursor/skills/` for the user, and "for compatibility" also from the Claude and Codex folders (`.claude/skills/`, `.codex/skills/`, `~/.claude/skills/`, `~/.codex/skills/`) ([Skills](https://cursor.com/docs/context/skills)). The dedicated `~/.cursor/skills` is the only place that no other app reads. Cursor's CLI is `cursor-agent`; nothing here runs it.
- **Copilot CLI:** personal skills go in `~/.copilot/skills` or `~/.agents/skills` ([Adding agent skills for GitHub Copilot CLI](https://docs.github.com/en/copilot/how-tos/copilot-cli/customize-copilot/add-skills), [About agent skills](https://docs.github.com/en/copilot/concepts/agents/about-agent-skills)). The pages say supported locations depend on the surface; `~/.copilot/skills` is the dedicated one. Nothing here runs `copilot`.
- **Antigravity:** global skills are `~/.gemini/config/skills/<skill-folder>/`, and the CLI also loads plugin skills from `~/.gemini/config/plugins/<plugin-folder>/skills/` ([Skills](https://antigravity.google/docs/skills)); `agy plugin install <path>` and `agy plugin validate` are in [Plugins](https://antigravity.google/docs/plugins). Neither `~/.agents/skills` nor `~/.claude/skills` is a global location. The docs list the plugin folder only under the CLI. A user of the Antigravity App or IDE instead copies `skills/opendoc/SKILL.md` to `~/.gemini/config/skills/opendoc/SKILL.md`; never both.

Two notes. Cursor and Copilot CLI use the plain copy, so for them the integration is a file copy that the app records in its manifest and removes on undo. Claude Code and Codex honour `CLAUDE_CONFIG_DIR` and `CODEX_HOME` respectively, so those are read from the user's login shell before registering.
