import assert from 'node:assert/strict';
import { chmod, lstat, mkdir, readFile, readdir, readlink, rm, symlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { test } from 'node:test';
import { BackupError, createBackup, deleteBackup, listBackups, restoreBackup, stamp } from '../../../src/main/workspace/backup.mjs';
import { runUpgradeSteps, stepsBetween } from '../../../src/main/workspace/registry.mjs';
import { lockBytes, makeWorkspace, scratch } from '../support/workspace-fixtures.mjs';

const when = new Date(2026, 10, 18, 14, 25, 30);

async function fixture(options) {
  const base = await scratch('backup');
  const root = join(base, 'my-ws');
  await makeWorkspace(root, { pin: '0.5.0', skills: true, ...options });
  await mkdir(join(root, 'node_modules', 'opendoc'), { recursive: true });
  await writeFile(join(root, 'node_modules', 'opendoc', 'big.js'), 'x'.repeat(1000));
  await mkdir(join(root, 'output', 'reviews'), { recursive: true });
  await writeFile(join(root, 'output', 'reviews', 'a.png'), 'png');
  await writeFile(join(root, '.opendoc', 'server.json'), '{}');
  await mkdir(join(root, '.claude'), { recursive: true });
  await symlink(join('..', '.agents', 'skills'), join(root, '.claude', 'skills'), 'dir');
  await mkdir(join(root, 'documents', 'welcome', '.history'), { recursive: true });
  await writeFile(join(root, 'documents', 'welcome', '.history', 'one.json'), '{}');
  return { base, root, dataDir: join(base, 'data') };
}

test('a backup copies everything except node_modules, .opendoc and output, with a manifest', async () => {
  const { root, dataDir } = await fixture();
  const backup = await createBackup({ root, dataDir, from: '0.5.0', to: '0.6.1', now: when });
  assert.equal(backup.name, `my-ws-${stamp(when)}`);
  assert.equal(backup.name, 'my-ws-2026-11-18-142530');
  assert.equal(backup.directory, join(dataDir, 'backups', backup.name));
  assert.deepEqual((await readdir(backup.directory)).sort(), ['backup.json', 'workspace']);
  assert.deepEqual((await readdir(join(backup.directory, 'workspace'))).sort(), ['.agents', '.claude', 'documents', 'package-lock.json', 'package.json']);
  assert.equal(await readFile(join(backup.directory, 'workspace', 'package.json'), 'utf8'), await readFile(join(root, 'package.json'), 'utf8'));
  assert.equal(await readFile(join(backup.directory, 'workspace', 'documents', 'welcome', '.history', 'one.json'), 'utf8'), '{}');
  assert.equal(await readlink(join(backup.directory, 'workspace', '.claude', 'skills')), join('..', '.agents', 'skills'), 'symlinks are copied as links');
  const manifest = JSON.parse(await readFile(join(backup.directory, 'backup.json'), 'utf8'));
  assert.equal(manifest.source, root);
  assert.deepEqual([manifest.from, manifest.to, manifest.time, manifest.kind], ['0.5.0', '0.6.1', when.toISOString(), 'upgrade']);
  assert.ok(manifest.files >= 5 && manifest.bytes > 0);
  assert.deepEqual(manifest.entries, ['.agents', '.claude', 'documents', 'package-lock.json', 'package.json']);
  assert.deepEqual((await readdir(join(dataDir, 'backups'))), [backup.name], 'no partial folder is left');
});

test('a second backup in the same second gets its own folder', async () => {
  const { root, dataDir } = await fixture();
  const one = await createBackup({ root, dataDir, from: '0.5.0', to: '0.6.1', now: when });
  const two = await createBackup({ root, dataDir, from: '0.5.0', to: '0.6.1', now: when });
  assert.notEqual(one.name, two.name);
  assert.equal((await listBackups(dataDir)).length, 2);
});

test('not enough free space: nothing is copied and the message says what is needed', async () => {
  const { root, dataDir } = await fixture();
  await assert.rejects(createBackup({ root, dataDir, from: '0.5.0', to: '0.6.1', free: async () => 1000 }), error => error instanceof BackupError && error.code === 'no-space' && /not enough free space/.test(error.message) && /Nothing was changed/.test(error.message));
  assert.deepEqual(await readdir(join(dataDir, 'backups')), []);
});

test('listing: complete backups only, newest first; delete goes through the trash function', async () => {
  const { root, dataDir } = await fixture();
  const first = await createBackup({ root, dataDir, from: '0.5.0', to: '0.6.1', now: new Date(2026, 10, 18, 9, 0, 0) });
  const second = await createBackup({ root, dataDir, from: '0.5.0', to: '0.6.1', now: new Date(2026, 10, 18, 10, 0, 0) });
  await mkdir(join(dataDir, 'backups', '.half.partial', 'workspace'), { recursive: true });
  await mkdir(join(dataDir, 'backups', 'not-a-backup'), { recursive: true });
  assert.deepEqual((await listBackups(dataDir)).map(item => item.name), [second.name, first.name]);
  const trashed = [];
  await deleteBackup({ dataDir, name: first.name, trash: async path => { trashed.push(path); await rm(path, { recursive: true }); } });
  assert.deepEqual(trashed, [first.directory]);
  assert.deepEqual((await listBackups(dataDir)).map(item => item.name), [second.name]);
  for (const name of ['../x', 'not-a-backup', '.half.partial', first.name]) await assert.rejects(deleteBackup({ dataDir, name, trash: async () => assert.fail('must not trash') }), BackupError);
  assert.deepEqual(await listBackups(join(dataDir, 'none')), []);
});

test('restore: what the workspace holds now goes to a before-restore backup first, then the backup is copied back', async () => {
  const { root, dataDir } = await fixture();
  const backup = await createBackup({ root, dataDir, from: '0.5.0', to: '0.6.1', now: when });
  const oldPackage = await readFile(join(root, 'package.json'), 'utf8');
  // The upgrade changes things: the pin, a document, a new file.
  await writeFile(join(root, 'package.json'), oldPackage.replace('0.5.0', '0.6.1'));
  await writeFile(join(root, 'documents', 'welcome', 'index.tsx'), 'export default "changed";\n');
  await writeFile(join(root, 'documents', 'new.txt'), 'new');
  await writeFile(join(root, 'node_modules', 'opendoc', 'big.js'), 'kept');
  const lock = await lockBytes(root);
  const restored = await restoreBackup({ root, dataDir, name: backup.name, now: new Date(2026, 10, 18, 15, 0, 0) });
  assert.equal(await readFile(join(root, 'package.json'), 'utf8'), oldPackage);
  assert.equal(await readFile(join(root, 'documents', 'welcome', 'index.tsx'), 'utf8'), 'export default "welcome";\n');
  await assert.rejects(lstat(join(root, 'documents', 'new.txt')), { code: 'ENOENT' });
  assert.deepEqual(await lockBytes(root), lock);
  assert.equal(await readFile(join(root, 'node_modules', 'opendoc', 'big.js'), 'utf8'), 'kept', 'node_modules is not part of a restore');
  assert.equal(await readFile(join(root, 'output', 'reviews', 'a.png'), 'utf8'), 'png');
  assert.equal(await readlink(join(root, '.claude', 'skills')), join('..', '.agents', 'skills'));
  // The files from just before the restore are kept, and the backup itself is untouched.
  assert.equal(restored.before.manifest.kind, 'before-restore');
  assert.equal(await readFile(join(restored.before.directory, 'workspace', 'documents', 'new.txt'), 'utf8'), 'new');
  assert.equal(JSON.parse(await readFile(join(restored.before.directory, 'workspace', 'package.json'), 'utf8')).dependencies.opendoc, 'npm:@ryanyahya/opendoc@0.6.1');
  assert.equal(JSON.parse(await readFile(join(backup.directory, 'workspace', 'package.json'), 'utf8')).dependencies.opendoc, 'npm:@ryanyahya/opendoc@0.5.0');
  assert.deepEqual((await listBackups(dataDir)).map(item => item.manifest.kind).sort(), ['before-restore', 'upgrade']);
});

test('restore of a backup that is gone fails before anything moves', async () => {
  const { root, dataDir } = await fixture();
  const before = await readdir(root);
  await assert.rejects(restoreBackup({ root, dataDir, name: 'nope' }), /not there any more/);
  assert.deepEqual(await readdir(root), before);
});

test('restore that fails half-way puts the workspace back as it was', { skip: process.getuid?.() === 0 && 'root can read any file' }, async () => {
  const { root, dataDir } = await fixture();
  const backup = await createBackup({ root, dataDir, from: '0.5.0', to: '0.6.1', now: when });
  await writeFile(join(root, 'documents', 'welcome', 'index.tsx'), 'export default "now";\n');
  // A file of the backup that cannot be read makes the copy back fail, after the workspace's own files were moved aside.
  await chmod(join(backup.directory, 'workspace', 'documents', 'welcome', 'index.tsx'), 0o000);
  await assert.rejects(restoreBackup({ root, dataDir, name: backup.name, now: new Date(2026, 10, 18, 15, 0, 0) }), error => error instanceof BackupError && /put back the way it was/.test(error.message));
  assert.equal(await readFile(join(root, 'documents', 'welcome', 'index.tsx'), 'utf8'), 'export default "now";\n');
  assert.equal(JSON.parse(await readFile(join(root, 'package.json'), 'utf8')).dependencies.opendoc, 'npm:@ryanyahya/opendoc@0.5.0');
  assert.deepEqual((await readdir(join(dataDir, 'backups'))).sort(), [backup.name]);
});

// ---- the registry runner

test('registry: an empty registry has no steps, and the run succeeds', async () => {
  assert.deepEqual(stepsBetween([], '0.5.0', '0.6.1'), []);
  assert.deepEqual(await runUpgradeSteps({ registry: [], from: '0.5.0', to: '0.6.1', root: '/x' }), { ok: true, results: [] });
});

test('registry: a "no changes needed" entry is recorded as unchanged and runs nothing', async () => {
  const registry = [{ from: '0.5', to: '0.6', noChanges: true }];
  const seen = [];
  const run = async () => assert.fail('a no-op entry runs no script');
  const result = await runUpgradeSteps({ registry, from: '0.5.2', to: '0.6.1', root: '/x', run, onStep: entry => seen.push(`${entry.from}>${entry.to}`) });
  assert.deepEqual(result, { ok: true, results: [{ from: '0.5', to: '0.6', status: 'unchanged' }] });
  assert.deepEqual(seen, ['0.5>0.6']);
});

test('registry: entries outside the pin-to-runtime range are skipped, the rest run in order', async () => {
  const registry = [{ from: '0.6', to: '0.7', noChanges: true }, { from: '0.4', to: '0.5', noChanges: true }, { from: '0.5', to: '0.6', script: '/s/b.mjs' }, { from: '0.3', to: '0.4', noChanges: true }, { from: '0.4', to: '0.5', script: '/s/a.mjs' }];
  assert.deepEqual(stepsBetween(registry, '0.4.0', '0.6.1').map(entry => `${entry.from}>${entry.to}${entry.script ?? ''}`), ['0.4>0.5', '0.4>0.5/s/a.mjs', '0.5>0.6/s/b.mjs']);
});

test('registry: a script entry runs as Node in the workspace with root, from and to; its output is kept', async () => {
  const base = await scratch('step');
  const script = join(base, 'step.mjs');
  await writeFile(script, "import { writeFileSync } from 'node:fs'; writeFileSync('step-ran.txt', process.argv.slice(2).join(' ')); console.log('moved 3 files');\n");
  const root = join(base, 'ws');
  await mkdir(root);
  const result = await runUpgradeSteps({ registry: [{ from: '0.5', to: '0.6', script }], from: '0.5.0', to: '0.6.1', root });
  assert.equal(result.ok, true);
  assert.deepEqual(result.results.map(item => [item.from, item.to, item.status, item.message]), [['0.5', '0.6', 'ran', 'moved 3 files']]);
  assert.equal(await readFile(join(root, 'step-ran.txt'), 'utf8'), `${root} 0.5 0.6`);
});

test('registry: a failing step stops the run, names the step and keeps what it said', async () => {
  const base = await scratch('step-fail');
  const bad = join(base, 'bad.mjs');
  await writeFile(bad, "console.error('cannot move the history'); process.exit(3);\n");
  const root = join(base, 'ws');
  await mkdir(root);
  const registry = [{ from: '0.4', to: '0.5', noChanges: true }, { from: '0.5', to: '0.6', script: bad }, { from: '0.6', to: '0.7', noChanges: true }];
  const result = await runUpgradeSteps({ registry, from: '0.4.0', to: '0.7.0', root });
  assert.equal(result.ok, false);
  assert.deepEqual(result.results.map(item => item.status), ['unchanged', 'failed']);
  assert.equal(result.failed.from, '0.5');
  assert.match(result.failed.message, /cannot move the history/);
});

test('registry: a script that cannot start fails the step with the reason', async () => {
  const root = await scratch('step-missing');
  const result = await runUpgradeSteps({ registry: [{ from: '0.5', to: '0.6', script: join(root, 'missing.mjs') }], from: '0.5.0', to: '0.6.0', root });
  assert.equal(result.ok, false);
  assert.equal(result.failed.status, 'failed');
});
