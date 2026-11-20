import test, { type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { fixture, projectRoot, source } from './helpers';
import { acceptAsApp } from './helpers-owner';
import { main } from '../src/cli/main';
import { runMediaCli } from '../src/server/media-cli';
import { importMedia, editMedia } from '../src/server/media-mutations';
import { scanMaterials } from '../src/server/materials';
import { hashBytes } from '../src/media/files';
import { Conflict } from '../src/server/comments';

const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAACgAAAAUCAIAAABwJOjsAAAAOUlEQVR4nO3NQQEAIAwDsVIzqMEF/jXw3QzcHjQGsvY9muCRVYlBJrMqMcZc1SXGmKu6xBhzlT6PH78GAQA/IUyuAAAAAElFTkSuQmCC', 'base64');
const revision = (meta: unknown) => hashBytes(Buffer.from(JSON.stringify(meta)));
const metaFile = (root: string, id = 'photo') => resolve(root, 'documents/proof/media', id, 'meta.json');
const readMeta = async (root: string, id = 'photo') => JSON.parse(await readFile(metaFile(root, id), 'utf8'));

function output(t: TestContext) {
  const lines: string[] = [];
  t.mock.method(console, 'log', (line: string) => { lines.push(String(line)); });
  return { lines, json: () => JSON.parse(lines.splice(0).join('\n')) };
}

/** `proof` with one imported image that has a title, sources, and a `data` and `recipe` the editor must leave alone. */
async function withMedia() {
  const f = await fixture();
  await importMedia(f.root, 'proof', { id: 'photo', title: 'Harbour', description: 'The harbour at dawn.', kind: 'photo', alt: 'Boats at dawn', attribution: 'Studio', sources: ['First note', 'https://example.com/second'] }, { filename: 'a.png', bytes: png });
  await writeFile(resolve(f.root, 'documents/proof/media/photo/data.json'), '{}\n');
  await writeFile(resolve(f.root, 'documents/proof/media/photo/recipe.md'), 'How it was made.\n');
  await writeFile(metaFile(f.root), JSON.stringify({ ...await readMeta(f.root), data: 'data.json', recipe: 'recipe.md' }, null, 2) + '\n');
  return f;
}

test('media edit changes only the fields named, keeps the rest of meta.json, and the app reads the new revision', async t => {
  const f = await withMedia();
  t.after(f.cleanup);
  const out = output(t);
  const before = await readMeta(f.root);
  await runMediaCli(['edit', 'proof', 'photo', '--title', 'Harbour at dawn', '--alt', 'Fishing boats at dawn', '--json'], f.root);
  const result = out.json();
  const after = await readMeta(f.root);
  assert.deepEqual(after, { ...before, title: 'Harbour at dawn', alt: 'Fishing boats at dawn' });
  assert.deepEqual(Object.keys(result), ['documentId', 'id', 'metadataRevision', 'changed', 'file', 'meta']);
  assert.deepEqual([result.documentId, result.id, result.changed, result.file], ['proof', 'photo', ['title', 'alt'], 'documents/proof/media/photo/meta.json']);
  assert.deepEqual(result.meta, after);
  assert.equal(result.metadataRevision, revision(after));
  // The media browser reads the same record and the same revision, so the app shows the change.
  const catalog = await scanMaterials(f.root, [{ id: 'proof', status: 'rendering', revision: 0 }]);
  const item = catalog.media.find(entry => entry.id === 'photo')!;
  assert.equal(item.meta?.title, 'Harbour at dawn');
  assert.equal(item.metadataRevision, result.metadataRevision);
});

test('media edit sets kind, description and attribution, replaces or clears sources, and clears alt text', async t => {
  const f = await withMedia();
  t.after(f.cleanup);
  output(t);
  await runMediaCli(['edit', 'proof', 'photo', '--kind', 'illustration', '--description', 'A drawing of the harbour.', '--attribution', 'Raed', '--source', 'Only note', '--json'], f.root);
  assert.deepEqual(await readMeta(f.root), { title: 'Harbour', description: 'A drawing of the harbour.', file: 'image.png', kind: 'illustration', alt: 'Boats at dawn', attribution: 'Raed', sources: ['Only note'], data: 'data.json', recipe: 'recipe.md' });
  await runMediaCli(['edit', 'proof', 'photo', '--source', 'One', '--source', 'Two', '--json'], f.root);
  assert.deepEqual((await readMeta(f.root)).sources, ['One', 'Two'], 'every --source, in order, replaces the list');
  await runMediaCli(['edit', 'proof', 'photo', '--clear-alt', '--clear-attribution', '--clear-sources', '--json'], f.root);
  const cleared = await readMeta(f.root);
  assert.equal(cleared.alt, undefined);
  assert.equal(cleared.attribution, undefined);
  assert.equal(cleared.sources, undefined);
  assert.deepEqual([cleared.title, cleared.data, cleared.recipe, cleared.file], ['Harbour', 'data.json', 'recipe.md', 'image.png']);
});

test('media edit finds the item from the path of its image, meta.json or folder', async t => {
  const f = await withMedia();
  t.after(f.cleanup);
  const out = output(t);
  const folder = resolve(f.root, 'documents/proof/media/photo');
  for (const [index, path] of [resolve(folder, 'image.png'), resolve(folder, 'meta.json'), folder, resolve(folder, 'data.json')].entries()) {
    await runMediaCli(['edit', path, '--title', `By path ${index}`, '--json'], f.root);
    const result = out.json();
    assert.deepEqual([result.documentId, result.id, result.meta.title], ['proof', 'photo', `By path ${index}`]);
  }
  // Relative to the current folder, as a person types it.
  const cwd = process.cwd();
  t.after(() => process.chdir(cwd));
  process.chdir(f.root);
  await runMediaCli(['edit', 'documents/proof/media/photo/image.png', '--title', 'Relative', '--json'], f.root);
  assert.equal(out.json().meta.title, 'Relative');
  await assert.rejects(runMediaCli(['edit', 'documents/proof/index.tsx', '--title', 'X', '--json'], f.root), /not inside a document's media folder/);
  await assert.rejects(runMediaCli(['edit', 'documents/proof/media', '--title', 'X', '--json'], f.root), /not inside a document's media folder/);
  await assert.rejects(runMediaCli(['edit', 'documents/proof/media/missing/image.png', '--title', 'X', '--json'], f.root), /Media item not found/);
  await assert.rejects(runMediaCli(['edit', '/etc/hostname', '--title', 'X', '--json'], f.root), /not inside a document's media folder/);
});

test('media edit refuses what the app refuses, and changes nothing', async t => {
  const f = await withMedia();
  t.after(f.cleanup);
  output(t);
  const before = await readFile(metaFile(f.root), 'utf8');
  const refused = async (args: string[], message: RegExp) => {
    await assert.rejects(runMediaCli(['edit', 'proof', 'photo', ...args, '--json'], f.root), message, args.join(' '));
    assert.equal(await readFile(metaFile(f.root), 'utf8'), before, `${args.join(' ')} left meta.json alone`);
  };
  await refused(['--kind', 'sketch'], /Media kind must be/);
  await refused(['--title', ' '], /Media title must be nonempty/);
  await refused(['--alt', ''], /Media alt must be nonempty/);
  await refused(['--source', 'Same', '--source', 'Same'], /must be unique/);
  await refused(['--description', 'x'.repeat(4001)], /Media description must be nonempty text/);
  await refused([], /Name at least one field to change/);
  await refused(['--alt', 'x', '--clear-alt'], /not both/);
  await refused(['--source', 'x', '--clear-sources'], /not both/);
  await refused(['--file', 'other.png', '--title', 'x'], /Usage: npx opendoc media edit/);
  await assert.rejects(runMediaCli(['edit', 'proof', 'missing', '--title', 'x'], f.root), /Media item not found: missing in proof/);
  await assert.rejects(runMediaCli(['edit', 'missing', 'photo', '--title', 'x'], f.root), /Document not found: missing/);
  await assert.rejects(runMediaCli(['edit', 'Bad ID', 'photo', '--title', 'x'], f.root), /Use a document ID and a lowercase media ID/);
  await assert.rejects(runMediaCli(['edit', 'proof', 'photo', 'extra', '--title', 'x'], f.root), /Usage: npx opendoc media edit/);
  await assert.rejects(runMediaCli(['edit', '--title', 'x'], f.root), /Usage: npx opendoc media edit/);
  // Edit flags belong to edit, and import's file flag does not.
  await assert.rejects(runMediaCli(['list', '--alt', 'x'], f.root), /Usage: npx opendoc media list/);
  await assert.rejects(runMediaCli(['record', 'proof', 'photo', '--title', 'x'], f.root), /Usage: npx opendoc media list/);
});

test('--expected-revision guards against a change made since the revision was read, like the route does', async t => {
  const f = await withMedia();
  t.after(f.cleanup);
  const out = output(t);
  const seen = revision(await readMeta(f.root));
  // Someone else edits through the route's code after the caller read the revision.
  await editMedia(f.root, 'proof', 'photo', { expectedRevision: seen, meta: { title: 'Changed elsewhere', description: 'The harbour at dawn.', kind: 'photo' } as never });
  await assert.rejects(runMediaCli(['edit', 'proof', 'photo', '--title', 'Mine', '--expected-revision', seen, '--json'], f.root), Conflict);
  assert.equal((await readMeta(f.root)).title, 'Changed elsewhere');
  const current = revision(await readMeta(f.root));
  await runMediaCli(['edit', 'proof', 'photo', '--title', 'Mine', '--expected-revision', current, '--json'], f.root);
  assert.equal(out.json().meta.title, 'Mine');
  // Without the flag the revision just read is used, so an edit on top of the current record succeeds.
  await runMediaCli(['edit', 'proof', 'photo', '--title', 'Again', '--json'], f.root);
  assert.equal(out.json().meta.title, 'Again');
});

test('media edit prints a short summary without --json and its help lists every option', async t => {
  const f = await withMedia();
  t.after(f.cleanup);
  const out = output(t);
  await runMediaCli(['edit', 'proof', 'photo', '--alt', 'New alt', '--source', 'A'], f.root);
  const [summary, revisionLine] = out.lines.splice(0).join('\n').split('\n');
  assert.equal(summary, 'Updated photo in proof: alt, sources');
  assert.match(revisionLine, /^Revision: [a-f0-9]{64}$/);
  await runMediaCli(['edit', '--help'], f.root);
  const help = out.lines.splice(0).join('\n');
  for (const option of ['--title', '--description', '--kind', '--alt', '--attribution', '--source', '--clear-alt', '--clear-attribution', '--clear-sources', '--expected-revision']) assert.ok(help.includes(option), option);
  await runMediaCli(['edit', '--help', '--json'], f.root);
  assert.match(out.json().usage, /media edit <document> <media-id>/);
  await runMediaCli(['--help'], f.root);
  assert.match(out.lines.splice(0).join('\n'), /media edit <document> <media-id>/);
});

/** A workspace the real dispatcher accepts, with the app standing by, a document and one media item. */
async function appWorkspace(t: TestContext, extra: Record<string, unknown> = {}) {
  const root = await mkdtemp(resolve(tmpdir(), 'opendoc-media-edit-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const { version } = JSON.parse(await readFile(resolve(projectRoot, 'package.json'), 'utf8'));
  await writeFile(resolve(root, 'package.json'), JSON.stringify({ name: 'ws', private: true, type: 'module', dependencies: { opendoc: `npm:@ryanyahya/opendoc@${version}` } }));
  await mkdir(resolve(root, '.opendoc'), { recursive: true });
  await writeFile(resolve(root, '.opendoc/workspace.json'), '{"formatVersion":1}\n');
  await mkdir(resolve(root, 'node_modules'));
  await symlink(projectRoot, resolve(root, 'node_modules/opendoc'), 'dir');
  await mkdir(resolve(root, 'documents/proof'), { recursive: true });
  await writeFile(resolve(root, 'documents/proof/index.tsx'), source());
  await importMedia(root, 'proof', { id: 'photo', title: 'Harbour', description: 'The harbour at dawn.', kind: 'photo' }, { filename: 'a.png', bytes: png });
  const sleeper = spawn('sleep', ['300'], { stdio: 'ignore' });
  t.after(() => { sleeper.kill('SIGKILL'); });
  const pid = acceptAsApp(sleeper.pid!, t);
  await writeFile(resolve(root, '.opendoc/desktop.json'), JSON.stringify({ pid, startedAt: '2026-01-01T00:00:00.000Z', version, build: 1, ...extra }));
  return root;
}

test('beside opendoc-desktop media edit writes directly, in a read-only workspace it is refused, and failures carry stable codes', async t => {
  const root = await appWorkspace(t);
  const { lines } = output(t);
  t.mock.method(console, 'error', () => {});
  t.after(() => { process.exitCode = undefined; });
  const run = async (...args: string[]) => { lines.length = 0; process.exitCode = undefined; await main(['--workspace', root, ...args, '--json']); const exitCode = process.exitCode as number | undefined; process.exitCode = undefined; return { exitCode, last: lines.length ? JSON.parse(lines.at(-1)!) : undefined }; };
  const edited = await run('media', 'edit', 'proof', 'photo', '--title', 'Edited beside the app');
  assert.equal(edited.exitCode, undefined);
  assert.equal(edited.last.meta.title, 'Edited beside the app');
  assert.equal((await readMeta(root)).title, 'Edited beside the app');
  const stale = await run('media', 'edit', 'proof', 'photo', '--title', 'x', '--expected-revision', 'a'.repeat(64));
  assert.deepEqual([stale.exitCode, stale.last.ok, stale.last.code], [1, false, 'conflict']);
  const invalid = await run('media', 'edit', 'proof', 'photo', '--kind', 'sketch');
  assert.deepEqual([invalid.exitCode, invalid.last.code], [1, 'invalid-input']);
  const missing = await run('media', 'edit', 'proof', 'missing', '--title', 'x');
  assert.deepEqual([missing.exitCode, missing.last.code], [1, 'not-found']);
  const nothing = await run('media', 'edit', 'proof', 'photo');
  assert.deepEqual([nothing.exitCode, nothing.last.code], [2, 'usage']);
  const unknown = await run('media', 'edit', 'proof', 'photo', '--no-such-flag');
  assert.deepEqual([unknown.exitCode, unknown.last.code], [2, 'usage']);
  // The app holds the workspace read-only: the write is refused before anything runs.
  const message = 'This workspace needs OpenDoc 9.9.9 or newer. Update the app to edit it.';
  const { version } = JSON.parse(await readFile(resolve(projectRoot, 'package.json'), 'utf8'));
  const state = JSON.parse(await readFile(resolve(root, '.opendoc/desktop.json'), 'utf8'));
  await writeFile(resolve(root, '.opendoc/desktop.json'), JSON.stringify({ ...state, version, readOnly: { reason: 'newer-patch', message } }));
  const before = await readFile(metaFile(root), 'utf8');
  const refused = await run('media', 'edit', 'proof', 'photo', '--title', 'Refused');
  assert.deepEqual(refused.last, { ok: false, error: message, code: 'workspace-read-only' });
  assert.equal(await readFile(metaFile(root), 'utf8'), before);
});
