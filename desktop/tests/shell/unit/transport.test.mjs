// The transport against a stand-in service, in plain Node (the host is an ordinary Node child here; in the app it is
// the app's own executable as Node). No Electron, no port: every request and answer crosses the child's IPC channel.
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { after, before, test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { serviceLocation, startTransport, TransportError } from '../../../src/main/transport.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const tsx = join(here, '..', '..', '..', '..', 'node_modules', 'tsx', 'dist', 'esm', 'index.mjs');

// A service with just enough routes to exercise the channel. It writes `closed` into the workspace when closed.
const fakeService = `
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { writeFileSync } from 'node:fs';
const listeners = new Set();
const pdf = Buffer.from('0123456789'.repeat(100));
export async function createOpenDocService({ root, production }) {
  if (process.env.FAKE_SERVICE_FAIL) throw new Error('the service could not start: ' + process.env.FAKE_SERVICE_FAIL);
  if (process.env.FAKE_SERVICE_HANG) await new Promise(() => {});
  return {
    token: 'token-' + process.pid,
    onChange(listener) { listeners.add(listener); return () => listeners.delete(listener); },
    async close() { writeFileSync(root + '/closed', 'yes'); },
    async handle(req, res) {
      const url = new URL(req.url, 'http://localhost');
      const json = (value, status = 200) => { res.writeHead(status, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(value)); };
      switch (url.pathname) {
        case '/api/session': return json({ token: 'x' });
        case '/cwd': return json({ cwd: process.cwd(), production, host: req.headers.host, pid: process.pid, node: process.env.ELECTRON_RUN_AS_NODE ?? null });
        case '/echo': {
          const hash = createHash('sha256'); let length = 0;
          for await (const chunk of req) { hash.update(chunk); length += chunk.length; }
          return json({ method: req.method, type: req.headers['content-type'], length, sha256: hash.digest('hex') }, 201);
        }
        case '/range': {
          const match = /^bytes=(\\d+)-(\\d+)?$/.exec(req.headers.range ?? '');
          if (!match) { res.writeHead(200, { 'Content-Length': pdf.length }); res.end(pdf); return; }
          const from = Number(match[1]); const to = Math.min(Number(match[2] ?? pdf.length - 1), pdf.length - 1);
          res.writeHead(206, { 'Content-Range': 'bytes ' + from + '-' + to + '/' + pdf.length, 'Content-Length': to - from + 1 }); res.end(pdf.subarray(from, to + 1)); return;
        }
        case '/big': { const piece = Buffer.alloc(1024 * 1024, 7); res.writeHead(200); for (let i = 0; i < 12; i++) { if (!res.write(piece)) await new Promise(accept => res.once('drain', accept)); } res.end(); return; }
        case '/change': for (const listener of listeners) listener(); return json({ ok: true });
        case '/slow': return; // never answers
        case '/die': process.exit(3);
        case '/grandchild': { const child = spawn('sleep', ['300'], { stdio: 'ignore' }); return json({ pid: child.pid }); }
        case '/nothing': res.writeHead(204); res.end(); return;
        case '/throw': throw new Error('boom');
        default: return json({ error: 'Not found.' }, 404);
      }
    },
  };
}
`;

let folder; let workspace; let location;
const get = (transport, path, init) => transport.handle(new Request(`app://opendoc${path}`, init));
const alive = pid => { try { process.kill(pid, 0); return true; } catch { return false; } };
async function started(options = {}) {
  const root = await mkdtemp(join(folder, 'ws-'));
  const transport = await startTransport({ root, location, ...options });
  return { transport, root };
}

before(async () => {
  folder = await mkdtemp(join(tmpdir(), 'opendoc-transport-'));
  workspace = join(folder, 'runtime');
  await mkdir(join(workspace, 'node_modules', 'opendoc', 'src', 'server'), { recursive: true });
  await writeFile(join(workspace, 'node_modules', 'opendoc', 'src', 'server', 'service.ts'), fakeService);
  await writeFile(join(workspace, 'node_modules', 'opendoc', 'package.json'), JSON.stringify({ name: 'opendoc', type: 'module' }));
  location = { entry: join(workspace, 'node_modules', 'opendoc', 'src', 'server', 'service.ts'), tsx };
  assert.equal(existsSync(tsx), true);
});
after(() => rm(folder, { recursive: true, force: true }));

test('the service is found in the runtime, or in the repository when developing, or nowhere', async () => {
  assert.deepEqual(serviceLocation({ runtime: workspace }), { entry: location.entry, tsx: join(workspace, 'node_modules', 'tsx', 'dist', 'esm', 'index.mjs') });
  const repo = join(folder, 'repo');
  await mkdir(join(repo, 'src', 'server'), { recursive: true });
  await writeFile(join(repo, 'src', 'server', 'service.ts'), '');
  assert.deepEqual(serviceLocation({ runtime: join(folder, 'no-runtime'), fallbackRoot: repo }), { entry: join(repo, 'src', 'server', 'service.ts'), tsx: join(repo, 'node_modules', 'tsx', 'dist', 'esm', 'index.mjs') });
  assert.equal(serviceLocation({ runtime: join(folder, 'no-runtime') }), null);
  assert.equal(serviceLocation({ runtime: join(folder, 'no-runtime'), fallbackRoot: join(folder, 'no-repo') }), null);
  await assert.rejects(startTransport({ root: folder, location: null }), error => error instanceof TransportError && /runtime/.test(error.message));
});

test('the host runs in the workspace, answers over the channel under app://opendoc, and stops cleanly', async () => {
  const { transport, root } = await started();
  try {
    assert.equal(transport.origin, 'app://opendoc');
    assert.equal(transport.running, true);
    const answer = await (await get(transport, '/cwd')).json();
    assert.equal(answer.cwd, await realpath(root));
    assert.equal(answer.production, true);
    assert.equal(answer.host, 'opendoc');
    assert.equal(answer.node, '1');
    assert.equal(answer.pid, transport.pid);
    assert.equal(await transport.ping(), true);
    const missing = await get(transport, '/nowhere');
    assert.equal(missing.status, 404);
    assert.equal((await get(transport, '/nothing')).status, 204);
    assert.equal((await get(transport, '/nothing', { method: 'HEAD' })).status, 204);
  } finally { await transport.stop(); }
  assert.equal(transport.running, false);
  assert.equal(await readFile(join(root, 'closed'), 'utf8'), 'yes'); // the service was closed, not killed
  assert.equal((await transport.exited).code, 0);
  assert.equal(alive(transport.pid), false);
});

test('an upload streams to the service in pieces and arrives intact; a Range request and a large answer too', async () => {
  const { transport } = await started();
  try {
    const body = Buffer.alloc(6 * 1024 * 1024);
    for (let index = 0; index < body.length; index += 4) body.writeUInt32LE((index * 2654435761) >>> 0, index);
    const sent = await get(transport, '/echo', { method: 'POST', headers: { 'content-type': 'multipart/form-data; boundary=x' }, body });
    assert.equal(sent.status, 201);
    assert.deepEqual(await sent.json(), { method: 'POST', type: 'multipart/form-data; boundary=x', length: body.length, sha256: createHash('sha256').update(body).digest('hex') });

    const whole = await get(transport, '/range');
    assert.equal(whole.status, 200);
    assert.equal((await whole.arrayBuffer()).byteLength, 1000);
    const part = await get(transport, '/range', { headers: { range: 'bytes=10-19' } });
    assert.equal(part.status, 206);
    assert.equal(part.headers.get('content-range'), 'bytes 10-19/1000');
    assert.equal(Buffer.from(await part.arrayBuffer()).toString(), '0123456789');

    const big = await get(transport, '/big');
    assert.equal((await big.arrayBuffer()).byteLength, 12 * 1024 * 1024);
  } finally { await transport.stop(); }
});

test('the service\'s changes reach the listeners, until they are removed', async () => {
  const { transport } = await started();
  try {
    let count = 0;
    const stop = transport.onChange(() => { count++; });
    await get(transport, '/change');
    await new Promise(accept => setTimeout(accept, 100));
    assert.equal(count, 1);
    stop();
    await get(transport, '/change');
    await new Promise(accept => setTimeout(accept, 100));
    assert.equal(count, 1);
  } finally { await transport.stop(); }
});

test('a request the page gives up on is cut off, and the host keeps serving', async () => {
  const { transport } = await started();
  try {
    const controller = new AbortController();
    const pending = get(transport, '/slow', { signal: controller.signal });
    setTimeout(() => controller.abort(), 100);
    assert.equal((await pending).status, 500);
    assert.equal(await transport.ping(), true);
    assert.equal((await get(transport, '/throw')).status, 500); // a service that throws is a 500, not a dead channel
    assert.equal(await transport.ping(), true);
  } finally { await transport.stop(); }
});

test('when the host dies, what waits fails at once, later requests are 503, and it reports it has exited', async () => {
  const { transport } = await started();
  const waiting = get(transport, '/slow');
  const dying = get(transport, '/die');
  assert.equal((await waiting).status, 503);
  assert.equal((await dying).status, 503);
  const { code } = await transport.exited;
  assert.equal(code, 3);
  assert.equal(transport.running, false);
  assert.equal((await get(transport, '/cwd')).status, 503);
  assert.equal(await transport.ping(), false);
  transport.kill(); // harmless on a host that is gone
});

test('a host that stops answering fails the ping', async () => {
  const { transport } = await started();
  try {
    process.kill(transport.pid, 'SIGSTOP');
    assert.equal(await transport.ping(400), false);
  } finally { process.kill(transport.pid, 'SIGCONT'); await transport.stop(); }
});

test('stopping or killing the host takes what it started with it', async () => {
  const { transport } = await started();
  const { pid } = await (await get(transport, '/grandchild')).json();
  assert.equal(alive(pid), true);
  await transport.stop();
  await new Promise(accept => setTimeout(accept, 200));
  assert.equal(alive(pid), false);

  const second = (await started()).transport;
  const child = (await (await get(second, '/grandchild')).json()).pid;
  second.kill();
  await second.exited;
  await new Promise(accept => setTimeout(accept, 200));
  assert.equal(alive(child), false);
});

test('a service that cannot start is a TransportError that carries what it printed', async () => {
  process.env.FAKE_SERVICE_FAIL = 'no theme';
  try {
    const root = await mkdtemp(join(folder, 'ws-'));
    await assert.rejects(startTransport({ root, location }), error => error instanceof TransportError && /could not start/.test(error.message) && error.tail.join('\n').includes('no theme'));
  } finally { delete process.env.FAKE_SERVICE_FAIL; }
});

test('a service that never comes up is stopped after the start-up time', async () => {
  process.env.FAKE_SERVICE_HANG = '1';
  try {
    const root = await mkdtemp(join(folder, 'ws-'));
    const began = Date.now();
    await assert.rejects(startTransport({ root, location, startupTimeout: 1500 }), error => error instanceof TransportError && /did not start/.test(error.message));
    assert.ok(Date.now() - began < 20_000);
  } finally { delete process.env.FAKE_SERVICE_HANG; }
});
