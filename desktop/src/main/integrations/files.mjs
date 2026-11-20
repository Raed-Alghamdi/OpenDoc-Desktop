// Small file helpers for the integration module: path questions, a content digest of a folder, and a plain copy.
import { createHash } from 'node:crypto';
import { chmod, copyFile, lstat, mkdir, readFile, readdir, realpath, rm, stat } from 'node:fs/promises';
import { isAbsolute, join, relative, resolve } from 'node:path';

export const exists = async path => { try { await stat(path); return true; } catch { return false; } };
export const isDirectory = async path => { try { return (await stat(path)).isDirectory(); } catch { return false; } };

/** The real path when the path exists, else the resolved one (so a missing path still compares sensibly). */
export async function realOrResolved(path) {
  try { return await realpath(path); } catch { return resolve(path); }
}

/** True when `child` is `parent` or lies below it, comparing real paths (a macOS `/var` link or a symbolic folder is followed). */
export async function isInside(child, parent) {
  if (typeof child !== 'string' || !child || typeof parent !== 'string' || !parent) return false;
  const [a, b] = await Promise.all([realOrResolved(child), realOrResolved(parent)]);
  const path = relative(b, a);
  return path === '' || (!path.startsWith('..') && !isAbsolute(path));
}

export const sameFolder = async (a, b) => (await realOrResolved(a)) === (await realOrResolved(b));

export class TreeError extends Error {
  constructor(message) { super(message); this.name = 'TreeError'; }
}

/** Every file below `dir`, sorted, as `{ path, sha256 }` with `/` separators, plus one digest over names and contents.
 *  Symbolic links are refused: the integration files are plain files (desktop/integrations/check.mjs enforces that). */
export async function readTree(dir) {
  const files = [];
  const folders = [];
  const walk = async (current, prefix) => {
    const names = (await readdir(current)).sort();
    for (const name of names) {
      const path = join(current, name);
      const label = prefix ? `${prefix}/${name}` : name;
      const info = await lstat(path);
      if (info.isSymbolicLink()) throw new TreeError(`${label} is a symbolic link`);
      if (info.isDirectory()) { folders.push(label); await walk(path, label); }
      else if (info.isFile()) files.push({ path: label, sha256: createHash('sha256').update(await readFile(path)).digest('hex') });
      else throw new TreeError(`${label} is not a plain file`);
    }
  };
  await walk(dir, '');
  const hash = createHash('sha256');
  for (const folder of folders) hash.update(`d:${folder}\n`);
  for (const file of files) hash.update(`f:${file.path}:${file.sha256}\n`);
  return { digest: hash.digest('hex'), files, folders };
}

/** Copy a folder of plain files. Modes are normalised (0644, or 0755 when the source can be run, folders 0755) because a source inside
 *  an AppImage mount or a package is read-only, and a read-only copy could never be replaced or removed. */
export async function copyTree(source, target) {
  await mkdir(target, { recursive: true, mode: 0o755 });
  await chmod(target, 0o755);
  for (const name of (await readdir(source)).sort()) {
    const from = join(source, name);
    const to = join(target, name);
    const info = await lstat(from);
    if (info.isSymbolicLink()) throw new TreeError(`${name} is a symbolic link`);
    if (info.isDirectory()) await copyTree(from, to);
    else if (info.isFile()) { await copyFile(from, to); await chmod(to, info.mode & 0o100 ? 0o755 : 0o644); }
    else throw new TreeError(`${name} is not a plain file`);
  }
}

export const removeTree = path => rm(path, { recursive: true, force: true });

/** `~/x` written by a user in a shell variable becomes `<home>/x`; anything else is returned as given. */
export function expandHome(value, home) {
  if (typeof value !== 'string') return value;
  if (value === '~') return home;
  return value.startsWith('~/') ? join(home, value.slice(2)) : value;
}
