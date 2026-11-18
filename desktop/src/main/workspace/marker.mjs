// `.opendoc/workspace.json`, the marker that makes a folder a workspace on this device (plan 3.4). The app adds
// `managed: true` (per device: the file is not synced in the maintainer's setup, though upstream's .gitignore keeps it
// in git, so a git user carries the flag to another device; U1 acts on it only when the runtime is really the app's).
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { basename, dirname, join } from 'node:path';

const markerFile = root => join(root, '.opendoc', 'workspace.json');

/** `{ state: 'none' }`, `{ state: 'ok', marker, text }` or `{ state: 'invalid', message }`. */
export async function readMarker(root) {
  let text;
  try { text = await readFile(markerFile(root), 'utf8'); }
  catch (error) { if (error.code === 'ENOENT' || error.code === 'ENOTDIR') return { state: 'none' }; return { state: 'invalid', message: `Cannot read ${markerFile(root)}: ${error.message}` }; }
  try {
    const marker = JSON.parse(text);
    if (!marker || typeof marker !== 'object' || Array.isArray(marker)) throw new Error('not an object');
    return { state: 'ok', marker, text };
  } catch { return { state: 'invalid', message: `${markerFile(root)} is damaged, so the app cannot tell what this workspace is. Nothing was changed.` }; }
}

async function writeMarker(root, text) {
  await mkdir(join(root, '.opendoc'), { recursive: true });
  const file = markerFile(root);
  const temporary = join(dirname(file), `.${basename(file)}.opendoc-${process.pid}.part`);
  await writeFile(temporary, text);
  await rename(temporary, file);
}

/** A synced workspace new to this device: a marker made from what the runtime knows. */
export async function adoptWorkspace(root, { formatVersion, edition = 'normal' }) {
  await writeMarker(root, `${JSON.stringify({ formatVersion, edition, managed: true }, null, 2)}\n`);
}

/** An existing marker (an npm workspace opened in the app for the first time) gets `managed: true`, nothing else changes. */
export async function markManaged(root) {
  const current = await readMarker(root);
  if (current.state !== 'ok') throw new Error('The workspace marker is missing or damaged.');
  if (current.marker.managed === true) return false;
  const indent = /^[ \t]+(?=")/m.exec(current.text)?.[0] ?? '  ';
  const eol = current.text.includes('\r\n') ? '\r\n' : '\n';
  await writeMarker(root, JSON.stringify({ ...current.marker, managed: true }, null, indent).replace(/\n/g, eol) + (/\r?\n$/.test(current.text) ? eol : ''));
  return true;
}

/** Stamp the marker with the workspace format the app's CLI now writes (after an upgrade) or the one a restored backup had. */
export async function setFormatVersion(root, formatVersion) {
  const current = await readMarker(root);
  if (current.state !== 'ok') throw new Error('The workspace marker is missing or damaged.');
  if (current.marker.formatVersion === formatVersion) return false;
  const indent = /^[ \t]+(?=")/m.exec(current.text)?.[0] ?? '  ';
  const eol = current.text.includes('\r\n') ? '\r\n' : '\n';
  await writeMarker(root, JSON.stringify({ ...current.marker, formatVersion }, null, indent).replace(/\n/g, eol) + (/\r?\n$/.test(current.text) ? eol : ''));
  return true;
}
