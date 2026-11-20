// The transport against a stand-in service, in plain Node (the host is an ordinary Node child here; in the app it is
// the app's own executable as Node). No Electron, no port: every request and answer crosses the child's IPC channel.
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { after, before, test } from 'node:test';
import { execFileSync, spawn } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { serviceLocation, startTransport, TransportError } from '../../../src/main/transport.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const tsx = join(here, '..', '..', '..', '..', 'node_modules', 'tsx', 'dist', 'esm', 'index.mjs');

// A service with just enough routes to exercise the channel. It writes `closed` into the workspace when closed.
const fakeService = `
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { writeFileSync } from 'node:fs';
const listeners = new Set();
let written = 0; let upload = 'none';
// A broken host, as far as the main process can tell: tamper rewrites what the host sends for one request, then removes itself.
const realSend = process.send.bind(process);
let tamper = null;
process.send = (message, ...rest) => { const out = tamper ? tamper(message) : message; if (message.t === 'end') tamper = null; return realSend(out, ...rest); };
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
        case '/stream': { const piece = Buffer.alloc(1024 * 1024, 9); res.writeHead(200); for (let i = 0; i < 400; i++) { written += piece.length; if (!res.write(piece)) await new Promise(accept => res.once('drain', accept)); if (res.destroyed) return; } res.end(); return; }
        case '/progress': return json({ written });
        case '/tamper-status-text': tamper = m => m.t === 'head' ? { ...m, status: '200' } : m; res.writeHead(200); res.end('x'); return;
        case '/tamper-header-name': tamper = m => m.t === 'head' ? { ...m, headers: [['bad header name', 'x']] } : m; res.writeHead(200); res.end('x'); return;
        case '/tamper-header-value': tamper = m => m.t === 'head' ? { ...m, headers: [['x-ok', 'a\\r\\nSet-Cookie: x=1']] } : m; res.writeHead(200); res.end('x'); return;
        case '/tamper-many-headers': tamper = m => m.t === 'head' ? { ...m, headers: Array.from({ length: 500 }, (_, i) => ['x-h' + i, 'v']) } : m; res.writeHead(200); res.end('x'); return;
        case '/tamper-big-chunk': tamper = m => m.t === 'chunk' ? { ...m, data: new Uint8Array(2 * 1024 * 1024) } : m; res.writeHead(200); res.end('x'); return;
        case '/tamper-chunk-type': tamper = m => m.t === 'chunk' ? { ...m, data: 'not bytes' } : m; res.writeHead(200); res.end('x'); return;
        case '/tamper-second-head': tamper = m => m.t === 'chunk' ? { t: 'head', id: m.id, status: 200, headers: [] } : m; res.writeHead(200); res.end('x'); return;
        case '/tamper-type': tamper = m => m.t === 'head' ? { ...m, t: ['head'] } : m; res.writeHead(200); res.end('x'); return;
        case '/badstatus': res.writeHead(700); res.end('x'); return;
        case '/hold-upload': { let size = 0; upload = 'reading'; req.on('data', chunk => { size += chunk.length; }); req.on('end', () => { upload = 'ended ' + size; res.writeHead(200); res.end('done'); }); req.on('close', () => { if (!upload.startsWith('ended')) upload = 'cut ' + size; }); return; }
        case '/upload-state': return json({ upload });
        case '/busy': for (;;) { /* blocks the host's event loop for good */ }
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

const pause = ms => new Promise(accept => setTimeout(accept, ms));
const until = async (check, limit = 8000) => { const end = Date.now() + limit; while (Date.now() < end) { if (await check()) return true; await pause(50); } return false; };
const childrenOf = pid => { try { return execFileSync('pgrep', ['-P', String(pid)], { encoding: 'utf8' }).split('\n').filter(Boolean).map(Number); } catch { return []; } };

test('a reader that does not read holds the host to about one window of an endless answer', async () => {
  const { transport } = await started();
  try {
    const response = await get(transport, '/stream'); // the head is here, the body is not read
    assert.equal(response.status, 200);
    await pause(700);
    const { written } = await (await get(transport, '/progress')).json();
    assert.ok(written <= 14 * 1024 * 1024, `the host wrote ${written} bytes for a reader that took none`);
    assert.ok(written >= 1024 * 1024);
    // Reading resumes it, and cancelling the body stops the service writing.
    const reader = response.body.getReader();
    for (let index = 0; index < 20; index++) await reader.read();
    await reader.cancel();
    await pause(300);
    const after = (await (await get(transport, '/progress')).json()).written;
    await pause(300);
    assert.equal((await (await get(transport, '/progress')).json()).written, after, 'the service stopped writing after the page cancelled');
    assert.ok(after < 100 * 1024 * 1024);
  } finally { await transport.stop(); }
});

test('a host that dies after the head and part of the body fails the body: an error, never a clean end', async () => {
  const { transport } = await started();
  const response = await get(transport, '/stream');
  const reader = response.body.getReader();
  assert.ok((await reader.read()).value.length > 0);
  process.kill(transport.pid, 'SIGKILL');
  const outcome = await (async () => { try { for (;;) { const { done } = await reader.read(); if (done) return 'ended cleanly'; } } catch (error) { return `error: ${error.message}`; } })();
  assert.match(outcome, /^error/);
  assert.equal(transport.running, false);
});

test('an answer with a status the host should not send is a 502, not a crash, and the host keeps serving', async () => {
  const { transport } = await started();
  try {
    assert.equal((await get(transport, '/badstatus')).status, 502);
    assert.equal(await transport.ping(), true);
    assert.equal(transport.running, true);
  } finally { await transport.stop(); }
});

// What a broken or compromised host can send, end to end: the page gets a 502 (before the answer began) or a failed body
// (after it began), never a hang and never a short answer that looks whole, and the same host serves the next request.
for (const [route, what] of [
  ['/badstatus', 'a status of 700'],
  ['/tamper-status-text', 'a status that is not a number'],
  ['/tamper-header-name', 'a header name with a space'],
  ['/tamper-header-value', 'a header value with a line break'],
  ['/tamper-many-headers', 'five hundred headers'],
  ['/tamper-big-chunk', 'a piece of the answer of 2 MiB'],
  ['/tamper-chunk-type', 'a piece of the answer that is text'],
  ['/tamper-second-head', 'a second set of headers'],
  ['/tamper-type', 'a message type that is not text'],
]) {
  test(`the host sends ${what}: the page gets a 502 or a failed response, and the next request is served by the same host`, async () => {
    const { transport } = await started();
    try {
      const pid = (await (await get(transport, '/cwd')).json()).pid;
      const outcome = await (async () => {
        const response = await get(transport, route);
        if (response.status === 502) return 'a 502';
        try { await response.arrayBuffer(); return `a ${response.status} that ended as whole`; } catch { return 'a failed response'; }
      })();
      assert.match(outcome, /^(a 502|a failed response)$/, `got ${outcome}`);
      assert.equal(transport.running, true, 'the host was not restarted for it');
      assert.equal((await (await get(transport, '/cwd')).json()).pid, pid);
      assert.equal(await transport.ping(), true);
    } finally { await transport.stop(); }
  });
}

test('an upload that is cut off midway reaches the service as a cut-off request, and the next request works', async () => {
  const { transport } = await started();
  try {
    let pushed = 0;
    const body = new ReadableStream({
      async pull(controller) {
        if (pushed >= 3) { await pause(100); controller.error(new Error('the page went away')); return; }
        pushed++;
        controller.enqueue(new Uint8Array(64 * 1024));
      },
    });
    const answer = await get(transport, '/hold-upload', { method: 'POST', body, duplex: 'half' }).catch(error => error);
    assert.ok(answer instanceof Error || answer.status >= 400, 'the cut-off upload is not answered as a success');
    assert.equal(await until(async () => (await (await get(transport, '/upload-state')).json()).upload.startsWith('cut')), true);
    assert.equal(await transport.ping(), true);
  } finally { await transport.stop(); }
});

test('a request that ends early (the page cancels the response) stops the upload loop and frees the host', async () => {
  const { transport } = await started();
  try {
    const controller = new AbortController();
    let pushed = 0;
    const body = new ReadableStream({ async pull(c) { pushed++; await pause(5); c.enqueue(new Uint8Array(32 * 1024)); } });
    const pending = get(transport, '/hold-upload', { method: 'POST', body, duplex: 'half', signal: controller.signal });
    await pause(300);
    controller.abort();
    assert.equal((await pending.catch(() => ({ status: 500 }))).status >= 400, true);
    const seen = pushed;
    await pause(400);
    assert.ok(pushed - seen <= 3, 'the body is no longer read once the request is over');
    assert.equal(await transport.ping(), true);
  } finally { await transport.stop(); }
});

test('a request that is over before its upload is read does not leave the upload body locked', async () => {
  const { transport } = await started();
  try {
    let cancelled = false;
    const body = new ReadableStream({ pull(controller) { controller.enqueue(new Uint8Array(1024)); }, cancel() { cancelled = true; } });
    const controller = new AbortController();
    const pending = get(transport, '/hold-upload', { method: 'POST', body, duplex: 'half', signal: controller.signal });
    controller.abort(); // before the request reached the host: nothing has taken a reader on the body yet
    assert.equal((await pending.catch(() => ({ status: 500 }))).status >= 400, true);
    assert.equal(await until(() => cancelled, 3000), true, 'the upload body is released, not left locked');
    assert.equal(await transport.ping(), true);
  } finally { await transport.stop(); }
});

test('a start that is cancelled by its signal rejects and leaves no host behind', async () => {
  process.env.FAKE_SERVICE_HANG = '1';
  try {
    const root = await mkdtemp(join(folder, 'ws-'));
    const controller = new AbortController();
    const before = new Set(childrenOf(process.pid));
    const starting = startTransport({ root, location, signal: controller.signal, startupTimeout: 20_000 });
    assert.equal(await until(() => childrenOf(process.pid).some(pid => !before.has(pid)), 5000), true, 'the host was spawned');
    const host = childrenOf(process.pid).find(pid => !before.has(pid));
    controller.abort();
    await assert.rejects(starting, error => error instanceof TransportError && /cancelled/.test(error.message));
    assert.equal(await until(() => !alive(host), 5000), true, 'the host was killed');
  } finally { delete process.env.FAKE_SERVICE_HANG; }
});

// The parent of a host is killed with SIGKILL (the app crashed or was killed). Nothing may be left, whatever the host
// was doing: starting, serving, stopped, or stuck in a loop that never returns to its event loop.
const helperSource = `
import { startTransport } from ${JSON.stringify(pathToFileURL(join(here, '..', '..', '..', 'src', 'main', 'transport.mjs')).href)};
const { root, location, scenario } = JSON.parse(process.argv[2]);
const transport = await startTransport({ root, location });
const grandchild = (await (await transport.handle(new Request('app://opendoc/grandchild'))).json()).pid;
console.log(JSON.stringify({ host: transport.pid, grandchild }));
if (scenario === 'busy') transport.handle(new Request('app://opendoc/busy')).catch(() => {});
await new Promise(() => {});
`;

async function runParent(scenario, { hang = false } = {}) {
  const root = await mkdtemp(join(folder, 'ws-'));
  const script = join(folder, `parent-${scenario}.mjs`);
  await writeFile(script, helperSource);
  const env = { ...process.env, ...(hang ? { FAKE_SERVICE_HANG: '1' } : {}) };
  const parent = spawn(process.execPath, [script, JSON.stringify({ root, location, scenario })], { env, stdio: ['ignore', 'pipe', 'inherit'] });
  let out = '';
  parent.stdout.on('data', data => { out += data; });
  return { parent, root, info: () => (out ? JSON.parse(out.split('\n')[0]) : null) };
}

test('kill -9 of the parent while the host is still starting leaves nothing', async () => {
  const { parent } = await runParent('start', { hang: true });
  assert.equal(await until(() => childrenOf(parent.pid).length > 0, 8000), true, 'a host was spawned');
  const host = childrenOf(parent.pid)[0];
  await pause(300);
  process.kill(parent.pid, 'SIGKILL');
  assert.equal(await until(() => !alive(host), 6000), true, 'the host that was starting is gone');
});

test('kill -9 of the parent while the host is busy in a loop leaves neither the host nor what it started', async () => {
  const { parent, info } = await runParent('busy');
  assert.equal(await until(() => info(), 15_000), true);
  const { host, grandchild } = info();
  await pause(500); // the loop is running
  assert.equal(alive(host), true);
  process.kill(parent.pid, 'SIGKILL');
  assert.equal(await until(() => !alive(host) && !alive(grandchild), 6000), true, 'host and grandchild are gone');
});

test('kill -9 of the parent while the host is stopped (SIGSTOP) leaves neither the host nor what it started', { skip: process.platform === 'win32' && 'process groups are not used on Windows' }, async () => {
  const { parent, info } = await runParent('serve');
  assert.equal(await until(() => info(), 15_000), true);
  const { host, grandchild } = info();
  process.kill(host, 'SIGSTOP');
  process.kill(parent.pid, 'SIGKILL');
  const gone = await until(() => !alive(host) && !alive(grandchild), 8000);
  if (!gone) for (const pid of [host, grandchild]) { try { process.kill(pid, 'SIGKILL'); } catch { /* gone */ } }
  assert.equal(gone, true, 'host and grandchild are gone');
});

test('after a normal stop the sentinel is gone too, and it never kills a group it does not own', async () => {
  const { transport } = await started();
  const group = transport.pid;
  await transport.stop();
  assert.equal(await until(() => { try { execFileSync('pgrep', ['-f', `opendoc-sentinel ${process.pid} ${group}$`]); return false; } catch { return true; } }, 4000), true);
});
