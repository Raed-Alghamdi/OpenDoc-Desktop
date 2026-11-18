// What the app's runtime says about itself, read from its files (nothing is run): the OpenDoc version and edition, the
// workspace format its CLI writes, and whether its service can open a workspace read-only (U4).
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { packageNames, parseVersion } from './versions.mjs';

const read = async path => { try { return await readFile(path, 'utf8'); } catch { return null; } };

/**
 * `{ ok: true, version, edition, workspaceFormat }` or `{ ok: false, message }`.
 * The format is the CLI's `workspaceFormat` constant (src/cli/workspace.ts of the runtime); the app never assumes a number.
 */
export async function readRuntimeInfo(runtime) {
  const base = join(runtime, 'node_modules', 'opendoc');
  const text = await read(join(base, 'package.json'));
  let metadata;
  try { metadata = JSON.parse(text); } catch { return { ok: false, message: `The OpenDoc runtime that comes with the app was not found in ${runtime}.` }; }
  const edition = metadata?.opendoc?.edition;
  if (!['normal', 'headless'].includes(edition) || metadata.name !== packageNames[edition] || !parseVersion(metadata.version)) return { ok: false, message: 'The OpenDoc runtime that comes with the app has no valid name, edition or version.' };
  const source = await read(join(base, 'src', 'cli', 'workspace.ts'));
  const format = /export const workspaceFormat\s*=\s*(\d+)/.exec(source ?? '')?.[1];
  if (!format) return { ok: false, message: 'The OpenDoc runtime that comes with the app does not say which workspace format it writes.' };
  return { ok: true, version: metadata.version, edition, workspaceFormat: Number(format) };
}

/**
 * Whether the runtime's service honours `readOnly` (U4 sets `readOnlySupported: true` on what `prepareOpenDocService`
 * returns). Read from the service's source, so it is known before anything is changed; the service host checks the real
 * object when it starts, and fails with `read-only-unsupported` if this guess was wrong.
 */
export async function readOnlySupported(runtime) {
  const source = await read(join(runtime, 'node_modules', 'opendoc', 'src', 'server', 'service.ts'));
  return Boolean(source && /readOnlySupported\s*:\s*true/.test(source));
}
