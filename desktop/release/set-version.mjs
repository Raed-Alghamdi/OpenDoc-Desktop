#!/usr/bin/env node
// Makes the desktop app carry a version: desktop/package.json, and the PKGBUILD and .SRCINFO in desktop/aur (pkgver and pkgrel; the
// checksum stays SKIP until aur-bump.yml fills it in for a real release). The contracts say `desktop/package.json` always equals the
// root `package.json`, and upstream's merge moves only the root one, so upstream-watch runs this after a merge that changed it.
//
// Usage: node desktop/release/set-version.mjs --version <x.y.z> [--build <n>] [--root <repository folder>]
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { renderPackage } from './aur-package.mjs';

// Returns the files (relative to `root`) it changed.
export function setDesktopVersion(root, version, build = 1) {
  if (!/^\d+\.\d+\.\d+$/.test(version)) throw new Error(`The version must be x.y.z, got "${version}".`);
  const changed = [];
  const write = (relative, text) => {
    const file = path.join(root, relative);
    if (!existsSync(file) || readFileSync(file, 'utf8') !== text) {
      writeFileSync(file, text);
      changed.push(relative);
    }
  };

  const manifest = readFileSync(path.join(root, 'desktop/package.json'), 'utf8');
  const lines = [...manifest.matchAll(/^ {2}"version": ".*",$/gm)];
  if (lines.length !== 1) throw new Error(`desktop/package.json needs exactly one top-level version line, found ${lines.length}.`);
  write('desktop/package.json', manifest.replace(/^ {2}"version": ".*",$/m, `  "version": "${version}",`));

  const aur = path.join(root, 'desktop/aur');
  if (existsSync(aur)) for (const [name, text] of Object.entries(renderPackage(aur, { version, build, sha256: 'SKIP' }))) write(`desktop/aur/${name}`, text);
  return changed;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const { values } = parseArgs({ options: { version: { type: 'string' }, build: { type: 'string', default: '1' }, root: { type: 'string', default: '.' } }, strict: true });
  if (!values.version) {
    console.error('usage: set-version.mjs --version <x.y.z> [--build <n>] [--root <folder>]');
    process.exit(2);
  }
  const changed = setDesktopVersion(path.resolve(values.root), values.version, Number(values.build));
  console.log(changed.length ? `changed: ${changed.join(', ')}` : 'nothing to change');
}
