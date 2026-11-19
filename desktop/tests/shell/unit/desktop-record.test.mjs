import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { desktopRecordFile, inspectDesktopRecord, readDesktopRecord, removeDesktopRecord, writeDesktopRecord, clearStaleDesktopRecord } from '../../../src/main/desktop-record.mjs';

const workspace = async () => { const root = await mkdtemp(join(tmpdir(), 'opendoc-record-')); await mkdir(join(root, '.opendoc')); return root; };

async function deadPid() {
  const child = spawn(process.execPath, ['-e', '0']);
  await new Promise(accept => child.once('exit', accept));
  return child.pid;
}

test('the record holds pid, startedAt, version and build', async () => {
  const root = await workspace();
  await writeDesktopRecord(root, { version: '0.6.1', build: 3 });
  const record = JSON.parse(await readFile(desktopRecordFile(root), 'utf8'));
  assert.deepEqual(Object.keys(record).sort(), ['build', 'pid', 'startedAt', 'version']);
  assert.equal(record.pid, process.pid);
  assert.equal(record.version, '0.6.1');
  assert.equal(record.build, 3);
  assert.ok(!Number.isNaN(Date.parse(record.startedAt)));
});

test('removing the record only removes our own', async () => {
  const root = await workspace();
  await writeFile(desktopRecordFile(root), JSON.stringify({ pid: process.pid + 100000, startedAt: 'x', version: '0.6.1', build: 1 }));
  await removeDesktopRecord(root);
  assert.notEqual(await readDesktopRecord(root), null);
  await writeDesktopRecord(root, { version: '0.6.1', build: 1 });
  await removeDesktopRecord(root);
  assert.equal(await readDesktopRecord(root), null);
});

test('a record of a pid that is gone is stale, and clearing removes it', async () => {
  const root = await workspace();
  await writeFile(desktopRecordFile(root), JSON.stringify({ pid: await deadPid(), startedAt: 'x', version: '0.6.1', build: 1 }));
  assert.equal((await inspectDesktopRecord(root)).state, 'stale');
  assert.equal(await clearStaleDesktopRecord(root), 'stale');
  assert.equal((await inspectDesktopRecord(root)).state, 'none');
});

test('a live pid that is another program is stale; the same program is live', async () => {
  const root = await workspace();
  const other = spawn('sleep', ['30']);
  try {
    await writeFile(desktopRecordFile(root), JSON.stringify({ pid: other.pid, startedAt: 'x', version: '0.6.1', build: 1 }));
    // `sleep` is not this program, so the pid was reused by something else.
    assert.equal((await inspectDesktopRecord(root)).state, 'stale');
    // Pretend the app's executable is `sleep`: now the same pid counts as a live app.
    assert.equal((await inspectDesktopRecord(root, { execPath: '/usr/bin/sleep' })).state, 'live');
  } finally { other.kill('SIGKILL'); }
});

test('an unreadable record is stale and our own record is not a conflict', async () => {
  const root = await workspace();
  await writeFile(desktopRecordFile(root), '{ nope');
  assert.equal((await inspectDesktopRecord(root)).state, 'stale');
  await writeDesktopRecord(root, { version: '0.6.1', build: null });
  assert.equal((await inspectDesktopRecord(root)).state, 'none');
});
