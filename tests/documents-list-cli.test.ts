import test, { type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdir, mkdtemp, readFile, readdir, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { fixture, projectRoot, source } from './helpers';
import { acceptAsApp } from './helpers-owner';
import { main } from '../src/cli/main';
import { runDocumentsCli } from '../src/server/documents-cli';
import { listDocuments, showDocument, staticMeta } from '../src/server/document-listing';
import { changeItemTags, setDocumentStatus } from '../src/server/tags';
import { createProject } from '../src/server/projects';

const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAACgAAAAUCAIAAABwJOjsAAAAOUlEQVR4nO3NQQEAIAwDsVIzqMEF/jXw3QzcHjQGsvY9muCRVYlBJrMqMcZc1SXGmKu6xBhzlT6PH78GAQA/IUyuAAAAAElFTkSuQmCC', 'base64');

function output(t: TestContext) {
  const lines: string[] = [];
  t.mock.method(console, 'log', (line: string) => { lines.push(String(line)); });
  return { lines, json: () => JSON.parse(lines.splice(0).join('\n')) };
}

/** `proof` (in a project, renamed later), `plan` (no project, computed title) and a folder that is no document. */
async function workspace() {
  const f = await fixture();
  await mkdir(resolve(f.root, 'documents/plan/media/chart'), { recursive: true });
  await writeFile(resolve(f.root, 'documents/plan/index.tsx'), 'export const meta = { title: `Plan ${1 + 1}`, description: "Computed", theme: "neutral" };\nexport default function Plan() { return null; }\n');
  await writeFile(resolve(f.root, 'documents/plan/data.json'), '{"rows":[]}\n');
  await writeFile(resolve(f.root, 'documents/plan/media/chart/image.png'), png);
  await writeFile(resolve(f.root, 'documents/plan/media/chart/meta.json'), JSON.stringify({ title: 'Cost chart', description: 'Costs by quarter.', file: 'image.png', kind: 'chart' }));
  await mkdir(resolve(f.root, 'documents/plan/media/broken'), { recursive: true });
  await writeFile(resolve(f.root, 'documents/plan/media/broken/meta.json'), '{"title": 1}');
  await mkdir(resolve(f.root, 'documents/not-a-document'), { recursive: true });
  await writeFile(resolve(f.root, 'documents/not-a-document/notes.md'), 'x');
  return f;
}

test('staticMeta reads plain string properties of the meta export and nothing else', () => {
  assert.deepEqual(staticMeta('a.tsx', "export const meta: DocumentMeta = { title: 'Annual report', description: \"Numbers\", kind: `report`, theme: theme.id };"), { title: 'Annual report', description: 'Numbers', kind: 'report' });
  assert.deepEqual(staticMeta('a.tsx', "export const meta = { title: 'A', } as const satisfies DocumentMeta;"), { title: 'A' });
  assert.deepEqual(staticMeta('a.tsx', 'const meta = { title: "Not exported" }; export const other = { title: "No" };'), {});
  assert.deepEqual(staticMeta('a.tsx', 'export const meta = { title: `Q${n}`, description: String(1) };'), {}, 'a computed value is not guessed');
  assert.deepEqual(staticMeta('a.tsx', 'export const meta = {{{'), {}, 'broken source gives nothing');
});

test('documents list gives each document with the fields an agent needs, without rendering', async t => {
  const f = await workspace();
  t.after(f.cleanup);
  await changeItemTags(f.root, 'documents', 'proof', { add: ['report', 'Client Acme'] });
  await setDocumentStatus(f.root, 'proof', 'in-review');
  const listing = await listDocuments(f.root);
  assert.deepEqual(listing.map(entry => entry.id), ['plan', 'proof'], 'sorted by the shown title, and only real documents');
  const proof = listing.find(entry => entry.id === 'proof')!;
  assert.equal(proof.title, 'Proof document');
  assert.equal(proof.name, null);
  assert.equal(proof.authoredTitle, 'Proof document');
  assert.equal(proof.path, 'documents/proof/index.tsx');
  assert.deepEqual([proof.projectId, proof.project, proof.format, proof.type, proof.tags, proof.documentStatus, proof.language], ['test-project', 'Test project', 'document', 'report', ['Client Acme'], 'in-review', 'english']);
  assert.match(proof.updatedAt!, /^\d{4}-\d\d-\d\dT/);
  const plan = listing.find(entry => entry.id === 'plan')!;
  assert.deepEqual([plan.title, plan.authoredTitle, plan.projectId, plan.project, plan.type, plan.documentStatus], ['plan', null, null, null, null, null], 'a computed title is only known to a render');
  await assert.rejects(readdir(resolve(f.root, '.opendoc/renders')), { code: 'ENOENT' }, 'nothing was rendered');
});

test('a name given in OpenDoc is the title; project and format come from the manifest', async t => {
  const f = await workspace();
  t.after(f.cleanup);
  await createProject(f.root, { id: 'archive', name: 'Archive' });
  const manifest = JSON.parse(await readFile(resolve(f.root, 'projects.json'), 'utf8'));
  manifest.assignments.plan = 'archive';
  manifest.names = { proof: 'Board review' };
  manifest.formats = { plan: 'presentation' };
  await writeFile(resolve(f.root, 'projects.json'), JSON.stringify(manifest));
  const listing = await listDocuments(f.root);
  const [plan, proof] = [listing.find(entry => entry.id === 'plan')!, listing.find(entry => entry.id === 'proof')!];
  assert.deepEqual([proof.title, proof.name, proof.authoredTitle], ['Board review', 'Board review', 'Proof document']);
  assert.deepEqual([plan.format, plan.project], ['presentation', 'Archive']);
  assert.deepEqual(listing.map(entry => entry.id), ['proof', 'plan'], 'sorted by the title the app shows');
});

test('a document folder that leaves the workspace through a link is not listed', async t => {
  const f = await workspace();
  t.after(f.cleanup);
  const outside = await mkdtemp(resolve(tmpdir(), 'opendoc-outside-'));
  t.after(() => rm(outside, { recursive: true, force: true }));
  await writeFile(resolve(outside, 'index.tsx'), source());
  await symlink(outside, resolve(f.root, 'documents/escape'), 'dir');
  assert.deepEqual((await listDocuments(f.root)).map(entry => entry.id), ['plan', 'proof']);
  await assert.rejects(showDocument(f.root, 'escape'), /Document not found/);
});

test('documents show gives the metadata, the source files and the media', async t => {
  const f = await workspace();
  t.after(f.cleanup);
  const plan = await showDocument(f.root, 'plan');
  assert.deepEqual(plan.meta, { description: 'Computed' });
  assert.deepEqual(plan.files.map(file => file.path), ['documents/plan/data.json', 'documents/plan/index.tsx']);
  assert.ok(plan.files.every(file => file.size > 0 && /^\d{4}-/.test(file.updatedAt)));
  assert.deepEqual(plan.media.map(item => [item.id, item.title, item.file, item.kind, Boolean(item.error)]), [['broken', undefined, undefined, undefined, true], ['chart', 'Cost chart', 'image.png', 'chart', false]]);
  assert.equal(plan.media[1].folder, 'documents/plan/media/chart');
  const proof = await showDocument(f.root, 'proof');
  assert.deepEqual(proof.meta, { title: 'Proof document', description: 'Test fixture', kind: 'report' });
  await assert.rejects(showDocument(f.root, 'missing'), /Document not found: missing/);
  await assert.rejects(showDocument(f.root, 'Bad ID'), /Invalid document ID/);
});

test('documents list and show print one line per document, or the JSON values', async t => {
  const f = await workspace();
  t.after(f.cleanup);
  const out = output(t);
  await runDocumentsCli(['list'], f.root);
  const lines = out.lines.splice(0).join('\n').split('\n');
  assert.equal(lines.length, 3, 'a header and one line per document');
  assert.match(lines[0], /^id {2}title/);
  assert.match(lines[2], /^proof {2}Proof document {2}Test project {2}document {2}- {2}- {2}\d{4}-\d\d-\d\d \d\d:\d\d$/);
  await runDocumentsCli(['list', '--json'], f.root);
  const listed = out.json();
  assert.ok(Array.isArray(listed));
  assert.deepEqual(Object.keys(listed[1]), ['id', 'title', 'name', 'authoredTitle', 'path', 'format', 'projectId', 'project', 'type', 'tags', 'documentStatus', 'language', 'updatedAt']);
  await runDocumentsCli(['show', 'proof'], f.root);
  const shown = out.lines.splice(0).join('\n');
  assert.match(shown, /^proof: Proof document\nEntry: documents\/proof\/index\.tsx\n/);
  assert.match(shown, /Files:\n {2}documents\/proof\/index\.tsx {2}\d+ bytes/);
  await runDocumentsCli(['show', 'plan', '--json'], f.root);
  const details = out.json();
  assert.deepEqual(Object.keys(details), [...Object.keys(listed[1]), 'meta', 'files', 'media'].filter(key => key !== 'language' || details.language));
});

test('documents list and show refuse misuse, with usage errors and stable codes', async t => {
  const f = await workspace();
  t.after(f.cleanup);
  await assert.rejects(runDocumentsCli(['list', 'proof'], f.root), /Unknown documents command/);
  await assert.rejects(runDocumentsCli(['list', '--title', 'X'], f.root), /duplicate only/);
  await assert.rejects(runDocumentsCli(['show'], f.root), /Usage: npx opendoc documents list/);
  await assert.rejects(runDocumentsCli(['show', 'proof', 'extra'], f.root), /Unknown documents command/);
});

/** A workspace the real dispatcher accepts, with the app standing by (a live process accepted as opendoc-desktop). */
async function appWorkspace(t: TestContext, extra: Record<string, unknown> = {}) {
  const root = await mkdtemp(resolve(tmpdir(), 'opendoc-documents-list-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const { version } = JSON.parse(await readFile(resolve(projectRoot, 'package.json'), 'utf8'));
  await writeFile(resolve(root, 'package.json'), JSON.stringify({ name: 'ws', private: true, type: 'module', dependencies: { opendoc: `npm:@ryanyahya/opendoc@${version}` } }));
  await mkdir(resolve(root, '.opendoc'), { recursive: true });
  await writeFile(resolve(root, '.opendoc/workspace.json'), '{"formatVersion":1}\n');
  await mkdir(resolve(root, 'node_modules'));
  await symlink(projectRoot, resolve(root, 'node_modules/opendoc'), 'dir');
  await mkdir(resolve(root, 'documents/proof'), { recursive: true });
  await writeFile(resolve(root, 'documents/proof/index.tsx'), source());
  const sleeper = spawn('sleep', ['300'], { stdio: 'ignore' });
  t.after(() => { sleeper.kill('SIGKILL'); });
  const pid = acceptAsApp(sleeper.pid!, t);
  await writeFile(resolve(root, '.opendoc/desktop.json'), JSON.stringify({ pid, startedAt: '2026-01-01T00:00:00.000Z', version, build: 1, ...extra }));
  return root;
}

test('beside opendoc-desktop, documents list and show read, even in a read-only workspace', async t => {
  const readOnly = { reason: 'newer-patch', message: 'This workspace needs OpenDoc 9.9.9 or newer. Update the app to edit it.' };
  const root = await appWorkspace(t, { readOnly });
  const { lines } = output(t);
  t.mock.method(console, 'error', () => {});
  t.after(() => { process.exitCode = undefined; });
  for (const args of [['documents', 'list'], ['documents', 'show', 'proof']]) {
    lines.length = 0; process.exitCode = undefined;
    await main(['--workspace', root, ...args, '--json']);
    assert.equal(process.exitCode, undefined, args.join(' '));
    assert.ok(JSON.parse(lines.join('\n')), args.join(' '));
  }
  // A failure is the C2 object with a stable code, and a missing document is not-found.
  lines.length = 0;
  await main(['--workspace', root, 'documents', 'show', 'missing', '--json']);
  assert.equal(process.exitCode, 1);
  assert.deepEqual(JSON.parse(lines.at(-1)!), { ok: false, error: 'Document not found: missing. List documents with npx opendoc documents list.', code: 'not-found' });
  process.exitCode = undefined; lines.length = 0;
  await main(['--workspace', root, 'documents', 'show', 'Bad ID', '--json']);
  assert.equal(JSON.parse(lines.at(-1)!).code, 'invalid-input');
  process.exitCode = undefined; lines.length = 0;
  await main(['--workspace', root, 'documents', 'list', 'extra', '--json']);
  assert.equal(process.exitCode, 2);
  assert.equal(JSON.parse(lines.at(-1)!).code, 'usage');
});
