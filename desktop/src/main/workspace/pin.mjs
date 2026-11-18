// The workspace's package.json: read, and move the OpenDoc pin up without disturbing the file. The pin is the one
// string that tells every device which OpenDoc a workspace is on, and the file syncs, so a rewrite keeps the file's
// indentation, key order, line endings and final newline, and goes in atomically. package-lock.json is never touched.
import { chmod, readFile, rename, stat, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { packageNames } from './versions.mjs';

const manifestFile = root => join(root, 'package.json');

/** `{ text, manifest }`, or null when there is no package.json; throws a readable error when it is not JSON. */
export async function readManifest(root) {
  let text;
  try { text = await readFile(manifestFile(root), 'utf8'); }
  catch (error) { if (error.code === 'ENOENT') return null; throw error; }
  try { return { text, manifest: JSON.parse(text) }; }
  catch (error) { throw new Error(`The workspace's package.json is not valid JSON (${error.message}).`); }
}

const pinPattern = new RegExp(`("opendoc"\\s*:\\s*")npm:(?:${Object.values(packageNames).map(name => name.replace(/[/@.-]/g, '\\$&')).join('|')})@\\d+\\.\\d+\\.\\d+(")`, 'g');

/** The text of a package.json with the OpenDoc pin set to `version` (edition kept). Throws when it cannot be done exactly. */
export function pinnedText(text, version, edition = 'normal') {
  const alias = `npm:${packageNames[edition]}@${version}`;
  const matches = [...text.matchAll(pinPattern)];
  let next;
  if (matches.length === 1) next = text.replace(pinPattern, `$1${alias}$2`);
  else {
    // A pin spelled in a way the text edit does not recognise: rewrite through JSON, keeping the indentation and the ending.
    const manifest = JSON.parse(text);
    if (typeof manifest?.dependencies?.opendoc !== 'string') throw new Error('The workspace has no OpenDoc pin to move.');
    manifest.dependencies.opendoc = alias;
    const indent = /^[ \t]+(?=")/m.exec(text)?.[0] ?? '  ';
    const eol = text.includes('\r\n') ? '\r\n' : '\n';
    next = JSON.stringify(manifest, null, indent).replace(/\n/g, eol) + (/\r?\n$/.test(text) ? eol : '');
  }
  if (JSON.parse(next)?.dependencies?.opendoc !== alias) throw new Error('The pin could not be rewritten safely, so package.json was left as it is.');
  return next;
}

/** Move the pin to `version` (never lowers it: the caller decides), atomically. Returns the new text. */
export async function writePin(root, version, edition = 'normal') {
  const file = manifestFile(root);
  const { text } = await readManifest(root);
  const next = pinnedText(text, version, edition);
  if (next === text) return next;
  const mode = (await stat(file)).mode & 0o7777;
  const temporary = `${file}.opendoc-${process.pid}.tmp`;
  await writeFile(temporary, next, { mode });
  await chmod(temporary, mode);
  await rename(temporary, file);
  return next;
}
