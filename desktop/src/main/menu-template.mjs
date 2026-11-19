// The application menu's contents, without Electron so the unit tests can read them.
import { appName, originalProject } from './identity.mjs';
import { basename } from 'node:path';

/**
 * @param actions { open, create, openRecent(path), reveal, showLog, about, installCommand, openExternal(url) }
 * @param state { workspaceOpen: boolean, recent: string[] }
 */
export function menuTemplate({ platform = process.platform, actions, state }) {
  const mac = platform === 'darwin';
  const recent = state.recent.length
    ? state.recent.map(path => ({ label: `${basename(path)}  (${path})`, click: () => actions.openRecent(path) }))
    : [{ label: 'No recent workspaces', enabled: false }];
  const about = { label: `About ${appName}`, click: () => actions.about() };
  return [
    ...(mac ? [{ label: appName, submenu: [about, { type: 'separator' }, { label: 'Install Command-Line Tool…', click: () => actions.installCommand() }, { type: 'separator' }, { role: 'hide' }, { role: 'hideOthers' }, { role: 'unhide' }, { type: 'separator' }, { role: 'quit' }] }] : []),
    {
      label: 'File',
      submenu: [
        { label: 'Open Workspace…', accelerator: 'CmdOrCtrl+O', click: () => actions.open() },
        { label: 'New Workspace…', accelerator: 'CmdOrCtrl+Shift+N', click: () => actions.create() },
        { label: 'Open Recent', submenu: recent },
        { type: 'separator' },
        { label: 'Reveal Workspace', enabled: state.workspaceOpen, click: () => actions.reveal() },
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
        ...(mac ? [] : [{ type: 'separator' }, about]),
      ],
    },
  ];
}
