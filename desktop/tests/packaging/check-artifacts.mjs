#!/usr/bin/env node
// Checks the Linux installers in desktop/dist: each file carries the app version and the build number in its own metadata (not
// just its name; the AppImage has no version in its name), and latest-linux.yml lists every installer and carries build: and commit:.
//
// Usage: node desktop/tests/packaging/check-artifacts.mjs [--dist <folder>] [--require-rpm]
// Reads package metadata with dpkg-deb, pacman and rpm where they exist, and otherwise straight from the archive (ar and bsdtar),
// except for rpm, which then is checked by file name only.
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';

const desktop = path.resolve(fileURLToPath(new URL('../..', import.meta.url)));
const { values } = parseArgs({ options: { dist: { type: 'string' }, 'require-rpm': { type: 'boolean', default: false } }, strict: true });
const dist = path.resolve(values.dist ?? path.join(desktop, 'dist'));
const version = JSON.parse(readFileSync(path.join(desktop, 'package.json'), 'utf8')).version;
const info = JSON.parse(readFileSync(path.join(desktop, 'build', 'runtime', `${process.platform}-${process.arch}`, 'build-info.json'), 'utf8'));
const build = String(info.build);

const tool = (command, args, input) => {
  const result = spawnSync(command, args, { encoding: 'utf8', input, maxBuffer: 64 << 20 });
  return result.error || result.status !== 0 ? null : result.stdout;
};
const field = (text, name) => text.match(new RegExp(`^${name}\\s*[:=]\\s*(.*)$`, 'm'))?.[1].trim();
const files = readdirSync(dist);

// The scalable and symbolic icons are mapped in through fpm (electron-builder installs only the sized PNGs).
const iconFiles = [
  '/usr/share/icons/hicolor/scalable/apps/opendoc-desktop.svg',
  '/usr/share/icons/hicolor/symbolic/apps/opendoc-desktop-symbolic.svg',
];
const assertIcons = (listing) => { for (const icon of iconFiles) assert.ok(listing.split('\n').some((line) => line.trim().endsWith(icon.slice(1))), `missing ${icon}`); };
const debListing = (file) => {
  const direct = tool('dpkg-deb', ['-c', file]);
  if (direct !== null) return direct;
  const member = tool('ar', ['t', file]).split('\n').find((entry) => entry.startsWith('data.tar'));
  const data = spawnSync('ar', ['p', file, member], { maxBuffer: 1 << 30 }).stdout;
  return spawnSync('bsdtar', ['-tf', '-'], { input: data, encoding: 'utf8', maxBuffer: 64 << 20 }).stdout;
};
const only = (extension) => {
  const found = files.filter((name) => name.endsWith(extension));
  assert.equal(found.length, 1, `expected one ${extension} in ${dist}, found ${found.length}`);
  return found[0];
};

const checks = [];
const check = (label, run) => {
  try { checks.push(`ok    ${label}: ${run()}`); } catch (error) { checks.push(`FAIL  ${label}: ${error.message}`); process.exitCode = 1; }
};

check('deb', () => {
  const name = only('.deb');
  const file = path.join(dist, name);
  let control = tool('dpkg-deb', ['-f', file]);
  if (control === null) {
    const members = tool('ar', ['t', file]).split('\n');
    const member = members.find((entry) => entry.startsWith('control.tar'));
    const bytes = spawnSync('ar', ['p', file, member], { maxBuffer: 64 << 20 }).stdout;
    control = spawnSync('bsdtar', ['-xOf', '-', './control'], { input: bytes, encoding: 'utf8' }).stdout;
  }
  assert.equal(field(control, 'Package'), 'opendoc-desktop');
  assert.equal(field(control, 'Version'), `${version}-${build}`);
  assert.equal(name, `opendoc-desktop_${version}-${build}_amd64.deb`);
  assertIcons(debListing(file));
  return `${field(control, 'Version')} (${field(control, 'Architecture')}, Maintainer ${field(control, 'Maintainer')})`;
});

check('pacman', () => {
  const name = only('.pacman');
  const file = path.join(dist, name);
  const text = tool('pacman', ['-Qip', file]) ?? tool('bsdtar', ['-xOf', file, '.PKGINFO']);
  const pkgver = field(text, 'Version') ?? field(text, 'pkgver');
  assert.equal(pkgver, `${version}-${build}`);
  assertIcons(tool('bsdtar', ['-tf', file]));
  assert.equal(name, `opendoc-desktop-${version}-${build}-x64.pacman`);
  return pkgver;
});

check('rpm', () => {
  const name = files.find((entry) => entry.endsWith('.rpm'));
  if (!name) throw new Error('no .rpm in dist');
  assert.equal(name, `opendoc-desktop-${version}-${build}.x86_64.rpm`);
  const text = tool('rpm', ['-qip', path.join(dist, name)]);
  if (text === null) {
    if (values['require-rpm']) throw new Error('rpm is not available to read the package');
    return `${name} (name only: rpm is not installed)`;
  }
  assert.equal(field(text, 'Version'), version);
  assert.equal(field(text, 'Release'), build);
  assertIcons(tool('rpm', ['-qlp', path.join(dist, name)]));
  return `${field(text, 'Version')}-${field(text, 'Release')}`;
});

check('AppImage', () => {
  const name = only('.AppImage');
  assert.equal(name, 'opendoc-desktop-x86_64.AppImage');
  return name;
});

check('latest-linux.yml', () => {
  const text = readFileSync(path.join(dist, 'latest-linux.yml'), 'utf8');
  assert.equal(field(text, 'version'), version);
  assert.equal(field(text, 'build'), build);
  assert.equal(field(text, 'commit'), info.commit);
  const urls = [...text.matchAll(/^ {2}- url: (.*)$/gm)].map((match) => match[1]);
  for (const extension of ['.deb', '.pacman', '.rpm', '.AppImage']) assert.ok(urls.some((url) => url.endsWith(extension)), `no ${extension} listed`);
  return `build ${build}, commit ${info.commit.slice(0, 12)}, ${urls.length} files`;
});

console.log(checks.join('\n'));
