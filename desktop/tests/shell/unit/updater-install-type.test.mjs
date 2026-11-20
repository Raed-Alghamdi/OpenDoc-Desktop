// Which kind of install this is, and when the updater may run at all: every row of the detection order.
import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { test } from 'node:test';
import { detectInstallType, needsRestartClick } from '../../../src/main/updater/install-type.mjs';
import { scratch } from '../support/updater.mjs';

/** A resources folder with the given files. */
async function resources(files = {}) {
  const folder = await scratch('resources');
  await mkdir(folder, { recursive: true });
  for (const [name, text] of Object.entries(files)) await writeFile(join(folder, name), text);
  return folder;
}

const detect = async (files, options = {}) => detectInstallType({ packaged: true, resourcesDir: await resources(files), platform: 'linux', env: {}, ...options });

test('a development run is inactive, whatever else is true', async () => {
  const result = await detect({ 'package-type': 'deb' }, { packaged: false, env: { APPIMAGE: '/x.AppImage' } });
  assert.deepEqual([result.type, result.active], ['inactive', false]);
  assert.equal((await detect({}, { resourcesDir: null })).type, 'inactive');
});

test('resources/update-disabled makes the install managed: no updater, even with an AppImage variable or the switch on', async () => {
  const result = await detect({ 'update-disabled': '', 'package-type': 'pacman' }, { env: { APPIMAGE: '/x.AppImage' }, config: { checkForUpdates: true } });
  assert.deepEqual([result.type, result.active], ['managed', false]);
});

test('the marker wins over the switch, and the switch wins over the install type', async () => {
  assert.equal((await detect({ 'update-disabled': '' }, { config: { checkForUpdates: false } })).type, 'managed');
  for (const files of [{ 'package-type': 'deb' }, {}]) {
    const result = await detect(files, { config: { checkForUpdates: false }, env: { APPIMAGE: '/x.AppImage' } });
    assert.deepEqual([result.type, result.active], ['off', false]);
  }
  assert.equal((await detect({}, { config: { checkForUpdates: false }, platform: 'darwin' })).type, 'off');
});

test('only a false switch turns the updater off (absent, true or anything else leaves it on)', async () => {
  for (const config of [{}, { checkForUpdates: true }, { checkForUpdates: 'no' }, { checkForUpdates: 0 }, { checkForUpdates: null }]) {
    assert.equal((await detect({ 'package-type': 'deb' }, { config })).type, 'deb', JSON.stringify(config));
  }
});

test('macOS is mac, even when an AppImage variable is set', async () => {
  const result = await detect({}, { platform: 'darwin', env: { APPIMAGE: '/x.AppImage' } });
  assert.deepEqual([result.type, result.active], ['mac', true]);
});

test('the APPIMAGE variable makes an AppImage, before the package type', async () => {
  assert.equal((await detect({ 'package-type': 'deb' }, { env: { APPIMAGE: '/home/u/opendoc.AppImage' } })).type, 'appimage');
  assert.equal((await detect({}, { env: { APPIMAGE: '' } })).type, 'inactive');
});

test('package-type names the package: deb, rpm or pacman, with surrounding space ignored', async () => {
  for (const type of ['deb', 'rpm', 'pacman']) {
    const result = await detect({ 'package-type': `${type}\n` });
    assert.deepEqual([result.type, result.active], [type, true]);
  }
});

test('an unknown or missing package-type is inactive', async () => {
  for (const files of [{}, { 'package-type': 'snap' }, { 'package-type': '' }, { 'package-type': 'AppImage' }]) {
    const result = await detect(files);
    assert.deepEqual([result.type, result.active], ['inactive', false], JSON.stringify(files));
  }
});

test('only the types that install through a click need the restart button', () => {
  assert.deepEqual(['appimage', 'deb', 'rpm', 'pacman', 'mac', 'managed', 'off', 'inactive'].map(needsRestartClick), [false, true, true, true, true, false, false, false]);
});
