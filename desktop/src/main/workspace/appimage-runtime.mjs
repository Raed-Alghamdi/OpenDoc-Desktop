// Where the runtime lives (E3). The deb, rpm, pacman and macOS builds keep it in the app's resources folder, which stays
// put. An AppImage's resources are inside a mount that exists only while the app runs, so a workspace's `node_modules` link
// cannot point there: the AppImage copies the runtime to `<data>/runtime/<version>-<build>/` at launch and the app runs
// everything from the copy. The workspace links name `<data>/runtime/current/node_modules`, and `current` is a link to the
// copy of this build, switched atomically, so pruning older copies never breaks a workspace that is linked to it.
//
// The agent command (resources/cli/opendoc-appimage.sh) makes the same copy when it runs before the app: the same folder
// name, the same `.tmp.XXXXXX` folder beside it and a rename at the end, and it is skipped when `build-info.json` matches.
import { cp, lstat, mkdir, mkdtemp, readdir, readFile, readlink, rename, rm, stat, symlink } from 'node:fs/promises';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { runtimeCopiesDirectory } from './paths.mjs';

export const currentName = 'current';
const staleAfter = 10 * 60_000; // a `.tmp.` folder this old is the leftover of a copy that died

const read = async path => { try { return await readFile(path); } catch { return null; } };

/** `<version>-<build>`: the package.json of the runtime names the version (as the agent command reads it), else OpenDoc's own. */
async function copyName(source) {
  const buildInfo = await read(join(source, 'build-info.json'));
  let build;
  try { build = JSON.parse(buildInfo).build; } catch { /* reported below */ }
  if (!Number.isSafeInteger(build)) throw new Error(`The runtime in ${source} has no build-info.json, so its copy cannot be named.`);
  let version;
  for (const file of [join(source, 'package.json'), join(source, 'node_modules', 'opendoc', 'package.json')]) {
    try { version = JSON.parse(await read(file)).version; } catch { /* next */ }
    if (typeof version === 'string' && /^[0-9A-Za-z.+-]+$/.test(version)) break;
    version = undefined;
  }
  if (!version) throw new Error(`The runtime in ${source} does not say its version, so its copy cannot be named.`);
  return { name: `${version}-${build}`, buildInfo };
}

const complete = async (folder, buildInfo) => {
  const same = await read(join(folder, 'build-info.json'));
  if (!same || !buildInfo || !same.equals(buildInfo)) return false;
  try { return (await stat(join(folder, 'node_modules', 'opendoc', 'bin', 'opendoc.mjs'))).isFile(); } catch { return false; }
};

/** Point `current` at `name` (a relative link, so the data folder can move), atomically. */
async function switchCurrent(directory, name) {
  const link = join(directory, currentName);
  try { if ((await readlink(link)) === name) return false; } catch { /* absent or not a link */ }
  const temporary = join(directory, `.${currentName}.${process.pid}.tmp`);
  await rm(temporary, { force: true });
  await symlink(name, temporary, 'dir');
  try { await rename(temporary, link); }
  catch (error) { await rm(temporary, { force: true }); throw error; }
  return true;
}

const copyName_ = /^[0-9A-Za-z.+]+(?:-[0-9A-Za-z.+]+)*-\d+$/; // `<version>-<build>`

/**
 * Does any running process have `path` in its command line? (The agent command passes the copy's path as an argument; the
 * service host carries its entry as a file:// URL, where a space is %20 and a non-ASCII character is percent-encoded, so that
 * form is matched too.) Linux only.
 */
export async function inUse(path) {
  const forms = [path, pathToFileURL(path).pathname];
  let pids;
  try { pids = (await readdir('/proc')).filter(name => /^\d+$/.test(name)); } catch { return false; }
  for (const pid of pids) {
    try { const line = await readFile(`/proc/${pid}/cmdline`, 'utf8'); if (forms.some(form => line.includes(form))) return true; } catch { /* gone, or not ours to read */ }
  }
  return false;
}

/**
 * Remove the copies of other builds, and the leftovers of copies that died. Only what the app made is touched: a folder named
 * `<version>-<build>` that holds a `build-info.json`, a `.tmp.` folder or a `.current.<pid>.tmp` link older than ten minutes (a
 * fresh one may be another process's copy in progress). A copy a running process uses is kept, and so is anything else, such as
 * a folder the user put there.
 */
export async function pruneCopies(directory, keep, now = Date.now(), used = inUse) {
  const removed = [];
  for (const entry of await readdir(directory).catch(() => [])) {
    if (entry === keep || entry === currentName) continue;
    const path = join(directory, entry);
    let info;
    try { info = await lstat(path); } catch { continue; }
    const stale = now - info.mtimeMs >= staleAfter;
    const leftover = (entry.startsWith('.tmp.') || (entry.startsWith(`.${currentName}.`) && entry.endsWith('.tmp'))) && stale;
    const oldCopy = info.isDirectory() && copyName_.test(entry) && (await stat(join(path, 'build-info.json')).then(file => file.isFile(), () => false));
    if (!leftover && !oldCopy) continue;
    if (oldCopy && await used(path)) continue;
    await rm(path, { recursive: true, force: true }).catch(() => {});
    removed.push(entry);
  }
  return removed;
}

/**
 * Make the copy of `source` (the AppImage's resources/runtime) for this build and point `current` at it.
 * Resolves `{ runtime, modules, copied, pruned }`: the copy to run from, the folder the workspace links name, whether a copy
 * was made, and what was pruned. Throws, with nothing half-used, when the copy cannot be made (a full disk).
 * `copy(from, to)` is for tests.
 */
export async function prepareAppImageRuntime({ source, dataDir, copy = (from, to) => cp(from, to, { recursive: true, verbatimSymlinks: true }), now = Date.now(), used }) {
  const directory = runtimeCopiesDirectory(dataDir);
  const { name, buildInfo } = await copyName(source);
  const target = join(directory, name);
  try { await mkdir(directory, { recursive: true }); }
  catch (error) { throw new Error(`The OpenDoc runtime could not be copied to ${target}: ${error.message}`); }
  let copied = false;
  if (!(await complete(target, buildInfo))) {
    const temporary = await mkdtemp(join(directory, '.tmp.'));
    try {
      await copy(source, temporary);
      if (!(await complete(temporary, buildInfo))) throw new Error('The copy of the runtime is incomplete.');
      // Another process (the agent command, a second instance) may have finished its copy first: a complete copy is kept, never removed.
      if (!(await complete(target, buildInfo))) {
        try { await rename(temporary, target); copied = true; }
        catch (error) {
          if (!['ENOTEMPTY', 'EEXIST'].includes(error.code)) throw error;
          if (!(await complete(target, buildInfo))) {
            await rm(target, { recursive: true, force: true }); // an unfinished folder, or one of another build, at the name
            await rename(temporary, target);
            copied = true;
          }
        }
      }
    } catch (error) {
      await rm(temporary, { recursive: true, force: true }).catch(() => {});
      throw new Error(`The OpenDoc runtime could not be copied to ${target}: ${error.message}`);
    }
    await rm(temporary, { recursive: true, force: true }).catch(() => {}); // already gone when it became the copy
  }
  return finish(copied);
  async function finish(didCopy) {
    await switchCurrent(directory, name);
    const pruned = await pruneCopies(directory, name, now, used);
    return { runtime: target, modules: join(directory, currentName, 'node_modules'), copied: didCopy, pruned };
  }
}
