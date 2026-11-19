// Which kind of install this is, and whether the in-app updater may run at all (plan 3.7, S6). The first match wins:
//   development run                           inactive (unless a test switch names a resources folder)
//   resources/update-disabled                 managed   the package manager owns the app (the AUR package): no updater object, no network
//   config.json checkForUpdates === false     off       switched off by the user: no updater object, no network
//   macOS                                     mac
//   the APPIMAGE variable                     appimage
//   resources/package-type (deb, rpm, pacman) that package
//   anything else                             inactive
// No Electron import: the facts come in as arguments.
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

export const packageTypes = ['deb', 'rpm', 'pacman'];
export const activeTypes = ['appimage', ...packageTypes, 'mac'];

/**
 * @param options.packaged app.isPackaged, or true when a test switch names a resources folder
 * @param options.resourcesDir process.resourcesPath, or the test switch's folder; null for a development run
 * @param options.config the parsed config.json
 * Everything else is for tests: platform, env, exists(path), read(path).
 * @returns { type, active, reason }
 */
export function detectInstallType({ packaged, resourcesDir, config = {}, platform = process.platform, env = process.env, exists = existsSync, read = path => readFileSync(path, 'utf8') }) {
  const result = (type, reason) => ({ type, active: activeTypes.includes(type), reason });
  if (!packaged || !resourcesDir) return result('inactive', 'a development run (the app is not packaged)');
  if (exists(join(resourcesDir, 'update-disabled'))) return result('managed', 'resources/update-disabled: the package manager owns this app');
  if (config.checkForUpdates === false) return result('off', 'switched off (config.json checkForUpdates is false)');
  if (platform === 'darwin') return result('mac');
  if (env.APPIMAGE) return result('appimage');
  let packageType = null;
  try { packageType = read(join(resourcesDir, 'package-type')).trim(); } catch { /* an AppImage or an unpacked build has none */ }
  if (packageTypes.includes(packageType)) return result(packageType);
  return result('inactive', 'not an AppImage, a known package or a Mac app');
}

/** The install types whose update needs the user's click (and for deb, rpm and pacman, the system password). */
export const needsRestartClick = type => type === 'mac' || packageTypes.includes(type);
