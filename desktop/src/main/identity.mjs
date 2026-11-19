import { readFile } from 'node:fs/promises';

// Names and addresses the app shows or checks. Kept in one place so About, the menus and the pages agree.
export const appName = 'opendoc-desktop';
export const originalProject = { name: 'OpenDoc', author: 'RyanYahya', url: 'https://github.com/RyanYahya/OpenDoc' };

// The app's own pages (workspace picker, crash screen) are served from this origin, never from file://.
export const shellScheme = 'app';
export const shellHost = 'shell';
export const shellOrigin = `${shellScheme}://${shellHost}`;
// The OpenDoc service's pages and API, on the same scheme. The main process answers them through the service host's
// channel; nothing listens on a port.
export const serviceHost = 'opendoc';
export const serviceOrigin = `${shellScheme}://${serviceHost}`;

// Settings read from the environment. They exist for tests and development builds only.
export const environment = {
  runtime: 'OPENDOC_DESKTOP_RUNTIME',
  healthInterval: 'OPENDOC_DESKTOP_HEALTH_MS',
};

/** The app's version, from desktop/package.json (equal to OpenDoc's own). Electron's app.getVersion() reads the
 *  nearest package.json to the entry script, which is wrong when the entry is started by its file path. */
export async function appVersion() {
  return JSON.parse(await readFile(new URL('../../package.json', import.meta.url), 'utf8')).version;
}
