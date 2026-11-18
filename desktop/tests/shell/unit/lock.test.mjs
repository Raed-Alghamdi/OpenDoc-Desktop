import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { acquireWorkspaceLock, clearStaleWorkspaceLock, WorkspaceLockError } from '../../../src/main/lock.mjs';

const workspace = () => mkdtemp(join(tmpdir(), 'opendoc-lock-'));
const lockPath = root => join(root, '.opendoc', 'update.lock');

async function deadPid() {
  const child = spawn(process.execPath, ['-e', '0']);
  await new Promise(accept => child.once('exit', accept));
  return child.pid;
}

test('the lock is the CLI lock: .opendoc/update.lock with our pid and an id', async () => {
  const root = await workspace();
  const lock = await acquireWorkspaceLock(root);
  const content = JSON.parse(await readFile(lockPath(root), 'utf8'));
  assert.equal(content.pid, process.pid);
  assert.equal(typeof content.id, 'string');
  await lock.release();
  await assert.rejects(readFile(lockPath(root)), { code: 'ENOENT' });
});

test('a second contender is refused while the first holds the lock', async () => {
  const root = await workspace();
  const lock = await acquireWorkspaceLock(root);
  await assert.rejects(acquireWorkspaceLock(root), error => error instanceof WorkspaceLockError && error.code === 'locked');
  await lock.release();
});

test('a lock of a live process owned by someone else is "locked" and cannot be cleared', async () => {
  const root = await workspace();
  const holder = spawn('sleep', ['30']);
  try {
    await acquireWorkspaceLock(root).then(lock => lock.release());
    await writeFile(lockPath(root), JSON.stringify({ pid: holder.pid, id: 'x' }));
    await assert.rejects(acquireWorkspaceLock(root), { code: 'locked' });
    await assert.rejects(clearStaleWorkspaceLock(root), { code: 'locked' });
  } finally { holder.kill('SIGKILL'); }
});

test('a lock whose pid is gone is reported as stale, never cleared on its own, and cleared on request', async () => {
  const root = await workspace();
  await acquireWorkspaceLock(root).then(lock => lock.release());
  await writeFile(lockPath(root), JSON.stringify({ pid: await deadPid(), id: 'x' }));
  await assert.rejects(acquireWorkspaceLock(root), error => error.code === 'stale-lock' && Number.isInteger(error.pid));
  await readFile(lockPath(root)); // still there
  assert.equal(await clearStaleWorkspaceLock(root), 'cleared');
  const lock = await acquireWorkspaceLock(root);
  await lock.release();
});

test('a damaged lock cannot be confirmed stale, so the app does not offer to clear it', async () => {
  const root = await workspace();
  await acquireWorkspaceLock(root).then(lock => lock.release());
  await writeFile(lockPath(root), '{ half');
  await assert.rejects(acquireWorkspaceLock(root), { code: 'invalid-lock' });
  await assert.rejects(clearStaleWorkspaceLock(root), { code: 'invalid-lock' });
});

test('release leaves a lock that someone else replaced', async () => {
  const root = await workspace();
  const lock = await acquireWorkspaceLock(root);
  await writeFile(lockPath(root), JSON.stringify({ pid: process.pid, id: 'someone-else' }));
  await lock.release();
  assert.equal(JSON.parse(await readFile(lockPath(root), 'utf8')).id, 'someone-else');
});
