// The updater classes built on electron-updater's own: a release must list a file for the install, the AppImage's folder must be
// writable, and package updates never use the stock synchronous install.
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { existsSync } from 'node:fs';
import { chmod, mkdir, readFile, readdir, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
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

/** An AppImage updater whose "installed" AppImage and download are real files in scratch folders. */
async function appImageSetup({ name = 'opendoc-desktop-x86_64.AppImage', seams = {} } = {}) {
  const folder = await scratch('appimage-class');
  const apps = join(folder, 'apps');
  await mkdir(apps);
  const appImage = join(apps, name);
  const download = join(folder, 'opendoc-desktop-x86_64.AppImage');
  const body = '#!/bin/sh\ntouch "' + join(folder, 'ran') + '"\n';
  await writeFile(appImage, 'old app');
  await writeFile(download, body);
  const updater = await make('appimage', { seams: { appImagePath: () => appImage, ...seams } });
  updater.downloadedUpdateHelper = { file: download, downloadedFileInfo: { fileName: 'x', sha512: createHash('sha512').update(body).digest('base64') } };
  const errors = [];
  updater.on('error', error => errors.push(error));
  const moved = [];
  updater.on('appimage-filename-updated', path => moved.push(path));
  return { folder, apps, appImage, download, updater, errors, moved, body };
}

test('the AppImage class swaps by staging beside the file: the new file is in place, nothing is run, no staging file is left', async () => {
  const { updater, appImage, apps, body, folder, errors, moved } = await appImageSetup();
  assert.equal(updater.installAtQuit(), true);
  assert.equal(await readFile(appImage, 'utf8'), body);
  assert.deepEqual(await readdir(apps), ['opendoc-desktop-x86_64.AppImage']);
  assert.equal(existsSync(join(folder, 'ran')), false, 'APPIMAGE_EXIT_AFTER_INSTALL style execution is gone: the new AppImage never runs');
  assert.deepEqual([errors, moved], [[], []]);
});

test('a swap that fails (the copy, or a folder made read-only after the download) keeps the old AppImage, reports the error, and returns false', async () => {
  const failing = await appImageSetup({ seams: { swapOps: { copyFile: () => { throw new Error('EIO: i/o error'); } } } });
  assert.equal(failing.updater.installAtQuit(), false);
  assert.equal(await readFile(failing.appImage, 'utf8'), 'old app');
  assert.deepEqual(await readdir(failing.apps), ['opendoc-desktop-x86_64.AppImage']);
  assert.match(failing.errors[0].message, /EIO/);

  const locked = await appImageSetup();
  await chmod(locked.apps, 0o555);
  try { assert.equal(locked.updater.installAtQuit(), false); } finally { await chmod(locked.apps, 0o755); }
  assert.equal(await readFile(locked.appImage, 'utf8'), 'old app');
  assert.match(locked.errors[0].message, /EACCES/);
});

test('a name that changes still raises appimage-filename-updated, with the new path', async () => {
  const { updater, apps, moved, errors } = await appImageSetup({ name: 'opendoc-desktop-0.6.0-x86_64.AppImage' });
  updater.downloadedUpdateHelper.file = join(dirname(updater.downloadedUpdateHelper.file), 'opendoc-desktop-0.6.1-x86_64.AppImage');
  await writeFile(updater.downloadedUpdateHelper.file, await readFile(join(dirname(updater.downloadedUpdateHelper.file), 'opendoc-desktop-x86_64.AppImage')));
  assert.equal(updater.installAtQuit(), true, JSON.stringify(errors.map(error => error.message)));
  assert.deepEqual(moved, [join(apps, 'opendoc-desktop-0.6.1-x86_64.AppImage')]);
  assert.deepEqual(await readdir(apps), ['opendoc-desktop-0.6.1-x86_64.AppImage']);
});

test('the AppImage preflight also checks free space (about the size of the AppImage), and says so', async () => {
  const { updater } = await appImageSetup({ seams: { statfs: () => ({ bavail: 1, bsize: 4096 }) } });
  const blocked = await updater.preflight();
  assert.deepEqual([blocked.ok, blocked.reason], [false, 'no-space']);
  assert.match(blocked.message, /not enough free space/);
  const roomy = await appImageSetup({ seams: { statfs: () => ({ bavail: 1e9, bsize: 4096 }) } });
  assert.deepEqual(await roomy.updater.preflight(), { ok: true });
});

test('the stock swap is not used: doInstall does not unlink the AppImage first', async () => {
  const { updater, appImage } = await appImageSetup({ seams: { swapOps: { copyFile: () => { assert.equal(existsSync(appImage), true, 'the old AppImage is there during the copy'); throw new Error('stop'); } } } });
  assert.equal(updater.installAtQuit(), false);
  assert.equal(existsSync(appImage), true);
});

test('the class checks file addresses against the feed it was given: a loopback feed refuses https:evil.example/x.deb', async () => {
  const folder = await scratch('feedbase');
  const build = base => newUpdater(createUpdaterClass('deb', { getBuild: () => 1, getFeedBase: () => base }), '0.6.1', folder);
  const info = release(2, 'https:evil.example/opendoc-desktop_0.6.1-2_amd64.deb');
  assert.equal(await build('http://127.0.0.1:8099/generic/').isUpdateAvailable(info), false);
  assert.equal(await build(null).isUpdateAvailable(info), true, 'without a known feed only the dummy base is used');
  assert.equal(await build('http://127.0.0.1:8099/generic/').isUpdateAvailable(release(2, 'opendoc-desktop_0.6.1-2_amd64.deb')), true);
});
