// The manifest: what the module did, per app, kept in the app's data folder so undo removes exactly that. Written atomically.
//
//   { "version": 1,
//     "copy": { "path", "digest", "build", "updatedAt" },          the stable copy (absent until something is connected)
//     "apps": { "<id>": { ...what was done... } } }               one record per connected app
import { chmod, mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';

export const manifestVersion = 1;

export function createManifest(file) {
  /** `{ manifest, problem }`: a missing file is an empty manifest; a damaged one is moved aside and reported. */
  async function read() {
    let text;
    try { text = await readFile(file, 'utf8'); }
    catch (error) { if (error.code === 'ENOENT') return { manifest: empty(), problem: null }; throw error; }
    try {
      const value = JSON.parse(text);
      if (value && typeof value === 'object' && !Array.isArray(value) && value.apps && typeof value.apps === 'object') return { manifest: { ...value, version: manifestVersion }, problem: null };
    } catch { /* fall through */ }
    const aside = `${file}.damaged-${Date.now()}`;
    await rename(file, aside).catch(() => {});
    return { manifest: empty(), problem: `The integration record could not be read. It was moved to ${aside}.` };
  }

  async function write(manifest) {
    if (!manifest.copy && Object.keys(manifest.apps).length === 0) { await rm(file, { force: true }); return; }
    await mkdir(dirname(file), { recursive: true });
    const temporary = `${file}.${process.pid}.tmp`;
    await writeFile(temporary, JSON.stringify(manifest, null, 2) + '\n', { mode: 0o600 });
    await chmod(temporary, 0o600);
    await rename(temporary, file);
  }

  /** Apply a change to the manifest (a function from a copy of it to the next one) and save it. Callers are serialised by the module. */
  async function update(change) {
    const { manifest } = await read();
    const next = change(structuredClone(manifest)) ?? manifest;
    await write(next);
    return next;
  }

  return { file, read, update };
}

const empty = () => ({ version: manifestVersion, apps: {} });
