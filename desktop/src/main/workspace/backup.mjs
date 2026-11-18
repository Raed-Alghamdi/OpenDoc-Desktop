// Backups outside the workspace's synced folder (plan 3.4): before an upgrade, and the "before restore" copy that
// Restore makes of what it replaces. A backup is a folder `<data>/backups/<workspace>-<date>/` holding `backup.json`
// (the manifest) and `workspace/` (the copy). It is built under a temporary name and renamed when complete, so a backup
// that is there is whole. Nothing here ever deletes one except `deleteBackup`, which the user asks for.
import { cp, lstat, mkdir, readFile, readdir, rename, rm, statfs, writeFile } from 'node:fs/promises';
import { basename, join } from 'node:path';
import { backupsDirectory } from './paths.mjs';

/** Not copied: the link and what the runtime can rebuild (`node_modules`, `.opendoc`) and what the user exports (`output`). */
export const excludedTopLevel = new Set(['node_modules', '.opendoc', 'output']);
const manifestName = 'backup.json';
const copyFolder = 'workspace';

export class BackupError extends Error {
  constructor(code, message) { super(message); this.name = 'BackupError'; this.code = code; }
}

const two = value => String(value).padStart(2, '0');
/** `2026-11-18-142530`, in local time. */
export const stamp = (date = new Date()) => `${date.getFullYear()}-${two(date.getMonth() + 1)}-${two(date.getDate())}-${two(date.getHours())}${two(date.getMinutes())}${two(date.getSeconds())}`;

/** Count the files and bytes below `path` (symlinks count as one file, never followed). */
export async function measure(path) {
  let files = 0;
  let bytes = 0;
  const walk = async current => {
    const info = await lstat(current);
    if (info.isDirectory()) { for (const name of await readdir(current)) await walk(join(current, name)); return; }
    files += 1;
    bytes += info.isSymbolicLink() ? 0 : info.size;
  };
  await walk(path);
  return { files, bytes };
}

/** The top-level entries of a workspace that a backup covers. */
export async function backedUpEntries(root) {
  return (await readdir(root)).filter(name => !excludedTopLevel.has(name)).sort();
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
 * Copy the workspace to a new backup. Checks the free space first (the copy's size and a margin), copies with symlinks
 * kept as they are, checks the copy has every file, then writes the manifest and renames the folder into place.
 * @returns { name, directory, manifest }
 */
export async function createBackup({ root, dataDir, from, to, now = new Date(), kind = 'upgrade', free = freeBytes }) {
  const directory = backupsDirectory(dataDir);
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const entries = await backedUpEntries(root);
  const size = await measureEntries(root, entries);
  const available = await free(directory);
  const needed = Math.ceil(size.bytes * 1.05) + 16 * 1024 * 1024;
  if (available < needed) throw new BackupError('no-space', `There is not enough free space for a backup of this workspace: it needs about ${humanBytes(needed)} in ${directory} and ${humanBytes(available)} is free. Nothing was changed.`);
  const name = await newBackupName(directory, `${basename(root)}-${stamp(now)}`);
  const partial = join(directory, `.${name}.partial`);
  await rm(partial, { recursive: true, force: true });
  await mkdir(join(partial, copyFolder), { recursive: true, mode: 0o700 });
  try {
    for (const entry of entries) await cp(join(root, entry), join(partial, copyFolder, entry), { recursive: true, verbatimSymlinks: true, preserveTimestamps: true, errorOnExist: true });
    const copied = await measureEntries(join(partial, copyFolder), entries);
    if (copied.files !== size.files) throw new BackupError('incomplete', `The backup is missing files (${copied.files} of ${size.files} were copied), so it was discarded. Nothing was changed.`);
    const manifest = { formatVersion: 1, kind, name, source: root, workspace: basename(root), from, to, time: now.toISOString(), files: size.files, bytes: size.bytes, entries };
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
  if (!(await readManifestOf(folder))) throw new BackupError('missing', 'That backup is not there any more.');
  await trash(folder);
}

async function move(from, to) {
  try { await rename(from, to); }
  catch (error) {
    if (error.code !== 'EXDEV') throw error;
    await cp(from, to, { recursive: true, verbatimSymlinks: true, preserveTimestamps: true });
    await rm(from, { recursive: true, force: true });
  }
}

/**
 * Put a backup's files back. First everything the backup covers in the workspace now (every top-level entry except
 * node_modules, .opendoc and output) is moved into a new backup of kind `before-restore`, so nothing the workspace holds
 * now is lost; then the backup's files are copied in. If the copy fails, the first step is undone.
 * @returns { before: { name, directory, manifest }, restored: manifest }
 */
export async function restoreBackup({ root, dataDir, name, now = new Date() }) {
  const directory = backupsDirectory(dataDir);
  const source = join(directory, name);
  const manifest = await readManifestOf(source);
  if (!manifest) throw new BackupError('missing', 'That backup is not there any more.');
  const wanted = (await readdir(join(source, copyFolder))).sort();
  const current = await backedUpEntries(root);
  const beforeName = await newBackupName(directory, `${basename(root)}-before-restore-${stamp(now)}`);
  const partial = join(directory, `.${beforeName}.partial`);
  await rm(partial, { recursive: true, force: true });
  await mkdir(join(partial, copyFolder), { recursive: true, mode: 0o700 });
  const moved = [];
  try {
    for (const entry of current) { await move(join(root, entry), join(partial, copyFolder, entry)); moved.push(entry); }
    for (const entry of wanted) await cp(join(source, copyFolder, entry), join(root, entry), { recursive: true, verbatimSymlinks: true, preserveTimestamps: true, errorOnExist: true });
  } catch (error) {
    // Undo: remove what was copied in, put back what was moved out.
    for (const entry of wanted) await rm(join(root, entry), { recursive: true, force: true }).catch(() => {});
    for (const entry of moved) await move(join(partial, copyFolder, entry), join(root, entry)).catch(() => {});
    await rm(partial, { recursive: true, force: true }).catch(() => {});
    throw new BackupError('restore-failed', `The backup could not be restored (${error.message}). The workspace was put back the way it was.`);
  }
  const size = await measureEntries(join(partial, copyFolder), moved);
  const before = { formatVersion: 1, kind: 'before-restore', name: beforeName, source: root, workspace: basename(root), from: manifest.to, to: manifest.from, time: now.toISOString(), files: size.files, bytes: size.bytes, entries: moved, restoredFrom: name };
  await writeManifest(partial, before);
  await rename(partial, join(directory, beforeName));
  return { before: { name: beforeName, directory: join(directory, beforeName), manifest: before }, restored: manifest };
}
