// The stable copy: the app's `integrations/` folder copied to its data folder, so Claude Code (which reads a local
// marketplace in place) and the other apps are never pointed into the app bundle or an AppImage mount, which move or vanish.
import { rename, rm } from 'node:fs/promises';
import { requiredFiles } from './apps.mjs';
import { copyTree, exists, readTree } from './files.mjs';

/** Read the app's own integration files and check that every file the connectors need is there. */
export async function readSource(source) {
  let tree;
  try { tree = await readTree(source); }
  catch (error) { return { ok: false, summary: `The app's integration files at ${source} could not be read: ${error.message}` }; }
  const have = new Set(tree.files.map(file => file.path));
  const missing = requiredFiles.filter(path => !have.has(path));
  if (missing.length) return { ok: false, summary: `The app's integration files at ${source} are incomplete (missing ${missing.join(', ')}).` };
  return { ok: true, digest: tree.digest, files: tree.files };
}

/** Make `target` hold exactly what `source` holds. A copy that already matches is left alone.
 *  Built beside the target and swapped in by renames, so a reader never sees a half-written copy. */
export async function ensureCopy({ source, target }) {
  const wanted = await readSource(source);
  if (!wanted.ok) return { ok: false, changed: false, digest: null, summary: wanted.summary };
  const current = (await exists(target)) ? await readTree(target).catch(() => null) : null;
  if (current && current.digest === wanted.digest) return { ok: true, changed: false, digest: wanted.digest, previousDigest: wanted.digest, summary: `The copy in ${target} is up to date.` };
  const temporary = `${target}.tmp-${process.pid}`;
  const old = `${target}.old-${process.pid}`;
  try {
    await rm(temporary, { recursive: true, force: true });
    await copyTree(source, temporary);
    const written = await readTree(temporary);
    if (written.digest !== wanted.digest) throw new Error('the copy does not match the source');
    await rm(old, { recursive: true, force: true });
    if (await exists(target)) await rename(target, old);
    try { await rename(temporary, target); }
    catch (error) { if (await exists(old)) await rename(old, target).catch(() => {}); throw error; }
    await rm(old, { recursive: true, force: true });
  } catch (error) {
    await rm(temporary, { recursive: true, force: true }).catch(() => {});
    return { ok: false, changed: false, digest: null, summary: `The integration files could not be copied to ${target}: ${error.message}` };
  }
  return { ok: true, changed: true, digest: wanted.digest, previousDigest: current?.digest ?? null, summary: current ? `Updated the copy in ${target}.` : `Copied the integration files to ${target}.` };
}

export async function removeCopy(target) {
  await rm(target, { recursive: true, force: true });
}

/** The digest of the copy as it is on disk now, or null when it is missing or damaged. */
export async function copyDigest(target) {
  if (!(await exists(target))) return null;
  return (await readTree(target).catch(() => null))?.digest ?? null;
}
