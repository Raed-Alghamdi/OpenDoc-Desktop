import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { fixture, projectRoot, source, until } from './helpers';
import { createOpenDocService, prepareOpenDocService, type OpenDocService } from '../src/server/service';

const run = promisify(execFile);
const tsx = import.meta.resolve('tsx'); // an absolute URL, so a child in an empty folder can load it
const servicePath = resolve(projectRoot, 'src/server/service.ts');
// The service never serves the built app in these tests; a stub stands in for the client middleware.
const client = (_req: IncomingMessage, res: ServerResponse) => { res.writeHead(200, { 'Content-Type': 'text/plain' }); res.end('client'); };

// A plain Node listener over the service, as `index.ts` and the desktop host's adapter both provide.
async function listen(service: OpenDocService) {
  const server = createServer((req, res) => { service.handle(req, res).catch(() => {}); });
  await new Promise<void>(accept => server.listen(0, '127.0.0.1', accept));
  const origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  return { origin, close: () => new Promise<void>(accept => { server.close(() => accept()); server.closeAllConnections(); }) };
}

test('importing the service module starts nothing', { timeout: 30_000 }, async () => {
  const cwd = await mkdtemp(resolve(tmpdir(), 'opendoc-import-'));
  try {
    // The process must end by itself: no watcher, timer, listener or child keeps it alive.
    const { stdout, stderr } = await run(process.execPath, ['--import', tsx, '--input-type=module', '-e', `const mod = await import(${JSON.stringify(servicePath)}); console.log(typeof mod.createOpenDocService);`], { cwd, timeout: 20_000 });
    assert.equal(stdout.trim(), 'function');
    assert.equal(stderr, '');
    assert.deepEqual(await readdir(cwd), [], 'Importing writes no file, such as .opendoc/server.json.');
  } finally { await rm(cwd, { recursive: true, force: true }); }
});

test('a development service without a client refuses to start', async () => {
  const f = await fixture();
  try { await assert.rejects(createOpenDocService({ root: f.root, production: false }), /needs the middleware/); }
  finally { await f.cleanup(); }
});

test('two services on two roots in one process stay separate', { timeout: 120_000 }, async () => {
  const first = await fixture();
  const second = await fixture();
  await writeFile(second.entry, source().replace('A first draft with office efficiency', 'The second workspace'));
  await mkdir(resolve(second.root, 'documents/extra'), { recursive: true });
  await writeFile(resolve(second.root, 'documents/extra/index.tsx'), source());
  const a = await createOpenDocService({ root: first.root, production: false, client });
  const b = await createOpenDocService({ root: second.root, production: false, client });
  const listeners = [await listen(a), await listen(b)];
  const [origin1, origin2] = [listeners[0].origin, listeners[1].origin];
  const changes = [0, 0];
  const stops = [a.onChange(() => { changes[0]++; }), b.onChange(() => { changes[1]++; })];
  try {
    assert.notEqual(a.token, b.token);
    assert.deepEqual(await fetch(`${origin1}/api/session`).then(r => r.json()), { token: a.token });
    assert.deepEqual(await fetch(`${origin2}/api/session`).then(r => r.json()), { token: b.token });
    const documents = async (origin: string) => (await fetch(`${origin}/api/documents?view=summary`).then(r => r.json()) as { id: string; status: string }[]);
    await until(async () => (await documents(origin1)).every(d => d.status === 'ready') && (await documents(origin2)).length === 2 && (await documents(origin2)).every(d => d.status === 'ready'));
    assert.deepEqual((await documents(origin1)).map(d => d.id), ['proof']);
    assert.deepEqual((await documents(origin2)).map(d => d.id).sort(), ['extra', 'proof']);
    const heading = async (origin: string) => JSON.stringify((await fetch(`${origin}/api/documents/proof`).then(r => r.json())).artifact.blocks.title.text);
    assert.match(await heading(origin1), /A first draft/);
    assert.match(await heading(origin2), /The second workspace/);

    // A token belongs to one service.
    const hash = (await fetch(`${origin1}/api/documents/proof`).then(r => r.json())).artifact.hash;
    const comment = (origin: string, token: string) => fetch(`${origin}/api/documents/proof/comments`, { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-OpenDoc-Token': token }, body: JSON.stringify({ hash, blockId: 'target', text: 'Only in the first root.' }) });
    assert.equal((await comment(origin2, a.token)).status, 403);
    const before = [...changes];
    assert.equal((await comment(origin1, a.token)).status, 200);
    assert.equal((await fetch(`${origin1}/api/documents/proof/comments`).then(r => r.json())).length, 1);
    assert.equal((await fetch(`${origin2}/api/documents/proof/comments`).then(r => r.json())).length, 0, 'The second root sees nothing of the first root\'s comment.');
    assert.equal(JSON.parse(await readFile(resolve(first.root, 'documents/proof/comments.json'), 'utf8')).length, 1);
    await assert.rejects(readFile(resolve(second.root, 'documents/proof/comments.json'), 'utf8'), { code: 'ENOENT' });

    // Changes are announced only to the service that owns the file.
    await until(() => changes[0] > before[0]);
    assert.equal(changes[1], before[1]);
    await writeFile(second.entry, (await readFile(second.entry, 'utf8')).replace('The second workspace', 'The second workspace, revised'));
    await until(async () => JSON.stringify((await fetch(`${origin2}/api/documents/proof`).then(r => r.json())).artifact?.blocks?.title?.text ?? '').includes('revised'));
    assert.match(await heading(origin1), /A first draft/);
    assert.ok(changes[1] > before[1]);
  } finally {
    for (const stop of stops) stop();
    await Promise.all(listeners.map(l => l.close()));
    await Promise.all([a.close(), b.close()]);
    await Promise.all([first.cleanup(), second.cleanup()]);
  }
});

test('close() releases the watchers', { timeout: 120_000 }, async () => {
  const f = await fixture();
  const service = await createOpenDocService({ root: f.root, production: false, client });
  const server = await listen(service);
  let changes = 0;
  service.onChange(() => { changes++; });
  try {
    await until(async () => (await fetch(`${server.origin}/api/documents?view=summary`).then(r => r.json()) as { status: string }[]).every(d => d.status === 'ready'));
    // While open, a source edit is seen.
    const seen = changes;
    await writeFile(f.entry, (await readFile(f.entry, 'utf8')).replace('A first draft', 'A watched draft'));
    await until(() => changes > seen);
    await until(async () => (await fetch(`${server.origin}/api/documents?view=summary`).then(r => r.json()) as { status: string }[]).every(d => d.status === 'ready'));
    await server.close();
    await service.close();
    await service.close(); // Closing twice is harmless.
    const closed = changes;
    await writeFile(f.entry, (await readFile(f.entry, 'utf8')).replace('A watched draft', 'An unwatched draft'));
    await new Promise(accept => setTimeout(accept, 1_500));
    assert.equal(changes, closed, 'A closed service no longer watches the source.');
  } finally { await f.cleanup(); }
});

test('a process that creates and closes a service exits by itself', { timeout: 120_000 }, async () => {
  const f = await fixture();
  try {
    // A live chokidar watcher, history timer or render child would keep this process running until the timeout.
    const script = `
      const { createOpenDocService } = await import(${JSON.stringify(servicePath)});
      const service = await createOpenDocService({ root: process.cwd(), production: false, client: (_req, res) => res.end('client') });
      await new Promise(accept => setTimeout(accept, 500));
      await service.close();
      console.log('closed');
    `;
    const started = Date.now();
    const { stdout } = await run(process.execPath, ['--import', 'tsx', '--input-type=module', '-e', script], { cwd: f.root, timeout: 60_000, killSignal: 'SIGKILL' });
    assert.equal(stdout.trim(), 'closed');
    assert.ok(Date.now() - started < 60_000);
  } finally { await f.cleanup(); }
});

test('a second instance that loses a pinned port never starts a service', { timeout: 120_000 }, async () => {
  const f = await fixture();
  const taken = createServer();
  await new Promise<void>(accept => taken.listen(0, '127.0.0.1', accept));
  try {
    const port = (taken.address() as AddressInfo).port;
    // OPENDOC_PORT pins the port, so there is no fallback to a free one and start-up fails.
    const result = await run(process.execPath, ['--import', 'tsx', resolve(projectRoot, 'src/server/index.ts')], { cwd: f.root, env: { ...process.env, OPENDOC_PORT: String(port) }, timeout: 60_000, killSignal: 'SIGKILL' }).then(() => ({ code: 0, stderr: '' }), error => ({ code: error.code as number, stderr: String(error.stderr) }));
    assert.equal(result.code, 1);
    assert.match(result.stderr, /EADDRINUSE/);
    // As in 0.6.1 the port is claimed before the workspace is touched: no server.json, no renders, no history.
    await assert.rejects(readdir(resolve(f.root, '.opendoc')), { code: 'ENOENT' });
    await assert.rejects(readdir(resolve(f.root, 'documents/proof/.history')), { code: 'ENOENT' });
  } finally { await new Promise(accept => taken.close(accept)); await f.cleanup(); }
});

test('a prepared service watches nothing until it is started', { timeout: 120_000 }, async () => {
  const f = await fixture();
  const { service, start } = await prepareOpenDocService({ root: f.root, production: false, client });
  const server = await listen(service);
  let changes = 0;
  service.onChange(() => { changes++; });
  try {
    assert.deepEqual(await fetch(`${server.origin}/api/session`).then(r => r.json()), { token: service.token }, 'It answers before it starts.');
    await writeFile(f.entry, (await readFile(f.entry, 'utf8')).replace('A first draft', 'An early draft'));
    await new Promise(accept => setTimeout(accept, 1_000));
    assert.equal(changes, 0);
    await assert.rejects(readdir(resolve(f.root, '.opendoc')), { code: 'ENOENT' }, 'Nothing is written before start.');
    await start();
    await start(); // Starting twice is harmless.
    const seen = changes;
    await writeFile(f.entry, (await readFile(f.entry, 'utf8')).replace('An early draft', 'A started draft'));
    await until(() => changes > seen);
  } finally { await server.close(); await service.close(); await f.cleanup(); }
});

test('a prepared service that is closed without starting leaves nothing running', { timeout: 60_000 }, async () => {
  const f = await fixture();
  try {
    const script = `
      const { prepareOpenDocService } = await import(${JSON.stringify(servicePath)});
      const { service } = await prepareOpenDocService({ root: process.cwd(), production: false, client: (_req, res) => res.end('client') });
      await service.close();
      console.log('closed');
    `;
    const { stdout } = await run(process.execPath, ['--import', 'tsx', '--input-type=module', '-e', script], { cwd: f.root, timeout: 30_000, killSignal: 'SIGKILL' });
    assert.equal(stdout.trim(), 'closed');
  } finally { await f.cleanup(); }
});

test('a failed start releases everything it started, then rethrows', { timeout: 60_000 }, async () => {
  const f = await fixture();
  try {
    await writeFile(resolve(f.root, 'projects.json'), '{ not json');
    // A leaked watcher or timer would keep this process alive until the timeout kills it.
    const script = `
      const { createOpenDocService } = await import(${JSON.stringify(servicePath)});
      try { await createOpenDocService({ root: process.cwd(), production: false, client: (_req, res) => res.end('client') }); console.log('started'); }
      catch (error) { console.log('rejected'); }
    `;
    const { stdout } = await run(process.execPath, ['--import', 'tsx', '--input-type=module', '-e', script], { cwd: f.root, timeout: 30_000, killSignal: 'SIGKILL' });
    assert.equal(stdout.trim(), 'rejected');
  } finally { await f.cleanup(); }
});

test('handle() reports a failing route to its caller only, with no unhandled rejection', { timeout: 30_000 }, async () => {
  const f = await fixture();
  // The client sends a whole response and then fails, so the error reply itself cannot be written.
  const failing = (_req: IncomingMessage, res: ServerResponse) => { res.writeHead(200); res.end('done'); throw new Error('stream failed'); };
  const service = await createOpenDocService({ root: f.root, production: false, client: failing });
  const unhandled: unknown[] = [];
  const record = (reason: unknown) => { unhandled.push(reason); };
  process.on('unhandledRejection', record);
  const caught: unknown[] = [];
  const server = createServer((req, res) => { service.handle(req, res).catch(error => caught.push(error)); });
  await new Promise<void>(accept => server.listen(0, '127.0.0.1', accept));
  try {
    await fetch(`http://127.0.0.1:${(server.address() as AddressInfo).port}/`).then(r => r.text());
    await until(() => caught.length === 1);
    await new Promise(accept => setTimeout(accept, 200)); // unhandled rejections are reported after the microtask queue drains
    assert.equal(caught.length, 1);
    assert.deepEqual(unhandled, []);
  } finally {
    process.off('unhandledRejection', record);
    server.closeAllConnections(); await new Promise(accept => server.close(accept));
    await service.close(); await f.cleanup();
  }
});

test('handle() after close() answers 503 and does no work', { timeout: 60_000 }, async () => {
  const f = await fixture();
  const service = await createOpenDocService({ root: f.root, production: false, client });
  const server = await listen(service);
  try {
    assert.equal((await fetch(`${server.origin}/api/documents?view=summary`)).status, 200);
    await service.close();
    const read = await fetch(`${server.origin}/api/documents?view=summary`);
    assert.equal(read.status, 503);
    assert.deepEqual(await read.json(), { error: 'OpenDoc is closing.' });
    // A write without the token gets the same answer: the request is not routed at all.
    assert.equal((await fetch(`${server.origin}/api/context`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' })).status, 503);
    assert.equal((await fetch(`${server.origin}/`)).status, 503, 'The client is not served either.');
  } finally { await server.close(); await f.cleanup(); }
});
