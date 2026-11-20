// A workspace that had no `.opendoc/` folder before the app opened it should have none after the app lets go of it. The lock
// (lock.mjs) makes `.opendoc/` just by taking the lock, and the service makes `locks/`, `pack-uploads/` and `renders/` inside it when it
// needs them; in a synced folder (no marker) that is a folder the user never agreed to, and it would sync to the other devices.
// So the app notes what was there before, and at the end removes what is empty and was not. Only `rmdir`, never recursive: a
// folder that holds anything (the marker after a Yes, a pin file, a backup journal) stays.
import { readdir, rmdir } from 'node:fs/promises';
import { join } from 'node:path';

/** Folders inside `.opendoc/` the service makes on demand. */
const serviceFolders = ['locks', 'pack-uploads', 'renders'];

async function present(path) {
  try { await readdir(path); return true; } catch { return false; }
}

/** What `.opendoc/` and its on-demand folders looked like before the app touched the workspace. */
export async function snapshotOpendocFolders(root) {
  const opendoc = join(root, '.opendoc');
  const had = await present(opendoc);
  return { had, inside: had ? await Promise.all(serviceFolders.map(async name => ((await present(join(opendoc, name))) ? name : null))).then(names => names.filter(Boolean)) : [] };
}

/**
 * Remove, when empty, the on-demand folders that were not there before, and then `.opendoc/` itself when it was not there
 * either. Returns the paths removed. Every failure (not empty, already gone, no permission) is the answer "leave it".
 */
export async function removeCreatedOpendocFolders(root, before) {
  const opendoc = join(root, '.opendoc');
  const removed = [];
  for (const name of serviceFolders) {
    if (before.inside.includes(name)) continue;
    try { await rmdir(join(opendoc, name)); removed.push(join(opendoc, name)); } catch { /* not there, or not empty */ }
  }
  if (!before.had) {
    try { await rmdir(opendoc); removed.push(opendoc); } catch { /* not empty: the app wrote something that stays */ }
  }
  return removed;
}
