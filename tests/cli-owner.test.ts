import test, { type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { spawn, type ChildProcess } from 'node:child_process';
import { once } from 'node:events';
import { cp, mkdir, symlink, mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { dirname, resolve } from 'node:path';
import { main } from '../src/cli/main';
import { InvalidOwnerRecord, workspaceOwner, workspaceSession } from '../src/cli/owner';
import { runStatus } from '../src/cli/status';
import { runStop } from '../src/cli/stop';
import { runStart } from '../src/cli/start';
import { runCommentsCli } from '../src/server/comments-cli';
import { readComments } from '../src/server/comments';
import { exportDocuments } from '../src/server/export-batch';
import { HistoryStore } from '../src/server/history';
import { historyService, recordAgentChanges } from '../src/server/history-capture';
import { runHistoryCli } from '../src/server/history-cli';
import { collectPack } from '../src/packs/collect';
import { writeArchive } from '../src/packs/archive';
import { digest, type PackManifest } from '../src/packs/manifest';
import { installPack } from '../src/packs/packs';
import { fixture, projectRoot, source } from './helpers';
import { acceptAsApp } from './helpers-owner';

const desktopJson = (pid: number) => JSON.stringify({ pid, startedAt: '2026-01-01T00:00:00.000Z', version: '0.6.1', build: 1 });

async function control(root: string, file: string, contents: string) {
  await mkdir(resolve(root, '.opendoc'), { recursive: true });
  await writeFile(resolve(root, '.opendoc', file), contents);
}

/** A process that stays alive until the test ends, standing in for the app. */
function alive(t: TestContext) {
  const child = spawn('sleep', ['300'], { stdio: 'ignore' });
  t.after(() => { child.kill('SIGKILL'); });
  return acceptAsApp(child.pid!, t);
}

/** A pid that belonged to a process that has exited. */
async function dead() {
  const child = spawn(process.execPath, ['-e', ''], { stdio: 'ignore' });
  const pid = child.pid!;
  await once(child, 'exit');
  return pid;
}

async function sessionServer(t: TestContext, token = 'owner-test-token') {
  const server = createServer((request, response) => {
    response.setHeader('Content-Type', 'application/json');
    response.end(request.url === '/api/session' ? JSON.stringify({ token }) : '[]');
  });
  await new Promise<void>(accept => server.listen(0, '127.0.0.1', accept));
  t.after(() => new Promise<void>(accept => { server.closeAllConnections(); server.close(() => accept()); }));
  const address = server.address();
  assert.ok(address && typeof address !== 'string');
  return { server, origin: `http://127.0.0.1:${address.port}`, token };
}

async function closedOrigin() {
  const server = createServer();
  await new Promise<void>(accept => server.listen(0, '127.0.0.1', accept));
  const address = server.address();
  assert.ok(address && typeof address !== 'string');
  await new Promise(accept => server.close(accept));
  return `http://127.0.0.1:${address.port}`;
}

async function scratch(t: TestContext) {
  const root = await mkdtemp(resolve(tmpdir(), 'opendoc-owner-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  await mkdir(resolve(root, '.opendoc'));
  return root;
}

function printed(t: TestContext) {
  const lines: string[] = [];
  t.mock.method(console, 'log', (line: string) => { lines.push(line); });
  t.mock.method(console, 'error', () => {});
  return lines;
}

test('workspaceOwner reports no owner, a verified service, or a live desktop app', async t => {
  const root = await scratch(t);
  assert.deepEqual(await workspaceOwner(root), { mode: null });
  assert.deepEqual(await workspaceOwner(resolve(root, 'missing')), { mode: null });

  const live = await sessionServer(t);
  await control(root, 'server.json', JSON.stringify({ origin: live.origin, token: live.token, pid: process.pid }));
  assert.deepEqual(await workspaceOwner(root), { mode: 'service', origin: live.origin, pid: process.pid });
  const session = await workspaceSession(root);
  assert.equal(session.token, live.token, 'Commands that call the service get its token.');
  assert.ok(!JSON.stringify(session.owner).includes(live.token), 'The owner itself never carries the token.');

  const pid = alive(t);
  await control(root, 'desktop.json', desktopJson(pid));
  assert.deepEqual(await workspaceOwner(root), { mode: 'desktop', pid }, 'A live desktop record takes precedence.');
  assert.deepEqual(await workspaceOwner(root, { verify: false }), { mode: 'desktop', pid });
});

test('stale records mean no owner, whichever file holds them', async t => {
  const root = await scratch(t);
  const gone = await dead();
  await control(root, 'desktop.json', desktopJson(gone));
  assert.deepEqual(await workspaceOwner(root), { mode: null }, 'A dead desktop pid is stale.');
  await rm(resolve(root, '.opendoc/desktop.json'));
  assert.deepEqual(await workspaceOwner(root), { mode: null }, 'No file is no owner.');

  const origin = await closedOrigin();
  await control(root, 'server.json', JSON.stringify({ origin, token: 'old', pid: gone }));
  assert.deepEqual(await workspaceOwner(root), { mode: null }, 'A dead service pid behind a closed port is stale.');
  assert.deepEqual(await workspaceOwner(root, { verify: false }), { mode: null });
  await control(root, 'desktop.json', desktopJson(gone));
  assert.deepEqual(await workspaceOwner(root), { mode: null }, 'Both files stale.');

  // The record alone, for commands that make their own request: a live pid keeps the service.
  await control(root, 'server.json', JSON.stringify({ origin, token: 'old', pid: process.pid }));
  assert.deepEqual(await workspaceOwner(root, { verify: false }), { mode: 'service', origin, pid: process.pid });
  await assert.rejects(workspaceOwner(root), /still finishing/, 'A refusing listener with a live process is shutting down.');
});

test('an unreadable server record is an error, never a silent absence', async t => {
  const root = await scratch(t);
  await control(root, 'server.json', 'garbage');
  await assert.rejects(workspaceOwner(root), /Cannot read the OpenDoc session/);
  await assert.rejects(workspaceOwner(root, { verify: false }), InvalidOwnerRecord);
  await control(root, 'server.json', JSON.stringify({ origin: 'http://example.com:80', token: 't' }));
  await assert.rejects(workspaceOwner(root), /session record is invalid/);
  await assert.rejects(workspaceOwner(root, { verify: false }), InvalidOwnerRecord);
});

test('status reports the owner without the session token', async t => {
  const root = await scratch(t);
  const lines = printed(t);
  await runStatus(['--json'], root);
  assert.deepEqual(JSON.parse(lines.pop()!), { running: false, mode: null });
  await runStatus([], root);
  assert.match(lines.pop()!, /not running/);

  const live = await sessionServer(t);
  await control(root, 'server.json', JSON.stringify({ origin: live.origin, token: live.token, pid: process.pid }));
  await runStatus(['--json'], root);
  const text = lines.pop()!;
  assert.deepEqual(JSON.parse(text), { running: true, mode: 'service', pid: process.pid, origin: live.origin });
  assert.ok(!text.includes(live.token));

  const pid = alive(t);
  await control(root, 'desktop.json', desktopJson(pid));
  await runStatus(['--json'], root);
  assert.deepEqual(JSON.parse(lines.pop()!), { running: true, mode: 'desktop', pid });
  await runStatus([], root);
  assert.match(lines.pop()!, /opendoc-desktop/);
  await assert.rejects(runStatus(['extra'], root), /Usage/);
});

/** A scratch workspace whose installed application is this checkout, so the real dispatcher accepts it. */
async function installedScratch(t: TestContext) {
  const root = await scratch(t);
  const { version } = JSON.parse(await readFile(resolve(projectRoot, 'package.json'), 'utf8'));
  await writeFile(resolve(root, 'package.json'), JSON.stringify({ name: 'scratch', private: true, dependencies: { opendoc: `npm:@ryanyahya/opendoc@${version}` } }));
  await writeFile(resolve(root, '.opendoc/workspace.json'), '{"formatVersion":1}\n');
  await mkdir(resolve(root, 'node_modules'));
  await symlink(projectRoot, resolve(root, 'node_modules/opendoc'), 'dir');
  return root;
}

test('status and stop are registered commands of the opendoc CLI', async t => {
  const root = await installedScratch(t);
  const lines = printed(t);
  const run = async (...args: string[]) => { process.exitCode = undefined; await main(['--workspace', root, ...args]); assert.equal(process.exitCode, undefined); return lines.splice(0); };
  assert.deepEqual((await run('status', '--json')).map(line => JSON.parse(line)), [{ running: false, mode: null }]);
  assert.deepEqual((await run('stop', '--json')).map(line => JSON.parse(line)), [{ stopped: false, running: false }]);
  const pid = alive(t);
  await control(root, 'desktop.json', desktopJson(pid));
  assert.deepEqual((await run('status', '--json')).map(line => JSON.parse(line)), [{ running: true, mode: 'desktop', pid }]);
  process.exitCode = undefined;
  await main(['--workspace', root, 'stop', '--json']);
  assert.equal(process.exitCode, 1, 'Stopping the desktop app is refused.');
  process.exitCode = undefined;
  assert.match(JSON.parse(lines.splice(0).at(-1)!).error, /Close opendoc-desktop/);
  assert.match((await run('--help'))[0], /opendoc status[\s\S]*opendoc stop/);
});

test('status names a damaged record in one line, as JSON when asked, instead of a stack', async t => {
  const root = await installedScratch(t);
  const lines = printed(t);
  const fails = async (file: string, pattern: RegExp) => {
    process.exitCode = undefined;
    await main(['--workspace', root, 'status', '--json']);
    assert.equal(process.exitCode, 1);
    process.exitCode = undefined;
    const { error } = JSON.parse(lines.splice(0).at(-1)!);
    assert.match(error, pattern);
    assert.ok(error.includes(file) && !error.includes('\n') && !/\bat .*\(/.test(error), error);
  };
  await control(root, 'server.json', 'garbage');
  await fails('.opendoc/server.json', /Cannot read the OpenDoc session/);
  await rm(resolve(root, '.opendoc/server.json'));
  await control(root, 'desktop.json', 'garbage');
  await fails('.opendoc/desktop.json', /delete .opendoc\/desktop\.json/);
});

test('stop ends a browser-edition service, leaves the desktop app alone, and ignores stale records', async t => {
  const root = await scratch(t);
  const lines = printed(t);
  // A stand-in service: records its session like the real one and exits cleanly on SIGTERM.
  const script = resolve(root, 'service.mjs');
  await writeFile(script, `import { createServer } from 'node:http';
import { rmSync, writeFileSync } from 'node:fs';
const token = 'stand-in-token';
const server = createServer((request, response) => { response.setHeader('Content-Type', 'application/json'); response.end(JSON.stringify({ token })); });
server.listen(0, '127.0.0.1', () => {
  writeFileSync('.opendoc/server.json', JSON.stringify({ origin: 'http://127.0.0.1:' + server.address().port, token, pid: process.pid }));
  console.log('ready');
});
process.on('SIGTERM', () => { rmSync('.opendoc/server.json', { force: true }); process.exit(0); });
`);
  const child: ChildProcess = spawn(process.execPath, [script], { cwd: root, stdio: ['ignore', 'pipe', 'inherit'] });
  t.after(() => { child.kill('SIGKILL'); });
  await once(child.stdout!, 'data');

  assert.equal((await workspaceOwner(root)).pid, child.pid);
  const closed = once(child, 'exit');
  await runStop(['--json'], root);
  assert.deepEqual(JSON.parse(lines.pop()!), { stopped: true, running: false, pid: child.pid });
  await closed;
  assert.deepEqual(await workspaceOwner(root), { mode: null });
  await runStop(['--json'], root);
  assert.deepEqual(JSON.parse(lines.pop()!), { stopped: false, running: false });

  const app = alive(t);
  await control(root, 'desktop.json', desktopJson(app));
  await assert.rejects(runStop([], root), /Close opendoc-desktop.*delete \.opendoc\/desktop\.json/);
  process.kill(app, 0);

  await control(root, 'desktop.json', desktopJson(await dead()));
  await runStop([], root);
  assert.match(lines.pop()!, /not running/);
});

test('C3: start refuses beside the desktop app before validating the installation', async t => {
  const f = await fixture();
  try {
    await control(f.root, 'desktop.json', desktopJson(alive(t)));
    await assert.rejects(runStart(['--no-open'], f.root), /open in opendoc-desktop.*delete \.opendoc\/desktop\.json/);
    await assert.rejects(readFile(resolve(f.root, '.opendoc/server.json')), { code: 'ENOENT' });
    await assert.rejects(readFile(resolve(f.root, '.opendoc/update.lock')), { code: 'ENOENT' }, 'The lock is released.');
  } finally { await f.cleanup(); }
});

test('C3: start reuses a verified service', async t => {
  const f = await fixture();
  const lines = printed(t);
  try {
    const live = await sessionServer(t);
    await control(f.root, 'server.json', JSON.stringify({ origin: live.origin, token: live.token, pid: process.pid }));
    await runStart(['--no-open', '--json'], f.root);
    assert.equal(JSON.parse(lines.pop()!).reused, true);
  } finally { await f.cleanup(); }
});

test('C3: comments add works directly beside the desktop app', async t => {
  const f = await fixture();
  printed(t);
  try {
    const calls: string[] = [];
    t.mock.method(globalThis, 'fetch', async (url: string) => { calls.push(String(url)); throw new Error('The service must not be called.'); });
    await control(f.root, 'desktop.json', desktopJson(alive(t)));
    await runCommentsCli(['add', 'proof', 'target', 'Beside the app', '--json'], f.root);
    assert.deepEqual(calls, []);
    const [comment] = await readComments(f.root, 'proof');
    assert.equal(comment.text, 'Beside the app');
    assert.match(comment.quote, /A stable paragraph/);
  } finally { await f.cleanup(); }
});

test('C3: export works directly beside the desktop app', { timeout: 60_000 }, async t => {
  const f = await fixture();
  try {
    const calls: string[] = [];
    t.mock.method(globalThis, 'fetch', async (url: string) => { calls.push(String(url)); throw new Error('The service must not be called.'); });
    await control(f.root, 'desktop.json', desktopJson(alive(t)));
    const [result] = await exportDocuments(f.root, ['proof']);
    assert.equal(result.status, 'success');
    if (result.status === 'success') assert.equal(result.source, 'render');
    assert.deepEqual(calls, []);
  } finally { await f.cleanup(); }
});

test('C3: history is not recorded by CLI commands beside the desktop app, and is once the record is stale', async t => {
  const f = await fixture();
  try {
    await control(f.root, 'desktop.json', desktopJson(alive(t)));
    assert.deepEqual(await recordAgentChanges(f.root, ['proof']), []);
    assert.deepEqual(await readdir(resolve(f.root, 'documents/proof')).then(names => names.includes('.history')), false);
    await control(f.root, 'desktop.json', desktopJson(await dead()));
    assert.deepEqual((await recordAgentChanges(f.root, ['proof'])).map(version => version.origin), ['baseline']);
  } finally { await f.cleanup(); }
});

test('C3: history restore refuses unsaved text edits beside the desktop app or the service, and passes with no owner or a stale record', { timeout: 60_000 }, async t => {
  const f = await fixture();
  printed(t);
  try {
    await recordAgentChanges(f.root, ['proof']);
    await writeFile(f.entry, source().replace('A stable paragraph', 'An edited paragraph'));
    await recordAgentChanges(f.root, ['proof']);
    const store = new HistoryStore(f.root);
    const versions = await store.list('proof');
    assert.equal(versions.length, 2);
    const oldest = versions.at(-1)!.id;
    await control(f.root, 'current.json', JSON.stringify({ documentId: 'proof', manualEdit: { pendingEdits: 2 } }));
    const restore = () => runHistoryCli(['restore', 'proof', oldest, '--json'], f.root);
    const before = await readFile(f.entry, 'utf8');

    await control(f.root, 'desktop.json', desktopJson(alive(t)));
    await assert.rejects(restore(), /unsaved text edits/);
    assert.equal(await readFile(f.entry, 'utf8'), before);
    await rm(resolve(f.root, '.opendoc/desktop.json'));

    await control(f.root, 'server.json', JSON.stringify({ origin: 'http://127.0.0.1:45678', token: 'test-token', pid: process.pid }));
    await assert.rejects(restore(), /unsaved text edits/);
    assert.equal(await readFile(f.entry, 'utf8'), before);

    // With no owner at all, no file of either kind, the guard stands down.
    await rm(resolve(f.root, '.opendoc/server.json'));
    await restore();
    assert.match(await readFile(f.entry, 'utf8'), /A stable paragraph/);
    await writeFile(f.entry, before);

    // A record whose process is gone is no owner either.
    await control(f.root, 'server.json', JSON.stringify({ origin: 'http://127.0.0.1:45678', token: 'test-token', pid: await dead() }));
    await control(f.root, 'desktop.json', desktopJson(await dead()));
    await restore();
    assert.match(await readFile(f.entry, 'utf8'), /A stable paragraph/);
  } finally { await f.cleanup(); }
});

async function packFixture(t: TestContext) {
  const container = await mkdtemp(resolve(tmpdir(), 'opendoc-owner-pack-'));
  t.after(() => rm(container, { recursive: true, force: true }));
  const sender = resolve(container, 'sender'), recipient = resolve(container, 'recipient'), file = resolve(container, 'design.opendoc.zip');
  await mkdir(recipient);
  await cp(resolve(projectRoot, 'assets/fonts'), resolve(sender, 'assets/fonts'), { recursive: true });
  await cp(resolve(projectRoot, 'themes/neutral'), resolve(sender, 'themes/neutral'), { recursive: true });
  for (const name of ['index.ts', 'Specimen.tsx']) await cp(resolve(projectRoot, 'themes', name), resolve(sender, 'themes', name));
  const put = async (path: string, text: string) => { await mkdir(dirname(resolve(sender, path)), { recursive: true }); await writeFile(resolve(sender, path), text); };
  await put('themes/acme/index.ts', `import { theme as base } from '../neutral'; export const theme = {...base, id:'acme',name:'Acme'};`);
  await put('themes/acme/design.md', '# Acme\nA portable design.\n');
  await put('themes/acme/preview.tsx', `import {Document,Pages,Paragraph} from 'opendoc'; import {theme} from './index'; export const meta={title:'Acme',description:'Pack proof',theme:'acme'}; export default function Preview(){ return <Document title="Acme specimen" theme={theme}><Pages title="Acme specimen"><Paragraph id="proof">A portable design.</Paragraph></Pages></Document> }`);
  const collected = await collectPack(sender, [{ kind: 'theme', id: 'acme' }]);
  collected.files.set('previews/theme-acme.pdf', Buffer.from('%PDF-1.7\nA supplied preview placeholder.'));
  const manifest: PackManifest = { format: 'opendoc-pack', schemaVersion: 1, id: 'test-pack', name: 'Test pack', version: '1.0.0', opendocVersion: '0.6.0', items: collected.items, assets: collected.assets,
    files: [...collected.files].map(([path, bytes]) => ({ path, bytes: bytes.length, sha256: digest(bytes) })) };
  collected.files.set('manifest.json', Buffer.from(JSON.stringify(manifest)));
  await writeFile(file, writeArchive(collected.files));
  return { recipient, file };
}

async function snapshot(root: string) {
  const out: Record<string, string> = {};
  for (const entry of await readdir(root, { recursive: true, withFileTypes: true })) if (entry.isFile()) {
    const path = resolve(entry.parentPath, entry.name); out[path.slice(root.length + 1)] = digest(await readFile(path));
  }
  return out;
}

test('C3: packs install refuses beside the desktop app, after taking the lock, and changes nothing', { timeout: 60_000 }, async t => {
  const f = await packFixture(t);
  await control(f.recipient, 'desktop.json', desktopJson(alive(t)));
  const before = await snapshot(f.recipient);
  await assert.rejects(installPack(f.recipient, f.file, { trust: true }), /open in opendoc-desktop.*Use Import in the app, or close it.*delete \.opendoc\/desktop\.json/);
  assert.deepEqual(await snapshot(f.recipient), before, 'Neither catalog files nor the lock are left behind.');
  // A dry run only inspects the pack, so it still works.
  assert.equal((await installPack(f.recipient, f.file, { dryRun: true })).installed, false);
});

test('C3: packs install still refuses beside a service with the stop-first message', { timeout: 60_000 }, async t => {
  const f = await packFixture(t);
  const live = await sessionServer(t);
  await control(f.recipient, 'server.json', JSON.stringify({ origin: live.origin, token: live.token, pid: process.pid }));
  await assert.rejects(installPack(f.recipient, f.file, { trust: true }), /Stop OpenDoc with Ctrl\+C/);
});

test('an invalid recorded pid is never signalled, and stop refuses it', async t => {
  const root = await scratch(t);
  printed(t);
  const live = await sessionServer(t);
  const kills: unknown[][] = [];
  // Only the liveness probe of pid 1 may reach process.kill, and it never reaches the real one.
  t.mock.method(process, 'kill', (pid: unknown, signal?: unknown) => {
    kills.push([pid, signal]);
    if (pid === 1 && signal === 0) return true;
    throw new Error(`process.kill must not be called with ${String(pid)}`);
  });
  for (const pid of [-1, 0, '123', 1.5, 1]) {
    await control(root, 'server.json', JSON.stringify({ origin: live.origin, token: live.token, pid }));
    const owner = await workspaceOwner(root);
    assert.equal(owner.mode, 'service');
    assert.equal(owner.pid, pid === 1 ? 1 : undefined, `pid ${JSON.stringify(pid)} is only reported when it is valid`);
    await assert.rejects(runStop([], root), /no valid process to stop/);
  }
  assert.deepEqual(kills.filter(([pid, signal]) => !(pid === 1 && signal === 0)), [], 'Nothing else was signalled.');
});

test('a service that exits between the check and the signal counts as stopped', async t => {
  const root = await scratch(t);
  const lines = printed(t);
  const live = await sessionServer(t);
  await control(root, 'server.json', JSON.stringify({ origin: live.origin, token: live.token, pid: 424242 }));
  const kills: unknown[][] = [];
  t.mock.method(process, 'kill', (pid: unknown, signal?: unknown) => {
    kills.push([pid, signal]);
    if (signal === 0) return true;
    throw Object.assign(new Error('kill ESRCH'), { code: 'ESRCH' });
  });
  await runStop(['--json'], root);
  assert.deepEqual(JSON.parse(lines.pop()!), { stopped: true, running: false, pid: 424242 });
  assert.deepEqual(kills, [[424242, 0], [424242, 'SIGTERM']]);
});

test('a dead recorded pid is stale even when another server now answers at its address', async t => {
  const root = await scratch(t);
  const other = await sessionServer(t, 'another-programs-token');
  await control(root, 'server.json', JSON.stringify({ origin: other.origin, token: 'the-old-services-token', pid: await dead() }));
  assert.deepEqual(await workspaceOwner(root), { mode: null });
  // With a live pid the same mismatch still refuses: whatever answers is not the recorded service.
  await control(root, 'server.json', JSON.stringify({ origin: other.origin, token: 'the-old-services-token', pid: process.pid }));
  await assert.rejects(workspaceOwner(root), /no longer matches/);
});

test('a live pid counts as the app only when the process is opendoc-desktop', { skip: process.platform !== 'linux' }, async t => {
  const root = await scratch(t);
  const start = async (name: string) => {
    // A Node process that names itself. Starting Node through a symlink of that name is not enough: Node renames its main
    // thread to node-MainThread while it starts, so the stand-in sets its own name once its code runs. (A copy of sleep
    // would not do either: on a multi-call coreutils it picks its tool from its file name and exits at once.)
    const script = `require('node:fs').writeFileSync('/proc/self/comm', ${JSON.stringify(name)}); setInterval(() => {}, 1000);`;
    const child = spawn(process.execPath, ['-e', script], { stdio: 'ignore' });
    t.after(() => { child.kill('SIGKILL'); });
    await once(child, 'spawn');
    // The name is the stand-in's only once its code has run; wait for that rather than assume it.
    const deadline = Date.now() + 2000;
    while ((await readFile(`/proc/${child.pid}/comm`, 'utf8').catch(() => '')).trim() !== name.slice(0, 15)) {
      assert.ok(Date.now() < deadline, `${name} did not start under its own name`);
      await new Promise(accept => setTimeout(accept, 20));
    }
    return child.pid!;
  };
  assert.deepEqual(await workspaceOwner(root), { mode: null });
  const other = await start('sleep-stand-in');
  await control(root, 'desktop.json', desktopJson(other));
  assert.deepEqual(await workspaceOwner(root), { mode: null }, 'A live pid that is some other program is stale.');
  for (const name of ['opendoc-desktop', 'Electron', 'electron']) {
    const pid = await start(name);
    await control(root, 'desktop.json', desktopJson(pid));
    assert.deepEqual(await workspaceOwner(root), { mode: 'desktop', pid }, name);
  }
});

test('a desktop record that cannot be read is refused with advice, never ignored', async t => {
  const root = await scratch(t);
  for (const junk of ['not json', '', '{}', JSON.stringify({ pid: 'abc' }), JSON.stringify({ pid: -4 }), JSON.stringify({ pid: 1.5 }), 'null']) {
    await control(root, 'desktop.json', junk);
    await assert.rejects(workspaceOwner(root), error => {
      assert.ok(error instanceof InvalidOwnerRecord, `junk ${JSON.stringify(junk)}`);
      assert.match(error.message, /\.opendoc\/desktop\.json/);
      assert.match(error.message, /delete \.opendoc\/desktop\.json/);
      return true;
    });
  }
  await rm(resolve(root, '.opendoc/desktop.json'));
  await mkdir(resolve(root, '.opendoc/desktop.json'));
  await assert.rejects(workspaceOwner(root), InvalidOwnerRecord, 'A folder in place of the file.');
  await rm(resolve(root, '.opendoc/desktop.json'), { recursive: true });
  assert.deepEqual(await workspaceOwner(root), { mode: null }, 'Only a missing file is no record.');
});

test('a record the app is still writing is read again before it is refused', async t => {
  const root = await scratch(t);
  const pid = alive(t);
  await control(root, 'desktop.json', '{"pid":');
  setTimeout(() => { void control(root, 'desktop.json', desktopJson(pid)); }, 30);
  assert.deepEqual(await workspaceOwner(root), { mode: 'desktop', pid });
});

test('C3: start and packs install refuse beside an unreadable desktop record instead of running under the app', { timeout: 60_000 }, async t => {
  const f = await fixture();
  try {
    await control(f.root, 'desktop.json', 'not json');
    await assert.rejects(runStart(['--no-open'], f.root), /desktop\.json.*delete \.opendoc\/desktop\.json/);
    await assert.rejects(readFile(resolve(f.root, '.opendoc/update.lock')), { code: 'ENOENT' });
    const pack = await packFixture(t);
    await control(pack.recipient, 'desktop.json', 'not json');
    const before = await snapshot(pack.recipient);
    await assert.rejects(installPack(pack.recipient, pack.file, { trust: true }), /desktop\.json.*delete \.opendoc\/desktop\.json/);
    assert.deepEqual(await snapshot(pack.recipient), before);
  } finally { await f.cleanup(); }
});

test('history recording stays off beside a service whose process lives, even if its record is damaged', async t => {
  const root = await scratch(t);
  for (const record of [{ pid: process.pid }, { pid: process.pid, origin: 'not an address' }, { origin: 'http://127.0.0.1:1', token: 't', pid: process.pid }]) {
    await control(root, 'server.json', JSON.stringify(record));
    assert.equal(await historyService(root), true, JSON.stringify(record));
  }
  await control(root, 'server.json', JSON.stringify({ origin: 'http://127.0.0.1:1', token: 't', pid: await dead() }));
  assert.equal(await historyService(root), false);
  await control(root, 'server.json', 'garbage');
  assert.equal(await historyService(root), false);
});
