import test, { type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { main } from '../src/cli/main';
import { runContext } from '../src/cli/context';
import { projectRoot } from './helpers';
import { acceptAsApp } from './helpers-owner';

const desktopJson = (pid: number) => JSON.stringify({ pid, startedAt: '2026-01-01T00:00:00.000Z', version: '0.6.1', build: 1 });
const selections = [{ blockId: 'target', quote: 'A phrase', targetId: 'body', start: 2, end: 10 }, { blockId: 'title', quote: 'Title' }];
const record = { documentId: 'proof', blockId: 'target', revision: 3, name: 'Proof', selection: selections[0], selections, selectionCurrent: true, pendingComments: [], futureKey: { kept: true } };

async function scratch(t: TestContext, current: unknown = record) {
  const root = await mkdtemp(resolve(tmpdir(), 'opendoc-context-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  await mkdir(resolve(root, '.opendoc'));
  if (current !== null) await writeFile(resolve(root, '.opendoc/current.json'), typeof current === 'string' ? current : JSON.stringify(current, null, 2) + '\n');
  return root;
}

const control = (root: string, file: string, text: string) => writeFile(resolve(root, '.opendoc', file), text);

function printed(t: TestContext) {
  const lines: string[] = [];
  t.mock.method(console, 'log', (line: string) => { lines.push(line); });
  t.mock.method(console, 'error', () => {});
  return lines;
}

function alive(t: TestContext) {
  const child = spawn('sleep', ['300'], { stdio: 'ignore' });
  t.after(() => { child.kill('SIGKILL'); });
  return acceptAsApp(child.pid!, t);
}

/** A stand-in service that reports the given revision for the document, or none. */
async function service(t: TestContext, revision: number | null) {
  const token = 'context-test-token';
  const server = createServer((request, response) => {
    response.setHeader('Content-Type', 'application/json');
    if (request.url === '/api/session') response.end(JSON.stringify({ token }));
    else if (request.url === '/api/documents/proof' && revision !== null) response.end(JSON.stringify({ id: 'proof', status: 'ready', revision }));
    else { response.statusCode = 404; response.end('{"error":"Document not found."}'); }
  });
  await new Promise<void>(accept => server.listen(0, '127.0.0.1', accept));
  t.after(() => new Promise<void>(accept => { server.closeAllConnections(); server.close(() => accept()); }));
  const address = server.address();
  assert.ok(address && typeof address !== 'string');
  return { origin: `http://127.0.0.1:${address.port}`, token };
}

test('context with the app closed passes the record through and marks it stale', async t => {
  const root = await scratch(t);
  const lines = printed(t);
  await runContext(['--json'], root);
  const result = JSON.parse(lines.pop()!);
  assert.deepEqual(result, { ...record, stale: true });
  assert.deepEqual(result.selections, selections, 'selections pass through untouched');
  assert.equal(JSON.stringify(Object.keys(result).slice(0, -1)), JSON.stringify(Object.keys(record)), 'the app\'s keys keep their order');
  assert.equal(await readFile(resolve(root, '.opendoc/current.json'), 'utf8'), JSON.stringify(record, null, 2) + '\n', 'the file is only read');
});

test('context beside a service is current only while the document revision matches', async t => {
  const lines = printed(t);
  for (const [revision, stale] of [[3, false], [4, true], [null, true]] as const) {
    const root = await scratch(t);
    const live = await service(t, revision);
    await control(root, 'server.json', JSON.stringify({ origin: live.origin, token: live.token, pid: process.pid }));
    await runContext(['--json'], root);
    const result = JSON.parse(lines.pop()!);
    assert.equal(result.stale, stale, `revision ${revision}`);
    assert.deepEqual(result.selections, selections);
  }
  // A library view has no document to be behind on.
  const root = await scratch(t, { documentId: null, view: 'library' });
  const live = await service(t, 1);
  await control(root, 'server.json', JSON.stringify({ origin: live.origin, token: live.token, pid: process.pid }));
  await runContext(['--json'], root);
  assert.equal(JSON.parse(lines.pop()!).stale, false);
});

test('context beside the desktop app is current, and a stale desktop record counts as closed', async t => {
  const root = await scratch(t);
  const lines = printed(t);
  await control(root, 'desktop.json', desktopJson(alive(t)));
  await runContext(['--json'], root);
  const result = JSON.parse(lines.pop()!);
  assert.equal(result.stale, false);
  assert.deepEqual(result.selections, selections);

  const gone = spawn(process.execPath, ['-e', ''], { stdio: 'ignore' });
  const pid = gone.pid!;
  await once(gone, 'exit');
  await control(root, 'desktop.json', desktopJson(pid));
  await runContext(['--json'], root);
  assert.equal(JSON.parse(lines.pop()!).stale, true);
});

test('an owner that cannot be confirmed leaves the record stale', async t => {
  const root = await scratch(t);
  const lines = printed(t);
  await control(root, 'server.json', 'garbage');
  await runContext(['--json'], root);
  assert.equal(JSON.parse(lines.pop()!).stale, true);
});

test('context without a record, with an unreadable one, or with extra arguments fails with guidance', async t => {
  printed(t);
  await assert.rejects(runContext(['--json'], await scratch(t, null)), /no current context yet/);
  await assert.rejects(runContext([], await scratch(t, 'not json')), /not a valid context record/);
  await assert.rejects(runContext([], await scratch(t, '[1]')), /not a valid context record/);
  await assert.rejects(runContext(['extra'], await scratch(t)), /Usage: npx opendoc context/);
});

test('context prints a short summary without --json', async t => {
  const root = await scratch(t);
  const lines = printed(t);
  await runContext([], root);
  assert.match(lines.pop()!, /^Document: Proof \(revision 3\)\nSelection: target "A phrase"\nStale:/);
  await control(root, 'desktop.json', desktopJson(alive(t)));
  await runContext([], root);
  assert.doesNotMatch(lines.pop()!, /Stale/);
});

test('context is a registered command of the opendoc CLI', async t => {
  const root = await scratch(t);
  const lines = printed(t);
  const { version } = JSON.parse(await readFile(resolve(projectRoot, 'package.json'), 'utf8'));
  await writeFile(resolve(root, 'package.json'), JSON.stringify({ name: 'scratch', private: true, dependencies: { opendoc: `npm:@ryanyahya/opendoc@${version}` } }));
  await writeFile(resolve(root, '.opendoc/workspace.json'), '{"formatVersion":1}\n');
  await mkdir(resolve(root, 'node_modules'));
  await symlink(projectRoot, resolve(root, 'node_modules/opendoc'), 'dir');
  process.exitCode = undefined;
  await main(['--workspace', root, 'context', '--json']);
  assert.equal(process.exitCode, undefined);
  assert.deepEqual(JSON.parse(lines.splice(0).at(-1)!).selections, selections);
  await rm(resolve(root, '.opendoc/current.json'));
  await main(['--workspace', root, 'context', '--json']);
  assert.equal(process.exitCode, 1, 'No record is a failure.');
  process.exitCode = undefined;
  assert.match(JSON.parse(lines.splice(0).at(-1)!).error, /no current context yet/);
  await main(['--help']);
  assert.match(lines.pop()!, /opendoc context/);
});
