// The updater classes built on electron-updater's own: a release must list a file for the install, the AppImage's folder must be
// writable, and package updates never use the stock synchronous install.
import assert from 'node:assert/strict';
import { chmod, mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { test } from 'node:test';
import { createUpdaterClass } from '../../../src/main/updater/classes.mjs';
import { newUpdater, scratch } from '../support/updater.mjs';

const sha = 'a'.repeat(86) + '==';
const release = (build, ...urls) => ({ version: '0.6.1', build, files: urls.map(url => ({ url, sha512: sha, size: 1 })) });
const make = async (type, { build = 1, seams } = {}) => newUpdater(createUpdaterClass(type, { getBuild: () => build, seams }), '0.6.1', await scratch('class'));

test('a newer build is offered only when the release lists a file for this install', async () => {
  const all = release(2, 'opendoc-desktop-x86_64.AppImage', 'opendoc-desktop_0.6.1-2_amd64.deb', 'opendoc-desktop-0.6.1-2.x86_64.rpm', 'opendoc-desktop-0.6.1-2-x86_64.pacman');
  for (const type of ['appimage', 'deb', 'rpm', 'pacman']) assert.equal(await (await make(type)).isUpdateAvailable(all), true, type);
  // S6: a feed with no pacman file made electron-updater fail with "Cannot read properties of undefined (reading 'info')".
  const noPacman = release(2, 'opendoc-desktop-x86_64.AppImage', 'opendoc-desktop_0.6.1-2_amd64.deb');
  assert.equal(await (await make('pacman')).isUpdateAvailable(noPacman), false);
  assert.equal(await (await make('deb')).isUpdateAvailable(noPacman), true);
  assert.equal(await (await make('appimage')).isUpdateAvailable(release(2, 'opendoc-desktop_0.6.1-2_amd64.deb')), false);
});

test('a higher version is offered by the same rule', async () => {
  const next = { version: '0.6.2', build: 1, files: [{ url: 'opendoc-desktop_0.6.2-1_amd64.deb', sha512: sha }] };
  assert.equal(await (await make('deb', { build: 9 })).isUpdateAvailable(next), true);
  assert.equal(await (await make('rpm', { build: 9 })).isUpdateAvailable(next), false);
});

test('a file without a checksum is never offered (electron-updater would download it unchecked)', async () => {
  const unchecked = { version: '0.6.1', build: 2, files: [{ url: 'opendoc-desktop-x86_64.AppImage' }] };
  assert.equal(await (await make('appimage')).isUpdateAvailable(unchecked), false);
});

test('nothing is offered when the build is not newer, whatever the release lists', async () => {
  assert.equal(await (await make('deb', { build: 2 })).isUpdateAvailable(release(2, 'x.deb')), false);
  assert.equal(await (await make('deb')).isUpdateAvailable({ version: '0.6.1', files: [{ url: 'x.deb', sha512: sha }] }), false);
});

test('a build without app-update.yml still gets a cache folder name', async () => {
  const updater = await make('deb');
  assert.deepEqual(await updater.configOnDisk.value, { updaterCacheDirName: 'opendoc-desktop-updater' });
});

test('package updates never use the stock synchronous install', async () => {
  for (const type of ['deb', 'rpm', 'pacman']) {
    const updater = await make(type);
    assert.throws(() => updater.quitAndInstall(), /installDownloaded/);
    assert.throws(() => updater.doInstall({}), /installDownloaded/);
    assert.equal(updater.install(), false, 'the stock install() reports false instead of freezing the app');
  }
});

test('installDownloaded hands the downloaded file and its metadata checksum to the install', async () => {
  const calls = [];
  const updater = await make('deb', { seams: { install: async options => { calls.push(options); return { outcome: 'cancelled' }; } } });
  assert.deepEqual(await updater.installDownloaded(), { outcome: 'failed', message: 'There is no downloaded update to install.' });
  updater.downloadedUpdateHelper = { file: '/cache/pending/update.deb', downloadedFileInfo: { fileName: 'update.deb', sha512: sha } };
  assert.deepEqual(await updater.installDownloaded(), { outcome: 'cancelled' });
  assert.equal(calls.length, 1);
  assert.deepEqual([calls[0].type, calls[0].file, calls[0].sha512], ['deb', '/cache/pending/update.deb', sha]);
});

test('the AppImage swap needs its folder: a writable one passes, a read-only one is reported with its path', async () => {
  const folder = await scratch('appimage');
  const open = join(folder, 'open');
  const locked = join(folder, 'locked');
  await mkdir(open);
  await mkdir(locked);
  await chmod(locked, 0o555);
  try {
    assert.deepEqual(await (await make('appimage', { seams: { appImagePath: () => join(open, 'opendoc-desktop-x86_64.AppImage') } })).preflight(), { ok: true });
    const blocked = await (await make('appimage', { seams: { appImagePath: () => join(locked, 'opendoc-desktop-x86_64.AppImage') } })).preflight();
    assert.deepEqual([blocked.ok, blocked.reason, blocked.folder], [false, 'not-writable', locked]);
    assert.match(blocked.message, /cannot write to|cannot replace itself/);
    assert.equal((await (await make('appimage', { seams: { appImagePath: () => undefined } })).preflight()).reason, 'no-appimage');
  } finally { await chmod(locked, 0o755); }
});

test('the AppImage class swaps through electron-updater (installAtQuit)', async () => {
  const updater = await make('appimage');
  assert.equal(typeof updater.installAtQuit, 'function');
  assert.equal(updater.installAtQuit(), false, 'with nothing downloaded it reports false and does not touch any file');
});

test('every type builds a class, and an unknown type is refused', () => {
  for (const type of ['appimage', 'deb', 'rpm', 'pacman', 'mac']) assert.equal(typeof createUpdaterClass(type, { getBuild: () => 1 }), 'function');
  assert.throws(() => createUpdaterClass('snap', { getBuild: () => 1 }), /No updater/);
});
