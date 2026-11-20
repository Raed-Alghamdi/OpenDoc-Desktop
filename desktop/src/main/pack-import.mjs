// Opening a design pack from outside the page (plan E9): which launch arguments are packs, reading a pack file in the main process
// (the sandboxed page cannot read paths), the queue that holds a pack until a workspace page can take it, and the rule for
// "Show in folder". Nothing here needs Electron, so the unit tests read it directly.
import { open, realpath, stat } from 'node:fs/promises';
import { basename, isAbsolute, join, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

/** The largest pack the app reads: the same limit the Import dialog and the service enforce. */
export const packSizeLimit = 64 * 1024 * 1024;

const isPackName = name => /\.zip$/i.test(name);

/**
 * The packs named in a command line (the launch arguments, or a second launch's): every argument that is a path to a `.zip`
 * (`.opendoc.zip` is the pack's own name; a browser may rename a download, and "Open With" can offer any zip), as an absolute
 * path. A file manager may pass `file://` addresses (`Exec=... %U`). Flags and the app's own entry script are never packs.
 */
export function packPathsFromArguments(argv, cwd) {
  const found = [];
  for (const raw of argv ?? []) {
    if (typeof raw !== 'string' || raw.startsWith('-')) continue;
    let path = raw;
    if (/^file:\/\//i.test(path)) {
      try { path = fileURLToPath(path); } catch { continue; }
    }
    if (!isPackName(path)) continue;
    found.push(isAbsolute(path) ? path : resolve(cwd ?? process.cwd(), path));
  }
  return [...new Set(found)];
}

const mebibytes = bytes => `${Math.round(bytes / (1024 * 1024))} MiB`;

/**
 * Read a pack file. Resolves { ok: true, name, bytes } or { ok: false, name, message } (a sentence for the app's own error box).
 * At most `limit` bytes are read, even if the file grows while it is being read.
 */
export async function readPackFile(path, { limit = packSizeLimit } = {}) {
  const name = basename(String(path));
  let handle;
  try {
    const info = await stat(path);
    if (!info.isFile()) return { ok: false, name, message: `${name} is not a file.` };
    if (info.size > limit) return { ok: false, name, message: `${name} is ${mebibytes(info.size)}. A design pack can be at most ${mebibytes(limit)}, so it was not opened.` };
    handle = await open(path, 'r');
    const buffer = Buffer.allocUnsafe(Math.min(info.size, limit) + 1);
    let length = 0;
    while (length < buffer.length) {
      const { bytesRead } = await handle.read(buffer, length, buffer.length - length, null);
      if (bytesRead === 0) break;
      length += bytesRead;
    }
    if (length > limit) return { ok: false, name, message: `${name} is larger than ${mebibytes(limit)}. A design pack can be at most that, so it was not opened.` };
    return { ok: true, name, bytes: new Uint8Array(buffer.buffer, buffer.byteOffset, length) };
  } catch (error) {
    const reason = error.code === 'ENOENT' ? 'It was not found.' : error.code === 'EACCES' ? 'The app is not allowed to read it.' : error.message;
    return { ok: false, name, message: `${name} could not be opened. ${reason}` };
  } finally { await handle?.close().catch(() => {}); }
}

/**
 * Packs that were opened before a workspace page could take them: a launch argument, macOS's open-file (which can arrive before the
 * app is ready), a second launch. `attach` hands over what waited and everything after. Only the newest pack is kept while none is
 * attached, because the Import dialog reviews one pack at a time (a second request would replace the first).
 */
export function createPackInbox() {
  let listener = null;
  let waiting = null;
  return {
    push(path) {
      if (listener) listener(path);
      else waiting = path;
    },
    attach(next) {
      listener = next;
      if (waiting !== null) { const path = waiting; waiting = null; next(path); }
    },
    get pending() { return waiting; },
  };
}

/**
 * "Show in folder" is for a pack the app itself saved: a path that is absolute and, once every link in it is resolved, is a file
 * inside the open workspace's output/packs/. Resolves the real path to reveal, or null. A link in the path or in the folders above
 * it that leads anywhere else is refused, because the real path then falls outside `<workspace>/output/packs`.
 */
export async function revealablePackPath(workspaceRoot, path) {
  if (typeof path !== 'string' || path.length === 0 || path.includes('\0') || !isAbsolute(path)) return null;
  try {
    const packs = join(await realpath(workspaceRoot), 'output', 'packs');
    const real = await realpath(path);
    if (!real.startsWith(packs + sep)) return null;
    if (!(await stat(real)).isFile()) return null;
    return real;
  } catch { return null; }
}
