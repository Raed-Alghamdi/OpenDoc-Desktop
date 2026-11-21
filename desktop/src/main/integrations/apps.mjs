// The agent apps the module knows. `kind` is how OpenDoc gets in: `plugin` goes through the vendor's own command, and
// `skill-files` copies the plain skill into the one folder that app reads (desktop/integrations/README.md, "One copy per app").
// `website` is where a person gets the app (plain text for the screen). `multiFolder` marks an app that may keep its settings in
// several folders at once (targets.mjs): besides the default folder it lists the folders named `<prefix>*` in the home folder that
// hold one of the `markers` Claude Code writes, and the folder `configVariable` names. Every folder is a connect target of its own.
export const apps = [
  {
    id: 'claude', name: 'Claude Code', command: 'claude', kind: 'plugin', configVariable: 'CLAUDE_CONFIG_DIR', defaultConfigFolder: ['.claude'], website: 'claude.com/claude-code',
    multiFolder: {
      prefix: '.claude-',
      // What Claude Code writes into a settings folder. A plain file or an empty folder with the prefix is not one.
      markers: { files: ['settings.json', 'settings.local.json', '.claude.json', '.credentials.json', 'CLAUDE.md', 'history.jsonl'], folders: ['projects', 'plugins', 'commands', 'agents', 'skills', 'todos', 'shell-snapshots'] },
    },
  },
  { id: 'codex', name: 'Codex', command: 'codex', kind: 'plugin', configVariable: 'CODEX_HOME', defaultConfigFolder: ['.codex'], website: 'developers.openai.com/codex' },
  // Antigravity has no variable for its folder; `agy` follows HOME.
  { id: 'antigravity', name: 'Antigravity', command: 'agy', kind: 'plugin', configVariable: null, defaultConfigFolder: ['.gemini'], website: 'antigravity.google' },
  { id: 'cursor', name: 'Cursor', command: 'cursor-agent', kind: 'skill-files', configVariable: null, defaultConfigFolder: ['.cursor'], skillFolder: ['.cursor', 'skills', 'opendoc'], website: 'cursor.com' },
  { id: 'copilot', name: 'Copilot CLI', command: 'copilot', kind: 'skill-files', configVariable: null, defaultConfigFolder: ['.copilot'], skillFolder: ['.copilot', 'skills', 'opendoc'], website: 'github.com/features/copilot/cli' },
];

export const appIds = apps.map(app => app.id);
export const appById = id => apps.find(app => app.id === id) ?? null;

/** The shell variables the module reads from the user's login shell. */
export const loginVariables = ['PATH', ...apps.map(app => app.configVariable).filter(Boolean)];

// What the integration files must contain; the copy step refuses a source that lacks any of them (a packaging step that drops
// dot folders would otherwise install a marketplace that cannot be read).
export const requiredFiles = [
  'claude/.claude-plugin/marketplace.json',
  'claude/opendoc/.claude-plugin/plugin.json',
  'claude/opendoc/skills/opendoc/SKILL.md',
  'codex/.agents/plugins/marketplace.json',
  'codex/opendoc/plugin.json',
  'codex/opendoc/skills/opendoc/SKILL.md',
  'skills/opendoc/SKILL.md',
];

export const pluginName = 'opendoc';
export const marketplaceName = 'opendoc';
export const pluginId = `${pluginName}@${marketplaceName}`;
