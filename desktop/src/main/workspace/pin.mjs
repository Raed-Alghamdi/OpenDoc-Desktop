// The workspace's package.json: read, and move the OpenDoc pin up without disturbing the file. The pin is the one
// string that tells every device which OpenDoc a workspace is on, and the file syncs, so a rewrite keeps the file's
// indentation, key order, line endings, byte order mark and final newline, and goes in atomically. package-lock.json is
// never touched, and a pin is never lowered: another device may have moved it up while the app was asking a question.
import { chmod, lstat, readFile, realpath, rename, rm, stat, writeFile } from 'node:fs/promises';
import { basename, dirname, join, sep } from 'node:path';
import { compareVersions, packageNames, parseVersion } from './versions.mjs';

const manifestFile = root => join(root, 'package.json');
const bom = '﻿';
const parseText = text => JSON.parse(text.startsWith(bom) ? text.slice(1) : text);

export class PinError extends Error {
  constructor(code, message) { super(message); this.name = 'PinError'; this.code = code; }
}

/** `{ text, manifest }`, or null when there is no package.json; throws a readable error when it is not JSON. A leading byte order mark is accepted. */
export async function readManifest(root) {
  let text;
  try { text = await readFile(manifestFile(root), 'utf8'); }
  catch (error) { if (error.code === 'ENOENT') return null; throw error; }
  try { return { text, manifest: parseText(text) }; }
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
    const manifest = parseText(text);
    if (typeof manifest?.dependencies?.opendoc !== 'string') throw new Error('The workspace has no OpenDoc pin to move.');
    manifest.dependencies.opendoc = alias;
    const indent = /^[ \t]+(?=")/m.exec(text)?.[0] ?? '  ';
    const eol = text.includes('\r\n') ? '\r\n' : '\n';
    next = (text.startsWith(bom) ? bom : '') + JSON.stringify(manifest, null, indent).replace(/\n/g, eol) + (/\r?\n$/.test(text) ? eol : '');
  }
  if (parseText(next)?.dependencies?.opendoc !== alias) throw new Error('The pin could not be rewritten safely, so package.json was left as it is.');
  return next;
}

const versionOfPin = pin => typeof pin === 'string' ? pin.slice(pin.lastIndexOf('@') + 1) : null;

/**
 * Move the pin to `version`, atomically, and only upward: the file is read again here, and a pin that is already newer (it
 * was moved up from another device while the app was asking) is left alone with a PinError ('newer-pin'). A package.json that
 * is a symlink is written through to its real file when that is inside the workspace, and refused otherwise, so a symlink is
 * never replaced by a regular file. Returns the new text.
 */
export async function writePin(root, version, edition = 'normal') {
  const loaded = await readManifest(root);
  if (!loaded) throw new PinError('no-package', 'The workspace has no package.json.');
  const current = versionOfPin(loaded.manifest?.dependencies?.opendoc);
  if (parseVersion(current) && compareVersions(current, version) > 0) throw new PinError('newer-pin', `The workspace is now on OpenDoc ${current}, newer than ${version} (another device moved it up while this app was asking). It was not changed.`);
  const next = pinnedText(loaded.text, version, edition);
  if (next === loaded.text) return next;
  const link = manifestFile(root);
  let file = link;
  if ((await lstat(link)).isSymbolicLink()) {
    file = await realpath(link);
    if (!file.startsWith((await realpath(root)) + sep)) throw new PinError('outside-package', `package.json is a link to ${file}, which is outside the workspace, so the app did not rewrite it.`);
  }
  const mode = (await stat(file)).mode & 0o7777;
  const temporary = join(dirname(file), `${basename(file)}.opendoc-${process.pid}.part`);
  try {
    await writeFile(temporary, next, { mode });
    await chmod(temporary, mode);
    await rename(temporary, file);
  } catch (error) { await rm(temporary, { force: true }).catch(() => {}); throw error; }
  return next;
}
