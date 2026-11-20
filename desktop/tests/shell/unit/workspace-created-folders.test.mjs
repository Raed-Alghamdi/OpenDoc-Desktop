import assert from 'node:assert/strict';
import { mkdir, readdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { test } from 'node:test';
import { removeCreatedOpendocFolders, snapshotOpendocFolders } from '../../../src/main/workspace/created-folders.mjs';
import { scratch } from '../support/workspace-fixtures.mjs';

const has = async (root, ...parts) => readdir(join(root, ...parts)).then(() => true, () => false);

test('a folder with no .opendoc before: the empty .opendoc, locks, pack-uploads and renders the open made are removed', async () => {
  const root = await scratch('created-none');
  const before = await snapshotOpendocFolders(root);
  assert.deepEqual(before, { had: false, inside: [] });
  await mkdir(join(root, '.opendoc', 'locks'), { recursive: true });
  await mkdir(join(root, '.opendoc', 'pack-uploads'));
  await mkdir(join(root, '.opendoc', 'renders'));
  const removed = await removeCreatedOpendocFolders(root, before);
  assert.equal(removed.length, 4);
  assert.equal(await has(root, '.opendoc'), false);
  assert.deepEqual(await readdir(root), []);
});

test('a folder that had .opendoc keeps it, and keeps the locks and pack-uploads folders that were there; only new empty ones go', async () => {
  const root = await scratch('created-had');
  await mkdir(join(root, '.opendoc', 'locks'), { recursive: true });
  const before = await snapshotOpendocFolders(root);
  assert.deepEqual(before, { had: true, inside: ['locks'] });
  await mkdir(join(root, '.opendoc', 'pack-uploads'));
  await removeCreatedOpendocFolders(root, before);
  assert.equal(await has(root, '.opendoc'), true);
  assert.equal(await has(root, '.opendoc', 'locks'), true);
  assert.equal(await has(root, '.opendoc', 'pack-uploads'), false);
});

test('an empty .opendoc that was there before stays', async () => {
  const root = await scratch('created-empty-before');
  await mkdir(join(root, '.opendoc'));
  const before = await snapshotOpendocFolders(root);
  assert.deepEqual(await removeCreatedOpendocFolders(root, before), []);
  assert.equal(await has(root, '.opendoc'), true);
});

test('nothing that holds a file is removed, and nothing is removed recursively: a marker after a Yes, a file in locks/', async () => {
  const root = await scratch('created-written');
  const before = await snapshotOpendocFolders(root);
  await mkdir(join(root, '.opendoc', 'locks'), { recursive: true });
  await writeFile(join(root, '.opendoc', 'locks', 'a.lock'), 'x');
  await writeFile(join(root, '.opendoc', 'workspace.json'), '{}');
  assert.deepEqual(await removeCreatedOpendocFolders(root, before), []);
  assert.deepEqual((await readdir(join(root, '.opendoc'))).sort(), ['locks', 'workspace.json']);
  assert.deepEqual(await readdir(join(root, '.opendoc', 'locks')), ['a.lock']);
});

test('a workspace that is gone, or whose folders are already removed, is not an error', async () => {
  const root = await scratch('created-gone');
  const before = await snapshotOpendocFolders(join(root, 'missing'));
  assert.deepEqual(before, { had: false, inside: [] });
  assert.deepEqual(await removeCreatedOpendocFolders(join(root, 'missing'), before), []);
});
