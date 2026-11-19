// Small fake runtimes and workspaces for the unit tests of the workspace modules (no Electron, no OpenDoc install).
import { cp, mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

export const scratch = async name => mkdtemp(join(tmpdir(), `opendoc-${name}-`));

/** A runtime folder shaped like the app's: node_modules/opendoc with a package.json, the CLI's workspace.ts and the service. */
export async function makeRuntime(folder, { version = '0.6.1', edition = 'normal', build = 7, format = 1, readOnly = false, runtimeVersion } = {}) {
  const base = join(folder, 'node_modules', 'opendoc');
  await mkdir(join(base, 'src', 'cli'), { recursive: true });
  await mkdir(join(base, 'src', 'server'), { recursive: true });
  await mkdir(join(base, 'bin'), { recursive: true });
  const name = edition === 'headless' ? '@ryanyahya/opendoc-headless' : '@ryanyahya/opendoc';
  await writeFile(join(base, 'package.json'), JSON.stringify({ name, version, opendoc: { edition } }));
  await writeFile(join(base, 'src', 'cli', 'workspace.ts'), `export const workspaceFormat = ${format};\n`);
  await writeFile(join(base, 'src', 'server', 'service.ts'), `export function prepareOpenDocService() { return { ${readOnly ? 'readOnlySupported: true, ' : ''}service: {}, start: async () => {} }; }\n`);
  await writeFile(join(base, 'bin', 'opendoc.mjs'), '// the CLI\n');
  await writeFile(join(folder, 'build-info.json'), JSON.stringify({ build, commit: 'a'.repeat(40), builtAt: '2026-01-01T00:00:00.000Z' }));
  await writeFile(join(folder, 'package.json'), JSON.stringify(runtimeVersion ? { name: 'runtime', version: runtimeVersion } : { name: 'runtime' }));
  return folder;
}

export const pinText = (version, { edition = 'normal', indent = '  ', eol = '\n', final = true } = {}) => {
  const name = edition === 'headless' ? '@ryanyahya/opendoc-headless' : '@ryanyahya/opendoc';
  const text = JSON.stringify({ name: 'my-workspace', private: true, type: 'module', scripts: { check: 'opendoc check' }, dependencies: { opendoc: `npm:${name}@${version}`, zod: '^4.0.0' } }, null, indent).replace(/\n/g, eol);
  return final ? text + eol : text;
};

/**
 * A workspace folder. `pin` (a version) writes package.json; `marker` writes .opendoc/workspace.json (an object, or true for
 * the usual one); `documents` makes folders with an index.tsx; `lock` writes a package-lock.json (its bytes are returned).
 */
export async function makeWorkspace(folder, { pin = '0.6.1', marker = true, documents = ['welcome'], skills = false, lock = true, extra = {} } = {}) {
  await mkdir(folder, { recursive: true });
  if (pin) await writeFile(join(folder, 'package.json'), typeof pin === 'string' && pin.startsWith('{') ? pin : pinText(pin));
  if (marker) {
    await mkdir(join(folder, '.opendoc'), { recursive: true });
    await writeFile(join(folder, '.opendoc', 'workspace.json'), `${JSON.stringify(marker === true ? { formatVersion: 1, createdWith: '0.6.0', edition: 'normal' } : marker, null, 2)}\n`);
  }
  for (const id of documents) {
    await mkdir(join(folder, 'documents', id), { recursive: true });
    await writeFile(join(folder, 'documents', id, 'index.tsx'), `export default ${JSON.stringify(id)};\n`);
  }
  if (skills) {
    await mkdir(join(folder, '.agents', 'skills', 'one'), { recursive: true });
    await writeFile(join(folder, '.agents', 'skills', 'one', 'SKILL.md'), '# one\n');
  }
  if (lock) await writeFile(join(folder, 'package-lock.json'), `${JSON.stringify({ name: 'my-workspace', lockfileVersion: 3, packages: {} }, null, 2)}\n`);
  for (const [name, content] of Object.entries(extra)) {
    await mkdir(join(folder, name, '..'), { recursive: true });
    await writeFile(join(folder, name), content);
  }
  return folder;
}

export const lockBytes = async folder => readFile(join(folder, 'package-lock.json')).catch(() => null);
export { cp };
