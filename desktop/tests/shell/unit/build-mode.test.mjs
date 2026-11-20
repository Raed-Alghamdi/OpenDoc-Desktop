// What a packaged build honours from the environment: the test switches, and the test-build mark in the app's package.json.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { ignoreTestSwitches, readTestBuild, testBuildField, testModeAllowed, testSwitches } from '../../../src/main/build-mode.mjs';

const everySwitch = () => Object.fromEntries(testSwitches.map(name => [name, '/somewhere']));

test('the switches that choose code, a feed or folders are all listed', () => {
  for (const name of ['OPENDOC_DESKTOP_RUNTIME', 'OPENDOC_DESKTOP_UPDATE_RESOURCES', 'OPENDOC_DESKTOP_HEALTH_MS', 'OPENDOC_DESKTOP_INTEGRATIONS_OPTIONS', 'OPENDOC_PACKAGE_TARBALL']) assert.ok(testSwitches.includes(name), name);
});

test('an installed app that is not a test build removes every test switch from the environment and says which were set', () => {
  const env = { ...everySwitch(), PATH: '/bin', HOME: '/h' };
  const removed = ignoreTestSwitches(env, { packaged: true, testBuild: false });
  assert.deepEqual(removed.sort(), [...testSwitches].sort());
  assert.deepEqual(env, { PATH: '/bin', HOME: '/h' }, 'nothing else is touched');
  const partial = { OPENDOC_DESKTOP_RUNTIME: '/x', OPENDOC_DESKTOP_UPDATE_RESOURCES: '' };
  assert.deepEqual(ignoreTestSwitches(partial, { packaged: true, testBuild: false }), ['OPENDOC_DESKTOP_RUNTIME'], 'an empty value is not a switch that was set');
  assert.deepEqual(partial, {});
});

test('a test build, and any unpackaged run, keeps the switches', () => {
  for (const options of [{ packaged: true, testBuild: true }, { packaged: false, testBuild: false }, { packaged: false, testBuild: true }]) {
    const env = everySwitch();
    assert.deepEqual(ignoreTestSwitches(env, options), [], JSON.stringify(options));
    assert.deepEqual(env, everySwitch());
    assert.equal(testModeAllowed(options), true);
  }
  assert.equal(testModeAllowed({ packaged: true, testBuild: false }), false);
  assert.equal(testModeAllowed({ packaged: true }), false);
  assert.equal(testModeAllowed({ packaged: true, testBuild: 'yes' }), false, 'only the boolean true marks a test build');
});

test('the mark is the field opendocTestBuild: true in the app\'s package.json; anything else, or no file, is a normal build', () => {
  const read = text => () => text;
  assert.equal(testBuildField, 'opendocTestBuild');
  assert.equal(readTestBuild('x', read(JSON.stringify({ name: 'opendoc-desktop', opendocTestBuild: true }))), true);
  for (const text of [JSON.stringify({ name: 'opendoc-desktop' }), JSON.stringify({ opendocTestBuild: false }), JSON.stringify({ opendocTestBuild: 'true' }), JSON.stringify({ opendocTestBuild: 1 }), 'not json', '']) assert.equal(readTestBuild('x', read(text)), false, text);
  assert.equal(readTestBuild('x', () => { throw new Error('ENOENT'); }), false);
});

test('this repository\'s own desktop package.json is not marked as a test build', () => {
  assert.equal(readTestBuild(), false);
});
