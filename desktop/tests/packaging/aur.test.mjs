// Keeps desktop/aur (the opendoc-desktop-bin package) in step with the rest of the desktop package. Reads files only; the real
// build is tests/packaging/aur-local.sh.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

const desktop = path.resolve(fileURLToPath(new URL('../..', import.meta.url)));
const read = (...parts) => readFileSync(path.join(desktop, ...parts), 'utf8');
const pkgbuild = read('aur', 'PKGBUILD');
const srcinfo = read('aur', '.SRCINFO');
const config = read('electron-builder.yml');
const version = JSON.parse(read('package.json')).version;

const variable = (name) => pkgbuild.match(new RegExp(`^${name}=(.*)$`, 'm'))?.[1].replace(/^['"]|['"]$/g, '');
const list = (name) => pkgbuild.match(new RegExp(`^${name}=\\((.*)\\)$`, 'm'))?.[1].split(/\s+/);
const info = (key) => [...srcinfo.matchAll(new RegExp(`^\\t${key} = (.*)$`, 'gm'))].map((match) => match[1]);

test('pkgver is the app version and pkgrel a build number', () => {
  assert.equal(variable('pkgver'), version);
  assert.match(variable('pkgrel'), /^[1-9]\d*$/);
});

test('depends are the pacman target\'s depends', () => {
  const target = config.match(/^pacman:\n(?:.*\n)*?\s+depends: \[(.*)\]/m)[1].split(/,\s*/);
  assert.deepEqual(list('depends'), target);
});

test('provides and conflicts opendoc-desktop, installs under /opt and never needs the shared electron', () => {
  assert.deepEqual(list('provides'), ['opendoc-desktop']);
  assert.deepEqual(list('conflicts'), ['opendoc-desktop']);
  assert.ok(!/\belectron\d*\b/.test(list('depends').join(' ')), 'depends on an Arch electron package');
  assert.match(pkgbuild, /\/opt\/opendoc-desktop\/opendoc-desktop/);
});

test('adds the updater-off marker inside the installed app', () => {
  assert.match(pkgbuild, /\$\{pkgdir\}\/opt\/opendoc-desktop\/resources\/update-disabled/);
});

test('downloads the release asset the config names, for the tag desktop-v<version>-<build>', () => {
  assert.match(pkgbuild, /_asset="opendoc-desktop-\$\{pkgver\}-\$\{pkgrel\}-x64\.pacman"/);
  assert.ok(config.includes('artifactName: ${name}-${version}-${buildNumber}-${arch}.${ext}'), 'pacman artifactName changed');
  assert.match(pkgbuild, /\/releases\/download\/desktop-v\$\{pkgver\}-\$\{pkgrel\}\/\$\{_asset\}/);
  assert.match(pkgbuild, /^options=\(!strip !debug\)$/m);
});

test('the maintainer line uses the same address as linux.maintainer', () => {
  const maintainer = config.match(/^ {2}maintainer: (.*)$/m)[1];
  assert.equal(pkgbuild.match(/^# Maintainer: (.*)$/m)[1], maintainer);
});

test('.SRCINFO is the PKGBUILD\'s (regenerate with makepkg --printsrcinfo)', () => {
  assert.deepEqual(info('pkgver'), [variable('pkgver')]);
  assert.deepEqual(info('pkgrel'), [variable('pkgrel')]);
  assert.deepEqual(info('depends'), list('depends'));
  assert.deepEqual(info('license'), list('license'));
  assert.deepEqual(info('provides'), ['opendoc-desktop']);
  assert.deepEqual(info('conflicts'), ['opendoc-desktop']);
  assert.equal(info('source')[0], `opendoc-desktop-${variable('pkgver')}-${variable('pkgrel')}-x64.pacman::https://github.com/Raed-Alghamdi/OpenDoc-Desktop/releases/download/desktop-v${variable('pkgver')}-${variable('pkgrel')}/opendoc-desktop-${variable('pkgver')}-${variable('pkgrel')}-x64.pacman`);
});
