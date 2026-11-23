// One electron-updater 6.8.11 class per install type, each with the build-aware version check, the "does this release
// list a file for me" check, and the install step this app wants. Loads in plain Node (the unit tests build instances with a fake app
// adapter); only a MacUpdater needs Electron's autoUpdater, in its constructor.
import { createRequire } from 'node:module';
import { constants } from 'node:fs';
import { access, rename, stat, writeFile } from 'node:fs/promises';
import { statSync } from 'node:fs';
import { dirname } from 'node:path';
import { enoughSpace, swapAppImage } from './appimage-swap.mjs';
import { parseBuild, withBuildCompare } from './build-compare.mjs';
import { installMacUpdate, macBundleState, decideMacInstall } from './mac-install.mjs';
import { packageTypes } from './install-type.mjs';
import { installPackage } from './privileged-install.mjs';
import { redirectVerdict } from './http-guard.mjs';
import { releaseFileFor } from './release-files.mjs';

const require = createRequire(import.meta.url);
const { AppImageUpdater, DebUpdater, RpmUpdater, PacmanUpdater, MacUpdater, CancellationToken } = require('electron-updater');

/** A release's signature file is the raw 64 bytes of an Ed25519 signature, published beside each installer as <installer>.sig. */
export const signatureLength = 64;
const signatureTimeoutMs = 30_000;
export const noSignatureMessage = 'This update has no signature, so it was not installed. Download it from the release page and install it by hand.';

/** The address of a package's signature: the package's own address with `.sig` added to the path. Null when it is not an address. */
export function signatureUrl(packageUrl) {
  try {
    const url = new URL(packageUrl);
    url.pathname += '.sig';
    return url;
  } catch { return null; }
}

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
 * @param options.getResourcesPath () => the app's resources folder (the release key and the root helper are looked for there); undefined means Electron's own
 * @param options.isLoopbackFeed () => true when the feed is on the loopback address (a test build only): the signature may then be fetched over plain http from there
 * @param options.seams for tests: install (replaces installPackage), fetchSignature (replaces the download of the .sig), appImagePath, statfs, swapOps, macState, macInstall
 */
export function createUpdaterClass(type, { getBuild, getFeedBase = () => null, isLoopbackFeed = () => false, getResourcesPath = () => undefined, seams = {} }) {
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
        if (!(await writable(folder))) return { ok: false, reason: 'not-writable', folder, message: `OpenDoc Desktop is an AppImage in ${folder}, a folder you cannot write to, so it cannot replace itself there. Move the AppImage to a folder of yours (for example ~/Applications) and start it from there, or update it by hand.` };
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

      /**
       * electron-updater downloads the package and checks its SHA-512; the release's own signature for it (<package address>.sig) is
       * fetched here, once the package is in place, and stored beside it. A signature that cannot be had now is tried again when
       * the user chooses to install; the root helper is what checks it, so nothing here decides that it is good.
       */
      async executeDownload(taskOptions) {
        const result = await super.executeDownload(taskOptions);
        this.signatureSource = { packageAddress: taskOptions.fileInfo.url.href };
        try { await this.fetchSignature(); }
        catch (error) { this._logger.warn(`The signature of the update could not be fetched (it is tried again at install time): ${error.message}`); }
        return result;
      }

      /**
       * Where the signature of the downloaded file is stored: <file>.ed25519.sig, not <file>.sig. pacman -U reads a <file>.sig beside a
       * package as its PGP signature and refuses the package as corrupted, which would break the command shown to install it by hand.
       */
      get signatureFile() {
        const file = this.downloadedUpdateHelper?.file;
        return file ? `${file}.ed25519.sig` : null;
      }

      /** Download <package address>.sig and store it as signatureFile. Throws with a plain message when it cannot be had. */
      async fetchSignature() {
        const target = this.signatureFile;
        const url = this.signatureSource ? signatureUrl(this.signatureSource.packageAddress) : null;
        if (!target || !url) throw new Error('there is no downloaded update to fetch it for');
        const verdict = redirectVerdict(url.href, { loopbackFeed: isLoopbackFeed() });
        if (!verdict.ok) throw new Error(verdict.message);
        const bytes = await (seams.fetchSignature ?? (address => this.#download(address)))(url);
        if (!Buffer.isBuffer(bytes) || bytes.length !== signatureLength) throw new Error(`the signature file is not ${signatureLength} bytes long`);
        const temporary = `${target}.part`;
        await writeFile(temporary, bytes);
        await rename(temporary, target);
      }

      async #download(url) {
        const token = new CancellationToken();
        const timer = setTimeout(() => token.cancel(), signatureTimeoutMs);
        try { return await this.httpExecutor.downloadToBuffer(url, { cancellationToken: token }); }
        finally { clearTimeout(timer); }
      }

      /** The stored signature's path when there is a 64-byte file, else null. */
      async #storedSignature() {
        const target = this.signatureFile;
        if (!target) return null;
        const info = await stat(target).catch(() => null);
        return info?.isFile() && info.size === signatureLength ? target : null;
      }

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
        let signature = await this.#storedSignature();
        if (!signature) {
          this._logger.warn('The downloaded update has no stored signature; fetching it once more.');
          try { await this.fetchSignature(); } catch (error) { this._logger.warn(`The signature could not be fetched: ${error.message}`); }
          signature = await this.#storedSignature();
        }
        // Without the signature nothing is installed, and pkexec is never started (no password prompt for an update that will be refused).
        if (!signature) return { outcome: 'failed', reason: 'no-signature', message: noSignatureMessage };
        return (seams.install ?? installPackage)({ type, ...found, signature, resourcesPath: getResourcesPath(), log: message => this._logger.info(message) });
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
