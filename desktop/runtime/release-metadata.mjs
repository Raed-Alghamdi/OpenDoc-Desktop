#!/usr/bin/env node
// Adds `build:` and `commit:` to electron-builder's update metadata: electron-builder knows no build
// number, and the updater treats a newer build of the same version as an update only when the metadata carries one. The stock
// updater ignores the extra keys. Every build runs this on every latest*.yml, before anything is uploaded.
//
// Usage: node desktop/runtime/release-metadata.mjs --build <integer> [--commit <sha>] <folder or latest*.yml>...
import { readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';

export function addBuildFields(text, build, commit) {
  if (!/^[1-9]\d*$/.test(String(build))) throw new Error(`The build number must be a positive whole number, got "${build}".`);
  if (commit !== undefined && !/^[0-9a-f]{7,64}$/.test(commit)) throw new Error(`The commit must be a hex hash, got "${commit}".`);
  const stripped = text.replace(/^build: .*\n/m, '').replace(/^commit: .*\n/m, '');
  if (!/^version: .+\n/m.test(stripped)) throw new Error('The metadata has no top-level version.');
  return stripped.replace(/^(version: .*\n)/m, `$1build: ${build}\n${commit ? `commit: ${commit}\n` : ''}`);
}

function metadataFiles(inputs) {
  const files = [];
  for (const input of inputs) {
    if (statSync(input).isDirectory()) {
      for (const name of readdirSync(input).sort()) if (/^latest.*\.yml$/.test(name)) files.push(path.join(input, name));
    } else files.push(input);
  }
  return files;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const { values, positionals } = parseArgs({ options: { build: { type: 'string' }, commit: { type: 'string' } }, allowPositionals: true, strict: true });
  const files = metadataFiles(positionals);
  if (values.build === undefined || files.length === 0) {
    console.error('usage: release-metadata.mjs --build <integer> [--commit <sha>] <folder or latest*.yml>...');
    process.exit(2);
  }
  for (const file of files) {
    writeFileSync(file, addBuildFields(readFileSync(file, 'utf8'), values.build, values.commit));
    console.log(`${path.basename(file)}: build ${values.build}${values.commit ? `, commit ${values.commit.slice(0, 12)}` : ''}`);
  }
}
