// The updater wired to Electron: the real dialog, the real electron-updater instance, the app's own quit and relaunch, and a log file.
// desktop-shell.mjs calls createUpdates() once; everything else is in controller.mjs.
import { app, dialog } from 'electron';
import { readFileSync } from 'node:fs';
import { appendFile, mkdir, rename, stat } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { join } from 'node:path';
import { openExternal } from '../session-policy.mjs';
import { createUpdaterClass } from './classes.mjs';
import { UpdateController } from './controller.mjs';
import { readHelperLogs } from './mac-install.mjs';
import { isLoopbackHost, updateConfigIsLoopback } from './feed.mjs';
import { guardRedirects, guardSession } from './http-guard.mjs';
import { readTestBuild, testModeAllowed } from '../build-mode.mjs';

/**
 * Environment variables that tests and development builds read.
 * OPENDOC_DESKTOP_UPDATE_RESOURCES (an installed app ignores it unless it is a test build, see build-mode.mjs): a folder to treat as the packaged app's `resources` (with update-disabled, package-type and
 * app-update.yml in it). Without it a development run never checks for updates. It switches nothing on by itself: the install type,
 * the switch in config.json and the address rules apply as in a packaged app.
 */
export const updaterEnvironment = { resources: 'OPENDOC_DESKTOP_UPDATE_RESOURCES' };

const logLimit = 512 * 1024;

// electron-updater reads the app's version from Electron's app.getVersion(), which answers "0.0" when the app is started as a script
// (development and tests). The shell knows the real version (desktop/package.json, the same one About shows), so it is handed over
// through the adapter. Passing an adapter also means passing the HTTP executor, which the constructor otherwise creates.
const require = createRequire(import.meta.url);
const { ElectronAppAdapter } = require('electron-updater/out/ElectronAppAdapter');
const { ElectronHttpExecutor, getNetSession } = require('electron-updater/out/electronHttpExecutor');

class VersionedAppAdapter extends ElectronAppAdapter {
  constructor(version) {
    super();
    this.fixedVersion = version;
  }

  get version() { return this.fixedVersion; }
}

/** The origin release files must stay on for an `updateFeed` provider (null for the built-in address, whose file is https and fixed). */
function feedBase(feed) {
  if (!feed) return null;
  if (feed.provider === 'generic') return feed.url;
  return `${feed.protocol ?? 'https'}://${feed.host ?? 'github.com'}/`;
}

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
  // An installed app takes neither the test resources folder nor a plain-http loopback feed, unless it was built as a test build.
  // (index.mjs has already removed the switch from the environment; this keeps the rule here too.)
  const testMode = testModeAllowed({ packaged: app.isPackaged, testBuild: readTestBuild() });
  const testResources = testMode ? process.env[updaterEnvironment.resources] || null : null;
  const packaged = app.isPackaged || Boolean(testResources);
  const controller = new UpdateController({
    config,
    packaged,
    allowLoopbackFeed: testMode,
    resourcesDir: testResources ?? (app.isPackaged ? process.resourcesPath : null),
    getVersion,
    getBuild,
    createUpdater: (type, { feed, logger }) => {
      const Updater = createUpdaterClass(type, { getBuild: () => getBuild() ?? 0, getFeedBase: () => feedBase(feed) });
      const updater = new Updater(null, new VersionedAppAdapter(getVersion()));
      // Requests and redirects stay on https (loopback http only when the feed, or the test app-update.yml, is on loopback). Three layers:
      // the redirect handlers, createRequest (the differential download), and a catch-all on the session's webRequest.
      let loopbackFeed = Boolean(feed) && isLoopbackHost(new URL(feed.url ?? `${feed.protocol ?? 'https'}://${feed.host ?? 'github.com'}`).hostname);
      if (!feed && testResources) { try { loopbackFeed = updateConfigIsLoopback(readFileSync(join(testResources, 'app-update.yml'), 'utf8')); } catch { /* none */ } }
      const GuardedExecutor = guardRedirects(ElectronHttpExecutor, { loopbackFeed: () => loopbackFeed, log: line => logger.warn(line) });
      updater.httpExecutor = new GuardedExecutor((authInfo, callback) => updater.emit('login', authInfo, callback));
      updater.httpExecutor.cachedSession = getNetSession();
      guardSession(updater.httpExecutor.cachedSession, { loopbackFeed: () => loopbackFeed, log: line => logger.warn(line) });
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
    helperLogs: () => (process.platform === 'darwin' ? readHelperLogs() : Promise.resolve([])),
    log: fileLogger(join(app.getPath('userData'), 'logs')),
  });
  return controller;
}
