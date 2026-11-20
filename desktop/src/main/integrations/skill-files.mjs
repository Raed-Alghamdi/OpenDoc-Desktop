// Cursor and Copilot CLI: the plain skill copied into the one folder that app reads (`~/.cursor/skills/opendoc/`,
// `~/.copilot/skills/opendoc/`). No vendor command runs. The manifest keeps the files written (with their hashes) and the folders
// created, so undo removes exactly those and nothing a user added.
import { mkdir, readdir, rename, rm, rmdir } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { copyTree, exists, readTree } from './files.mjs';

const source = ctx => join(ctx.copyDirectory, 'skills', 'opendoc');
export const destination = (ctx, app = ctx.app) => join(ctx.home, ...app.skillFolder);

const sameFiles = (a, b) => a.length === b.length && a.every((file, index) => file.path === b[index].path && file.sha256 === b[index].sha256);

/** The folders from the home folder down to `target` that do not exist yet, outermost first. */
async function missingFolders(home, target) {
  const missing = [];
  for (let folder = target; folder !== home && folder !== dirname(folder); folder = dirname(folder)) {
    if (!(await exists(folder))) missing.unshift(folder);
  }
  return missing;
}

export async function install(ctx) {
  const target = destination(ctx);
  const wanted = await readTree(source(ctx));
  const present = await exists(target);
  if (present && !ctx.wasConnected) {
    const current = await readTree(target).catch(() => null);
    const same = current && sameFiles(current.files, wanted.files);
    return { ok: true, code: 'already-present', changed: false, summary: same ? `The OpenDoc skill is already in ${target}, put there by hand. It was left as it is.` : `A folder ${target} already exists and was not made by this app. It was left as it is.` };
  }

  const created = present ? [] : await missingFolders(ctx.home, target);
  ctx.record.destination = target;
  ctx.record.createdFolders = [...new Set([...(ctx.record.createdFolders ?? []), ...created.slice(0, -1)])];
  ctx.record.files = [];
  await ctx.save();
  try {
    await mkdir(dirname(target), { recursive: true });
    // Written beside the target and moved into place, so a skill that is there is whole.
    const temporary = `${target}.tmp-${process.pid}`;
    await rm(temporary, { recursive: true, force: true });
    await copyTree(source(ctx), temporary);
    if (present) { const old = `${target}.old-${process.pid}`; await rename(target, old); await rename(temporary, target); await rm(old, { recursive: true, force: true }); }
    else await rename(temporary, target);
  } catch (error) {
    ctx.fail('Copy the skill', `${error.message}`);
    return rollBack(ctx, { ok: false, code: 'failed', summary: `Could not copy the skill into ${target}: ${error.message}` });
  }
  ctx.record.files = wanted.files;
  await ctx.save();
  ctx.note('Copy the skill', `Wrote ${wanted.files.length} file(s) to ${target}.`);

  const check = await verify(ctx, ctx.record);
  if (!check.ok) return rollBack(ctx, { ok: false, code: 'verify-failed', summary: check.summary });
  return { ok: true, code: 'connected', changed: true, summary: `Copied the OpenDoc skill to ${target}.` };
}

async function rollBack(ctx, failure) {
  ctx.prefix = 'Undo: ';
  const undone = await uninstall(ctx, ctx.record);
  ctx.prefix = '';
  return { ...failure, leftBehind: !undone.ok, undone: undone.ok, summary: undone.ok ? `${failure.summary} What had been written was removed again.` : `${failure.summary} Removing what had been written also failed: ${undone.summary}` };
}

/** The files in the destination are exactly the files the record names. */
async function verify(ctx, record) {
  let current;
  try { current = await readTree(record.destination); } catch { return { ok: false, missing: true, summary: `The skill folder ${record.destination} is not there.` }; }
  if (!sameFiles(current.files, record.files ?? [])) return { ok: false, summary: `The files in ${record.destination} are not the ones this app wrote.` };
  return { ok: true };
}

export async function uninstall(ctx, record) {
  const target = record.destination;
  if (!target) return { ok: true, code: 'disconnected', changed: false, summary: 'Nothing had been written.' };
  const modified = [];
  const extra = [];
  if (await exists(target)) {
    // Remove the files this app wrote, as long as they are still what it wrote. A file that changed since is kept and reported;
    // a file this app never wrote is the user's and stays without a fuss.
    let present = [];
    try { present = (await readTree(target)).files; } catch { /* an odd entry: nothing is removed below, and the result says so */ }
    const ours = new Map((record.files ?? []).map(file => [file.path, file.sha256]));
    for (const file of present) {
      if (!ours.has(file.path)) extra.push(file.path);
      else if (ours.get(file.path) !== file.sha256) modified.push(file.path);
      else await rm(join(target, ...file.path.split('/')), { force: true });
    }
    // Folders inside the skill that are now empty, deepest first, then the skill folder itself.
    const walk = async folder => {
      for (const entry of await readdir(folder, { withFileTypes: true })) if (entry.isDirectory()) await walk(join(folder, entry.name));
      if ((await readdir(folder)).length === 0) await rmdir(folder);
    };
    await walk(target).catch(() => {});
  }
  if (modified.length) {
    ctx.fail('Remove the skill', `Left in place because they changed after this app wrote them: ${modified.join(', ')}.`);
    return { ok: false, code: 'modified', leftBehind: true, summary: `Some files in ${target} were changed after this app wrote them and were left in place: ${modified.join(', ')}.` };
  }
  if (extra.length) ctx.note('Remove the skill', `Removed the files this app wrote from ${target}. Kept ${extra.join(', ')}, which this app did not write.`);
  else if (await exists(target)) return { ok: false, code: 'verify-failed', leftBehind: true, summary: `${target} could not be removed.` };
  else ctx.note('Remove the skill', `Removed ${target}.`);
  // Folders this app created on the way (`skills`, and the config folder when there was none), innermost first, only when empty.
  const removed = [];
  for (const folder of [...(record.createdFolders ?? [])].reverse()) {
    try { await rmdir(folder); removed.push(folder); } catch { /* not empty: the user put something there */ }
  }
  if (removed.length) ctx.note('Remove the folders this app created', `Removed ${removed.join(', ')}.`);
  return { ok: true, code: 'disconnected', changed: true, summary: `Removed the OpenDoc skill from ${target}.` };
}

export async function check(ctx) {
  const target = destination(ctx);
  if (!(await exists(target))) return { connected: false, summary: 'The OpenDoc skill is not in place.' };
  if (ctx.record) {
    const result = await verify(ctx, ctx.record);
    if (result.ok) return { connected: true, own: true, summary: `The skill is in ${target}.` };
    return { connected: false, own: true, summary: result.summary };
  }
  let wanted; let current;
  try { wanted = await readTree(source(ctx)); current = await readTree(target); } catch { return { connected: false, summary: `${target} exists but does not hold the OpenDoc skill.` }; }
  return sameFiles(wanted.files, current.files)
    ? { connected: true, own: false, summary: `The skill is in ${target}, put there by hand, not by this app.` }
    : { connected: false, own: false, summary: `${target} exists but holds something else.` };
}
