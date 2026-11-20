// The agent apps the module knows. `kind` is how OpenDoc gets in: `plugin` goes through the vendor's own command, and
// `skill-files` copies the plain skill into the one folder that app reads (desktop/integrations/README.md, "One copy per app").
export const apps = [
  { id: 'claude', name: 'Claude Code', command: 'claude', kind: 'plugin', configVariable: 'CLAUDE_CONFIG_DIR', defaultConfigFolder: ['.claude'] },
  { id: 'codex', name: 'Codex', command: 'codex', kind: 'plugin', configVariable: 'CODEX_HOME', defaultConfigFolder: ['.codex'] },
  // Antigravity has no variable for its folder; `agy` follows HOME.
  { id: 'antigravity', name: 'Antigravity', command: 'agy', kind: 'plugin', configVariable: null, defaultConfigFolder: ['.gemini'] },
  { id: 'cursor', name: 'Cursor', command: 'cursor-agent', kind: 'skill-files', configVariable: null, defaultConfigFolder: ['.cursor'], skillFolder: ['.cursor', 'skills', 'opendoc'] },
  { id: 'copilot', name: 'Copilot CLI', command: 'copilot', kind: 'skill-files', configVariable: null, defaultConfigFolder: ['.copilot'], skillFolder: ['.copilot', 'skills', 'opendoc'] },
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
