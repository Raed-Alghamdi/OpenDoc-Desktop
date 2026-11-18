// Replacing the running AppImage without ever leaving the user without one. electron-updater's own swap unlinks the AppImage first and
// then moves the download in from ~/.cache (a copy across file systems when it is a different disk), so a full disk or a killed
// process in between leaves no app at all, and it then runs the new AppImage with no time limit while the app is quitting.
// Here the download is copied beside the AppImage under a temporary name, checked against the metadata's SHA-512, made executable and
// synced, and only then renamed over the AppImage (atomic, same folder). Any failure removes the temporary file and leaves the old
// AppImage untouched. The new AppImage is never run. No Electron import.
import { createHash } from 'node:crypto';
import { chmodSync, closeSync, constants, copyFileSync, fsyncSync, openSync, readSync, renameSync, rmSync, statSync, statfsSync, unlinkSync } from 'node:fs';
import { basename, dirname, isAbsolute, join } from 'node:path';

/** Room to keep free in the AppImage's folder beyond the file itself. */
export const spaceSlack = 16 * 1024 * 1024;

const defaults = { copyFile: copyFileSync, statfs: statfsSync };

/** Bytes a normal user can still write in `folder`. */
export function freeBytes(folder, statfs = statfsSync) {
  const info = statfs(folder);
  return Number(info.bavail) * Number(info.bsize);
}

const megabytes = bytes => `${Math.ceil(bytes / (1024 * 1024))} MB`;

/** `{ ok: true }`, or `{ ok: false, message }` when `folder` has less than `size` bytes (plus a little) free. */
export function enoughSpace(folder, size, statfs = statfsSync) {
  let free;
  try { free = freeBytes(folder, statfs); } catch { return { ok: true }; } // unknown: the copy itself then decides
  if (free >= size + spaceSlack) return { ok: true };
  return { ok: false, message: `There is not enough free space in ${folder} to put the update beside opendoc-desktop (${megabytes(size)} needed, ${megabytes(Math.max(free, 0))} free). Free some space and check again.` };
}

/** Where the new file goes: over the AppImage, as electron-updater does, or beside it under the new name when the old name has a version in it. */
export function destinationFor(appImage, installerPath) {
  const existing = basename(appImage);
  if (basename(installerPath) === existing || !/\d+\.\d+\.\d+/.test(existing)) return appImage;
  return join(dirname(appImage), basename(installerPath));
}

/** Base64 SHA-512 of a file, read in pieces. */
export function hashFileSync(file) {
  const hash = createHash('sha512');
  const buffer = Buffer.allocUnsafe(1024 * 1024);
  const fd = openSync(file, 'r');
  try {
    for (let read = readSync(fd, buffer, 0, buffer.length, null); read > 0; read = readSync(fd, buffer, 0, buffer.length, null)) hash.update(buffer.subarray(0, read));
  } finally { closeSync(fd); }
  return hash.digest('base64');
}

function syncPath(path, flags) {
  const fd = openSync(path, flags);
  try { fsyncSync(fd); } finally { closeSync(fd); }
}

/**
 * Swap the downloaded file in for the AppImage. Synchronous (it runs while the app quits). Resolves { destination, renamed }; throws on
 * any failure, after removing its temporary file, with the old AppImage untouched.
 * @param options.appImage the running AppImage's path (APPIMAGE)
 * @param options.installerPath the downloaded file
 * @param options.sha512 the metadata's checksum (base64) for it
 * @param options.ops for tests: { copyFile, statfs }
 */
export function swapAppImage({ appImage, installerPath, sha512, ops = {}, log = () => {} }) {
  const { copyFile, statfs } = { ...defaults, ...ops };
  if (typeof appImage !== 'string' || !isAbsolute(appImage) || appImage.includes('\0')) throw new Error(`APPIMAGE is not a valid absolute path: "${appImage}"`);
  if (typeof sha512 !== 'string' || !sha512) throw new Error('The downloaded update has no checksum to verify it against.');
  const destination = destinationFor(appImage, installerPath);
  const folder = dirname(destination);
  const size = statSync(installerPath).size;
  const space = enoughSpace(folder, size, statfs);
  if (!space.ok) throw new Error(space.message);
  const staged = join(folder, `.${basename(destination)}.update-${process.pid}`);
  try {
    copyFile(installerPath, staged, constants.COPYFILE_EXCL);
    if (hashFileSync(staged) !== sha512) throw new Error('The copy of the update next to opendoc-desktop does not match its checksum, so it was not installed.');
    chmodSync(staged, 0o755);
    syncPath(staged, 'r');
    renameSync(staged, destination); // atomic: the AppImage is the old file or the new one, never neither
  } catch (error) {
    rmSync(staged, { force: true });
    throw error;
  }
  try { syncPath(folder, 'r'); } catch { /* best effort */ }
  const renamed = destination !== appImage;
  if (renamed) { try { unlinkSync(appImage); } catch (error) { log(`the old AppImage could not be removed: ${error.message}`); } }
  rmSync(installerPath, { force: true }); // as the stock move did: the cache holds no second copy
  return { destination, renamed };
}
