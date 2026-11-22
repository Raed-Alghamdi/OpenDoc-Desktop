// The updater classes built on electron-updater's own: a release must list a file for the install, the AppImage's folder must be
// writable, and package updates never use the stock synchronous install.
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { existsSync } from 'node:fs';
import { createRequire } from 'node:module';
import { createServer, request as httpRequest } from 'node:http';
import { chmod, mkdir, readFile, readdir, stat, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { test } from 'node:test';
import { createUpdaterClass, noSignatureMessage, signatureUrl } from '../../../src/main/updater/classes.mjs';
import { fakeTools, newUpdater, scratch } from '../support/updater.mjs';

// electron-updater needs an HTTP executor of its own when it is not given Electron's: builder-util-runtime's, on Node's http module.
const { HttpExecutor, configureRequestOptions, configureRequestUrl } = createRequire(createRequire(import.meta.url).resolve('electron-updater'))('builder-util-runtime');
class NodeExecutor extends HttpExecutor {
  createRequest(options, callback) { return httpRequest(options, callback); }

  // The same call as ElectronHttpExecutor.download, which is what the package classes use.
  async download(url, destination, options) {
    return options.cancellationToken.createPromise((resolve, reject, onCancel) => {
      const requestOptions = { headers: options.headers || undefined, redirect: 'manual' };
      configureRequestUrl(url, requestOptions);
      configureRequestOptions(requestOptions);
      this.doDownload(requestOptions, { destination, options, onCancel, callback: error => (error == null ? resolve(destination) : reject(error)), responseHandler: null }, 0);
    });
  }
}

const sha = 'a'.repeat(86) + '==';
const release = (build, ...urls) => ({ version: '0.6.1', build, files: urls.map(url => ({ url, sha512: sha, size: 1 })) });
const make = async (type, { build = 1, seams, isLoopbackFeed } = {}) => newUpdater(createUpdaterClass(type, { getBuild: () => build, isLoopbackFeed, seams }), '0.6.1', await scratch('class'));

test('a newer build is offered only when the release lists a file for this install', async () => {
  const all = release(2, 'opendoc-desktop-x86_64.AppImage', 'opendoc-desktop_0.6.1-2_amd64.deb', 'opendoc-desktop-0.6.1-2.x86_64.rpm', 'opendoc-desktop-0.6.1-2-x86_64.pacman');
  for (const type of ['appimage', 'deb', 'rpm', 'pacman']) assert.equal(await (await make(type)).isUpdateAvailable(all), true, type);
  // A feed with no pacman file made electron-updater fail with "Cannot read properties of undefined (reading 'info')".
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

/** A downloaded package in a real folder, with its signature file when `signature` is given. */
async function downloadedDeb(updater, signature) {
  const folder = await scratch('pending');
  const file = join(folder, 'update.deb');
  await writeFile(file, 'package');
  if (signature) await writeFile(`${file}.sig`, signature);
  updater.downloadedUpdateHelper = { file, downloadedFileInfo: { fileName: 'update.deb', sha512: sha } };
  return file;
}

test('installDownloaded hands the downloaded file, its metadata checksum and its signature file to the install', async () => {
  const calls = [];
  const updater = await make('deb', { seams: { install: async options => { calls.push(options); return { outcome: 'cancelled' }; } } });
  assert.deepEqual(await updater.installDownloaded(), { outcome: 'failed', message: 'There is no downloaded update to install.' });
  const file = await downloadedDeb(updater, Buffer.alloc(64, 1));
  assert.deepEqual(await updater.installDownloaded(), { outcome: 'cancelled' });
  assert.equal(calls.length, 1);
  assert.deepEqual([calls[0].type, calls[0].file, calls[0].sha512, calls[0].signature], ['deb', file, sha, `${file}.sig`]);
});

test('with no signature file the install tries once more to fetch it, and installs nothing if it still cannot', async () => {
  const installs = [];
  const fetches = [];
  const updater = await make('deb', { seams: { install: async options => { installs.push(options); return { outcome: 'installed' }; }, fetchSignature: async url => { fetches.push(url.href); throw new Error('404'); } } });
  const file = await downloadedDeb(updater);
  updater.signatureSource = { packageAddress: 'https://example.invalid/releases/update.deb' };
  assert.deepEqual(await updater.installDownloaded(), { outcome: 'failed', reason: 'no-signature', message: noSignatureMessage });
  assert.deepEqual(fetches, ['https://example.invalid/releases/update.deb.sig'], 'one more try');
  assert.deepEqual(installs, []);
  assert.equal(await stat(`${file}.sig`).catch(() => null), null);
  assert.equal(noSignatureMessage, 'This update has no signature, so it was not installed. Download it from the release page and install it by hand.');
});

test('the second try at install time can succeed: the signature is stored and the install goes ahead', async () => {
  const installs = [];
  const updater = await make('deb', { seams: { install: async options => { installs.push(options); return { outcome: 'installed' }; }, fetchSignature: async () => Buffer.alloc(64, 7) } });
  const file = await downloadedDeb(updater);
  updater.signatureSource = { packageAddress: 'https://example.invalid/releases/update.deb' };
  assert.equal((await updater.installDownloaded()).outcome, 'installed');
  assert.equal(installs[0].signature, `${file}.sig`);
  assert.deepEqual(await readFile(`${file}.sig`), Buffer.alloc(64, 7));
});

test('a stored signature that is not 64 bytes is not used, and with no way to fetch another nothing is installed', async () => {
  const installs = [];
  const updater = await make('deb', { seams: { install: async options => { installs.push(options); return { outcome: 'installed' }; } } });
  await downloadedDeb(updater, Buffer.alloc(63));
  assert.equal((await updater.installDownloaded()).reason, 'no-signature');
  assert.deepEqual(installs, []);
});

test('a refusal for a missing signature never starts pkexec', async () => {
  const tools = await fakeTools();
  const updater = await make('deb');
  await downloadedDeb(updater);
  const result = await updater.installDownloaded();
  assert.deepEqual([result.outcome, result.reason], ['failed', 'no-signature']);
  assert.deepEqual(await tools.calls('pkexec'), []);
  assert.deepEqual(await tools.calls('dpkg'), []);
  // With PATH pointing at the fake tools the real install would have called pkexec; here the class stops before it.
  const before = process.env.PATH;
  process.env.PATH = tools.bin;
  try { assert.equal((await updater.installDownloaded()).reason, 'no-signature'); } finally { process.env.PATH = before; }
  assert.deepEqual(await tools.calls('pkexec'), []);
});

test('the signature is fetched from the package\'s own address with .sig added', () => {
  assert.equal(signatureUrl('https://github.com/o/r/releases/download/desktop-v0.6.1-2/opendoc-desktop_0.6.1-2_amd64.deb').href, 'https://github.com/o/r/releases/download/desktop-v0.6.1-2/opendoc-desktop_0.6.1-2_amd64.deb.sig');
  assert.equal(signatureUrl('http://127.0.0.1:1/generic/x%20y.rpm?z=1').href, 'http://127.0.0.1:1/generic/x%20y.rpm.sig?z=1');
  assert.equal(signatureUrl('not an address'), null);
});

/** A real download from a loopback server through electron-updater's own class: what is fetched, and what lands beside the package. */
async function downloadFrom({ sig, loopback = true, type = 'deb' }) {
  const bytes = Buffer.from('a package for the download test');
  const name = { deb: 'opendoc-desktop_0.6.1-2_amd64.deb', rpm: 'opendoc-desktop-0.6.1-2.x86_64.rpm', pacman: 'opendoc-desktop-0.6.1-2-x86_64.pacman' }[type];
  const requests = [];
  const server = createServer((request, response) => {
    const path = request.url.split('?')[0];
    requests.push(path);
    if (path === '/latest-linux.yml') {
      response.end(`version: 0.6.1\nbuild: 2\nfiles:\n  - url: ${name}\n    sha512: ${createHash('sha512').update(bytes).digest('base64')}\n    size: ${bytes.length}\npath: ${name}\nsha512: x\nreleaseDate: '2026-11-18T12:00:00.000Z'\n`);
    } else if (path === `/${name}`) response.end(bytes);
    else if (path === `/${name}.sig` && sig !== null) response.end(sig);
    else { response.statusCode = 404; response.end('no'); }
  });
  await new Promise(accept => server.listen(0, '127.0.0.1', accept));
  try {
    const updater = await make(type, { isLoopbackFeed: () => loopback });
    updater.httpExecutor = new NodeExecutor();
    updater.setFeedURL({ provider: 'generic', url: `http://127.0.0.1:${server.address().port}/` });
    updater.autoDownload = false;
    const checked = await updater.checkForUpdates();
    assert.equal(checked.isUpdateAvailable, true);
    await updater.downloadUpdate(checked.cancellationToken);
    const file = updater.downloaded().file;
    return { updater, file, requests, signature: await readFile(`${file}.sig`).catch(() => null) };
  } finally { server.close(); }
}

test('after the package is downloaded its .sig is fetched from the same folder and stored beside it', async () => {
  const sig = Buffer.alloc(64, 9);
  for (const type of ['deb', 'rpm', 'pacman']) {
    const result = await downloadFrom({ sig, type });
    assert.deepEqual(result.signature, sig, type);
    assert.deepEqual(result.requests.map(url => url.replace(/^\/opendoc-desktop.*(\.sig)$/, '/package$1')), ['/latest-linux.yml', result.requests[1], '/package.sig'], type);
    assert.deepEqual((await readdir(dirname(result.file))).filter(name => name.endsWith('.part')), []);
  }
});

test('a signature that is missing or of the wrong length is not stored, and the download itself still stands', async () => {
  for (const sig of [null, Buffer.alloc(63), Buffer.alloc(65), Buffer.alloc(0)]) {
    const result = await downloadFrom({ sig });
    assert.equal(result.signature, null, String(sig?.length));
    assert.equal(result.updater.downloaded().sha512.length > 0, true);
    assert.equal(await readFile(result.file, 'utf8'), 'a package for the download test');
  }
});

test('a plain-http feed that is not on loopback gets no signature request (the same rule as the package)', async () => {
  const result = await downloadFrom({ sig: Buffer.alloc(64), loopback: false });
  assert.equal(result.signature, null);
  assert.equal(result.requests.some(url => url.endsWith('.sig')), false);
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

test('every install type can empty the pending folder (the downloaded file and update-info.json)', async () => {
  for (const type of ['deb', 'rpm', 'pacman', 'appimage']) {
    const folder = await scratch('class-clear');
    const updater = newUpdater(createUpdaterClass(type, { getBuild: () => 1 }), '0.6.1', folder);
    const pending = join(folder, 'opendoc-desktop-updater', 'pending');
    await mkdir(pending, { recursive: true });
    await writeFile(join(pending, type === 'appimage' ? 'opendoc-desktop-x86_64.AppImage' : 'opendoc-desktop_0.6.1-2_amd64.deb'), 'x'.repeat(1000));
    await writeFile(join(pending, 'update-info.json'), '{}');
    await updater.clearDownloaded();
    assert.deepEqual(await readdir(pending), [], type);
    await updater.clearDownloaded(); // nothing there: no error
  }
  // MacUpdater needs Electron's autoUpdater to be constructed, so here only the class is checked: it has the same shared call.
  const mac = createUpdaterClass('mac', { getBuild: () => 1 }).prototype.clearDownloaded;
  assert.equal(typeof mac, 'function');
  assert.equal(String(mac), String(createUpdaterClass('deb', { getBuild: () => 1 }).prototype.clearDownloaded));
});
