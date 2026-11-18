// The build-aware version check against electron-updater's real classes (S6's 16 rows, and more).
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { test } from 'node:test';
import { parseBuild, withBuildCompare } from '../../../src/main/updater/build-compare.mjs';
import { newUpdater, scratch } from '../support/updater.mjs';

const require = createRequire(new URL('../../../package.json', import.meta.url));
const { AppImageUpdater, DebUpdater, RpmUpdater, PacmanUpdater } = require('electron-updater');

const rows = [
  // [current version, running build, feed info, expected, what it shows]
  ['0.6.1', 1, { version: '0.6.1', build: 2 }, true, 'same version, higher build'],
  ['0.6.1', 1, { version: '0.6.1', build: 1 }, false, 'same version, same build'],
  ['0.6.1', 2, { version: '0.6.1', build: 1 }, false, 'same version, lower build (no downgrade)'],
  ['0.6.1', 1, { version: '0.6.1' }, false, 'same version, the feed has no build field'],
  ['0.6.1', 0, { version: '0.6.1', build: 1 }, true, 'running build unknown (0), feed build 1'],
  ['0.6.1', 5, { version: '0.6.2', build: 1 }, true, 'a higher version beats any build'],
  ['0.6.1', 5, { version: '0.7.0' }, true, 'a higher minor, the feed has no build field'],
  ['0.6.2', 1, { version: '0.6.1', build: 9 }, false, 'a lower version is never offered, even with a high build'],
  ['0.6.1', 1, { version: '0.6.1', build: '2' }, true, 'build written as text "2"'],
  ['0.6.1', 1, { version: '0.6.1', build: 2.5 }, false, 'build is not a whole number'],
  ['0.6.1', 1, { version: '0.6.1', build: -3 }, false, 'negative build'],
  ['0.6.1', 1, { version: '0.6.1', build: 'abc' }, false, 'build is text'],
  ['0.6.1', 1, { version: '0.6.1', build: true }, false, 'build is a YAML boolean'],
  ['0.6.1', 1, { version: '0.6.1', build: null }, false, 'build is empty'],
  ['0.6.1', 1, { version: '0.6.1', build: '' }, false, 'build is an empty string'],
  ['0.6.1', 1, { version: '0.6.1', build: '2 ' }, true, 'build text with a trailing space'],
  ['0.6.1', 1, { version: '0.6.1', build: '1e3' }, false, 'build in exponent notation'],
  ['0.6.1', 1, { version: '0.6.1', build: 99999999999999999999 }, false, 'build too large to be exact'],
  ['0.6.1', 1, { version: '0.6.1', build: 2, minimumSystemVersion: '99.0.0' }, false, 'same version, OS too old (the stock rule still applies)'],
  ['0.6.1', 1, { version: '0.6.1', build: 2, stagingPercentage: 0 }, false, 'same version, rollout 0 percent (the stock rule still applies)'],
  ['0.6.1', 1, { version: '0.6.1', build: 2, stagingPercentage: 100 }, true, 'same version, rollout 100 percent'],
  ['0.6.1', 1, { version: '0.6.2', build: 1, minimumSystemVersion: '99.0.0' }, false, 'a higher version, OS too old'],
];

for (const [name, Base] of [['AppImage', AppImageUpdater], ['deb', DebUpdater], ['rpm', RpmUpdater], ['pacman', PacmanUpdater]]) {
  test(`the ${name} class: build comparison rows`, async () => {
    const folder = await scratch('compare');
    for (const [version, build, info, expected, label] of rows) {
      const updater = newUpdater(withBuildCompare(Base, () => build), version, folder);
      assert.equal(await updater.isUpdateAvailable(info), expected, `${label}: ${JSON.stringify(info)}`);
    }
  });
}

test('the stock check never offers the same version again (what the wrapper is for)', async () => {
  const stock = newUpdater(AppImageUpdater, '0.6.1', await scratch('stock'));
  assert.equal(await stock.isUpdateAvailable({ version: '0.6.1', build: 2 }), false);
});

test('an invalid feed version still raises the stock error', async () => {
  const updater = newUpdater(withBuildCompare(AppImageUpdater, () => 1), '0.6.1', await scratch('invalid'));
  await assert.rejects(updater.isUpdateAvailable({ version: 'banana', build: 2 }), { code: 'ERR_UPDATER_INVALID_VERSION' });
});

test('parseBuild accepts whole numbers and digit text only', () => {
  assert.equal(parseBuild(3), 3);
  assert.equal(parseBuild('12'), 12);
  assert.equal(parseBuild(0), 0);
  for (const bad of [-1, 1.5, '1.5', '-2', 'x', '', null, undefined, true, {}, [], NaN, Infinity]) assert.equal(parseBuild(bad), null, String(bad));
});
