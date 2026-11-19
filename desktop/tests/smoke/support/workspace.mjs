// A scratch workspace linked to a runtime folder, the way the app links a managed one: what `opendoc init` makes, with the
// runtime's node_modules as a symlink instead of an npm install. Shared by the runtime test and the app test.
import { chmodSync, cpSync, lstatSync, mkdirSync, readdirSync, symlinkSync, writeFileSync } from 'node:fs';
import path from 'node:path';

/** Make everything under `directory` writable by its owner (the starter files come from a read-only runtime). */
export function makeWritable(directory) {
  for (const name of readdirSync(directory)) {
    const file = path.join(directory, name);
    const stat = lstatSync(file);
    if (stat.isSymbolicLink()) continue;
    chmodSync(file, stat.mode | (stat.isDirectory() ? 0o300 : 0o200));
    if (stat.isDirectory()) makeWritable(file);
  }
}

export function makeWorkspace(runtime, root, version) {
  mkdirSync(path.join(root, '.opendoc'), { recursive: true });
  cpSync(path.join(runtime, 'node_modules', 'opendoc', 'starter'), root, { recursive: true });
  chmodSync(root, 0o755);
  makeWritable(root);
  writeFileSync(path.join(root, 'package.json'), `${JSON.stringify({
    name: 'opendoc-workspace', private: true, type: 'module', dependencies: { opendoc: `npm:@ryanyahya/opendoc@${version}` },
  }, null, 2)}\n`);
  writeFileSync(path.join(root, 'tsconfig.json'), `${JSON.stringify({ extends: 'opendoc/tsconfig.workspace.json', include: ['documents', 'templates', 'themes'] }, null, 2)}\n`);
  writeFileSync(path.join(root, '.opendoc', 'workspace.json'), `${JSON.stringify({ formatVersion: 1, createdWith: version, edition: 'normal', managed: true }, null, 2)}\n`);
  symlinkSync(path.join(runtime, 'node_modules'), path.join(root, 'node_modules'), 'dir');
}
