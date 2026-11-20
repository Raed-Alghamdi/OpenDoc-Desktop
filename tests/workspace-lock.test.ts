import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { withWorkspaceLock } from '../src/cli/lock';

async function workspace(t: import('node:test').TestContext) {
  const root = await mkdtemp(resolve(tmpdir(), 'opendoc-lock-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  return root;
}

test('the lock is never observed empty or half written, and has the format the app reads', { timeout: 60_000 }, async t => {
  const root = await workspace(t);
  const file = resolve(root, '.opendoc/update.lock');
  let observations = 0, bad: string[] = [], running = true;
  const watcher = (async () => {
    while (running) {
      const text = await readFile(file, 'utf8').catch(() => null);
      if (text !== null) { observations++; try { const parsed = JSON.parse(text); if (!Number.isSafeInteger(parsed.pid) || typeof parsed.id !== 'string') bad.push(text); } catch { bad.push(text); } }
      await new Promise(accept => setImmediate(accept));
    }
  })();
  for (let round = 0; round < 300; round++) await withWorkspaceLock(root, async () => { await new Promise(accept => setImmediate(accept)); });
  running = false; await watcher;
  assert.ok(observations > 0, 'The loop saw the lock at least once.');
  assert.deepEqual(bad, []);
  await assert.rejects(readFile(file), { code: 'ENOENT' }, 'released');
  assert.deepEqual((await readdir(resolve(root, '.opendoc'))).filter(name => name.endsWith('.part')), [], 'no temporary file is left behind');
});

test('a held lock records this process, refuses a second command, and leaves no temporary file', async t => {
  const root = await workspace(t);
  await withWorkspaceLock(root, async () => {
    const owner = JSON.parse(await readFile(resolve(root, '.opendoc/update.lock'), 'utf8'));
    assert.equal(owner.pid, process.pid);
    await assert.rejects(withWorkspaceLock(root, async () => {}), /Another OpenDoc command is in progress/);
    assert.deepEqual((await readdir(resolve(root, '.opendoc'))).filter(name => name.endsWith('.part')), []);
  });
});

test('a lock the old way left empty still reports as incomplete and is not taken over', async t => {
  const root = await workspace(t);
  await mkdir(resolve(root, '.opendoc'), { recursive: true });
  await writeFile(resolve(root, '.opendoc/update.lock'), '');
  await assert.rejects(withWorkspaceLock(root, async () => {}), /incomplete workspace runtime lock/);
});
