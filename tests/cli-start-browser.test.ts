import test from 'node:test';
import assert from 'node:assert/strict';
import childProcess from 'node:child_process';
import { EventEmitter } from 'node:events';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import { syncBuiltinESMExports } from 'node:module';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { runStart } from '../src/cli/start';

test('start opens the browser with an environment that does not carry ELECTRON_RUN_AS_NODE', async t => {
  const root = await mkdtemp(resolve(tmpdir(), 'opendoc-start-browser-'));
  const token = 'start-browser-token';
  const server = createServer((_request, response) => { response.setHeader('Content-Type', 'application/json'); response.end(JSON.stringify({ token })); });
  await new Promise<void>(accept => server.listen(0, '127.0.0.1', accept));
  const address = server.address();
  assert.ok(address && typeof address !== 'string');
  const origin = `http://127.0.0.1:${address.port}`;
  const calls: { command: string; args: string[]; env?: NodeJS.ProcessEnv }[] = [];
  const saved = process.env.ELECTRON_RUN_AS_NODE;
  try {
    await mkdir(resolve(root, '.opendoc'));
    await writeFile(resolve(root, '.opendoc/server.json'), JSON.stringify({ origin, token, pid: process.pid }));
    // The service is already running, so the only program started is the browser opener.
    t.mock.method(childProcess, 'spawn', (command: string, args: string[], options: { env?: NodeJS.ProcessEnv }) => {
      calls.push({ command, args, env: options.env });
      const child = new EventEmitter();
      setImmediate(() => child.emit('exit', 0));
      return child;
    });
    syncBuiltinESMExports();
    // The desktop app's host runs with this variable set; the opener must not inherit it.
    process.env.ELECTRON_RUN_AS_NODE = '1';
    t.mock.method(console, 'log', () => {});
    await runStart([], root);
    assert.equal(calls.length, 1);
    assert.deepEqual(calls[0].args, [origin]);
    assert.ok(calls[0].env, 'The opener gets an explicit environment.');
    assert.equal('ELECTRON_RUN_AS_NODE' in calls[0].env!, false);
    assert.equal(calls[0].env!.PATH, process.env.PATH, 'Everything else is kept.');
  } finally {
    if (saved === undefined) delete process.env.ELECTRON_RUN_AS_NODE; else process.env.ELECTRON_RUN_AS_NODE = saved;
    t.mock.restoreAll(); syncBuiltinESMExports();
    await new Promise<void>(accept => { server.closeAllConnections(); server.close(() => accept()); });
    await rm(root, { recursive: true, force: true });
  }
});
