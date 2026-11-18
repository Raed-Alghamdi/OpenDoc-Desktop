// The updater wired to Electron: the real dialog, the real electron-updater instance, the app's own quit and relaunch, and a log file.
// desktop-shell.mjs calls createUpdates() once; everything else is in controller.mjs.
import { app, dialog } from 'electron';
import { appendFile, mkdir, rename, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { openExternal } from '../session-policy.mjs';
import { createUpdaterClass } from './classes.mjs';
import { UpdateController } from './controller.mjs';

/**
 * Environment variables that tests and development builds read.
 * OPENDOC_DESKTOP_UPDATE_RESOURCES: a folder to treat as the packaged app's `resources` (with update-disabled, package-type and
 * app-update.yml in it). Without it a development run never checks for updates. It switches nothing on by itself: the install type,
 * the switch in config.json and the address rules apply as in a packaged app.
 */
export const updaterEnvironment = { resources: 'OPENDOC_DESKTOP_UPDATE_RESOURCES' };

const logLimit = 512 * 1024;

/** One line per event, to the console and to <profile>/logs/updater.log (the log is moved aside once it passes 512 KB). */
function fileLogger(folder) {
  let prepared = null;
  const prepare = () => prepared ??= (async () => {
    await mkdir(folder, { recursive: true });
    const file = join(folder, 'updater.log');
    const size = await stat(file).then(info => info.size, () => 0);
    if (size > logLimit) await rename(file, `${file}.1`).catch(() => {});
    return file;
  })();
  return line => {
    console.log(`[updater] ${line}`);
    void prepare().then(file => appendFile(file, `${new Date().toISOString()} ${line}\n`)).catch(() => {});
  };
}

/**
 * @param options.config the app's config.json handle
 * @param options.getVersion, getBuild the running version and build number (the build is null in a development run)
 * @param options.parent () => the window dialogs belong to, or undefined
 * @param options.onChange called when the menu must be rebuilt
 * @param options.onAppImageMoved async (newPath): the AppImage got a new file name
 */
export function createUpdates({ config, getVersion, getBuild, parent, onChange, onAppImageMoved }) {
  const testResources = process.env[updaterEnvironment.resources] || null;
  const packaged = app.isPackaged || Boolean(testResources);
  const controller = new UpdateController({
    config,
    packaged,
    resourcesDir: testResources ?? (app.isPackaged ? process.resourcesPath : null),
    getVersion,
    getBuild,
    createUpdater: (type, { feed, logger }) => {
      const Updater = createUpdaterClass(type, { getBuild: () => getBuild() ?? 0 });
      const updater = new Updater();
      updater.logger = logger;
      updater.forceDevUpdateConfig = !app.isPackaged; // a test switch on a development Electron
      if (testResources) updater.updateConfigPath = join(testResources, 'app-update.yml'); // before setFeedURL: the setter clears the client
      if (feed) updater.setFeedURL(feed);
      return updater;
    },
    show: options => {
      const window = parent();
      return window && !window.isDestroyed() ? dialog.showMessageBox(window, options) : dialog.showMessageBox(options);
    },
    openExternal,
    relaunch: () => app.relaunch(),
    quit: () => app.quit(),
    onChange,
    onAppImageMoved,
    log: fileLogger(join(app.getPath('userData'), 'logs')),
  });
  return controller;
}
