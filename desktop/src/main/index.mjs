// opendoc-desktop: the main process. Electron waits for an ES module entry point to finish loading before it
// emits `ready`, so nothing here awaits app.whenReady() at the top level.
import { app } from 'electron';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { DesktopShell } from './desktop-shell.mjs';
import { appName } from './identity.mjs';
import { appImageTemplatePath } from './command-line-tool.mjs';
import { createPackInbox, packPathsFromArguments } from './pack-import.mjs';
import { runtimeLocation } from './runtime.mjs';
import { dataDirectory } from './workspace/paths.mjs';
import { registerSchemes } from './shell-pages.mjs';

app.setName(appName);
// Settings live where the router skill and the agent integrations expect them: ~/.config/opendoc-desktop on Linux,
// ~/Library/Application Support/opendoc-desktop on macOS. A --user-data-dir switch (tests) still wins.
if (!app.commandLine.hasSwitch('user-data-dir')) app.setPath('userData', join(app.getPath('appData'), appName));

registerSchemes();

// An uncaught error in the main process would otherwise open a modal error dialog and freeze the app's supervision.
process.on('uncaughtException', error => console.error('Uncaught error in the main process:', error));
process.on('unhandledRejection', error => console.error('Unhandled rejection in the main process:', error));

// One instance at a time: a second launch focuses the first and exits.
const first = app.requestSingleInstanceLock();
if (!first) app.quit();

// Design packs opened from outside: a path in the launch arguments (Linux; a double-click runs `opendoc-desktop <path>`), the same in
// a second launch, and macOS's open-file event, which can arrive before the app is ready, so it is registered here, not in run().
const packs = createPackInbox();
if (first) {
  for (const path of packPathsFromArguments(process.argv.slice(1), process.cwd())) packs.push(path);
  app.on('open-file', (event, path) => { event.preventDefault(); packs.push(path); });
}

async function run() {
  await app.whenReady();
  const here = fileURLToPath(new URL('.', import.meta.url));
  const runtime = runtimeLocation({ packaged: app.isPackaged, resourcesPath: process.resourcesPath, developmentRoot: join(here, '..', '..') });
  const templatePath = appImageTemplatePath({ packaged: app.isPackaged, resourcesPath: process.resourcesPath, developmentRoot: join(here, '..', '..') });
  // An AppImage's resources are inside a mount that goes away with the app, so it works from a copy in the data folder.
  const appImage = process.platform === 'linux' && Boolean(process.env.APPIMAGE);
  const dataDir = dataDirectory({ env: process.env, platform: process.platform, home: app.getPath('home') });
  const shell = new DesktopShell({
    runtime, templatePath, dataDir, appImage, fallbackRoot: app.isPackaged ? undefined : join(here, '..', '..', '..'), packs,
    integrationSettings: { packaged: app.isPackaged, resourcesPath: process.resourcesPath, env: process.env },
  });

  app.on('second-instance', (_event, argv, workingDirectory) => {
    for (const path of packPathsFromArguments(argv.slice(1), workingDirectory)) packs.push(path);
    shell.secondInstance();
  });
  app.on('window-all-closed', () => { if (!shell.keepAlive) app.quit(); });
  // The service stops in will-quit, never before-quit: a cancelled quit would leave a window whose calls fail.
  app.on('will-quit', event => {
    if (shell.stopped) return;
    event.preventDefault();
    void shell.shutdown().finally(() => app.exit(0));
  });
  for (const signal of ['SIGINT', 'SIGTERM', 'SIGHUP']) process.on(signal, () => app.quit());

  await shell.start();
}

if (first) run().catch(error => { console.error('opendoc-desktop could not start:', error); app.exit(1); });
