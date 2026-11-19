import assert from 'node:assert/strict';
import { mkdir, readdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { test } from 'node:test';
import { cleanStaleTemps } from '../../../src/main/workspace/temps.mjs';
import { scratch } from '../support/workspace-fixtures.mjs';

test('leftover temporary files of a dead process are removed from the workspace, .claude and .opendoc; live ones and real files stay', async () => {
  const root = await scratch('temps');
  await mkdir(join(root, '.claude'));
  await mkdir(join(root, '.opendoc'));
  const stale = ['package.json.opendoc-111.part', '.skills.opendoc-111.part'];
  for (const name of stale) await writeFile(join(root, name), 'x');
  await writeFile(join(root, '.claude', '.skills.opendoc-111.part'), 'x');
  await writeFile(join(root, '.opendoc', 'workspace.json.opendoc-111.part'), 'x');
  await writeFile(join(root, 'package.json.opendoc-222.part'), 'alive');
  await writeFile(join(root, 'package.json'), '{}');
  await writeFile(join(root, 'notes.part'), 'user file');
  const removed = await cleanStaleTemps(root, pid => pid === 222);
  assert.equal(removed.length, 4);
  assert.deepEqual((await readdir(root)).sort(), ['.claude', '.opendoc', 'notes.part', 'package.json', 'package.json.opendoc-222.part']);
  assert.deepEqual(await readdir(join(root, '.claude')), []);
  assert.deepEqual(await readdir(join(root, '.opendoc')), []);
  assert.deepEqual(await cleanStaleTemps(join(root, 'missing'), () => false), []);
});
