// The application menu: Open and New Workspace, Reveal Workspace, Edit (roles), View (zoom only: no reload or
// developer tools in a release), Window and Help. macOS needs the Edit menu for copy and paste to work at all.
import { Menu } from 'electron';
import { menuTemplate } from './menu-template.mjs';

export { menuTemplate };

export function installMenu(options) {
  Menu.setApplicationMenu(Menu.buildFromTemplate(menuTemplate(options)));
}
