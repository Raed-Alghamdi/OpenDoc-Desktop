import test, { type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { spawn } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { cp, mkdir, mkdtemp, readdir, readFile, rm, stat, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { relative, resolve } from 'node:path';
import { renderToStaticMarkup } from 'react-dom/server';
import { createElement } from 'react';
import { fixture, projectRoot, source, until } from './helpers';
import { acceptAsApp } from './helpers-owner';
import { main } from '../src/cli/main';
import { commandRegistry } from '../src/cli/registry';
import { isWriteCommand, readOnlyCommands, writeCommands, workspaceReadOnly } from '../src/cli/read-only';
import { recordAgentChanges } from '../src/server/history-capture';
import { prepareOpenDocService, createOpenDocService, readOnlyAllows, type OpenDocService } from '../src/server/service';
import { readOnlyState, type ReadOnlyState } from '../src/shared/read-only';
import { ReadOnlyBanner } from '../src/app/ReadOnlyBanner';

const readOnly: ReadOnlyState = { reason: 'newer-patch', message: 'This workspace needs OpenDoc 0.6.9 or newer. Update the app to edit it.' };
const client = (_req: IncomingMessage, res: ServerResponse) => { res.writeHead(200, { 'Content-Type': 'text/plain' }); res.end('client'); };

async function listen(service: OpenDocService) {
  const server = createServer((req, res) => { service.handle(req, res).catch(() => {}); });
  await new Promise<void>(accept => server.listen(0, '127.0.0.1', accept));
  const origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  return { origin, close: () => new Promise<void>(accept => { server.close(() => accept()); server.closeAllConnections(); }) };
}

/** Every file in the workspace outside `.opendoc/` and `output/` (renders and exports may go there), with its digest. */
async function snapshot(root: string, directory = root): Promise<Record<string, string>> {
  const result: Record<string, string> = {};
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const path = resolve(directory, entry.name), name = relative(root, path);
    if (['.opendoc', 'output', 'src', 'node_modules', 'assets'].includes(name) || entry.isSymbolicLink()) continue;
    if (entry.isDirectory()) Object.assign(result, await snapshot(root, path));
    else result[name] = createHash('sha256').update(await readFile(path)).digest('hex');
  }
  return result;
}

const pinned = async (root: string) => writeFile(resolve(root, 'package.json'), JSON.stringify({ name: 'ws', private: true, type: 'module', dependencies: { opendoc: 'npm:@ryanyahya/opendoc@0.6.9' } }));

test('a read-only service refuses every write but the few it allows, and changes nothing in the workspace', { timeout: 120_000 }, async () => {
  const f = await fixture();
  await pinned(f.root); // pinned, with no .opendoc/workspace.json: a newer workspace this app must not stamp
  const prepared = await prepareOpenDocService({ root: f.root, production: false, client, readOnly });
  assert.equal(prepared.readOnlySupported, true);
  const { service } = prepared;
  await prepared.start();
  const server = await listen(service);
  const before = await snapshot(f.root);
  const write = (method: string, path: string, body: unknown = {}, token = service.token) => fetch(`${server.origin}${path}`, { method, headers: { 'Content-Type': 'application/json', 'X-OpenDoc-Token': token }, body: JSON.stringify(body) });
  try {
    assert.deepEqual(await fetch(`${server.origin}/api/session`).then(r => r.json()), { token: service.token, readOnly });
    await until(async () => (await fetch(`${server.origin}/api/documents?view=summary`).then(r => r.json()) as { status: string }[]).every(d => d.status === 'ready'));
    const hash = (await fetch(`${server.origin}/api/documents/proof`).then(r => r.json())).artifact.hash;

    // Every kind of write refuses with the app's message, the stable code and no change; routes that do not exist yet are covered too.
    const refused: [string, string, unknown?][] = [
      ['POST', '/api/documents', { title: 'New' }], ['PATCH', '/api/documents/proof', { name: 'x' }], ['DELETE', '/api/documents/proof'], ['POST', '/api/documents/proof/duplicate'],
      ['POST', '/api/documents/proof/comments', { hash, blockId: 'target', text: 'No.' }], ['PATCH', '/api/documents/proof/comments/abc', { status: 'resolved' }], ['DELETE', '/api/documents/proof/comments/abc'],
      ['POST', '/api/documents/proof/edits', {}], ['POST', '/api/documents/proof/edits/preview', {}], ['POST', '/api/documents/proof/history/20260101T000000000Z-abcdef12/restore', { scope: 'version' }],
      ['POST', '/api/projects', { id: 'p', name: 'P' }], ['PATCH', '/api/projects/test-project', { name: 'Q' }], ['DELETE', '/api/projects/test-project'], ['PUT', '/api/documents/proof/project', { projectId: null }],
      ['POST', '/api/assets/logo'], ['POST', '/api/packs/install', { stagedId: 'x', trust: true }], ['POST', '/api/future/route', {}], ['PUT', '/api/anything/else', {}],
    ];
    for (const [method, path, body] of refused) {
      const response = await write(method, path, body);
      assert.equal(response.status, 403, `${method} ${path}`);
      assert.deepEqual(await response.json(), { error: readOnly.message, code: 'workspace-read-only', readOnly }, `${method} ${path}`);
    }
    // The token check still comes first.
    assert.equal((await write('POST', '/api/documents', {}, 'wrong')).status, 403);

    // Reading, sharing the selection and exporting go on.
    assert.equal((await fetch(`${server.origin}/api/documents/proof/pdf?hash=${hash}`)).status, 200);
    assert.equal((await fetch(`${server.origin}/api/documents/proof/history`)).status, 200);
    assert.equal((await fetch(`${server.origin}/api/documents/proof/comments`)).status, 200);
    assert.equal((await write('POST', '/api/context', { documentId: 'proof', blockId: 'target', page: 1 })).status, 200);
    const exported = await write('POST', '/api/documents/proof/export', { hash });
    assert.equal(exported.status, 200);
    assert.ok((await readdir(resolve(f.root, 'output'))).length >= 1);

    // A source change on disk while the service watches is not recorded as a version.
    await writeFile(f.entry, (await readFile(f.entry, 'utf8')).replace('A first draft', 'An outside draft'));
    await until(async () => JSON.stringify((await fetch(`${server.origin}/api/documents/proof`).then(r => r.json())).artifact?.blocks?.title?.text ?? '').includes('outside'));
    await new Promise(accept => setTimeout(accept, 3_200)); // a writable service records an outside change after 2.5 s of quiet
    await server.close();
    await service.close();
    const after = await snapshot(f.root);
    assert.deepEqual(Object.keys(after).filter(name => /\.history|workspace\.json|comments\.json/.test(name)), [], 'No history, comment or marker file appears.');
    assert.deepEqual({ ...before, 'documents/proof/index.tsx': after['documents/proof/index.tsx'] }, after, 'Nothing else in the workspace changed.');
    await assert.rejects(stat(resolve(f.root, '.opendoc/workspace.json')), { code: 'ENOENT' });
  } finally { await server.close(); await service.close(); await f.cleanup(); }
});

test('a service without the option is as writable as before, and says nothing about read-only', { timeout: 60_000 }, async () => {
  const f = await fixture();
  const service = await createOpenDocService({ root: f.root, production: false, client });
  const server = await listen(service);
  try {
    assert.deepEqual(await fetch(`${server.origin}/api/session`).then(r => r.json()), { token: service.token });
    assert.equal((await fetch(`${server.origin}/api/future/route`, { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-OpenDoc-Token': service.token }, body: '{}' })).status, 404);
  } finally { await server.close(); await service.close(); await f.cleanup(); }
});

test('read-only survives a restart, and an option that cannot be understood never opens a writable service', { timeout: 60_000 }, async () => {
  const f = await fixture();
  try {
    for (let round = 0; round < 2; round++) {
      const service = await createOpenDocService({ root: f.root, production: false, client, readOnly });
      const server = await listen(service);
      try {
        assert.deepEqual((await fetch(`${server.origin}/api/session`).then(r => r.json())).readOnly, readOnly);
        assert.equal((await fetch(`${server.origin}/api/projects`, { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-OpenDoc-Token': service.token }, body: '{"id":"p","name":"P"}' })).status, 403);
      } finally { await server.close(); await service.close(); }
    }
    for (const bad of [{ reason: 'nonsense', message: 'x' }, { reason: 'newer-minor' }, { reason: 'newer-minor', message: '  ' }, 'read-only', 7]) {
      await assert.rejects(createOpenDocService({ root: f.root, production: false, client, readOnly: bad as never }), /readOnly option/);
    }
  } finally { await f.cleanup(); }
});

test('the literal the desktop app looks for is in service.ts', async () => {
  assert.match(await readFile(resolve(projectRoot, 'src/server/service.ts'), 'utf8'), /readOnlySupported\s*:\s*true/);
});

test('the banner shows the app\'s message exactly, and nothing when the workspace is writable', () => {
  const tricky: ReadOnlyState = { reason: 'restored-backup', message: 'Restored from a backup on OpenDoc 0.6.1 <again>. "Open it again" & upgrade.' };
  const html = renderToStaticMarkup(createElement(ReadOnlyBanner, { state: tricky }));
  assert.match(html, /role="status"/);
  assert.ok(html.includes('Restored from a backup on OpenDoc 0.6.1 &lt;again&gt;. &quot;Open it again&quot; &amp; upgrade.'));
  assert.equal(renderToStaticMarkup(createElement(ReadOnlyBanner, { state: null })), '');
  assert.deepEqual(readOnlyState(tricky), tricky);
  assert.equal(readOnlyState({ reason: 'x', message: 'y' }), null);
});

test('every command is classified once, as read or as write, against the registry', () => {
  const paths = new Set(commandRegistry.map(entry => entry.path.join(' ')));
  const classified = [...readOnlyCommands, ...writeCommands];
  assert.equal(new Set(classified).size, classified.length, 'No command is in both lists or twice.');
  for (const path of paths) assert.ok(classified.includes(path), `Decide whether "${path}" writes: add it to readOnlyCommands or writeCommands in src/cli/read-only.ts.`);
  for (const path of classified) assert.ok(paths.has(path), `"${path}" is classified but is not a registered command.`);
  for (const path of readOnlyCommands) { const [command, ...args] = path.split(' '); assert.equal(isWriteCommand(command, args.concat(command === 'update' ? ['--check'] : [])), false, path); }
  for (const path of writeCommands) { const [command, ...args] = path.split(' '); assert.equal(isWriteCommand(command, args), true, path); }
  assert.equal(isWriteCommand('create', ['--list']), false);
  assert.equal(isWriteCommand('create', ['x', '--title', 'T']), true);
  assert.equal(isWriteCommand('update', ['--check']), false);
  assert.equal(isWriteCommand('update', []), true);
  assert.equal(isWriteCommand('--version', []), false);
  assert.equal(isWriteCommand('documents', ['rename', 'proof', 'New']), true);
  assert.equal(isWriteCommand('export', ['history', 'list', 'proof']), false);
  assert.equal(isWriteCommand('somethingnew', []), true, 'A command nobody classified is refused.');
});

/** A workspace the real dispatcher accepts, as the CLI tests build them, with a document and the app standing by. */
async function appWorkspace(t: TestContext, state: ReadOnlyState | null) {
  const root = await mkdtemp(resolve(tmpdir(), 'opendoc-readonly-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const { version } = JSON.parse(await readFile(resolve(projectRoot, 'package.json'), 'utf8'));
  await writeFile(resolve(root, 'package.json'), JSON.stringify({ name: 'ws', private: true, type: 'module', dependencies: { opendoc: `npm:@ryanyahya/opendoc@${version}` } }));
  await mkdir(resolve(root, '.opendoc'), { recursive: true });
  await writeFile(resolve(root, '.opendoc/workspace.json'), '{"formatVersion":1}\n');
  await mkdir(resolve(root, 'node_modules'));
  await symlink(projectRoot, resolve(root, 'node_modules/opendoc'), 'dir');
  for (const folder of ['themes', 'assets']) await cp(resolve(projectRoot, folder), resolve(root, folder), { recursive: true });
  await symlink(resolve(projectRoot, 'src'), resolve(root, 'src'), 'dir');
  await mkdir(resolve(root, 'documents/proof'), { recursive: true });
  await writeFile(resolve(root, 'documents/proof/index.tsx'), source());
  await writeFile(resolve(root, 'projects.json'), JSON.stringify({ version: 1, projects: [{ id: 'test-project', name: 'Test project', defaultTheme: null }], assignments: { proof: 'test-project' } }));
  const sleeper = spawn('sleep', ['300'], { stdio: 'ignore' });
  t.after(() => { sleeper.kill('SIGKILL'); });
  const pid = acceptAsApp(sleeper.pid!, t);
  await writeFile(resolve(root, '.opendoc/desktop.json'), JSON.stringify({ pid, startedAt: '2026-01-01T00:00:00.000Z', version: '0.6.1', build: 1, ...(state ? { readOnly: state } : {}) }));
  return root;
}

function capture(t: TestContext) {
  const lines: string[] = [];
  const log = t.mock.method(console, 'log', (line: unknown) => { lines.push(String(line)); });
  t.mock.method(console, 'error', () => {});
  return { lines, log };
}

test('the CLI refuses every command that writes while the app has the workspace read-only, and still reads, reviews and exports', { timeout: 180_000 }, async t => {
  const root = await appWorkspace(t, readOnly);
  const { lines } = capture(t);
  const run = async (...args: string[]) => { process.exitCode = undefined; lines.length = 0; await main(['--workspace', root, ...args, '--json']); const code = process.exitCode; process.exitCode = undefined; return { code, last: lines.length ? JSON.parse(lines.at(-1)!) : undefined }; };
  const before = await snapshot(root);
  assert.deepEqual((await workspaceReadOnly(root)), readOnly);
  const writes: string[][] = [
    ['create', 'new-doc', '--project', 'test-project', '--title', 'New'], ['projects', 'create', 'p2', '--name', 'P2'], ['projects', 'assign', 'proof', 'test-project'],
    ['documents', 'rename', 'proof', 'Other'], ['documents', 'duplicate', 'proof'], ['documents', 'delete', 'proof'],
    ['comments', 'add', 'proof', 'target', 'No'], ['comments', 'resolve', 'proof', 'abc'], ['history', 'restore', 'proof', '20260101T000000000Z-abcdef12'],
    ['tags', 'add', 'document', 'proof', 'x'], ['assets', 'archive', 'x'], ['media', 'import', 'proof', 'x.png'], ['themes', 'folders', 'create', 'f'], ['packs', 'install', 'x.opendoc-pack'], ['update'],
  ];
  for (const args of writes) {
    const result = await run(...args);
    assert.equal(result.code, 1, args.join(' '));
    assert.deepEqual(result.last, { ok: false, error: readOnly.message, code: 'workspace-read-only' }, args.join(' '));
  }
  // Reading, reviewing and exporting work.
  assert.equal((await run('documents', 'trash')).code, undefined);
  assert.equal((await run('projects', 'list')).code, undefined);
  assert.equal((await run('review', 'proof')).code, undefined);
  assert.equal((await run('export', 'proof')).code, undefined);
  assert.ok((await readdir(resolve(root, 'output'))).length >= 1);
  assert.deepEqual(await snapshot(root), before, 'Nothing under documents/ or anywhere else in the workspace changed.');
  // History recording is off even for the commands that normally record agent edits.
  await writeFile(resolve(root, 'documents/proof/index.tsx'), source().replace('A first draft', 'An agent draft'));
  assert.deepEqual(await recordAgentChanges(root, ['proof']), []);
  await assert.rejects(stat(resolve(root, 'documents/proof/.history')), { code: 'ENOENT' });
});

test('without the app\'s read-only record, the same writes are accepted and history is recorded', { timeout: 120_000 }, async t => {
  const root = await appWorkspace(t, null);
  await rm(resolve(root, '.opendoc/desktop.json'));
  const { lines } = capture(t);
  process.exitCode = undefined;
  await main(['--workspace', root, 'documents', 'rename', 'proof', 'Renamed', '--json']);
  assert.equal(process.exitCode, undefined, lines.join('\n'));
  await recordAgentChanges(root, ['proof']); // the first version of a document
  await writeFile(resolve(root, 'documents/proof/index.tsx'), source().replace('A first draft', 'An agent draft'));
  assert.equal((await recordAgentChanges(root, ['proof'])).length, 1);
});

test('the read-only allowlist matches exactly the routes that write only exports, packs output and context', () => {
  const allowed: [string, string][] = [
    ['GET', '/api/anything'], ['HEAD', '/api/documents'], ['POST', '/api/context'],
    ['POST', '/api/documents/proof/export'], ['POST', '/api/documents/proof/exports'],
    ['DELETE', '/api/exports/abc-123'], ['POST', '/api/exports/abc-123/restore'], ['POST', '/api/exports/abc-123/reveal'], ['POST', '/api/exports/abc-123/copy'],
    ['POST', '/api/packs/export'], ['POST', '/api/packs/inspect'],
  ];
  for (const [method, path] of allowed) assert.equal(readOnlyAllows(method, path), true, `${method} ${path}`);
  const refused: [string, string][] = [
    ['POST', '/api/packs/install'], ['POST', '/api/packs/export/extra'], ['POST', '/api/packs/inspect/x'], ['PUT', '/api/packs/export'], ['DELETE', '/api/packs/inspect'], ['POST', '/api/packs'],
    ['POST', '/api/documents/proof/exports/extra'], ['POST', '/api/documents/proof/exports/'], ['PATCH', '/api/documents/proof/exports'], ['DELETE', '/api/documents/proof/exports'], ['POST', '/api/documents/a/b/exports'],
    ['POST', '/api/exports/abc-123/download'], ['PUT', '/api/exports/abc-123'], ['POST', '/api/documents/proof/comments'], ['POST', '/api/projects'],
  ];
  for (const [method, path] of refused) assert.equal(readOnlyAllows(method, path), false, `${method} ${path}`);
});

test('the app\'s own Export button route (plural) works in read-only mode and writes only exports and output', { timeout: 60_000 }, async () => {
  const f = await fixture();
  const service = await createOpenDocService({ root: f.root, production: false, client, readOnly });
  const server = await listen(service);
  try {
    const headers = { 'Content-Type': 'application/json', 'X-OpenDoc-Token': service.token, Origin: server.origin };
    let state: { status?: string; artifact?: { hash: string } } | undefined;
    await until(async () => { state = (await fetch(`${server.origin}/api/documents`).then(response => response.json()) as { id: string; status?: string; artifact?: { hash: string } }[]).find(item => item.id === 'proof'); return state?.status === 'ready'; });
    const before = await snapshot(f.root);
    const saved = await fetch(`${server.origin}/api/documents/proof/exports`, { method: 'POST', headers, body: JSON.stringify({ id: randomUUID(), hash: state!.artifact!.hash, filename: 'proof.pdf', format: 'pdf' }) });
    assert.ok(saved.ok, `${saved.status} ${await saved.clone().text()}`);
    assert.deepEqual(await snapshot(f.root), before);
    assert.equal((await fetch(`${server.origin}/api/packs/install`, { method: 'POST', headers, body: '{}' })).status, 403);
  } finally { await server.close(); await service.close(); await f.cleanup(); }
});
