#!/usr/bin/env node
// Checks the Linux installers in desktop/dist: each file carries the app version and the build number in its own metadata (not
// just its name; the AppImage has no version in its name), and latest-linux.yml lists every installer and carries build: and commit:.
//
// Usage: node desktop/tests/packaging/check-artifacts.mjs [--dist <folder>] [--require-rpm]
// Reads package metadata with dpkg-deb, pacman and rpm where they exist, and otherwise straight from the archive (ar and bsdtar),
// except for rpm, which then is checked by file name only.
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import os from 'node:os';
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

// What the updater reads from inside each install (plan 3.7, S6): the type word, the feed (app-update.yml) and, for the AUR only, the
// marker that switches it off. A file in a package is read straight from its archive (rpm through rpm2cpio).
const debMember = (file, prefix) => tool('ar', ['t', file]).split('\n').find((entry) => entry.startsWith(prefix));
const inPackage = (kind, file, inner) => {
  if (kind === 'deb') {
    const data = spawnSync('ar', ['p', file, debMember(file, 'data.tar')], { maxBuffer: 1 << 30 }).stdout;
    return spawnSync('bsdtar', ['-xOf', '-', `./${inner}`], { input: data, encoding: 'utf8', maxBuffer: 64 << 20 });
  }
  if (kind === 'rpm') {
    const cpio = spawnSync('rpm2cpio', [file], { maxBuffer: 1 << 30 }).stdout;
    return spawnSync('bsdtar', ['-xOf', '-', `./${inner}`], { input: cpio, encoding: 'utf8', maxBuffer: 64 << 20 });
  }
  return spawnSync('bsdtar', ['-xOf', file, inner], { encoding: 'utf8', maxBuffer: 64 << 20 });
};
for (const [kind, extension] of [['deb', '.deb'], ['pacman', '.pacman'], ['rpm', '.rpm']]) {
  check(`${kind} update files`, () => {
    const name = files.find((entry) => entry.endsWith(extension));
    if (!name) throw new Error(`no ${extension} in dist`);
    const file = path.join(dist, name);
    const type = inPackage(kind, file, 'opt/opendoc-desktop/resources/package-type');
    assert.equal(type.stdout.trim(), kind, `package-type: ${type.stdout.trim() || type.stderr.trim()}`);
    const feed = inPackage(kind, file, 'opt/opendoc-desktop/resources/app-update.yml').stdout;
    assert.match(feed, /^provider: github$/m);
    assert.match(feed, /^owner: .+$/m);
    const marker = inPackage(kind, file, 'opt/opendoc-desktop/resources/update-disabled');
    assert.notEqual(marker.status, 0, 'the updater-off marker must not ship in this package (only the AUR package adds it)');
    return `package-type ${kind}, app-update.yml (github), no update-disabled`;
  });
}

check('AppImage update files', () => {
  const name = only('.AppImage');
  const scratch = mkdtempSync(path.join(os.tmpdir(), 'opendoc-appimage-'));
  try {
    // The AppImage runtime's own extract flag: it unpacks files and starts nothing.
    const extract = spawnSync(path.join(dist, name), ['--appimage-extract', 'resources/app-update.yml'], { cwd: scratch, encoding: 'utf8', timeout: 120_000 });
    assert.equal(extract.status, 0, extract.stderr);
    const feed = readFileSync(path.join(scratch, 'squashfs-root', 'resources', 'app-update.yml'), 'utf8');
    assert.match(feed, /^provider: github$/m);
    assert.ok(!existsSync(path.join(scratch, 'squashfs-root', 'resources', 'package-type')), 'an AppImage has no package-type (the updater uses $APPIMAGE)');
    return 'app-update.yml (github), no package-type';
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
});

check('latest-linux.yml', () => {
  const text = readFileSync(path.join(dist, 'latest-linux.yml'), 'utf8');
  assert.equal(field(text, 'version'), version);
  assert.equal(field(text, 'build'), build);
  assert.equal(field(text, 'commit'), info.commit);
  // The updater only offers a file whose entry exists, so every installer needs one, with the file's real size and SHA-512.
  const entries = [...text.matchAll(/^ {2}- url: (.*)\n {4}sha512: (.*)\n {4}size: (\d+)/gm)].map((match) => ({ url: match[1], sha512: match[2], size: Number(match[3]) }));
  for (const extension of ['.deb', '.pacman', '.rpm', '.AppImage']) {
    const entry = entries.find((candidate) => candidate.url.endsWith(extension));
    assert.ok(entry, `no ${extension} listed`);
    const bytes = readFileSync(path.join(dist, entry.url));
    assert.equal(entry.size, bytes.length, `${entry.url}: size`);
    assert.equal(entry.sha512, createHash('sha512').update(bytes).digest('base64'), `${entry.url}: sha512`);
  }
  assert.equal(field(text, 'path'), 'opendoc-desktop-x86_64.AppImage');
  return `build ${build}, commit ${info.commit.slice(0, 12)}, ${entries.length} files with sha512 and size, all matching`;
});

console.log(checks.join('\n'));
