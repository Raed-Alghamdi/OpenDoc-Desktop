// Where the app keeps what is not a setting: backups, and (AppImage) the copy of its runtime. Contracts, "App identity".
import { join } from 'node:path';
import { appName } from '../identity.mjs';

/** Linux: $XDG_DATA_HOME/opendoc-desktop, else ~/.local/share/opendoc-desktop. macOS: ~/Library/Application Support/opendoc-desktop. */
export function dataDirectory({ env = process.env, platform = process.platform, home }) {
  if (platform === 'darwin') return join(home, 'Library', 'Application Support', appName);
  const base = env.XDG_DATA_HOME && env.XDG_DATA_HOME.startsWith('/') ? env.XDG_DATA_HOME : join(home, '.local', 'share');
  return join(base, appName);
}

export const backupsDirectory = dataDir => join(dataDir, 'backups');
export const runtimeCopiesDirectory = dataDir => join(dataDir, 'runtime');
