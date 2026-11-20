import assert from 'node:assert/strict';
import { chmod, lstat, mkdir, readFile, readdir, readlink, rename, rm, symlink, utimes, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { test } from 'node:test';
import { BackupError, abandonRestore, cleanPartials, createBackup, deleteBackup, listBackups, recoverRestore, restoreBackup, stamp } from '../../../src/main/workspace/backup.mjs';
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

// ---- a link in the workspace never carries a restore outside it

const outsideFolder = async base => { const outside = join(base, 'outside'); await mkdir(outside, { recursive: true }); await writeFile(join(outside, 'precious.txt'), 'not the workspace'); return outside; };
const snapshot = async folder => Object.fromEntries(await Promise.all((await readdir(folder)).sort().map(async name => [name, await readFile(join(folder, name), 'utf8')])));

test('a link that took the place of a folder is replaced by the folder, and nothing is written where the link led', async () => {
  const { base, root, dataDir } = await fixture();
  const backup = await createBackup({ root, dataDir, from: '0.5.0', to: '0.6.1', now: when });
  const outside = await outsideFolder(base);
  const held = await snapshot(outside);
  // After the backup the documents folder became a link to a folder elsewhere.
  await rm(join(root, 'documents'), { recursive: true });
  await symlink(outside, join(root, 'documents'), 'dir');
  await restoreBackup({ root, dataDir, name: backup.name, now: new Date(2026, 10, 18, 15, 0, 0) });
  assert.ok((await lstat(join(root, 'documents'))).isDirectory(), 'a real folder again, not a link');
  assert.equal(await readFile(join(root, 'documents', 'welcome', 'index.tsx'), 'utf8'), 'export default "welcome";\n');
  assert.deepEqual(await snapshot(outside), held, 'the folder the link led to is as it was');
});

test('a folder that becomes a link to outside while the restore runs: the restore stops and nothing is written outside', async () => {
  const { base, root, dataDir } = await fixture();
  const backup = await createBackup({ root, dataDir, from: '0.5.0', to: '0.6.1', now: when });
  const outside = await outsideFolder(base);
  await writeFile(join(root, 'documents', 'welcome', 'index.tsx'), 'export default "now";\n'); // the restore will replace this
  const held = await snapshot(outside);
  let swapped = false;
  const step = async ({ stage, path }) => {
    if (stage === 'replace' && path === 'documents/welcome/index.tsx' && !swapped) {
      swapped = true;
      await rename(join(root, 'documents', 'welcome'), join(base, 'welcome-moved'));
      await symlink(outside, join(root, 'documents', 'welcome'), 'dir');
    }
  };
  const failure = await restoreBackup({ root, dataDir, name: backup.name, now: new Date(2026, 10, 18, 15, 0, 0), step }).then(() => null, error => error);
  assert.ok(failure instanceof BackupError, String(failure));
  assert.match(failure.message, /outside the workspace/, failure.message);
  assert.deepEqual(await snapshot(outside), held, 'nothing was written, replaced or removed outside the workspace');
  await assert.rejects(lstat(join(outside, 'index.tsx')), { code: 'ENOENT' });
});

test('a restore with every parent folder inside the workspace (links included) is not refused', async () => {
  const { root, dataDir } = await fixture();
  await mkdir(join(root, 'real'), { recursive: true });
  await writeFile(join(root, 'real', 'a.txt'), 'old');
  await symlink('real', join(root, 'alias'), 'dir'); // a link that stays inside
  const backup = await createBackup({ root, dataDir, from: '0.5.0', to: '0.6.1', now: when });
  await writeFile(join(root, 'real', 'a.txt'), 'new');
  await restoreBackup({ root, dataDir, name: backup.name, now: new Date(2026, 10, 18, 15, 0, 0) });
  assert.equal(await readFile(join(root, 'real', 'a.txt'), 'utf8'), 'old');
  assert.equal(await readlink(join(root, 'alias')), 'real');
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

// ---- metadata, names

test('version control and sync metadata (.git, .stfolder, .sync_*.db, .~lock.*, .dropbox*, ...) is neither backed up nor restored', async () => {
  const { root, dataDir } = await fixture();
  const names = ['.git', '.hg', '.svn', '.jj', '.stfolder', '.stignore', '.stversions', '.sync_abc123.db', '.sync_abc123.db-wal', '._sync_abc123.db', '.csync_journal.db', '.owncloudsync.log', '.nextcloudsync.log.1', '.~lock.notes.odt#', '.dropbox', '.dropbox.cache'];
  for (const name of names) { await mkdir(join(root, name), { recursive: true }); await writeFile(join(root, name, 'state'), 'old'); }
  await mkdir(join(root, 'documents', 'welcome', '.git'), { recursive: true });
  await writeFile(join(root, 'documents', 'welcome', '.git', 'inner'), 'old');
  const backup = await createBackup({ root, dataDir, from: '0.5.0', to: '0.6.1', now: when });
  const copied = await readdir(join(backup.directory, 'workspace'));
  for (const name of names) assert.equal(copied.includes(name), false, name);
  assert.equal(await exists(join(backup.directory, 'workspace', 'documents', 'welcome', '.git')), false, 'nested metadata too');
  // The metadata moves on; a restore must leave it as it is, and the safety copy must not hold it.
  for (const name of names) await writeFile(join(root, name, 'state'), 'newer');
  await writeFile(join(root, 'documents', 'welcome', '.git', 'inner'), 'newer');
  await writeFile(join(root, 'documents', 'welcome', 'index.tsx'), 'changed');
  const restored = await restoreBackup({ root, dataDir, name: backup.name, now: new Date(2026, 10, 18, 15, 0, 0) });
  for (const name of names) assert.equal(await readFile(join(root, name, 'state'), 'utf8'), 'newer', name);
  assert.equal(await readFile(join(root, 'documents', 'welcome', '.git', 'inner'), 'utf8'), 'newer');
  assert.deepEqual(restored.before.manifest.entries, ['documents/welcome/index.tsx']);
  assert.equal(await readFile(join(root, 'documents', 'welcome', 'index.tsx'), 'utf8'), 'export default "welcome";\n');
});

const exists = path => lstat(path).then(() => true, () => false);

test('a workspace whose folder name starts with a dot still gets backups the list and Delete can see', async () => {
  const base = await scratch('hidden');
  const root = join(base, '.my-notes');
  await makeWorkspace(root, { pin: '0.5.0', skills: false });
  const dataDir = join(base, 'data');
  const backup = await createBackup({ root, dataDir, from: '0.5.0', to: '0.6.1', now: when });
  assert.equal(backup.name.startsWith('.'), false);
  assert.equal(backup.name, 'my-notes-2026-11-18-142530');
  assert.deepEqual((await listBackups(dataDir)).map(item => item.name), [backup.name]);
  await deleteBackup({ dataDir, name: backup.name, trash: async path => rm(path, { recursive: true }) });
  assert.deepEqual(await listBackups(dataDir), []);
  const hidden = join(base, '...');
  await makeWorkspace(hidden, { pin: '0.5.0' });
  assert.equal((await createBackup({ root: hidden, dataDir, from: 'a', to: 'b', now: when })).name, 'workspace-2026-11-18-142530');
});

test('unfinished copies of a crashed backup are removed once they are old; a fresh one is left (another backup may be running)', async () => {
  const dataDir = join(await scratch('partials'), 'data');
  const backups = join(dataDir, 'backups');
  for (const name of ['.old-ws.partial', '.fresh-ws.partial']) await mkdir(join(backups, name, 'workspace'), { recursive: true });
  const old = new Date(Date.now() - 3_600_000);
  await utimes(join(backups, '.old-ws.partial'), old, old);
  assert.deepEqual(await cleanPartials(dataDir), ['.old-ws.partial']);
  assert.deepEqual(await readdir(backups), ['.fresh-ws.partial']);
});

// ---- restore: file by file, and no file lost at any stage

/** A workspace and a backup of it, then changes of every kind that a restore must undo, and the state they make. */
async function restoring() {
  const { base, root, dataDir } = await fixture({ documents: ['welcome', 'second'] });
  await mkdir(join(root, 'documents', 'empty-dir'), { recursive: true });
  await mkdir(join(root, 'notes', 'deep'), { recursive: true });
  await writeFile(join(root, 'notes', 'deep', 'kept.txt'), 'kept\n');
  await writeFile(join(root, 'untouched.txt'), 'same\n');
  const backup = await createBackup({ root, dataDir, from: '0.5.0', to: '0.6.1', now: when });
  // After the backup: a changed file, a deleted file, a deleted folder with a file in it, a new file, a new folder, a symlink change.
  await writeFile(join(root, 'documents', 'welcome', 'index.tsx'), 'export default "changed";\n');
  await rm(join(root, 'documents', 'second', 'index.tsx'));
  await rm(join(root, 'notes'), { recursive: true });
  await rm(join(root, 'documents', 'empty-dir'), { recursive: true });
  await writeFile(join(root, 'newest.txt'), 'newest\n');
  await mkdir(join(root, 'brand-new', 'sub'), { recursive: true });
  await writeFile(join(root, 'brand-new', 'sub', 'file.txt'), 'new\n');
  await rm(join(root, '.claude', 'skills'));
  await symlink('elsewhere', join(root, '.claude', 'skills'));
  return { base, root, dataDir, backup, tree: () => treeOf(root) };
}

/** Everything in the workspace but node_modules, .opendoc and output: path to content, so "no file lost" is a plain comparison. */
async function treeOf(root) {
  const found = {};
  const walk = async (path, relative) => {
    const info = await lstat(path);
    if (info.isSymbolicLink()) found[relative] = `link ${await readlink(path)}`;
    else if (info.isDirectory()) { found[relative] = 'dir'; for (const name of (await readdir(path)).sort()) await walk(join(path, name), `${relative}/${name}`); }
    else found[relative] = `file ${await readFile(path, 'utf8')}`;
  };
  for (const name of (await readdir(root)).sort()) if (!['node_modules', '.opendoc', 'output'].includes(name)) await walk(join(root, name), name);
  return found;
}

test('restore puts back changed, deleted and moved files, removes new ones, and leaves identical files untouched (same inode)', async () => {
  const { root, dataDir, backup } = await restoring();
  const untouched = (await lstat(join(root, 'untouched.txt'))).ino;
  const lock = await lockBytes(root);
  const result = await restoreBackup({ root, dataDir, name: backup.name, now: new Date(2026, 10, 18, 15, 0, 0) });
  assert.equal(await readFile(join(root, 'documents', 'welcome', 'index.tsx'), 'utf8'), 'export default "welcome";\n');
  assert.equal(await readFile(join(root, 'documents', 'second', 'index.tsx'), 'utf8'), 'export default "second";\n');
  assert.equal(await readFile(join(root, 'notes', 'deep', 'kept.txt'), 'utf8'), 'kept\n');
  assert.equal(await exists(join(root, 'documents', 'empty-dir')), true, 'an empty folder comes back');
  assert.equal(await exists(join(root, 'newest.txt')), false);
  assert.equal(await exists(join(root, 'brand-new')), false);
  assert.equal(await readlink(join(root, '.claude', 'skills')), join('..', '.agents', 'skills'));
  assert.equal((await lstat(join(root, 'untouched.txt'))).ino, untouched, 'an identical file is not rewritten');
  assert.deepEqual(await lockBytes(root), lock);
  assert.deepEqual([result.replaced, result.added, result.removed].map(n => n > 0), [true, true, true]);
  assert.equal(await exists(join(root, '.opendoc', 'restore-journal.json')), false);
  assert.deepEqual((await readdir(root)).filter(name => name.endsWith('.part')), []);
  // The safety copy has the files the restore changed or removed, as they were just before.
  const safe = join(result.before.directory, 'workspace');
  assert.equal(await readFile(join(safe, 'newest.txt'), 'utf8'), 'newest\n');
  assert.equal(await readFile(join(safe, 'brand-new', 'sub', 'file.txt'), 'utf8'), 'new\n');
  assert.equal(await readFile(join(safe, 'documents', 'welcome', 'index.tsx'), 'utf8'), 'export default "changed";\n');
  assert.equal(await exists(join(safe, 'untouched.txt')), false);
  assert.equal(result.before.manifest.scope, 'changed-files');
});

test('restoring from a backup of changed files only puts files back and removes nothing', async () => {
  const { root, dataDir, backup } = await restoring();
  const first = await restoreBackup({ root, dataDir, name: backup.name, now: new Date(2026, 10, 18, 15, 0, 0) });
  await writeFile(join(root, 'another-new.txt'), 'mine\n');
  await restoreBackup({ root, dataDir, name: first.before.name, now: new Date(2026, 10, 18, 16, 0, 0) });
  assert.equal(await readFile(join(root, 'another-new.txt'), 'utf8'), 'mine\n');
  assert.equal(await readFile(join(root, 'newest.txt'), 'utf8'), 'newest\n', 'the files the first restore removed are back');
});

for (const stage of ['copy-before', 'remove', 'rmdir', 'mkdir', 'replace', 'add', 'finish']) {
  test(`a failure at the ${stage} stage loses no file: the workspace is exactly as it was, and no journal, temporary file or copy is left`, async () => {
    const { root, dataDir, backup, tree } = await restoring();
    const before = await tree();
    const beforeLock = await lockBytes(root);
    let seen = 0;
    const step = async info => { if (info.stage === stage && ++seen === 1) throw new Error(`disk trouble at ${stage}`); };
    await assert.rejects(restoreBackup({ root, dataDir, name: backup.name, now: new Date(2026, 10, 18, 15, 0, 0), step }), error => error instanceof BackupError && /disk trouble/.test(error.message) && /(put back the way it was|Nothing was changed)/.test(error.message));
    assert.equal(seen, 1, 'the stage ran');
    assert.deepEqual(await tree(), before);
    assert.deepEqual(await lockBytes(root), beforeLock);
    assert.equal(await exists(join(root, '.opendoc', 'restore-journal.json')), false);
    assert.deepEqual((await readdir(root)).filter(name => name.endsWith('.part')), []);
    assert.deepEqual((await listBackups(dataDir)).map(item => item.manifest.kind), ['upgrade'], 'the safety copy is gone only because everything was put back');
    assert.deepEqual((await readdir(join(dataDir, 'backups'))).filter(name => name.startsWith('.')), []);
  });
}

test('a failure in the middle of the replacements (the third file) rolls back the first two as well', async () => {
  const { root, dataDir, backup, tree } = await restoring();
  const before = await tree();
  let count = 0;
  const step = async ({ stage }) => { if (['replace', 'add'].includes(stage) && ++count === 2) throw new Error('unreadable file'); };
  await assert.rejects(restoreBackup({ root, dataDir, name: backup.name, step }), /put back the way it was/);
  assert.ok(count >= 2);
  assert.deepEqual(await tree(), before);
});

test('a failed rollback keeps the journal and the safety copy, says where it is, and the next recovery finishes the job', async () => {
  const { root, dataDir, backup, tree } = await restoring();
  const before = await tree();
  const fail = async ({ stage }) => { if (stage === 'replace' || stage === 'rollback-file') throw new Error('still broken'); };
  const error = await restoreBackup({ root, dataDir, name: backup.name, now: new Date(2026, 10, 18, 15, 0, 0), step: fail }).catch(failure => failure);
  assert.ok(error instanceof BackupError);
  assert.equal(error.code, 'rollback-failed');
  const [safety] = (await listBackups(dataDir)).filter(item => item.manifest.kind === 'before-restore');
  assert.ok(safety, 'the safety copy is kept');
  assert.ok(error.message.includes(safety.directory), 'the message says where it is');
  assert.equal(await exists(join(root, '.opendoc', 'restore-journal.json')), true);
  // A restore refuses to start on top of an unfinished one; Delete refuses to remove the copy that is needed.
  await assert.rejects(restoreBackup({ root, dataDir, name: backup.name }), /interrupted/);
  await assert.rejects(deleteBackup({ dataDir, name: safety.name, trash: async () => assert.fail('must not trash') }), /safety copy of a restore/);
  const recovered = await recoverRestore({ root });
  assert.match(recovered.message, /undid it/);
  assert.deepEqual(await tree(), before);
  assert.equal(await exists(join(root, '.opendoc', 'restore-journal.json')), false);
  assert.deepEqual((await listBackups(dataDir)).map(item => item.manifest.kind), ['upgrade']);
  assert.equal(await recoverRestore({ root }), null);
});

test('recovery that cannot be completed says so and keeps everything', async () => {
  const { root, dataDir, backup } = await restoring();
  await restoreBackup({ root, dataDir, name: backup.name, step: async ({ stage }) => { if (stage === 'replace' || stage.startsWith('rollback')) throw new Error('x'); } }).catch(() => {});
  await assert.rejects(recoverRestore({ root, step: async ({ stage }) => { if (stage === 'rollback-file') throw new Error('again'); } }), error => error.code === 'rollback-failed' && /kept in/.test(error.message));
  assert.equal(await exists(join(root, '.opendoc', 'restore-journal.json')), true);
  await writeFile(join(root, '.opendoc', 'restore-journal.json'), '{ nope');
  await assert.rejects(recoverRestore({ root }), error => error.code === 'journal-damaged');
  await writeFile(join(root, '.opendoc', 'restore-journal.json'), JSON.stringify({ plan: { add: [], mkdirs: [], rmdirs: [], remove: [], replace: [] }, beforeDirectory: join(dataDir, 'gone') }));
  await assert.rejects(recoverRestore({ root }), error => error.code === 'journal-orphan');
});

test('not enough free space for the safety copy or for the new files: nothing is touched, no journal', async () => {
  const { root, dataDir, backup, tree } = await restoring();
  const before = await tree();
  for (const small of [folder => folder.includes('backups') ? 10 : 1e12, folder => folder === root ? 10 : 1e12]) {
    await assert.rejects(restoreBackup({ root, dataDir, name: backup.name, free: async folder => small(folder) }), error => error.code === 'no-space' && /Nothing was changed/.test(error.message));
    assert.deepEqual(await tree(), before);
    assert.equal(await exists(join(root, '.opendoc', 'restore-journal.json')), false);
    assert.deepEqual((await listBackups(dataDir)).length, 1);
  }
});

test('a file that becomes a folder (and the other way round) is restored', async () => {
  const { base, root, dataDir } = await fixture();
  await mkdir(join(root, 'was-folder'), { recursive: true });
  await writeFile(join(root, 'was-folder', 'a.txt'), 'a\n');
  await writeFile(join(root, 'was-file'), 'file\n');
  const backup = await createBackup({ root, dataDir, from: '0.5.0', to: '0.6.1', now: when });
  await rm(join(root, 'was-folder'), { recursive: true });
  await writeFile(join(root, 'was-folder'), 'now a file\n');
  await rm(join(root, 'was-file'));
  await mkdir(join(root, 'was-file', 'inner'), { recursive: true });
  await writeFile(join(root, 'was-file', 'inner', 'b.txt'), 'b\n');
  await restoreBackup({ root, dataDir, name: backup.name, now: new Date(2026, 10, 18, 15, 0, 0) });
  assert.equal(await readFile(join(root, 'was-folder', 'a.txt'), 'utf8'), 'a\n');
  assert.equal(await readFile(join(root, 'was-file'), 'utf8'), 'file\n');
  void base;
});

// ---- recovery runs again from any state: a file that became a folder, a folder that became a file, kills anywhere

/** `direction`: 'folder-over-file' (the backup has a folder, the workspace has a file there) or 'file-over-folder'. */
async function swapping(direction) {
  const { base, root, dataDir } = await fixture();
  if (direction === 'folder-over-file') {
    await mkdir(join(root, 'themes', 't', 'deep'), { recursive: true });
    await writeFile(join(root, 'themes', 't', 'theme.ts'), 'theme\n');
    await writeFile(join(root, 'themes', 't', 'deep', 'big.bin'), 'big\n');
  } else await writeFile(join(root, 'themes'), 'a file\n');
  await writeFile(join(root, 'same.txt'), 'same\n');
  await writeFile(join(root, 'changed.txt'), 'old\n');
  const backup = await createBackup({ root, dataDir, from: '0.5.0', to: '0.6.1', now: when });
  if (direction === 'folder-over-file') { await rm(join(root, 'themes'), { recursive: true }); await writeFile(join(root, 'themes'), 'now a file\n'); }
  else { await rm(join(root, 'themes')); await mkdir(join(root, 'themes', 'sub'), { recursive: true }); await writeFile(join(root, 'themes', 'sub', 'x.txt'), 'x\n'); }
  await writeFile(join(root, 'changed.txt'), 'new\n');
  return { base, root, dataDir, backup, tree: () => treeOf(root) };
}

const killed = new Error('killed');
const changing = new Set(['remove', 'rmdir', 'mkdir', 'replace', 'add', 'finish']); // the steps after the journal is written

/** A step hook that stops the restore dead at its `at`-th step that changes the workspace (and lets nothing be rolled back, as a kill would). */
const killAt = at => {
  let count = 0;
  return async ({ stage }) => {
    if (stage.startsWith('rollback')) throw killed;
    if (changing.has(stage) && ++count === at) throw killed;
  };
};
/** A restore that dies at its last step: everything is done and nothing was rolled back. */
const dieAtTheEnd = async ({ stage }) => { if (stage === 'finish' || stage.startsWith('rollback')) throw killed; };

for (const direction of ['folder-over-file', 'file-over-folder']) {
  test(`${direction}: a kill at every step that changes the workspace, then recovery (run twice), puts everything back, with no temp and no copy left`, async () => {
    const dry = await swapping(direction);
    let steps = 0;
    await restoreBackup({ root: dry.root, dataDir: dry.dataDir, name: dry.backup.name, step: async ({ stage }) => { if (changing.has(stage)) steps++; } });
    assert.ok(steps >= 5, `steps: ${steps}`);
    for (let at = 1; at <= steps; at++) {
      const { root, dataDir, backup, tree } = await swapping(direction);
      const before = await tree();
      await assert.rejects(restoreBackup({ root, dataDir, name: backup.name, step: killAt(at) }), error => error.code === 'rollback-failed', `kill at ${at}`);
      const recovered = await recoverRestore({ root });
      assert.match(recovered.message, /undid it/, `kill at ${at}`);
      assert.deepEqual(await tree(), before, `kill at ${at}`);
      assert.equal(await recoverRestore({ root }), null, `kill at ${at}: a second recovery has nothing to do`);
      assert.equal(await exists(join(root, '.opendoc', 'restore-journal.json')), false);
      assert.deepEqual((await listBackups(dataDir)).map(item => item.manifest.kind), ['upgrade']);
    }
  });

  test(`${direction}: a kill in the middle of the rollback itself, at every rollback step, then recovery`, async () => {
    const counting = await swapping(direction);
    await restoreBackup({ root: counting.root, dataDir: counting.dataDir, name: counting.backup.name, step: dieAtTheEnd }).catch(() => {});
    let rollbackSteps = 0;
    await recoverRestore({ root: counting.root, step: async () => { rollbackSteps++; } });
    assert.ok(rollbackSteps >= 3, `rollback steps: ${rollbackSteps}`);
    for (let at = 1; at <= rollbackSteps; at++) {
      const { root, dataDir, backup, tree } = await swapping(direction);
      const before = await tree();
      await restoreBackup({ root, dataDir, name: backup.name, step: dieAtTheEnd }).catch(() => {});
      let seen = 0;
      await assert.rejects(recoverRestore({ root, step: async () => { if (++seen === at) throw killed; } }), error => error.code === 'rollback-failed', `rollback kill at ${at}`);
      await recoverRestore({ root }).catch(error => assert.fail(`recovery after a kill at rollback step ${at}: ${error.message}`));
      assert.deepEqual(await tree(), before, `rollback kill at ${at}`);
      assert.equal(await recoverRestore({ root }), null);
    }
  });
}

test('a hidden temporary file a kill left deep in a document folder is removed by the rollback', async () => {
  const { root, dataDir, backup, tree } = await restoring();
  await mkdir(join(root, 'documents', 'a', 'deep'), { recursive: true });
  const before = await tree();
  // The restore writes its temp beside the target; it dies after writing part of it.
  const dead = join(root, 'documents', 'welcome', '.index.tsx.opendoc-999999.part');
  const dead2 = join(root, 'notes', 'deep', '.kept.txt.opendoc-999999.part');
  await assert.rejects(restoreBackup({ root, dataDir, name: backup.name, step: async ({ stage, path }) => { if (stage === 'add' && path === 'notes/deep/kept.txt') { await writeFile(dead2, 'partial'); await writeFile(dead, 'partial'); throw killed; } if (stage.startsWith('rollback')) throw killed; } }), /putting the files back failed/);
  await recoverRestore({ root });
  assert.equal(await exists(dead), false);
  assert.equal(await exists(dead2), false);
  assert.deepEqual(await tree(), before);
});

test('rollback leaves a replaced file alone when it already equals its saved copy (no rewrite, so no room needed)', async () => {
  const { root, dataDir, backup } = await restoring();
  let writes = 0;
  const inode = (await lstat(join(root, 'documents', 'welcome', 'index.tsx'))).ino;
  // Fail the very last forward step: every replace has happened, the failing one is after them; rollback must rewrite them all.
  // Fail the first replace instead: nothing was replaced yet, so rollback must not rewrite any replace file.
  await assert.rejects(restoreBackup({ root, dataDir, name: backup.name, step: async ({ stage }) => { if (stage === 'replace') throw new Error('stop'); if (stage === 'rollback-file') writes++; } }), /put back the way it was/);
  assert.equal((await lstat(join(root, 'documents', 'welcome', 'index.tsx'))).ino, inode, 'the untouched file was not rewritten');
  assert.ok(writes >= 1);
});

test('a new folder that holds nested metadata stays, is reported, and the restore succeeds', async () => {
  const { root, dataDir, backup } = await restoring();
  await mkdir(join(root, 'documents', 'd3', '.git'), { recursive: true });
  await writeFile(join(root, 'documents', 'd3', '.git', 'HEAD'), 'ref\n');
  await writeFile(join(root, 'documents', 'd3', 'index.tsx'), 'x\n');
  const result = await restoreBackup({ root, dataDir, name: backup.name });
  assert.deepEqual(result.kept, ['documents/d3']);
  assert.equal(await readFile(join(root, 'documents', 'd3', '.git', 'HEAD'), 'utf8'), 'ref\n');
  assert.equal(await exists(join(root, 'documents', 'd3', 'index.tsx')), false);
  assert.equal(await readFile(join(root, 'documents', 'welcome', 'index.tsx'), 'utf8'), 'export default "welcome";\n');
});

test('abandonRestore sets the journal aside inside the safety copy, so nothing is rolled back later; the copy stays', async () => {
  const { root, dataDir, backup } = await restoring();
  await restoreBackup({ root, dataDir, name: backup.name, step: async ({ stage }) => { if (stage === 'replace' || stage.startsWith('rollback')) throw new Error('x'); } }).catch(() => {});
  const [safety] = (await listBackups(dataDir)).filter(item => item.manifest.kind === 'before-restore');
  const { directory } = await abandonRestore({ root });
  assert.equal(directory, safety.directory);
  assert.equal(await exists(join(root, '.opendoc', 'restore-journal.json')), false);
  assert.equal(await exists(join(safety.directory, 'abandoned-restore-journal.json')), true);
  assert.equal(await recoverRestore({ root }), null);
  await deleteBackup({ dataDir, name: safety.name, trash: async path => rm(path, { recursive: true }) });
  await writeFile(join(root, '.opendoc', 'restore-journal.json'), '{ nope');
  assert.equal((await abandonRestore({ root })).directory, null);
  assert.equal(await exists(join(root, '.opendoc', 'restore-journal.json')), false);
  assert.equal((await readdir(join(root, '.opendoc'))).some(name => name.startsWith('restore-journal.abandoned-')), true);
});

test('two "Open anyway" abandons in the same second keep both journals under different names', async () => {
  const { root } = await fixture();
  const same = new Date(2026, 10, 19, 10, 0, 0);
  const names = [];
  for (const body of ['{ one', '{ two', '{ three']) {
    await writeFile(join(root, '.opendoc', 'restore-journal.json'), body);
    assert.equal((await abandonRestore({ root, now: same })).directory, null);
    assert.equal(await exists(join(root, '.opendoc', 'restore-journal.json')), false);
  }
  for (const name of (await readdir(join(root, '.opendoc'))).filter(entry => entry.startsWith('restore-journal.abandoned-'))) names.push([name, await readFile(join(root, '.opendoc', name), 'utf8')]);
  assert.deepEqual(names.map(([, text]) => text).sort(), ['{ one', '{ three', '{ two']);
  assert.equal(new Set(names.map(([name]) => name)).size, 3);
  // The same safety copy named by two journals: the folder keeps both too.
  const { root: other, dataDir, backup } = await restoring();
  const crash = async () => restoreBackup({ root: other, dataDir, name: backup.name, now: same, step: async ({ stage }) => { if (stage === 'replace' || stage.startsWith('rollback')) throw new Error('x'); } }).catch(() => {});
  await crash();
  const [safety] = (await listBackups(dataDir)).filter(item => item.manifest.kind === 'before-restore');
  const journal = await readFile(join(other, '.opendoc', 'restore-journal.json'), 'utf8');
  await abandonRestore({ root: other, now: same });
  await writeFile(join(other, '.opendoc', 'restore-journal.json'), journal);
  await abandonRestore({ root: other, now: same });
  assert.deepEqual((await readdir(safety.directory)).filter(name => name.startsWith('abandoned-restore-journal')).sort(), ['abandoned-restore-journal-2.json', 'abandoned-restore-journal.json']);
});
