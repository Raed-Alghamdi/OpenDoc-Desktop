import test, { type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { cp, mkdir, mkdtemp, readFile, readdir, rm, utimes, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, resolve } from 'node:path';
import { collectPack } from '../src/packs/collect';
import { writeArchive } from '../src/packs/archive';
import { digest, type PackManifest } from '../src/packs/manifest';
import { handlePacksRequest, stagedLifetime, type PackHooks } from '../src/server/packs-http';
import { createOpenDocService } from '../src/server/service';
import { exportPack, installPack } from '../src/packs/packs';
import { fixture, projectRoot, until } from './helpers';

async function put(root: string, path: string, source: string | Buffer) { await mkdir(dirname(resolve(root, path)), { recursive: true }); await writeFile(resolve(root, path), source); }
async function workspaces(t: TestContext) {
  const container = await mkdtemp(resolve(tmpdir(), 'opendoc-packs-http-'));
  t.after(() => rm(container, { recursive: true, force: true }));
  const source = resolve(container, 'sender'), recipient = resolve(container, 'recipient');
  await mkdir(source); await mkdir(recipient);
  await cp(resolve(projectRoot, 'assets/fonts'), resolve(source, 'assets/fonts'), { recursive: true });
  await cp(resolve(projectRoot, 'themes/neutral'), resolve(source, 'themes/neutral'), { recursive: true });
  for (const file of ['index.ts', 'Specimen.tsx']) await cp(resolve(projectRoot, 'themes', file), resolve(source, 'themes', file));
  await put(source, 'themes/acme/index.ts', `import { theme as base } from '../neutral'; export const theme = {...base, id:'acme',name:'Acme'};`);
  await put(source, 'themes/acme/design.md', '# Acme\nA portable design.\n');
  await put(source, 'themes/acme/preview.tsx', `import {Document,Pages,Paragraph} from 'opendoc'; import {theme} from './index'; export const meta={title:'Acme',description:'Pack proof',theme:'acme'}; export default function Preview(){ return <Document title="Acme specimen" theme={theme}><Pages title="Acme specimen"><Paragraph id="proof">A portable design.</Paragraph></Pages></Document> }`);
  return { container, source, recipient };
}

async function synthetic(source: string, file: string, themeSource?: string) {
  const collected = await collectPack(source, [{ kind: 'theme', id: 'acme' }]);
  // The exporter refuses code like this, so a hostile pack is built by hand, after collection.
  if (themeSource) collected.files.set('themes/acme/index.ts', Buffer.from(themeSource));
  collected.files.set('previews/theme-acme.pdf', Buffer.from('%PDF-1.7\nA supplied preview placeholder.'));
  const manifest: PackManifest = { format: 'opendoc-pack', schemaVersion: 1, id: 'test-pack', name: 'Test pack', version: '1.0.0', opendocVersion: '0.6.0', items: collected.items, assets: collected.assets,
    files: [...collected.files].map(([path, bytes]) => ({ path, bytes: bytes.length, sha256: digest(bytes) })) };
  collected.files.set('manifest.json', Buffer.from(JSON.stringify(manifest)));
  await writeFile(file, writeArchive(collected.files));
}

async function snapshot(root: string) {
  const out: Record<string, string> = {};
  for (const entry of await readdir(root, { recursive: true, withFileTypes: true })) if (entry.isFile() && !entry.parentPath.includes('.opendoc')) {
    const path = resolve(entry.parentPath, entry.name); out[path.slice(root.length + 1)] = digest(await readFile(path));
  }
  return out;
}

function json(res: ServerResponse, value: unknown, status = 200) {
  res.writeHead(status, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(value));
}
async function body(req: IncomingMessage, limit = 32_000) {
  const chunks: Buffer[] = []; let size = 0;
  for await (const chunk of req) { size += chunk.length; if (size > limit) throw new Error('Request too large.'); chunks.push(Buffer.from(chunk)); }
  return JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}');
}

/** Serve one workspace through the handler, the way the service will, with hooks that record their order. */
async function serve(t: TestContext, root: string) {
  const events: string[] = [];
  const hooks: PackHooks = { pauseWatching: () => { events.push('pause'); }, resumeWatching: () => { events.push('resume'); } };
  const server = createServer((req, res) => {
    void handlePacksRequest(root, req, res, new URL(req.url!, 'http://localhost'), json, body, () => { events.push('changed'); }, hooks)
      .then(handled => { if (!handled) json(res, { error: 'Not found.' }, 404); })
      // Match the app's outer request handler: an error that names a status keeps it, others are 400.
      .catch(error => json(res, { error: error.message }, error.status ?? 400));
  });
  await new Promise<void>(accept => server.listen(0, '127.0.0.1', accept));
  const address = server.address();
  assert.ok(address && typeof address === 'object');
  const origin = `http://127.0.0.1:${address.port}`;
  t.after(async () => { server.closeAllConnections(); await new Promise<void>((accept, reject) => server.close(error => error ? reject(error) : accept())); });
  return {
    events, origin,
    get: (path: string) => fetch(origin + path),
    send: (path: string, value: unknown) => fetch(origin + path, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(value) }),
    upload: async (bytes: Uint8Array) => { const form = new FormData(); form.set('file', new Blob([new Uint8Array(bytes)], { type: 'application/zip' }), 'design.opendoc.zip'); return fetch(origin + '/api/packs/inspect', { method: 'POST', body: form }); },
  };
}
async function good<T>(response: Response, status = 200): Promise<T> {
  assert.equal(response.status, status, await response.clone().text());
  return response.json() as Promise<T>;
}
type Inspected = { stagedId: string; manifest: PackManifest; items: PackManifest['items']; files: PackManifest['files']; compatibility: { compatible: boolean; requiredVersion: string; currentVersion: string }; conflicts: string[]; previews: string[] };
const staging = (root: string) => resolve(root, '.opendoc/pack-uploads');
const stagedFolders = async (root: string) => existsSync(staging(root)) ? await readdir(staging(root)) : [];

test('pack HTTP exports, inspects, dry-runs and installs, then the staged file is gone', { timeout: 120_000 }, async t => {
  const f = await workspaces(t);
  const sender = await serve(t, f.source), recipient = await serve(t, f.recipient);
  await put(f.source, 'templates/portable/template.json', JSON.stringify({ name: 'Portable', description: 'A portable template', format: 'A4', structure: ['Flowing prose'] }));
  await put(f.source, 'templates/portable/AGENTS.md', '# Portable\nLet content lead.\n');
  await put(f.source, 'templates/portable/index.tsx', `import {Document,Pages,Paragraph} from 'opendoc'; import type {DocTheme} from 'opendoc/themes'; export function Layout({theme,title}: {theme:DocTheme,title:string}){return <Document title={title} theme={theme}><Pages title={title}><Paragraph id="title">{title}</Paragraph></Pages></Document>}`);
  await put(f.source, 'templates/portable/preview.tsx', `import {Layout} from './index'; import {theme} from '../../themes/neutral'; export const meta={title:'Portable',description:'Specimen',theme:'neutral'}; export default function Preview(){return <Layout theme={theme} title="Portable"/>}`);
  await put(f.source, 'templates/portable/starter.tsx', `import {Layout} from '../../templates/portable';\n// @ts-ignore Replaced on creation.\nimport {theme} from "__OPENDOC_THEME_MODULE__"; export const meta={title:"__OPENDOC_TITLE__",description:'A new document',theme:"__OPENDOC_THEME__"}; export default function Instance(){return <Layout theme={theme} title="__OPENDOC_TITLE__"/>}`);

  assert.equal((await sender.get('/api/packs/export')).status, 404);
  assert.equal((await sender.send('/api/packs/export', { themes: [], templates: [] })).status, 400);
  assert.equal((await sender.send('/api/packs/export', { themes: ['acme'], surprise: true })).status, 400);
  assert.equal((await sender.send('/api/packs/export', { themes: ['../acme'] })).status, 400);
  const exported = await good<{ file: string; relativeFile: string; sha256: string; items: PackManifest['items']; previews: { path: string; pages: number }[] }>(
    await sender.send('/api/packs/export', { themes: ['acme'], templates: ['portable'], id: 'acme-pack', name: 'Acme pack', version: '1.2.0', author: 'Test author', license: 'MIT' }), 201);
  assert.equal(exported.relativeFile, 'output/packs/acme-pack-1.2.0.opendoc.zip');
  assert.equal(exported.file, resolve(f.source, exported.relativeFile));
  assert.equal(exported.previews.length, 2);
  assert.deepEqual(exported.items.map(item => `${item.kind}/${item.id}`).sort(), ['template/portable', 'theme/acme', 'theme/neutral']);
  const archive = await readFile(exported.file);
  assert.equal(digest(archive), exported.sha256);
  // The same version again is refused rather than overwritten.
  assert.equal((await sender.send('/api/packs/export', { themes: ['acme'], templates: ['portable'], id: 'acme-pack', version: '1.2.0' })).status, 409);

  const inspected = await good<Inspected>(await recipient.upload(archive), 201);
  assert.match(inspected.stagedId, /^[a-f0-9-]{36}$/);
  assert.equal(inspected.manifest.name, 'Acme pack');
  assert.equal(inspected.manifest.author, 'Test author');
  assert.equal(inspected.compatibility.compatible, true);
  assert.deepEqual(inspected.conflicts, []);
  assert.ok(inspected.files.some(file => file.path === 'themes/acme/index.ts'));
  assert.equal(inspected.previews.length, 2);
  for (const url of inspected.previews) {
    const preview = await recipient.get(url);
    assert.equal(preview.status, 200);
    assert.equal(preview.headers.get('content-type'), 'application/pdf');
    assert.equal(preview.headers.get('x-content-type-options'), 'nosniff');
    assert.match(preview.headers.get('content-security-policy')!, /sandbox/);
    assert.equal((await preview.text()).slice(0, 5), '%PDF-');
  }
  assert.equal((await recipient.get(`/api/packs/staged/${inspected.stagedId}/previews/theme-missing.pdf`)).status, 404);
  assert.equal((await recipient.get(`/api/packs/staged/${inspected.stagedId}/previews/manifest.json`)).status, 404);
  // Inspection installed nothing and paused nothing.
  assert.deepEqual(await snapshot(f.recipient), {});
  assert.deepEqual(recipient.events, []);

  const installed = await good<{ installed: { kind: string; id: string; selected: boolean }[]; files: string[]; verification?: string; visualReview?: string }>(
    await recipient.send('/api/packs/install', { stagedId: inspected.stagedId, trust: true }));
  assert.deepEqual(installed.installed.map(item => `${item.kind}/${item.id}`).sort(), ['template/portable', 'theme/acme', 'theme/neutral']);
  assert.ok(installed.files.includes('themes/acme/index.ts'));
  assert.equal(installed.visualReview, 'required');
  assert.deepEqual(recipient.events, ['pause', 'resume', 'changed']);
  assert.equal(await readFile(resolve(f.recipient, 'themes/acme/design.md'), 'utf8'), '# Acme\nA portable design.\n');
  assert.deepEqual(await stagedFolders(f.recipient), []);
  assert.equal((await recipient.send('/api/packs/install', { stagedId: inspected.stagedId, trust: true })).status, 404);
  assert.equal((await recipient.get(inspected.previews[0])).status, 404);

  // The same pack again is recognised as installed and leaves the workspace alone.
  const before = await snapshot(f.recipient);
  const again = await good<Inspected>(await recipient.upload(archive), 201);
  assert.equal(again.conflicts.length, 0);
  recipient.events.length = 0;
  const repeated = await good<{ installed: unknown[]; alreadyInstalled?: boolean }>(await recipient.send('/api/packs/install', { stagedId: again.stagedId, trust: true }));
  assert.deepEqual(repeated.installed, []);
  assert.equal(repeated.alreadyInstalled, true);
  assert.deepEqual(recipient.events, []);
  assert.deepEqual(await snapshot(f.recipient), before);
  assert.deepEqual(await stagedFolders(f.recipient), []);
});

test('pack HTTP inspection runs no pack code, even for a pack that would write a marker file', { timeout: 60_000 }, async t => {
  const f = await workspaces(t);
  const marker = resolve(f.container, 'MARKER-WRITTEN'), zip = resolve(f.container, 'trap.opendoc.zip');
  const trap = `import {theme as base} from '../neutral'; process.getBuiltinModule('node:fs').writeFileSync(${JSON.stringify(marker)}, 'ran'); throw new Error('MUST_NOT_EXECUTE_DURING_INSPECTION'); export const theme = {...base,id:'acme'};`;
  await synthetic(f.source, zip, trap);
  const server = await serve(t, f.recipient);
  const inspected = await good<Inspected>(await server.upload(await readFile(zip)), 201);
  assert.deepEqual(inspected.conflicts, []);
  assert.equal(inspected.previews.length, 1);
  assert.equal(inspected.manifest.id, 'test-pack');
  assert.equal(existsSync(marker), false, 'inspection must not import theme source');
  // A conflict plan reads the destination too, and still runs nothing.
  await put(f.recipient, 'themes/acme/index.ts', 'My existing theme');
  const conflicted = await good<Inspected>(await server.upload(await readFile(zip)), 201);
  assert.ok(conflicted.conflicts.includes('themes/acme/index.ts'));
  assert.equal(existsSync(marker), false);
  assert.deepEqual(await snapshot(f.recipient), { 'themes/acme/index.ts': digest('My existing theme') });
});

test('pack HTTP refuses conflicts, a missing trust confirmation, and a failing install, restoring the watcher each time', { timeout: 90_000 }, async t => {
  const f = await workspaces(t);
  const zip = resolve(f.container, 'design.opendoc.zip'), broken = resolve(f.container, 'broken.opendoc.zip');
  await synthetic(f.source, zip);
  await synthetic(f.source, broken, `import {theme as base} from '../neutral'; throw new Error('BROKEN_DESIGN_SOURCE'); export const theme = {...base,id:'acme'};`);
  const server = await serve(t, f.recipient);

  const first = await good<Inspected>(await server.upload(await readFile(zip)), 201);
  for (const value of [{ stagedId: first.stagedId }, { stagedId: first.stagedId, trust: false }, { stagedId: first.stagedId, trust: 'true' }, { stagedId: first.stagedId, trust: 1 }]) {
    const refused = await server.send('/api/packs/install', value);
    assert.equal(refused.status, 400, await refused.clone().text());
    assert.match((await refused.json() as { error: string }).error, /trust/i);
  }
  assert.equal((await server.send('/api/packs/install', { stagedId: first.stagedId, trust: true, replace: true })).status, 400);
  assert.equal((await server.send('/api/packs/install', { trust: true })).status, 404);
  for (const stagedId of ['../../etc', '..', first.stagedId.toUpperCase(), `${first.stagedId}/..`]) assert.equal((await server.send('/api/packs/install', { stagedId, trust: true })).status, 404, stagedId);
  assert.deepEqual(await snapshot(f.recipient), {});
  assert.deepEqual(server.events, []);
  assert.deepEqual(await stagedFolders(f.recipient), [first.stagedId], 'a refused install keeps the staged file for another try');

  // Existing designs are never overwritten: a conflict is refused before anything pauses or runs.
  await put(f.recipient, 'themes/acme/index.ts', 'My existing theme');
  const before = await snapshot(f.recipient);
  const refused = await server.send('/api/packs/install', { stagedId: first.stagedId, trust: true });
  assert.equal(refused.status, 409);
  assert.match((await refused.json() as { error: string }).error, /conflicts[\s\S]*themes\/acme\/index\.ts/);
  assert.deepEqual(await snapshot(f.recipient), before);
  assert.deepEqual(server.events, []);
  await rm(resolve(f.recipient, 'themes'), { recursive: true });

  // Pack code that fails when it runs: nothing stays behind, and the watcher resumes without a rescan.
  const second = await good<Inspected>(await server.upload(await readFile(broken)), 201);
  const failed = await server.send('/api/packs/install', { stagedId: second.stagedId, trust: true });
  assert.equal(failed.status, 400);
  assert.match((await failed.json() as { error: string }).error, /BROKEN_DESIGN_SOURCE/);
  assert.deepEqual(await snapshot(f.recipient), {});
  assert.deepEqual(server.events, ['pause', 'resume']);

  // Not a pack, not a ZIP, extra fields and plain JSON never reach the staging folder.
  const stagedBefore = await stagedFolders(f.recipient);
  assert.equal((await server.upload(Buffer.from('not a zip'))).status, 400);
  const extra = new FormData(); extra.set('file', new Blob([new Uint8Array(await readFile(zip))]), 'a.zip'); extra.set('metadata', '{}');
  assert.equal((await fetch(server.origin + '/api/packs/inspect', { method: 'POST', body: extra })).status, 400);
  assert.equal((await server.send('/api/packs/inspect', {})).status, 400);
  assert.deepEqual(await stagedFolders(f.recipient), stagedBefore);
});

test('pack HTTP staged files expire after an hour', { timeout: 60_000 }, async t => {
  const f = await workspaces(t);
  const zip = resolve(f.container, 'design.opendoc.zip');
  await synthetic(f.source, zip);
  const server = await serve(t, f.recipient);
  const archive = await readFile(zip);
  const old = await good<Inspected>(await server.upload(archive), 201);
  const fresh = await good<Inspected>(await server.upload(archive), 201);
  const longAgo = new Date(Date.now() - stagedLifetime - 60_000);
  await utimes(resolve(staging(f.recipient), old.stagedId), longAgo, longAgo);
  assert.equal((await server.get(old.previews[0])).status, 404);
  assert.deepEqual(await stagedFolders(f.recipient), [fresh.stagedId], 'the expired folder is removed when it is looked up');
  // Without a lookup, the next pack request sweeps what has expired.
  const third = await good<Inspected>(await server.upload(archive), 201);
  await utimes(resolve(staging(f.recipient), third.stagedId), longAgo, longAgo);
  await utimes(resolve(staging(f.recipient), fresh.stagedId), new Date(), new Date());
  const refused = await server.send('/api/packs/install', { stagedId: third.stagedId, trust: true });
  assert.equal(refused.status, 404);
  assert.match((await refused.json() as { error: string }).error, /hour/);
  assert.deepEqual(await stagedFolders(f.recipient), [fresh.stagedId]);
  assert.deepEqual(await snapshot(f.recipient), {});
  assert.deepEqual(server.events, []);
});

test('pack HTTP leaves other routes alone and answers only the documented methods', { timeout: 30_000 }, async t => {
  const f = await workspaces(t);
  const server = await serve(t, f.recipient);
  assert.equal((await server.get('/api/tags')).status, 404);
  assert.equal((await server.get('/api/packs')).status, 404);
  assert.equal((await server.get('/api/packs/install')).status, 404);
  assert.equal((await server.send('/api/packs/staged/x/previews/y.pdf', {})).status, 404);
});

test('a running service installs a pack for Import, shows the new design without a restart, and the CLI still refuses', { timeout: 120_000 }, async t => {
  const f = await workspaces(t);
  const zip = resolve(f.container, 'acme.opendoc.zip');
  await exportPack(f.source, { themes: ['acme'], output: zip });
  const recipient = await fixture();
  // The service may still write its context file while it stops, so removal retries.
  t.after(() => rm(recipient.root, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 }));
  await rm(resolve(recipient.root, 'assets')); // The fixture links the repository's assets; an installing workspace owns its own.
  await mkdir(resolve(recipient.root, 'assets'));
  const service = await createOpenDocService({ root: recipient.root, production: false, client: (_req, res) => { res.end('client'); } });
  t.after(() => service.close());
  const server = createServer((req, res) => { service.handle(req, res).catch(() => {}); });
  await new Promise<void>(accept => server.listen(0, '127.0.0.1', accept));
  t.after(async () => { server.closeAllConnections(); await new Promise<void>(accept => server.close(() => accept())); });
  const address = server.address();
  assert.ok(address && typeof address === 'object');
  const origin = `http://127.0.0.1:${address.port}`;
  // The record the CLI and `installPack` read to learn that a service owns this workspace.
  await put(recipient.root, '.opendoc/server.json', JSON.stringify({ origin, pid: process.pid, token: service.token }));
  const themes = async () => (await (await fetch(origin + '/api/themes')).json() as { id: string }[]).map(theme => theme.id);
  assert.ok(!(await themes()).includes('acme'));
  await assert.rejects(installPack(recipient.root, zip, { trust: true }), /Stop OpenDoc/);
  assert.ok(!(await themes()).includes('acme'));

  const archive = await readFile(zip);
  const form = new FormData(); form.set('file', new Blob([new Uint8Array(archive)]), 'acme.opendoc.zip');
  const guard = { 'X-OpenDoc-Token': service.token };
  // Writes need the session token, as everywhere else in the service.
  assert.equal((await fetch(origin + '/api/packs/inspect', { method: 'POST', body: form })).status, 403);
  const inspected = await good<Inspected>(await fetch(origin + '/api/packs/inspect', { method: 'POST', headers: guard, body: form }), 201);
  assert.deepEqual(inspected.conflicts, []);
  const install = (value: unknown) => fetch(origin + '/api/packs/install', { method: 'POST', headers: { ...guard, 'Content-Type': 'application/json' }, body: JSON.stringify(value) });
  assert.equal((await install({ stagedId: inspected.stagedId })).status, 400);
  assert.ok(!(await themes()).includes('acme'));
  const installed = await good<{ installed: { id: string }[] }>(await install({ stagedId: inspected.stagedId, trust: true }));
  assert.ok(installed.installed.some(item => item.id === 'acme'));
  assert.ok((await themes()).includes('acme'), 'the catalog lists the new theme without a restart');
  const preview = await good<{ artifact?: { hash: string } }>(await fetch(origin + '/api/themes/acme/preview'));
  assert.ok(preview.artifact, 'the new theme renders in the running service');
  // The watcher is listening again: an edit to the new theme is noticed by its catalog.
  const revision = async () => (await (await fetch(origin + '/api/themes')).json() as { id: string; revision?: string }[]).find(theme => theme.id === 'acme')?.revision;
  const before = await revision();
  await writeFile(resolve(recipient.root, 'themes/acme/design.md'), '# Acme\nChanged after install.\n');
  await until(async () => (await revision()) !== before);
  // A conflict reaches the client as 409.
  const again = await good<Inspected>(await fetch(origin + '/api/packs/inspect', { method: 'POST', headers: guard, body: form }), 201);
  assert.ok(again.conflicts.includes('themes/acme/design.md'));
  assert.equal((await install({ stagedId: again.stagedId, trust: true })).status, 409);
});
