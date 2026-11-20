import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { inspectService, serverRecordFile } from '../../../src/main/service-session.mjs';

const workspace = async () => { const root = await mkdtemp(join(tmpdir(), 'opendoc-service-')); await mkdir(join(root, '.opendoc')); return root; };

async function deadPid() {
  const child = spawn(process.execPath, ['-e', '0']);
  await new Promise(accept => child.once('exit', accept));
  return child.pid;
}

/** A port nothing listens on (fetch refuses a few low ports outright, so port 1 would not do). */
async function closedPort() {
  const server = createServer();
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const { port } = server.address();
  await new Promise(accept => server.close(accept));
  return port;
}

test('no record means no service', async () => {
  assert.deepEqual(await inspectService(await workspace()), { state: 'none' });
});

test('a record whose port refuses and whose pid is gone is stale, so no service', async () => {
  const root = await workspace();
  await writeFile(serverRecordFile(root), JSON.stringify({ origin: `http://127.0.0.1:${await closedPort()}`, token: 't', pid: await deadPid() }));
  assert.deepEqual(await inspectService(root), { state: 'none' });
});

test('a record whose port refuses but whose pid lives is a service that is still finishing', async () => {
  const root = await workspace();
  await writeFile(serverRecordFile(root), JSON.stringify({ origin: `http://127.0.0.1:${await closedPort()}`, token: 't', pid: process.pid }));
  assert.equal((await inspectService(root)).state, 'finishing');
});

test('a service that answers with the recorded token is running', async () => {
  const root = await workspace();
  const server = createServer((_request, response) => { response.setHeader('content-type', 'application/json'); response.end(JSON.stringify({ token: 'secret' })); });
  await new Promise(accept => server.listen(0, '127.0.0.1', accept));
  try {
    const origin = `http://127.0.0.1:${server.address().port}`;
    await writeFile(serverRecordFile(root), JSON.stringify({ origin, token: 'secret', pid: 4242 }));
    assert.deepEqual(await inspectService(root), { state: 'running', origin, pid: 4242 });
    await writeFile(serverRecordFile(root), JSON.stringify({ origin, token: 'other', pid: 4242 }));
    assert.equal((await inspectService(root)).state, 'unknown');
  } finally { server.close(); }
});

test('an unreadable or malformed record is unknown, never silently ignored', async () => {
  const root = await workspace();
  await writeFile(serverRecordFile(root), '{ bad');
  assert.equal((await inspectService(root)).state, 'unknown');
  await writeFile(serverRecordFile(root), JSON.stringify({ origin: 'http://example.com', token: 't', pid: 1 }));
  assert.equal((await inspectService(root)).state, 'unknown');
});
