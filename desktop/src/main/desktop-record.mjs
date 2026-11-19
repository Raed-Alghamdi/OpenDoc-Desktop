// .opendoc/desktop.json (contracts.md, C3): { pid, startedAt, version, build }, present while the app has the
// workspace open. A file whose pid is gone, or whose pid now belongs to another program, is stale.
import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { processExists, runsSameProgram } from './process-info.mjs';

export const desktopRecordFile = root => resolve(root, '.opendoc/desktop.json');

export async function readDesktopRecord(root) {
  let text;
  try { text = await readFile(desktopRecordFile(root), 'utf8'); }
  catch (error) { if (error.code === 'ENOENT') return null; throw error; }
  try {
    const value = JSON.parse(text);
    return value && Number.isSafeInteger(value.pid) ? value : { unreadable: true };
  } catch { return { unreadable: true }; }
}

export async function writeDesktopRecord(root, { version, build }) {
  const file = desktopRecordFile(root);
  await mkdir(dirname(file), { recursive: true });
  const record = { pid: process.pid, startedAt: new Date().toISOString(), version, build };
  const temporary = `${file}.${process.pid}.tmp`;
  await writeFile(temporary, JSON.stringify(record, null, 2) + '\n');
  await rename(temporary, file);
  return record;
}

/** Remove the record only when it is ours: another app instance may own the workspace now. */
export async function removeDesktopRecord(root, pid = process.pid) {
  const record = await readDesktopRecord(root).catch(() => null);
  if (record && record.pid === pid) await rm(desktopRecordFile(root), { force: true });
}

/** `none`, `live` (another opendoc-desktop has the workspace) or `stale` (a leftover to remove). */
export async function inspectDesktopRecord(root, { execPath = process.execPath } = {}) {
  const record = await readDesktopRecord(root);
  if (!record) return { state: 'none' };
  if (record.unreadable) return { state: 'stale', record };
  if (record.pid === process.pid) return { state: 'none', record };
  if (processExists(record.pid) && runsSameProgram(record.pid, execPath)) return { state: 'live', record };
  return { state: 'stale', record };
}

export async function clearStaleDesktopRecord(root) {
  const inspection = await inspectDesktopRecord(root);
  if (inspection.state === 'stale') await rm(desktopRecordFile(root), { force: true });
  return inspection.state;
}
