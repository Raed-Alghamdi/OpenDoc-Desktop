import assert from 'node:assert/strict';
import { mkdtemp, readFile, readdir, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { createConfig, forgetWorkspace, maxRecentWorkspaces, rememberWorkspace, withRecentWorkspace } from '../../../src/main/config.mjs';

const folder = () => mkdtemp(join(tmpdir(), 'opendoc-config-'));

test('reading a missing config gives an empty object', async () => {
  assert.deepEqual(await createConfig(join(await folder(), 'config.json')).read(), {});
});

test('the file is written with mode 0600 and atomically (no temporary file is left)', async () => {
  const dir = await folder();
  const config = createConfig(join(dir, 'nested', 'config.json'));
  await config.update({ checkForUpdates: true });
  assert.equal((await stat(config.file)).mode & 0o777, 0o600);
  assert.deepEqual(await readdir(join(dir, 'nested')), ['config.json']);
});

test('unknown keys survive an update', async () => {
  const dir = await folder();
  const file = join(dir, 'config.json');
  await writeFile(file, JSON.stringify({ updateFeed: 'https://example.com/feed', somethingNew: { a: 1 } }));
  const config = createConfig(file);
  await rememberWorkspace(config, '/work/one');
  assert.deepEqual(JSON.parse(await readFile(file, 'utf8')), { updateFeed: 'https://example.com/feed', somethingNew: { a: 1 }, defaultWorkspace: '/work/one', recentWorkspaces: ['/work/one'] });
});

test('the recent list is newest first, without duplicates, and capped at ten', () => {
  assert.deepEqual(withRecentWorkspace(['/b', '/a'], '/a'), ['/a', '/b']);
  let list = [];
  for (let index = 0; index < 15; index++) list = withRecentWorkspace(list, `/w${index}`);
  assert.equal(list.length, maxRecentWorkspaces);
  assert.equal(list[0], '/w14');
  assert.deepEqual(withRecentWorkspace('not a list', '/a'), ['/a']);
});

test('forgetting a workspace removes it from the list and from the default', async () => {
  const config = createConfig(join(await folder(), 'config.json'));
  await rememberWorkspace(config, '/one');
  await rememberWorkspace(config, '/two');
  assert.equal((await config.read()).defaultWorkspace, '/two');
  const next = await forgetWorkspace(config, '/two');
  assert.deepEqual(next, { recentWorkspaces: ['/one'] });
});

test('concurrent updates are applied one after the other', async () => {
  const config = createConfig(join(await folder(), 'config.json'));
  await Promise.all(Array.from({ length: 8 }, (_, index) => rememberWorkspace(config, `/w${index}`)));
  assert.equal((await config.read()).recentWorkspaces.length, 8);
});

test('a damaged file is moved aside and replaced, never read as settings', async () => {
  const dir = await folder();
  const file = join(dir, 'config.json');
  await writeFile(file, '{ not json');
  const config = createConfig(file);
  assert.deepEqual(await config.read(), {});
  await config.update({ checkForUpdates: false });
  const names = await readdir(dir);
  assert.ok(names.some(name => name.startsWith('config.json.damaged-')));
  assert.deepEqual(await config.read(), { checkForUpdates: false });
});
