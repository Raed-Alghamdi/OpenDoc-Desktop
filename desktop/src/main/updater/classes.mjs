// One electron-updater 6.8.11 class per install type, each with the build-aware version check, the "does this release
// list a file for me" check, and the install step this app wants. Loads in plain Node (the unit tests build instances with a fake app
// adapter); only a MacUpdater needs Electron's autoUpdater, in its constructor.
import { createRequire } from 'node:module';
import { constants } from 'node:fs';
import { access } from 'node:fs/promises';
import { statSync } from 'node:fs';
import { dirname } from 'node:path';
import { enoughSpace, swapAppImage } from './appimage-swap.mjs';
import { parseBuild, withBuildCompare } from './build-compare.mjs';
import { installMacUpdate, macBundleState, decideMacInstall } from './mac-install.mjs';
import { packageTypes } from './install-type.mjs';
import { installPackage } from './privileged-install.mjs';
import { releaseFileFor } from './release-files.mjs';

const require = createRequire(import.meta.url);
const { AppImageUpdater, DebUpdater, RpmUpdater, PacmanUpdater, MacUpdater } = require('electron-updater');

const bases = { appimage: AppImageUpdater, deb: DebUpdater, rpm: RpmUpdater, pacman: PacmanUpdater, mac: MacUpdater };

/** Offer an update only when the metadata lists a file for this install type, with a checksum. */
function withReleaseFile(Base, type, getFeedBase) {
  return class extends Base {
    async isUpdateAvailable(info) {
      const available = await super.isUpdateAvailable(info);
      if (!available) return false;
      const found = releaseFileFor(type, info, { base: getFeedBase() });
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
 * @param options.getFeedBase () => the feed's address (text or URL) when `updateFeed` is set, else null: file addresses must stay on its origin
 * @param options.seams for tests: install (replaces installPackage), appImagePath, statfs, swapOps, macState, macInstall
 */
export function createUpdaterClass(type, { getBuild, getFeedBase = () => null, seams = {} }) {
  const Base = bases[type];
  if (!Base) throw new Error(`No updater for install type ${type}.`);
  const Checked = withConfigFallback(withReleaseFile(withBuildCompare(Base, getBuild), type, getFeedBase));
  /**
   * Every type can empty the folder the download sits in (the file and update-info.json): after a package install, and at a check that
   * finds nothing newer (which clears what an AppImage swap or a macOS swap left there). The controller never calls it while a downloaded
   * update still waits to be installed, so the AppImage's swap at quit always has its file.
   */
  const Clearing = class extends Checked {
    async clearDownloaded() { await (await this.getOrCreateDownloadHelper()).clear(); }
  };

  if (type === 'appimage') {
    return class extends Clearing {
      /**
       * The swap at quit stages a copy in the AppImage's own folder, so that folder must be writable and have room (about the size of
       * the AppImage itself until the real size is known). Either problem would lose the update at quit, so nothing is downloaded.
       */
      async preflight() {
        const file = (seams.appImagePath ?? (() => process.env.APPIMAGE))();
        if (!file) return { ok: false, reason: 'no-appimage', message: 'The APPIMAGE variable is not set.' };
        const folder = dirname(file);
        if (!(await writable(folder))) return { ok: false, reason: 'not-writable', folder, message: `opendoc-desktop is an AppImage in ${folder}, a folder you cannot write to, so it cannot replace itself there. Move the AppImage to a folder of yours (for example ~/Applications) and start it from there, or update it by hand.` };
        let size = 0;
        try { size = statSync(file).size; } catch { /* the file is gone: the swap will say so */ }
        const space = enoughSpace(folder, size, seams.statfs);
        return space.ok ? { ok: true } : { ok: false, reason: 'no-space', folder, message: space.message };
      }

      /**
       * Replaces electron-updater's swap (unlink, then mv from the cache, then run the new AppImage): the file is staged beside the
       * AppImage, checked, and renamed over it, and the new AppImage is never run. Runs while the app quits, so it is synchronous.
       */
      doInstall() {
        const appImage = (seams.appImagePath ?? (() => process.env.APPIMAGE))();
        const installerPath = this.installerPath;
        const sha512 = this.downloadedUpdateHelper?.downloadedFileInfo?.sha512;
        if (installerPath == null) {
          this.dispatchError(new Error("No update filepath provided, can't quit and install"));
          return false;
        }
        try {
          const { destination, renamed } = swapAppImage({ appImage, installerPath, sha512, ops: seams.swapOps, log: message => this._logger.warn(message) });
          this._logger.info(`The AppImage was replaced: ${destination}`);
          if (renamed) this.emit('appimage-filename-updated', destination);
          return true;
        } catch (error) {
          this._logger.error(`The AppImage was not replaced, the current one is untouched: ${error.message}`);
          this.dispatchError(error);
          return false;
        }
      }

      /** Swap the AppImage now (the app is quitting). */
      installAtQuit() { return this.install(true, false); }
    };
  }

  if (packageTypes.includes(type)) {
    return class extends Clearing {
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
  return class extends Clearing {
    async updateDownloaded(zipFileInfo, event) {
      this.downloadedZip = event.downloadedFile;
      this.downloadedRelease = { version: event.version, build: parseBuild(event.build) }; // what the unzipped bundle must say it is
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
        const result = await (seams.macInstall ?? installMacUpdate)({ zipFile: this.downloadedZip, state, expected: this.downloadedRelease ?? null, log: message => this._logger.info(message) });
        return { outcome: 'installed', info: result.info };
      } catch (error) {
        if (error.code === 'MOVE_TO_APPLICATIONS' || error.code === 'NOT_WRITABLE') return { outcome: 'blocked', reason: error.code === 'MOVE_TO_APPLICATIONS' ? 'translocated' : 'not-writable', message: error.message };
        return { outcome: 'failed', message: error.message };
      }
    }

    quitAndInstall() { throw new Error('macOS updates are installed with installDownloaded().'); }
  };
}
