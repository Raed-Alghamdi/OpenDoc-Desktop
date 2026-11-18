// The two links a workspace keeps to things outside its synced files (spike S1): `node_modules`, a symlink to the app's
// runtime, and `.claude/skills -> ../.agents/skills`. Neither syncs (Nextcloud skips symlinks), so both are checked on every
// open and repaired. They are only links: a missing, dangling or foreign link is replaced (a new link under a temporary
// name, then a rename over the old one). A real folder or file is never removed here: the caller asks first.
import { lstat, mkdir, readlink, realpath, rename, rm, stat, symlink } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';

const linkNames = (root, name) => ({ path: join(root, name), temporary: join(root, `.${name.replace(/\W/g, '')}.opendoc-${process.pid}.tmp`) });

async function realOrNull(path) {
  try { return await realpath(path); } catch { return null; }
}

/**
 * What `<root>/node_modules` is, against `wanted = { path }` (the folder the link must name: the runtime's node_modules,
 * for the AppImage through its `current` link).
 *   missing | correct | dangling (a link to nothing) | foreign (a link to somewhere that exists, not the app's runtime)
 *   | real (not a link: `kind` says folder or file)
 * With `exact`, a link must name `wanted.path` itself; otherwise any link that ends in the same folder is correct.
 */
export async function inspectModules(root, wanted, { exact = false } = {}) {
  const { path } = linkNames(root, 'node_modules');
  let info;
  try { info = await lstat(path); }
  catch (error) { if (error.code === 'ENOENT') return { state: 'missing' }; throw error; }
  if (!info.isSymbolicLink()) return { state: 'real', kind: info.isDirectory() ? 'folder' : 'file' };
  const target = resolve(dirname(path), await readlink(path));
  const here = await realOrNull(path);
  if (!here) return { state: 'dangling', target };
  const same = exact ? target === resolve(wanted.path) : here === await realOrNull(wanted.path);
  return same ? { state: 'correct', target } : { state: 'foreign', target };
}

/** Put the link in place (the file named node_modules must be a link or absent). */
export async function linkModules(root, wanted) {
  const { path, temporary } = linkNames(root, 'node_modules');
  if (!(await realOrNull(wanted.path))) throw new Error(`The app's runtime is not at ${wanted.path}, so the workspace cannot be linked to it.`);
  await rm(temporary, { force: true });
  await symlink(wanted.path, temporary, 'dir');
  try { await rename(temporary, path); }
  catch (error) { await rm(temporary, { force: true }); throw error; }
}

/**
 * Make `node_modules` the link, whatever is wrong with it, except for a real folder or file, which stays untouched
 * (`{ state: 'real' }`) unless `replaceReal(path)` is given: that one removes it (the shell moves it to the trash).
 * Returns what it found and whether it changed anything.
 */
export async function ensureModulesLink(root, wanted, { exact = false, replaceReal } = {}) {
  const found = await inspectModules(root, wanted, { exact });
  if (found.state === 'correct') return { ...found, changed: false };
  if (found.state === 'real') {
    if (!replaceReal) return { ...found, changed: false };
    await replaceReal(join(root, 'node_modules'));
  }
  await linkModules(root, wanted);
  return { ...found, changed: true };
}

/**
 * `.claude/skills` against `.agents/skills`. The link is made only when `.agents/skills` is a folder and `.claude/skills`
 * is missing or a link to nothing; a real folder, or a link that works, is never replaced.
 * Returns { state: 'no-agents' | 'correct' | 'other-link' | 'real' | 'repaired', changed }.
 */
export async function ensureSkillsLink(root) {
  const agents = join(root, '.agents', 'skills');
  try { if (!(await stat(agents)).isDirectory()) return { state: 'no-agents', changed: false }; }
  catch { return { state: 'no-agents', changed: false }; }
  const { path, temporary } = linkNames(join(root, '.claude'), 'skills');
  let info = null;
  try { info = await lstat(path); } catch (error) { if (error.code !== 'ENOENT') throw error; }
  if (info && !info.isSymbolicLink()) return { state: 'real', changed: false };
  if (info && await realOrNull(path)) return { state: (await readlink(path)) === join('..', '.agents', 'skills') ? 'correct' : 'other-link', changed: false };
  await mkdir(join(root, '.claude'), { recursive: true });
  await rm(temporary, { force: true });
  await symlink(join('..', '.agents', 'skills'), temporary, 'dir');
  try { await rename(temporary, path); }
  catch (error) { await rm(temporary, { force: true }); throw error; }
  return { state: 'repaired', changed: true };
}
