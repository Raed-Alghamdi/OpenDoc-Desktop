import test, { type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdir, mkdtemp, readFile, readdir, rm, symlink, utimes, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { fixture, projectRoot } from './helpers';
import { ExportStore } from '../src/server/exports';
import { runExportHistoryCli } from '../src/server/exports-cli';
import { main } from '../src/cli/main';

const pdf = Buffer.from('%PDF-1.7\nExact reviewed bytes');
const prepare = async () => ({ bytes: pdf, isCurrent: () => true });
const save = (store: ExportStore, filename: string) => store.save({ id: randomUUID(), documentId: 'proof', hash: 'reviewed-hash', filename }, prepare);

function printed(t: TestContext) {
  const lines: string[] = [];
  t.mock.method(console, 'log', (line: string) => { lines.push(line); });
  t.mock.method(console, 'error', () => {});
  return () => lines.splice(0);
}

test('export history list shows what the Previous exports dialog shows, newest first', async t => {
  const f = await fixture();
  const out = printed(t);
  try {
    const store = new ExportStore(f.root);
    await runExportHistoryCli(['history', 'list', 'proof'], f.root);
    assert.deepEqual(out(), ['No exports yet for proof.']);
    const first = await save(store, 'First.pdf');
    await new Promise(accept => setTimeout(accept, 5));
    await save(store, 'Second.pdf');
    // A file the command-line export wrote is adopted, and says where it came from.
    await mkdir(resolve(f.root, 'output'), { recursive: true });
    await writeFile(resolve(f.root, 'output/proof.pdf'), pdf.toString() + ' from the command line');
    // An adopted file is dated by its modification time, and the file system's clock is coarser than Date.now(), so a file
    // written a moment after Second.pdf can carry an earlier time. Date it plainly later, as a later command-line export would be.
    const later = new Date(Date.now() + 2_000);
    await utimes(resolve(f.root, 'output/proof.pdf'), later, later);

    await runExportHistoryCli(['history', 'list', 'proof', '--json'], f.root);
    const { documentId, exports } = JSON.parse(out()[0]);
    assert.equal(documentId, 'proof');
    assert.deepEqual(exports.map((entry: { filename: string }) => entry.filename), ['proof.pdf', 'Second.pdf', 'First.pdf']);
    assert.deepEqual(exports, JSON.parse(JSON.stringify(await store.list('proof'))), 'The same entries the app route returns.');
    assert.ok(exports.every((entry: { available: boolean }) => entry.available));
    assert.equal(exports[0].hash, '');

    // A file changed outside OpenDoc stays listed but unavailable.
    await writeFile(first.path, 'Changed outside OpenDoc');
    await runExportHistoryCli(['history', 'list', 'proof'], f.root);
    const text = out()[0];
    assert.match(text, /^3 exports of proof, newest first:/);
    assert.match(text, /proof\.pdf.*PDF.*\n    Saved from the command line/);
    assert.match(text, new RegExp(`${first.id}  First\\.pdf.*\\n    File moved, removed, or changed`));
    assert.ok(text.indexOf('Second.pdf') < text.indexOf('First.pdf'));
  } finally { await f.cleanup(); }
});

test('export history delete removes the file and receipt, and restore brings them back', async t => {
  const f = await fixture();
  const out = printed(t);
  try {
    const store = new ExportStore(f.root);
    const saved = await save(store, 'Reviewed.pdf');
    await runExportHistoryCli(['history', 'delete', saved.id, '--json'], f.root);
    assert.deepEqual(JSON.parse(out()[0]), { id: saved.id, filename: 'Reviewed.pdf', removed: true });
    assert.deepEqual(await readdir(resolve(f.root, 'output')), []);
    assert.deepEqual(await store.list('proof'), []);

    await runExportHistoryCli(['history', 'restore', saved.id, '--json'], f.root);
    assert.deepEqual(JSON.parse(out()[0]), JSON.parse(JSON.stringify(saved)));
    assert.deepEqual(await readFile(saved.path), pdf);
    assert.equal((await store.list('proof')).length, 1);

    await runExportHistoryCli(['history', 'delete', saved.id], f.root);
    assert.equal(out()[0], `Removed Reviewed.pdf\nRestore with: npx opendoc export history restore ${saved.id}`);
    await runExportHistoryCli(['history', 'restore', saved.id], f.root);
    assert.equal(out()[0], 'Restored Reviewed.pdf');
  } finally { await f.cleanup(); }
});

test('delete never removes a file changed outside OpenDoc, and unknown exports are refused', async t => {
  const f = await fixture();
  printed(t);
  try {
    const store = new ExportStore(f.root);
    const saved = await save(store, 'Reviewed.pdf');
    await writeFile(saved.path, 'Changed outside OpenDoc');
    await runExportHistoryCli(['history', 'delete', saved.id], f.root);
    assert.equal(await readFile(saved.path, 'utf8'), 'Changed outside OpenDoc');
    await assert.rejects(runExportHistoryCli(['history', 'delete', randomUUID()], f.root), /Export not found/);
    await assert.rejects(runExportHistoryCli(['history', 'restore', randomUUID()], f.root), /Export not found/);
    await assert.rejects(runExportHistoryCli(['history', 'delete', 'not-an-id'], f.root), /Invalid export request/);
    await assert.rejects(runExportHistoryCli(['history', 'list', 'no-such-document'], f.root), /Document not found/);
    await assert.rejects(runExportHistoryCli(['history', 'list', '../escape'], f.root), /Invalid document ID/);
  } finally { await f.cleanup(); }
});

test('reveal prints the path and launches nothing unless --open is given', async t => {
  const f = await fixture();
  const out = printed(t);
  try {
    const store = new ExportStore(f.root);
    const saved = await save(store, 'Reviewed.pdf');
    const launched: string[] = [];
    const reveal = async (_store: ExportStore, id: string) => { launched.push(id); };
    await runExportHistoryCli(['history', 'reveal', saved.id, '--json'], f.root, { reveal });
    assert.deepEqual(JSON.parse(out()[0]), { id: saved.id, filename: 'Reviewed.pdf', path: saved.path, opened: false });
    await runExportHistoryCli(['history', 'reveal', saved.id], f.root, { reveal });
    assert.equal(out()[0], saved.path);
    assert.deepEqual(launched, []);

    await runExportHistoryCli(['history', 'reveal', saved.id, '--open', '--json'], f.root, { reveal });
    assert.equal(JSON.parse(out()[0]).opened, true);
    assert.deepEqual(launched, [saved.id]);

    // An entry whose file is gone has nothing to show or open.
    await store.remove(saved.id);
    await assert.rejects(runExportHistoryCli(['history', 'reveal', saved.id, '--open'], f.root, { reveal }), /no longer available/);
    assert.deepEqual(launched, [saved.id]);
    await assert.rejects(runExportHistoryCli(['history', 'list', 'proof', '--open'], f.root, { reveal }), /--open belongs to export history reveal/);
  } finally { await f.cleanup(); }
});

test('export history has help and rejects incomplete commands', async t => {
  const out = printed(t);
  await runExportHistoryCli(['history', '--help', '--json'], '/missing-opendoc-workspace');
  assert.match(JSON.parse(out()[0]).usage, /export history list <doc>/);
  for (const args of [['history'], ['history', 'list'], ['history', 'purge', 'x'], ['history', 'list', 'proof', 'extra'], ['list', 'proof']]) {
    await assert.rejects(runExportHistoryCli(args, '/missing-opendoc-workspace'), /Usage: npx opendoc export history/);
  }
});

test('the opendoc CLI routes export history, and other export arguments still name documents', async t => {
  const root = await mkdtemp(resolve(tmpdir(), 'opendoc-exports-cli-'));
  const out = printed(t);
  try {
    const { version } = JSON.parse(await readFile(resolve(projectRoot, 'package.json'), 'utf8'));
    await writeFile(resolve(root, 'package.json'), JSON.stringify({ name: 'scratch', private: true, dependencies: { opendoc: `npm:@ryanyahya/opendoc@${version}` } }));
    await mkdir(resolve(root, '.opendoc'));
    await writeFile(resolve(root, '.opendoc/workspace.json'), '{"formatVersion":1}\n');
    await mkdir(resolve(root, 'node_modules'));
    await symlink(projectRoot, resolve(root, 'node_modules/opendoc'), 'dir');
    await mkdir(resolve(root, 'documents/proof'), { recursive: true });
    await writeFile(resolve(root, 'documents/proof/index.tsx'), 'export default null;');
    process.exitCode = undefined;
    await main(['--workspace', root, 'export', 'history', 'list', 'proof', '--json']);
    assert.equal(process.exitCode, undefined);
    assert.deepEqual(JSON.parse(out()[0]), { documentId: 'proof', exports: [] });
    // Without a known action the words are document IDs, as before.
    await main(['--workspace', root, 'export', 'history', '--json']);
    process.exitCode = undefined;
    assert.ok(Array.isArray(JSON.parse(out().at(-1)!).results));
    assert.match((await (async () => { await main(['--help']); return out()[0]; })()), /export history/);
  } finally { process.exitCode = undefined; await rm(root, { recursive: true, force: true }); }
});
