#!/usr/bin/env node
// The arm64 and x64 macOS builds each write their own latest-mac.yml. The updater reads one file per release and picks the zip for
// its architecture by name (arm64 in the name or not), so the release carries one merged file: the first file's fields, plus the
// other files' `files:` entries.
//
// Usage: node desktop/runtime/merge-mac-metadata.mjs <output> <latest-mac.yml> <latest-mac.yml>...
import { readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const filesBlock = /^files:\n((?:(?: {2}- | {4}).*\n)+)/m;

export function mergeMacMetadata(texts) {
  if (texts.length < 1) throw new Error('Give at least one latest-mac.yml.');
  const [first] = texts;
  const entries = [];
  for (const text of texts) {
    const found = text.match(filesBlock);
    if (!found) throw new Error('A metadata file has no files: list.');
    entries.push(found[1]);
    for (const field of ['version', 'build', 'commit']) {
      const value = (candidate) => candidate.match(new RegExp(`^${field}: (.*)$`, 'm'))?.[1];
      if (value(text) !== value(first)) throw new Error(`The metadata files disagree on ${field}: ${value(first)} and ${value(text)}.`);
    }
  }
  return first.replace(filesBlock, () => `files:\n${entries.join('')}`);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const [output, ...inputs] = process.argv.slice(2);
  if (!output || inputs.length === 0) {
    console.error('usage: merge-mac-metadata.mjs <output> <latest-mac.yml>...');
    process.exit(2);
  }
  writeFileSync(output, mergeMacMetadata(inputs.map((file) => readFileSync(file, 'utf8'))));
  console.log(`${output}: merged ${inputs.length} files`);
}
