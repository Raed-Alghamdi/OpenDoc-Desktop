// The AppImage swap: staged beside the AppImage, checked, renamed over it. The old AppImage is never removed before the new one is in
// place, any failure leaves it untouched with no temporary file behind, and the new AppImage is never run.
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { chmodSync, existsSync, statSync, writeFileSync } from 'node:fs';
import { chmod, mkdir, readFile, readdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { test } from 'node:test';
import { destinationFor, enoughSpace, hashFileSync, spaceSlack, swapAppImage } from '../../../src/main/updater/appimage-swap.mjs';
import { scratch } from '../support/updater.mjs';

const sha = text => createHash('sha512').update(text).digest('base64');

/** An AppImage folder with the old file, and a cache folder with the download (a shell script that leaves a marker if it is ever run). */
async function layout({ old = 'old app', download = null, name = 'opendoc-desktop-x86_64.AppImage' } = {}) {
  const root = await scratch('swap');
  const apps = join(root, 'apps');
  const cache = join(root, 'cache');
  await mkdir(apps);
  await mkdir(cache);
  const marker = join(root, 'ran');
  const body = download ?? `#!/bin/sh\ntouch "${marker}"\n`;
  const appImage = join(apps, name);
  const installerPath = join(cache, 'opendoc-desktop-x86_64.AppImage');
  await writeFile(appImage, old);
  await chmod(appImage, 0o755);
  await writeFile(installerPath, body);
  return { root, apps, cache, marker, appImage, installerPath, body, sha512: sha(body) };
}

test('the download replaces the AppImage: checked, executable, no temporary file, the cache copy gone, and it was not run', async () => {
  const setup = await layout();
  const result = swapAppImage(setup);
  assert.deepEqual(result, { destination: setup.appImage, renamed: false });
  assert.equal(await readFile(setup.appImage, 'utf8'), setup.body);
  assert.notEqual(statSync(setup.appImage).mode & 0o111, 0, 'executable');
  assert.deepEqual(await readdir(setup.apps), ['opendoc-desktop-x86_64.AppImage'], 'no staging file is left');
  assert.equal(existsSync(setup.installerPath), false);
  assert.equal(existsSync(setup.marker), false, 'the new AppImage was never run');
});

test('the old AppImage is still there while the copy is made, and a copy that fails halfway leaves it untouched and no file behind', async () => {
  const setup = await layout();
  let seen = null;
  const ops = { copyFile: (from, to) => { seen = existsSync(setup.appImage); writeFileSync(to, 'partial'); throw Object.assign(new Error('ENOSPC: no space left on device'), { code: 'ENOSPC' }); } };
  assert.throws(() => swapAppImage({ ...setup, ops }), /ENOSPC/);
  assert.equal(seen, true, 'nothing was unlinked first');
  assert.equal(await readFile(setup.appImage, 'utf8'), 'old app');
  assert.deepEqual(await readdir(setup.apps), ['opendoc-desktop-x86_64.AppImage']);
  assert.equal(existsSync(setup.installerPath), true, 'the download is kept for another try');
});

test('a copy that does not match the checksum is not installed', async () => {
  const setup = await layout();
  assert.throws(() => swapAppImage({ ...setup, sha512: sha('something else') }), /does not match its checksum/);
  assert.equal(await readFile(setup.appImage, 'utf8'), 'old app');
  assert.deepEqual(await readdir(setup.apps), ['opendoc-desktop-x86_64.AppImage']);
  assert.throws(() => swapAppImage({ ...setup, sha512: undefined }), /no checksum/);
  assert.equal(await readFile(setup.appImage, 'utf8'), 'old app');
});

test('not enough room in the AppImage folder: refused before anything is written', async () => {
  const setup = await layout();
  const statfs = () => ({ bavail: 10, bsize: 4096 });
  assert.throws(() => swapAppImage({ ...setup, ops: { statfs } }), /not enough free space in .*apps/);
  assert.equal(await readFile(setup.appImage, 'utf8'), 'old app');
  assert.deepEqual(await readdir(setup.apps), ['opendoc-desktop-x86_64.AppImage']);
  assert.equal(enoughSpace(setup.apps, 1000, () => ({ bavail: 1e9, bsize: 4096 })).ok, true);
  const short = enoughSpace(setup.apps, 100 * 1024 * 1024, () => ({ bavail: (spaceSlack + 100 * 1024 * 1024) / 4096 - 1, bsize: 4096 }));
  assert.equal(short.ok, false);
  assert.match(short.message, /100 MB needed/);
  assert.equal(enoughSpace(setup.apps, 1, () => { throw new Error('no statfs'); }).ok, true, 'unknown free space does not block');
});

test('a folder made read-only after the download: the swap fails and the old AppImage still works', async () => {
  const setup = await layout();
  chmodSync(setup.apps, 0o555);
  try {
    assert.throws(() => swapAppImage(setup), /EACCES/);
  } finally { chmodSync(setup.apps, 0o755); }
  assert.equal(await readFile(setup.appImage, 'utf8'), 'old app');
  assert.deepEqual(await readdir(setup.apps), ['opendoc-desktop-x86_64.AppImage']);
});

test('a versioned old name moves to the new name; the old file goes only after the new one is in place', async () => {
  const setup = await layout({ name: 'opendoc-desktop-0.6.0-x86_64.AppImage' });
  const named = join(setup.cache, 'opendoc-desktop-0.6.1-x86_64.AppImage');
  await writeFile(named, setup.body);
  const log = [];
  const result = swapAppImage({ ...setup, installerPath: named, log: line => log.push(line) });
  assert.deepEqual(result, { destination: join(setup.apps, 'opendoc-desktop-0.6.1-x86_64.AppImage'), renamed: true });
  assert.deepEqual(await readdir(setup.apps), ['opendoc-desktop-0.6.1-x86_64.AppImage']);
  assert.equal(destinationFor('/a/opendoc-desktop-x86_64.AppImage', '/c/opendoc-desktop-0.6.1-x86_64.AppImage'), '/a/opendoc-desktop-x86_64.AppImage', 'a name without a version is kept');
});

test('a path that is not absolute is refused, and the hash of a file is the base64 SHA-512', async () => {
  const setup = await layout();
  for (const appImage of ['relative/app.AppImage', 'a\0b', undefined]) assert.throws(() => swapAppImage({ ...setup, appImage }), /not a valid absolute path/);
  assert.equal(hashFileSync(setup.installerPath), setup.sha512);
  const big = join(setup.root, 'big');
  const bytes = Buffer.alloc(3 * 1024 * 1024 + 17, 7);
  await writeFile(big, bytes);
  assert.equal(hashFileSync(big), createHash('sha512').update(bytes).digest('base64'));
});
