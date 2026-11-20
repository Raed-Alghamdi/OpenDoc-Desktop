// Backups outside the workspace's synced folder: before an upgrade, and the "before restore" copy that
// Restore makes of the files it changes. A backup is a folder `<data>/backups/<workspace>-<date>/` holding `backup.json`
// (the manifest) and `workspace/` (the copy). It is built under a temporary name and renamed when complete, so a backup
// that is there is whole. Nothing here ever deletes one except `deleteBackup`, which the user asks for.
//
// What a backup covers: every top-level entry except `node_modules`, `.opendoc` and `output`, and, at any depth, the
// metadata of version control and file sync (`isMetadata`). Restoring an old `.git` would silently roll back commits, and
// restoring a sync journal puts an old one over a newer one, so none of them is copied or restored.
//
// Restore works file by file: it copies (never moves) what will change into a safety copy, writes a journal into the
// workspace's `.opendoc/`, replaces files one at a time through a temporary name and a rename, removes the files the backup
// does not have, and leaves identical files alone. A failure at any step rolls back from the safety copy, and the safety copy
// is deleted only when the rollback fully succeeded.
import { chmod, copyFile, cp, lstat, mkdir, open, readFile, readdir, readlink, realpath, rename, rm, rmdir, statfs, symlink, utimes, writeFile } from 'node:fs/promises';
import { basename, dirname, join, sep } from 'node:path';
import { readMarker } from './marker.mjs';
import { backupsDirectory } from './paths.mjs';

/** Not copied: the link and what the runtime can rebuild (`node_modules`, `.opendoc`) and what the user exports (`output`). */
export const excludedTopLevel = new Set(['node_modules', '.opendoc', 'output']);
const manifestName = 'backup.json';
const copyFolder = 'workspace';
export const journalName = 'restore-journal.json';
const partialAge = 10 * 60_000;

// Version control and file sync metadata, by file or folder name, at any depth.
const metadataPatterns = [
  /^\.(git|hg|svn|jj)$/,
  /^\.(stfolder|stignore|stversions)$/,
  /^\.sync_.*\.db.*$/, /^\._sync_.*\.db.*$/, /^\.csync_journal\.db.*$/, /^\.owncloudsync\.log.*$/, /^\.nextcloudsync\.log.*$/, /^\.~lock\..*$/,
  /^\.dropbox.*$/,
];
/** True for the name of a version-control or file-sync metadata file or folder (`.git`, `.sync_*.db`, `.stfolder`, `.dropbox*`, ...). */
export const isMetadata = name => metadataPatterns.some(pattern => pattern.test(name));

export class BackupError extends Error {
  constructor(code, message) { super(message); this.name = 'BackupError'; this.code = code; }
}

const two = value => String(value).padStart(2, '0');
/** `2026-11-18-142530`, in local time. */
export const stamp = (date = new Date()) => `${date.getFullYear()}-${two(date.getMonth() + 1)}-${two(date.getDate())}-${two(date.getHours())}${two(date.getMinutes())}${two(date.getSeconds())}`;

/** The folder name's own part of a backup name: never starts with a dot, so the list and Delete always see the backup. */
export const backupBase = root => basename(root).replace(/^\.+/, '') || 'workspace';

/** Count the files and bytes below `path` (symlinks count as one file, never followed; metadata is skipped). */
export async function measure(path) {
  let files = 0;
  let bytes = 0;
  const walk = async current => {
    const info = await lstat(current);
    if (info.isDirectory()) { for (const name of await readdir(current)) if (!isMetadata(name)) await walk(join(current, name)); return; }
    files += 1;
    bytes += info.isSymbolicLink() ? 0 : info.size;
  };
  await walk(path);
  return { files, bytes };
}

/** The top-level entries of a workspace that a backup covers. */
export async function backedUpEntries(root) {
  return (await readdir(root)).filter(name => !excludedTopLevel.has(name) && !isMetadata(name)).sort();
}

async function measureEntries(root, names) {
  let files = 0;
  let bytes = 0;
  for (const name of names) { const part = await measure(join(root, name)); files += part.files; bytes += part.bytes; }
  return { files, bytes };
}

const humanBytes = bytes => bytes >= 1024 ** 3 ? `${(bytes / 1024 ** 3).toFixed(1)} GB` : bytes >= 1024 ** 2 ? `${(bytes / 1024 ** 2).toFixed(1)} MB` : `${Math.max(1, Math.round(bytes / 1024))} KB`;
export { humanBytes };

async function freeBytes(folder) {
  const info = await statfs(folder);
  return Number(info.bavail) * Number(info.bsize);
}

/** A folder name for a new backup that does not exist yet. */
async function newBackupName(directory, base) {
  for (let n = 1; ; n++) {
    const name = n === 1 ? base : `${base}-${n}`;
    try { await lstat(join(directory, name)); } catch (error) { if (error.code === 'ENOENT') return name; throw error; }
  }
}

async function writeManifest(folder, manifest) {
  await writeFile(join(folder, manifestName), `${JSON.stringify(manifest, null, 2)}\n`);
}

/**
 * Remove the `.<name>.partial` folders that a crash left in the backups folder. A partial is only a copy that was never
 * finished (the workspace itself was not touched while it was made), so removing it loses nothing. Folders younger than
 * ten minutes are left: another backup may be being made.
 */
export async function cleanPartials(dataDir, now = Date.now()) {
  const directory = backupsDirectory(dataDir);
  const removed = [];
  for (const name of await readdir(directory).catch(() => [])) {
    if (!name.startsWith('.') || !name.endsWith('.partial')) continue;
    const info = await lstat(join(directory, name)).catch(() => null);
    if (!info || now - info.mtimeMs < partialAge) continue;
    await rm(join(directory, name), { recursive: true, force: true }).catch(() => {});
    removed.push(name);
  }
  return removed;
}

/**
 * Copy the workspace to a new backup. Checks the free space first (the copy's size and a margin), copies with symlinks
 * kept as they are, checks the copy has every file, then writes the manifest and renames the folder into place.
 * @returns { name, directory, manifest }
 */
export async function createBackup({ root, dataDir, from, to, now = new Date(), kind = 'upgrade', free = freeBytes }) {
  const directory = backupsDirectory(dataDir);
  await mkdir(directory, { recursive: true, mode: 0o700 });
  await cleanPartials(dataDir, now.getTime());
  const entries = await backedUpEntries(root);
  const size = await measureEntries(root, entries);
  const available = await free(directory);
  const needed = Math.ceil(size.bytes * 1.05) + 16 * 1024 * 1024;
  if (available < needed) throw new BackupError('no-space', `There is not enough free space for a backup of this workspace: it needs about ${humanBytes(needed)} in ${directory} and ${humanBytes(available)} is free. Nothing was changed.`);
  const name = await newBackupName(directory, `${backupBase(root)}-${stamp(now)}`);
  const partial = join(directory, `.${name}.partial`);
  await rm(partial, { recursive: true, force: true });
  await mkdir(join(partial, copyFolder), { recursive: true, mode: 0o700 });
  try {
    for (const entry of entries) await cp(join(root, entry), join(partial, copyFolder, entry), { recursive: true, verbatimSymlinks: true, preserveTimestamps: true, errorOnExist: true, filter: source => !isMetadata(basename(source)) });
    const copied = await measureEntries(join(partial, copyFolder), entries);
    if (copied.files !== size.files) throw new BackupError('incomplete', `The backup is missing files (${copied.files} of ${size.files} were copied), so it was discarded. Nothing was changed.`);
    // The marker is not copied (it belongs to this device), so the format it names is kept here for Restore.
    const marker = await readMarker(root);
    const manifest = { formatVersion: 1, kind, name, source: root, workspace: basename(root), from, to, workspaceFormat: marker.state === 'ok' ? marker.marker.formatVersion ?? null : null, time: now.toISOString(), files: size.files, bytes: size.bytes, entries };
    await writeManifest(partial, manifest);
    await rename(partial, join(directory, name));
    return { name, directory: join(directory, name), manifest };
  } catch (error) {
    await rm(partial, { recursive: true, force: true }).catch(() => {});
    if (error instanceof BackupError) throw error;
    throw new BackupError('failed', `The backup could not be made (${error.message}). Nothing was changed.`);
  }
}

async function readManifestOf(folder) {
  try {
    const manifest = JSON.parse(await readFile(join(folder, manifestName), 'utf8'));
    return manifest && manifest.formatVersion === 1 && typeof manifest.source === 'string' ? manifest : null;
  } catch { return null; }
}

/** The manifest of the backup called `name`, or null. */
export const backupManifest = (dataDir, name) => readManifestOf(join(backupsDirectory(dataDir), name));

/** The backups on this device, newest first: `{ name, directory, manifest }`. Folders that are not complete backups are ignored. */
export async function listBackups(dataDir) {
  const directory = backupsDirectory(dataDir);
  let names;
  try { names = await readdir(directory); } catch (error) { if (error.code === 'ENOENT') return []; throw error; }
  const found = [];
  for (const name of names) {
    if (name.startsWith('.')) continue;
    const manifest = await readManifestOf(join(directory, name));
    if (manifest) found.push({ name, directory: join(directory, name), manifest });
  }
  return found.sort((a, b) => String(b.manifest.time).localeCompare(String(a.manifest.time)) || b.name.localeCompare(a.name));
}

/** Delete one backup by moving it with `trash(path)` (the shell's trash). The name must be a backup folder's own name. */
export async function deleteBackup({ dataDir, name, trash }) {
  if (typeof name !== 'string' || name !== basename(name) || name.startsWith('.')) throw new BackupError('bad-name', 'That is not the name of a backup.');
  const folder = join(backupsDirectory(dataDir), name);
  const manifest = await readManifestOf(folder);
  if (!manifest) throw new BackupError('missing', 'That backup is not there any more.');
  // The safety copy of a restore that was interrupted is what undoes it: it stays until the app has done that.
  const journal = await readFile(journalFile(manifest.source), 'utf8').then(JSON.parse, () => null);
  if (journal?.before === name) throw new BackupError('needed', 'This backup is the safety copy of a restore that was interrupted and has not been undone yet. Open the workspace so the app can undo it; then this backup is removed by the app.');
  await trash(folder);
}

// ---------- restore, file by file

/** What is at `path`: { type: 'file' | 'dir' | 'link', size, target, mode, mtime }, or null when nothing is. Links are not followed. */
async function describe(path) {
  let info;
  try { info = await lstat(path); } catch (error) { if (error.code === 'ENOENT' || error.code === 'ENOTDIR') return null; throw error; }
  if (info.isSymbolicLink()) return { type: 'link', size: 0, target: await readlink(path) };
  if (info.isDirectory()) return { type: 'dir', size: 0 };
  return { type: 'file', size: info.size, mode: info.mode & 0o7777, mtime: info.mtimeMs };
}

/** Every entry below the top-level `names` of `base`, as a map from relative path to describe(), metadata skipped. */
async function walkTree(base, names) {
  const found = new Map();
  const visit = async relative => {
    const entry = await describe(join(base, relative));
    if (!entry) return;
    found.set(relative, entry);
    if (entry.type === 'dir') for (const name of (await readdir(join(base, relative))).sort()) if (!isMetadata(name)) await visit(join(relative, name));
  };
  for (const name of names) await visit(name);
  return found;
}

async function sameBytes(a, b) {
  const [left, right] = [await open(a, 'r'), await open(b, 'r')];
  try {
    const one = Buffer.allocUnsafe(1 << 20);
    const two = Buffer.allocUnsafe(1 << 20);
    for (;;) {
      const [x, y] = [await left.read(one, 0, one.length, null), await right.read(two, 0, two.length, null)];
      if (x.bytesRead !== y.bytesRead) return false;
      if (x.bytesRead === 0) return true;
      if (!one.subarray(0, x.bytesRead).equals(two.subarray(0, y.bytesRead))) return false;
    }
  } finally { await left.close(); await right.close(); }
}

/** Do the entries at these two paths hold the same thing (same type; links to the same target; files with the same bytes)? */
async function sameEntry(pathA, a, pathB, b) {
  if (!a || !b || a.type !== b.type) return false;
  if (a.type === 'dir') return true;
  if (a.type === 'link') return a.target === b.target;
  return a.size === b.size && sameBytes(pathA, pathB);
}

/** Put `source` at `target` through a temporary name beside it and a rename, so the path never holds half a file. */
async function placeAtomically(source, info, target) {
  await mkdir(dirname(target), { recursive: true });
  const temporary = join(dirname(target), `.${basename(target)}.opendoc-${process.pid}.part`);
  await rm(temporary, { force: true });
  try {
    if (info.type === 'link') await symlink(info.target, temporary);
    else {
      await copyFile(source, temporary);
      await chmod(temporary, info.mode);
      await utimes(temporary, new Date(), new Date(info.mtime));
    }
    await rename(temporary, target);
  } catch (error) { await rm(temporary, { force: true }).catch(() => {}); throw error; }
}

/**
 * Refuse a path of the workspace whose parent folder, with every link in it followed, is outside the workspace. The workspace is the
 * user's own, but a folder in it may be a link to somewhere else (a synced folder, a mistake), and a restore must never write, remove or
 * copy a file there. The nearest folder that exists is resolved, because a restore may be about to create the rest.
 */
async function assertInside(rootReal, root, relative) {
  let folder = dirname(join(root, relative));
  let real;
  for (;;) {
    try { real = await realpath(folder); break; } catch (error) {
      if (error.code !== 'ENOENT' && error.code !== 'ENOTDIR') throw error;
      const up = dirname(folder);
      if (up === folder) throw error;
      folder = up;
    }
  }
  if (real !== rootReal && !real.startsWith(rootReal + sep)) throw new BackupError('outside', `${relative} would be changed outside the workspace: a link in its path leads to ${real}. Nothing was changed there.`);
}

const journalFile = root => join(root, '.opendoc', journalName);

async function writeJournal(root, journal) {
  await mkdir(join(root, '.opendoc'), { recursive: true });
  const temporary = join(root, '.opendoc', `.${journalName}.opendoc-${process.pid}.part`);
  await writeFile(temporary, `${JSON.stringify(journal, null, 2)}\n`);
  await rename(temporary, journalFile(root));
}

const depth = relative => relative.split('/').length;
const bytesOf = (tree, paths) => paths.reduce((sum, relative) => sum + (tree.get(relative)?.size ?? 0), 0);

/** The temporary files (`.<name>.opendoc-<pid>.part`) a killed restore left beside any path of its plan, at any depth. */
async function removeTemps(root, plan) {
  const names = new Map(); // folder -> the file names of the plan in it
  for (const key of Object.keys(plan)) for (const relative of plan[key]) {
    const folder = dirname(join(root, relative));
    if (!names.has(folder)) names.set(folder, new Set());
    names.get(folder).add(basename(relative));
  }
  for (const [folder, wanted] of names) {
    for (const entry of await readdir(folder).catch(() => [])) {
      const match = /^\.(.+)\.opendoc-\d+\.part$/.exec(entry);
      if (match && wanted.has(match[1])) await rm(join(folder, entry), { recursive: true, force: true }).catch(() => {});
    }
  }
}

/**
 * Undo a restore from its safety copy, exactly. It reads the state each path is in and does only what is still needed, so it
 * is safe to run again from any state (a kill in the middle of the restore, in the middle of this rollback, or both, and a
 * file that became a folder or the other way round): a path that is already as it was is left alone, a path that is not there
 * (or whose parent is not a folder yet) counts as gone. Every error is collected and reported, none is swallowed, and the
 * result is verified against the safety copy. Throws a BackupError ('rollback-failed') that names the safety copy when
 * anything could not be put back (the copy and the journal are then kept); otherwise removes the journal and the safety copy.
 */
async function rollback({ root, journal, step }) {
  const savedRoot = join(journal.beforeDirectory, copyFolder);
  const { plan } = journal;
  const errors = [];
  const rootReal = await realpath(root);
  const attempt = async (stage, relative, run) => {
    try { await step({ stage, path: relative }); await assertInside(rootReal, root, relative); await run(); } catch (error) { errors.push(`${relative}: ${error.message}`); }
  };
  const was = { file: new Set([...plan.remove, ...plan.replace]), dir: new Set(plan.rmdirs) }; // what a path was before the restore
  await removeTemps(root, plan);
  // What the restore added goes, the deepest first, unless what is there is what the path held before (the restore had not got to it).
  for (const relative of [...new Set([...plan.add, ...plan.mkdirs])].sort((a, b) => depth(b) - depth(a))) {
    await attempt('rollback-add', relative, async () => {
      const now = await describe(join(root, relative));
      if (!now) return;
      if (now.type === 'dir' ? was.dir.has(relative) : was.file.has(relative)) return;
      // A folder that now holds something the restore did not put there is not ours to remove.
      if (now.type === 'dir') await rmdir(join(root, relative)).catch(error => { if (!['ENOENT', 'ENOTDIR', 'ENOTEMPTY'].includes(error.code)) throw error; });
      else await rm(join(root, relative), { force: true });
    });
  }
  for (const relative of [...plan.rmdirs].sort((a, b) => depth(a) - depth(b))) await attempt('rollback-rmdir', relative, () => mkdir(join(root, relative), { recursive: true }));
  const restored = [...plan.remove, ...plan.replace];
  for (const relative of restored) {
    await attempt('rollback-file', relative, async () => {
      const info = await describe(join(savedRoot, relative));
      if (!info) throw new Error('the safety copy has no such file');
      // A file that already equals its saved copy (the restore never got to it) is not written again: that needs no room.
      if (await sameEntry(join(root, relative), await describe(join(root, relative)), join(savedRoot, relative), info)) return;
      await placeAtomically(join(savedRoot, relative), info, join(root, relative));
    });
  }
  await removeTemps(root, plan);
  for (const relative of restored) {
    if (errors.some(message => message.startsWith(`${relative}:`))) continue;
    const [saved, now] = [await describe(join(savedRoot, relative)), await describe(join(root, relative))];
    if (!(await sameEntry(join(root, relative), now, join(savedRoot, relative), saved))) errors.push(`${relative}: it is not the same as in the safety copy`);
  }
  if (errors.length) throw new BackupError('rollback-failed', `The restore could not be undone completely (${errors.length} problem${errors.length === 1 ? '' : 's'}, the first: ${errors[0]}). Your files from before the restore are kept in ${journal.beforeDirectory}; the journal is ${journalFile(root)}.`);
  await rm(journalFile(root), { force: true });
  await rm(journal.beforeDirectory, { recursive: true, force: true });
}

/**
 * Put a backup's files back, file by file. Files that are the same are not touched; files that differ are replaced one at a
 * time through a temporary name and a rename; files the backup does not have are removed (unless the backup is itself only a
 * set of changed files). Before the first change, the current version of every file that will change or disappear is copied
 * into a new backup of kind `before-restore`, and a journal goes into the workspace's `.opendoc/`. If anything fails, everything
 * is rolled back from that copy; the copy is deleted only when the rollback fully succeeded.
 * `step({ stage, path })` is called before each file operation (tests use it to fail at a chosen place).
 * @returns { before: { name, directory, manifest }, restored: manifest, replaced, added, removed, kept } where `kept` lists the folders the
 * backup lacks that stayed because they hold version control or sync metadata
 */
export async function restoreBackup({ root, dataDir, name, now = new Date(), free = freeBytes, step = async () => {} }) {
  const directory = backupsDirectory(dataDir);
  const source = join(directory, name);
  const manifest = await readManifestOf(source);
  if (!manifest) throw new BackupError('missing', 'That backup is not there any more.');
  if (await describe(journalFile(root))) throw new BackupError('journal-present', 'An earlier restore of this workspace was interrupted. Open the workspace again so the app can undo it first.');
  const backupRoot = join(source, copyFolder);
  const wanted = await walkTree(backupRoot, (await readdir(backupRoot)).filter(entry => !excludedTopLevel.has(entry) && !isMetadata(entry)));
  const current = await walkTree(root, await backedUpEntries(root));
  const removeExtras = manifest.scope !== 'changed-files';

  const plan = { mkdirs: [], replace: [], add: [], remove: [], rmdirs: [] };
  for (const [relative, entry] of wanted) {
    const now = current.get(relative);
    if (!now) { (entry.type === 'dir' ? plan.mkdirs : plan.add).push(relative); continue; }
    if (now.type !== entry.type) {
      if (!removeExtras) throw new BackupError('conflict', `${relative} is a different kind of thing now than in the backup, so this backup cannot be put back over it.`);
      (now.type === 'dir' ? plan.rmdirs : plan.remove).push(relative);
      (entry.type === 'dir' ? plan.mkdirs : plan.add).push(relative);
      continue;
    }
    if (entry.type !== 'dir' && !(await sameEntry(join(root, relative), now, join(backupRoot, relative), entry))) plan.replace.push(relative);
  }
  if (removeExtras) for (const [relative, now] of current) if (!wanted.has(relative)) (now.type === 'dir' ? plan.rmdirs : plan.remove).push(relative);
  for (const key of Object.keys(plan)) plan[key].sort();

  // Nothing is read or written through a link that leaves the workspace: checked for the whole plan before anything changes.
  // (A path below a link or folder the plan itself removes first is checked when its turn comes, once the link is gone.)
  const rootReal = await realpath(root);
  const goneFirst = new Set([...plan.remove, ...plan.rmdirs]);
  const underRemoved = relative => relative.split('/').slice(0, -1).some((_, index, parts) => goneFirst.has(parts.slice(0, index + 1).join('/')));
  for (const relative of new Set(Object.values(plan).flat())) if (!underRemoved(relative)) await assertInside(rootReal, root, relative);

  // Room for the safety copy, and for the temporary files beside the replaced ones.
  const saved = [...plan.replace, ...plan.remove];
  const savedBytes = bytesOf(current, saved);
  const needCopy = Math.ceil(savedBytes * 1.05) + 16 * 1024 * 1024;
  const needWorkspace = Math.ceil(bytesOf(wanted, [...plan.replace, ...plan.add]) * 1.05) + 16 * 1024 * 1024;
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const [roomForCopy, roomInWorkspace] = [await free(directory), await free(root)];
  if (roomForCopy < needCopy) throw new BackupError('no-space', `There is not enough free space to restore: the safety copy of your current files needs about ${humanBytes(needCopy)} in ${directory} and ${humanBytes(roomForCopy)} is free. Nothing was changed.`);
  if (roomInWorkspace < needWorkspace) throw new BackupError('no-space', `There is not enough free space to restore: the files need about ${humanBytes(needWorkspace)} in ${root} and ${humanBytes(roomInWorkspace)} is free. Nothing was changed.`);

  // The safety copy: a copy, so every file is still where it was.
  const beforeName = await newBackupName(directory, `${backupBase(root)}-before-restore-${stamp(now)}`);
  const partial = join(directory, `.${beforeName}.partial`);
  await rm(partial, { recursive: true, force: true });
  await mkdir(join(partial, copyFolder), { recursive: true, mode: 0o700 });
  let beforeInfo;
  try {
    for (const relative of saved) {
      await step({ stage: 'copy-before', path: relative });
      await placeAtomically(join(root, relative), current.get(relative), join(partial, copyFolder, relative));
    }
    for (const relative of saved) {
      if (!(await sameEntry(join(root, relative), current.get(relative), join(partial, copyFolder, relative), await describe(join(partial, copyFolder, relative))))) throw new Error(`the safety copy of ${relative} is not the same as the file`);
    }
    const before = { formatVersion: 1, kind: 'before-restore', scope: 'changed-files', name: beforeName, source: root, workspace: basename(root), from: manifest.to, to: manifest.from, time: now.toISOString(), files: saved.length, bytes: savedBytes, entries: saved, restoredFrom: name };
    await writeManifest(partial, before);
    await rename(partial, join(directory, beforeName));
    beforeInfo = { name: beforeName, directory: join(directory, beforeName), manifest: before };
  } catch (error) {
    // Nothing in the workspace has changed yet: only the unfinished copy is removed.
    await rm(partial, { recursive: true, force: true }).catch(() => {});
    throw new BackupError('failed', `The backup could not be restored (${error.message}). Nothing was changed.`);
  }

  const journal = { formatVersion: 1, backup: name, before: beforeName, beforeDirectory: beforeInfo.directory, startedAt: now.toISOString(), plan };
  try { await writeJournal(root, journal); }
  catch (error) {
    await rm(beforeInfo.directory, { recursive: true, force: true }).catch(() => {});
    throw new BackupError('failed', `The backup could not be restored (${error.message}). Nothing was changed.`);
  }

  const kept = [];
  const swapped = new Set(plan.add); // a folder that must become a file cannot stay
  try {
    for (const relative of plan.remove) { await step({ stage: 'remove', path: relative }); await assertInside(rootReal, root, relative); await rm(join(root, relative), { force: true }); }
    for (const relative of [...plan.rmdirs].sort((a, b) => depth(b) - depth(a))) {
      await step({ stage: 'rmdir', path: relative });
      await assertInside(rootReal, root, relative);
      // A folder the backup lacks that holds version control or sync metadata (never restored, never removed) stays, and is reported.
      await rmdir(join(root, relative)).catch(error => {
        if (error.code === 'ENOENT') return;
        if (error.code === 'ENOTEMPTY' && !swapped.has(relative)) { kept.push(relative); return; }
        throw error;
      });
    }
    for (const relative of [...plan.mkdirs].sort((a, b) => depth(a) - depth(b))) { await step({ stage: 'mkdir', path: relative }); await assertInside(rootReal, root, relative); await mkdir(join(root, relative), { recursive: true }); }
    for (const relative of plan.replace) { await step({ stage: 'replace', path: relative }); await assertInside(rootReal, root, relative); await placeAtomically(join(backupRoot, relative), wanted.get(relative), join(root, relative)); }
    for (const relative of plan.add) { await step({ stage: 'add', path: relative }); await assertInside(rootReal, root, relative); await placeAtomically(join(backupRoot, relative), wanted.get(relative), join(root, relative)); }
    await step({ stage: 'finish', path: '' });
  } catch (error) {
    try { await rollback({ root, journal, step }); }
    catch (failure) { throw new BackupError('rollback-failed', `The backup could not be restored (${error.message}), and putting the files back failed too. ${failure.message}`); }
    throw new BackupError('restore-failed', `The backup could not be restored (${error.message}). Every file was put back the way it was.`);
  }
  await rm(journalFile(root), { force: true });
  return { before: beforeInfo, restored: manifest, replaced: plan.replace.length, added: plan.add.length, removed: plan.remove.length, kept };
}

/**
 * A restore that was interrupted (the app or the machine stopped) leaves `.opendoc/restore-journal.json`. Roll it back from the
 * safety copy, so the workspace is as it was before the restore. Resolves null when there is no journal, or
 * `{ message }` after a rollback; throws a BackupError when the rollback cannot be completed (the journal and the safety copy are kept).
 */
export async function recoverRestore({ root, step = async () => {} }) {
  let text;
  try { text = await readFile(journalFile(root), 'utf8'); } catch (error) { if (error.code === 'ENOENT') return null; throw error; }
  let journal;
  try { journal = JSON.parse(text); } catch { throw new BackupError('journal-damaged', `${journalFile(root)} is damaged, so the app cannot tell how to undo an interrupted restore. The safety copies are in the backups folder; nothing was changed.`); }
  if (!journal?.plan || typeof journal.beforeDirectory !== 'string') throw new BackupError('journal-damaged', `${journalFile(root)} is not a restore journal, so the app cannot undo an interrupted restore. Nothing was changed.`);
  if (!(await describe(join(journal.beforeDirectory, copyFolder)))) throw new BackupError('journal-orphan', `A restore of this workspace was interrupted, and its safety copy (${journal.beforeDirectory}) is not there, so it cannot be undone automatically. The journal is ${journalFile(root)}; nothing was changed.`);
  await rollback({ root, journal, step });
  return { message: `A restore of this workspace from the backup ${journal.backup} was interrupted. The app undid it: the workspace is as it was before the restore began.` };
}

/**
 * The way forward when `recoverRestore` cannot finish: set the journal aside so the workspace can be opened and is never rolled
 * back later over edits the user makes from here on. The journal moves into the safety copy's folder (or, when that is gone or
 * the journal is unreadable, to `.opendoc/restore-journal.abandoned-<time>.json`); nothing else is touched, and the safety copy
 * is kept. Resolves `{ directory }`, the folder that holds the files as they were before the restore (null when unknown).
 */
export async function abandonRestore({ root, now = new Date() }) {
  let text;
  try { text = await readFile(journalFile(root), 'utf8'); } catch (error) { if (error.code === 'ENOENT') return { directory: null }; throw error; }
  let directory = null;
  try { const journal = JSON.parse(text); if (typeof journal?.beforeDirectory === 'string' && await describe(journal.beforeDirectory)) directory = journal.beforeDirectory; } catch { /* unreadable: kept beside the workspace's own files */ }
  // Never over an earlier one: two abandons in the same second (or two journals of the same safety copy) each keep their own file.
  const [folder, base] = directory ? [directory, 'abandoned-restore-journal'] : [join(root, '.opendoc'), `restore-journal.abandoned-${stamp(now)}`];
  for (let attempt = 1; ; attempt++) {
    try { await writeFile(join(folder, `${base}${attempt === 1 ? '' : `-${attempt}`}.json`), text, { flag: 'wx' }); break; }
    catch (error) { if (error.code !== 'EEXIST') throw error; }
  }
  await rm(journalFile(root), { force: true });
  return { directory };
}
