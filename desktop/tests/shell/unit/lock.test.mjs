import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { mkdir, mkdtemp, readFile, readdir, writeFile } from 'node:fs/promises';
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

test('a lock file is never seen empty or partial, however closely it is watched while it is taken and released', async () => {
  const root = await workspace();
  const url = new URL('../../../src/main/lock.mjs', import.meta.url).href;
  // Another process takes and releases the lock again and again; this one reads the file in a tight loop.
  const script = `import { acquireWorkspaceLock } from ${JSON.stringify(url)}; for (let n = 0; n < 1500; n++) { const lock = await acquireWorkspaceLock(process.argv[1]); await lock.release(); }`;
  const child = spawn(process.execPath, ['--input-type=module', '-e', script, root], { stdio: 'ignore' });
  const finished = new Promise(accept => child.once('exit', accept));
  let done = false;
  finished.then(() => { done = true; });
  let seen = 0;
  const bad = [];
  while (!done) {
    let text;
    try { text = readFileSync(lockPath(root), 'utf8'); } catch { await new Promise(accept => setImmediate(accept)); continue; }
    seen++;
    try { if (!Number.isInteger(JSON.parse(text).pid)) bad.push(text); } catch { bad.push(text); }
    await new Promise(accept => setImmediate(accept));
  }
  assert.ok(seen > 0, 'the file was observed at least once');
  assert.deepEqual(bad, []);
  assert.deepEqual((await readdir(join(root, '.opendoc'))).filter(name => name.endsWith('.part')), [], 'no temporary file is left');
});

test('a kill between the temporary file and the link leaves only a .part file, which is no lock; the lock can be taken, and the next open removes the leftover', async () => {
  const root = await workspace();
  await mkdir(join(root, '.opendoc'), { recursive: true });
  const leftover = join(root, '.opendoc', `.update.lock.abc.opendoc-${await deadPid()}.part`);
  await writeFile(leftover, JSON.stringify({ pid: 1, id: 'x' }));
  const lock = await acquireWorkspaceLock(root);
  assert.equal(JSON.parse(await readFile(lockPath(root), 'utf8')).pid, process.pid);
  await lock.release();
  const { cleanStaleTemps } = await import('../../../src/main/workspace/temps.mjs');
  assert.deepEqual(await cleanStaleTemps(root), [leftover]);
});
