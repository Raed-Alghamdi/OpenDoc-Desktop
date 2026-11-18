// One electron-updater 6.8.11 class per install type (plan 3.7, S6), each with the build-aware version check, the "does this release
// list a file for me" check, and the install step this app wants. Loads in plain Node (the unit tests build instances with a fake app
// adapter); only a MacUpdater needs Electron's autoUpdater, in its constructor.
import { createRequire } from 'node:module';
import { constants } from 'node:fs';
import { access } from 'node:fs/promises';
import { dirname } from 'node:path';
import { withBuildCompare } from './build-compare.mjs';
import { installMacUpdate, macBundleState, decideMacInstall } from './mac-install.mjs';
import { packageTypes } from './install-type.mjs';
import { installPackage } from './privileged-install.mjs';
import { releaseFileFor } from './release-files.mjs';

const require = createRequire(import.meta.url);
const { AppImageUpdater, DebUpdater, RpmUpdater, PacmanUpdater, MacUpdater } = require('electron-updater');

const bases = { appimage: AppImageUpdater, deb: DebUpdater, rpm: RpmUpdater, pacman: PacmanUpdater, mac: MacUpdater };

/** Offer an update only when the metadata lists a file for this install type, with a checksum. */
function withReleaseFile(Base, type) {
  return class extends Base {
    async isUpdateAvailable(info) {
      const available = await super.isUpdateAvailable(info);
      if (!available) return false;
      const found = releaseFileFor(type, info);
      if (!found.ok) {
        this._logger.warn(`Version ${info.version} (build ${info.build ?? 'none'}) is not offered: ${found.message}`);
        return false;
      }
      return true;
    }
  };
}

/** Releases built by electron-builder carry app-update.yml; a build without it (or a test run) still needs a cache folder name. */
function withConfigFallback(Base) {
  return class extends Base {
    async loadUpdateConfig() {
      try { return await super.loadUpdateConfig(); }
      catch (error) {
        if (error?.code !== 'ENOENT') throw error;
        return { updaterCacheDirName: 'opendoc-desktop-updater' };
      }
    }
  };
}

const writable = path => access(path, constants.W_OK).then(() => true, () => false);

/**
 * The class for an install type.
 * Every class gets `preflight()` (can this install replace itself where it stands? { ok } or { ok: false, reason, message }) and,
 * for the types that need a click, `installDownloaded()` (resolves { outcome: 'installed' | 'cancelled' | 'failed' | 'blocked', message? }).
 * @param options.getBuild the running build number
 * @param options.seams for tests: install (replaces installPackage), appImagePath, macState, macInstall
 */
export function createUpdaterClass(type, { getBuild, seams = {} }) {
  const Base = bases[type];
  if (!Base) throw new Error(`No updater for install type ${type}.`);
  const Checked = withConfigFallback(withReleaseFile(withBuildCompare(Base, getBuild), type));

  if (type === 'appimage') {
    return class extends Checked {
      /** The swap at quit needs the AppImage's folder: unlink and move happen there. EACCES at quit would lose the update silently. */
      async preflight() {
        const file = (seams.appImagePath ?? (() => process.env.APPIMAGE))();
        if (!file) return { ok: false, reason: 'no-appimage', message: 'The APPIMAGE variable is not set.' };
        const folder = dirname(file);
        if (await writable(folder)) return { ok: true };
        return { ok: false, reason: 'not-writable', folder, message: `opendoc-desktop is an AppImage in ${folder}, a folder you cannot write to, so it cannot replace itself there. Move the AppImage to a folder of yours (for example ~/Applications) and start it from there, or update it by hand.` };
      }

      /** Swap the AppImage now (the app is quitting). electron-updater unlinks the old file and moves the new one in. */
      installAtQuit() { return this.install(true, false); }
    };
  }

  if (packageTypes.includes(type)) {
    return class extends Checked {
      async preflight() { return { ok: true }; }

      /** The file as downloaded and its checksum from the metadata (what electron-updater compared it with). */
      downloaded() {
        const helper = this.downloadedUpdateHelper;
        const file = helper?.file;
        const sha512 = helper?.downloadedFileInfo?.sha512;
        return file && sha512 ? { file, sha512 } : null;
      }

      async installDownloaded() {
        const found = this.downloaded();
        if (!found) return { outcome: 'failed', message: 'There is no downloaded update to install.' };
        return (seams.install ?? installPackage)({ type, ...found, log: message => this._logger.info(message) });
      }

      // The stock installs are synchronous (they freeze every window while the password prompt is open), so none of them may run.
      quitAndInstall() { throw new Error('Package updates are installed with installDownloaded().'); }
      doInstall() { throw new Error('Package updates are installed with installDownloaded().'); }
    };
  }

  // macOS: electron-updater downloads and checks the zip, then the app's own swap takes over (Squirrel.Mac is skipped).
  return class extends Checked {
    async updateDownloaded(zipFileInfo, event) {
      this.downloadedZip = event.downloadedFile;
      this.dispatchUpdateDownloaded(event);
      return [];
    }

    async preflight() {
      const state = await (seams.macState ?? macBundleState)();
      const decision = decideMacInstall(state);
      return decision.action === 'swap' ? { ok: true } : { ok: false, reason: decision.reason, message: decision.message };
    }

    async installDownloaded() {
      if (!this.downloadedZip) return { outcome: 'failed', message: 'There is no downloaded update to install.' };
      try {
        const state = await (seams.macState ?? macBundleState)();
        const result = await (seams.macInstall ?? installMacUpdate)({ zipFile: this.downloadedZip, state, log: message => this._logger.info(message) });
        return { outcome: 'installed', info: result.info };
      } catch (error) {
        if (error.code === 'MOVE_TO_APPLICATIONS' || error.code === 'NOT_WRITABLE') return { outcome: 'blocked', reason: error.code === 'MOVE_TO_APPLICATIONS' ? 'translocated' : 'not-writable', message: error.message };
        return { outcome: 'failed', message: error.message };
      }
    }

    quitAndInstall() { throw new Error('macOS updates are installed with installDownloaded().'); }
  };
}
