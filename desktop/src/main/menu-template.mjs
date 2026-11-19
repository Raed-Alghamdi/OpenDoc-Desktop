// The application menu's contents, without Electron so the unit tests can read them.
import { appName, originalProject } from './identity.mjs';
import { basename } from 'node:path';

/**
 * @param actions { open, create, openRecent(path), reveal, showLog, backups, about, installCommand, checkForUpdates, setAutomaticUpdates(checked), restartToUpdate, openExternal(url) }
 * @param state { workspaceOpen: boolean, recent: string[], updates?: { show, automatic, checkEnabled, restartReady, installing } }
 */
export function menuTemplate({ platform = process.platform, actions, state }) {
  const mac = platform === 'darwin';
  const recent = state.recent.length
    ? state.recent.map(path => ({ label: `${basename(path)}  (${path})`, click: () => actions.openRecent(path) }))
    : [{ label: 'No recent workspaces', enabled: false }];
  const about = { label: `About ${appName}`, click: () => actions.about() };
  const updates = updateItems({ actions, state: state.updates });
  return [
    ...(mac ? [{ label: appName, submenu: [about, ...updates, { type: 'separator' }, { label: 'Install Command-Line Tool…', click: () => actions.installCommand() }, { type: 'separator' }, { role: 'hide' }, { role: 'hideOthers' }, { role: 'unhide' }, { type: 'separator' }, { role: 'quit' }] }] : []),
    {
      label: 'File',
      submenu: [
        { label: 'Open Workspace…', accelerator: 'CmdOrCtrl+O', click: () => actions.open() },
        { label: 'New Workspace…', accelerator: 'CmdOrCtrl+Shift+N', click: () => actions.create() },
        { label: 'Open Recent', submenu: recent },
        { type: 'separator' },
        { label: 'Reveal Workspace', enabled: state.workspaceOpen, click: () => actions.reveal() },
        { label: 'Workspace Backups…', click: () => actions.backups() },
        { label: 'Show Log', click: () => actions.showLog() },
        ...(mac ? [] : [{ type: 'separator' }, { role: 'quit' }]),
      ],
    },
    { label: 'Edit', submenu: [{ role: 'undo' }, { role: 'redo' }, { type: 'separator' }, { role: 'cut' }, { role: 'copy' }, { role: 'paste' }, { role: 'selectAll' }] },
    { label: 'View', submenu: [{ role: 'resetZoom' }, { role: 'zoomIn' }, { role: 'zoomOut' }, { type: 'separator' }, { role: 'togglefullscreen' }] },
    { label: 'Window', submenu: [{ role: 'minimize' }, { role: 'close' }] },
    {
      role: 'help',
      submenu: [
        { label: `${originalProject.name} on GitHub`, click: () => actions.openExternal(originalProject.url) },
        ...(mac ? [] : [{ type: 'separator' }, about, ...updates]),
      ],
    },
  ];
}

/**
 * The update items (UpdateController.menuState): a manual check, the switch for the daily check, and "Restart to Update" while a
 * downloaded update waits. Nothing for an install the app does not update (a package manager's, or a development run).
 * In the app menu on macOS, in Help elsewhere (the shell has no settings page).
 */
function updateItems({ actions, state }) {
  if (!state?.show) return [];
  return [
    { type: 'separator' },
    { label: 'Check for Updates…', enabled: state.checkEnabled, click: () => actions.checkForUpdates() },
    { label: 'Check for Updates Automatically', type: 'checkbox', checked: state.automatic, click: item => actions.setAutomaticUpdates(item.checked) },
    ...(state.restartReady ? [{ label: 'Restart to Update', click: () => actions.restartToUpdate() }] : []),
  ];
}
