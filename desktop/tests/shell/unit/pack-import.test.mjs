// Opening a design pack from outside the page, below Electron: which arguments are packs, reading a pack in the main process,
// the inbox that holds one until a workspace is open, and the rule for Show in folder (refusals included).
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, realpath, rm, symlink, truncate, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, test } from 'node:test';
import { createPackInbox, packPathsFromArguments, packSizeLimit, readPackFile, revealablePackPath } from '../../../src/main/pack-import.mjs';

const folders = [];
const scratch = async () => { const folder = await realpath(await mkdtemp(join(tmpdir(), 'opendoc-pack-import-'))); folders.push(folder); return folder; };
after(async () => { for (const folder of folders) await rm(folder, { recursive: true, force: true }); });

test('a double-click passes the path: only .zip paths are packs, flags and the entry script never are', () => {
  assert.deepEqual(packPathsFromArguments(['--no-sandbox', '/opt/app/src/main/index.mjs', '/home/u/Downloads/civic-1.0.0.opendoc.zip'], '/'), ['/home/u/Downloads/civic-1.0.0.opendoc.zip']);
  assert.deepEqual(packPathsFromArguments(['--user-data-dir=/x/y.opendoc.zip'], '/'), []);
  assert.deepEqual(packPathsFromArguments(['/a/PACK.OPENDOC.ZIP'], '/'), ['/a/PACK.OPENDOC.ZIP'], 'any case');
  assert.deepEqual(packPathsFromArguments(['/a/renamed (1).zip'], '/'), ['/a/renamed (1).zip'], 'a download a browser renamed, or Open With on a zip');
  assert.deepEqual(packPathsFromArguments([], '/'), []);
  assert.deepEqual(packPathsFromArguments(undefined, '/'), []);
});

test('a relative path is made absolute from the folder the launch came from (a second launch has its own)', () => {
  assert.deepEqual(packPathsFromArguments(['pack.opendoc.zip', './sub/other.opendoc.zip'], '/work/dir'), ['/work/dir/pack.opendoc.zip', '/work/dir/sub/other.opendoc.zip']);
});

test('a file manager may pass a file address: it is turned into the path, and a bad address is skipped', () => {
  assert.deepEqual(packPathsFromArguments(['file:///home/u/My%20Pack.opendoc.zip'], '/'), ['/home/u/My Pack.opendoc.zip']);
  assert.deepEqual(packPathsFromArguments(['file://otherhost/x/y.opendoc.zip'], '/'), []);
});

test('a name with a space is found both as a plain path and as a file address (the .desktop Exec uses %U, a list of addresses)', () => {
  const plain = '/tmp/x/My pack.opendoc.zip';
  assert.deepEqual(packPathsFromArguments([plain], '/'), [plain]);
  assert.deepEqual(packPathsFromArguments(['file:///tmp/x/My%20pack.opendoc.zip'], '/'), [plain]);
  // The same two forms in a second launch's arguments (the app passes its arguments without the executable) and from another folder.
  assert.deepEqual(packPathsFromArguments(['--flag', 'file:///tmp/x/My%20pack.opendoc.zip', 'My pack.opendoc.zip'], '/work'), [plain, '/work/My pack.opendoc.zip']);
  assert.deepEqual(packPathsFromArguments(['file:///tmp/x/Caf%C3%A9%20pack.opendoc.zip'], '/'), ['/tmp/x/Café pack.opendoc.zip']);
});

test('the same pack named twice is one pack', () => {
  assert.deepEqual(packPathsFromArguments(['/a/p.opendoc.zip', '/a/p.opendoc.zip'], '/'), ['/a/p.opendoc.zip']);
});

test('a pack is read whole, with its file name', async () => {
  const folder = await scratch();
  const file = join(folder, 'civic.opendoc.zip');
  const content = Buffer.from('PK\u0003\u0004 pretend zip bytes');
  await writeFile(file, content);
  const read = await readPackFile(file);
  assert.equal(read.ok, true);
  assert.equal(read.name, 'civic.opendoc.zip');
  assert.ok(read.bytes instanceof Uint8Array);
  assert.deepEqual(Buffer.from(read.bytes), content);
});

test('a pack of exactly 64 MiB is read; one byte more is refused with the app\'s own message and is not read', async () => {
  assert.equal(packSizeLimit, 64 * 1024 * 1024);
  const folder = await scratch();
  const exact = join(folder, 'exact.opendoc.zip');
  await writeFile(exact, '');
  await truncate(exact, packSizeLimit);
  const ok = await readPackFile(exact);
  assert.equal(ok.ok, true);
  assert.equal(ok.bytes.length, packSizeLimit);
  const over = join(folder, 'over.opendoc.zip');
  await writeFile(over, '');
  await truncate(over, packSizeLimit + 1);
  const refused = await readPackFile(over);
  assert.equal(refused.ok, false);
  assert.equal(refused.name, 'over.opendoc.zip');
  assert.match(refused.message, /over\.opendoc\.zip is 64 MiB\. A design pack can be at most 64 MiB, so it was not opened\./);
  assert.equal(refused.bytes, undefined);
});

test('a limit that is passed in is honoured, also while the file is read', async () => {
  const folder = await scratch();
  const file = join(folder, 'small.opendoc.zip');
  await writeFile(file, Buffer.alloc(1000, 7));
  assert.equal((await readPackFile(file, { limit: 1000 })).ok, true);
  const refused = await readPackFile(file, { limit: 999 });
  assert.equal(refused.ok, false);
});

test('a missing file, a folder and an unreadable file give a sentence, never a throw', async () => {
  const folder = await scratch();
  const missing = await readPackFile(join(folder, 'nope.opendoc.zip'));
  assert.deepEqual([missing.ok, missing.name], [false, 'nope.opendoc.zip']);
  assert.match(missing.message, /nope\.opendoc\.zip could not be opened\. It was not found\./);
  await mkdir(join(folder, 'dir.opendoc.zip'));
  const directory = await readPackFile(join(folder, 'dir.opendoc.zip'));
  assert.equal(directory.ok, false);
  assert.match(directory.message, /is not a file/);
});

test('the inbox holds the newest pack until someone attaches, then passes on every one', () => {
  const inbox = createPackInbox();
  inbox.push('/a/first.opendoc.zip');
  inbox.push('/a/second.opendoc.zip');
  assert.equal(inbox.pending, '/a/second.opendoc.zip');
  const seen = [];
  inbox.attach(path => seen.push(path));
  assert.deepEqual(seen, ['/a/second.opendoc.zip']);
  assert.equal(inbox.pending, null);
  inbox.push('/a/third.opendoc.zip');
  assert.deepEqual(seen, ['/a/second.opendoc.zip', '/a/third.opendoc.zip']);
});

test('the inbox with nothing waiting calls the new listener for nothing', () => {
  const inbox = createPackInbox();
  const seen = [];
  inbox.attach(path => seen.push(path));
  assert.deepEqual(seen, []);
});

async function workspaceWithPack() {
  const folder = await scratch();
  const root = join(folder, 'workspace');
  const packs = join(root, 'output', 'packs');
  await mkdir(packs, { recursive: true });
  const pack = join(packs, 'civic-1.0.0.opendoc.zip');
  await writeFile(pack, 'zip');
  return { folder, root, packs, pack };
}

test('Show in folder: a file the app saved in output/packs is accepted, as its real path', async () => {
  const { root, pack } = await workspaceWithPack();
  assert.equal(await revealablePackPath(root, pack), pack);
});

test('Show in folder: a path through a workspace that is itself reached by a link is accepted', async () => {
  const { folder, root, pack } = await workspaceWithPack();
  const alias = join(folder, 'alias');
  await symlink(root, alias);
  assert.equal(await revealablePackPath(alias, join(alias, 'output', 'packs', 'civic-1.0.0.opendoc.zip')), pack);
});

test('Show in folder: refuses a relative path, an empty value, a non-string and a NUL byte', async () => {
  const { root } = await workspaceWithPack();
  for (const value of ['output/packs/civic-1.0.0.opendoc.zip', '', undefined, null, 42, {}, ['/x'], `${root}/output/packs/a\0b`]) assert.equal(await revealablePackPath(root, value), null, String(value));
});

test('Show in folder: refuses ".." that climbs out of output/packs', async () => {
  const { root, folder, packs } = await workspaceWithPack();
  await writeFile(join(root, 'secret.txt'), 'x');
  await writeFile(join(folder, 'outside.txt'), 'x');
  assert.equal(await revealablePackPath(root, join(packs, '..', '..', 'secret.txt')), null);
  assert.equal(await revealablePackPath(root, `${packs}/../../../outside.txt`), null);
  assert.equal(await revealablePackPath(root, join(packs, '..', 'packs', 'civic-1.0.0.opendoc.zip')), join(packs, 'civic-1.0.0.opendoc.zip'), '.. that stays inside is the same file');
});

test('Show in folder: refuses a link inside output/packs that leads out, and a link to a folder', async () => {
  const { root, folder, packs } = await workspaceWithPack();
  await writeFile(join(folder, 'elsewhere.txt'), 'x');
  await symlink(join(folder, 'elsewhere.txt'), join(packs, 'link.opendoc.zip'));
  assert.equal(await revealablePackPath(root, join(packs, 'link.opendoc.zip')), null);
  await mkdir(join(folder, 'other-dir'));
  await writeFile(join(folder, 'other-dir', 'p.opendoc.zip'), 'zip');
  await symlink(join(folder, 'other-dir'), join(packs, 'dir-link'));
  assert.equal(await revealablePackPath(root, join(packs, 'dir-link', 'p.opendoc.zip')), null);
});

test('Show in folder: refuses output/packs itself being a link out of the workspace', async () => {
  const folder = await scratch();
  const root = join(folder, 'workspace');
  await mkdir(join(root, 'output'), { recursive: true });
  const real = join(folder, 'somewhere-else');
  await mkdir(real);
  await writeFile(join(real, 'p.opendoc.zip'), 'zip');
  await symlink(real, join(root, 'output', 'packs'));
  assert.equal(await revealablePackPath(root, join(root, 'output', 'packs', 'p.opendoc.zip')), null);
  assert.equal(await revealablePackPath(root, join(real, 'p.opendoc.zip')), null);
});

test('Show in folder: refuses other folders of the workspace, another workspace\'s packs, the folder itself, and a missing file', async () => {
  const { root, folder, packs } = await workspaceWithPack();
  await mkdir(join(root, 'output', 'documents'), { recursive: true });
  await writeFile(join(root, 'output', 'documents', 'report.pdf'), 'pdf');
  await writeFile(join(root, 'package.json'), '{}');
  assert.equal(await revealablePackPath(root, join(root, 'output', 'documents', 'report.pdf')), null);
  assert.equal(await revealablePackPath(root, join(root, 'package.json')), null);
  assert.equal(await revealablePackPath(root, packs), null, 'the packs folder itself is not a pack');
  assert.equal(await revealablePackPath(root, join(packs, 'missing.opendoc.zip')), null);
  assert.equal(await revealablePackPath(root, '/etc/passwd'), null);
  assert.equal(await revealablePackPath(root, '/'), null);
  const second = join(folder, 'second');
  await mkdir(join(second, 'output', 'packs'), { recursive: true });
  await writeFile(join(second, 'output', 'packs', 'p.opendoc.zip'), 'zip');
  assert.equal(await revealablePackPath(root, join(second, 'output', 'packs', 'p.opendoc.zip')), null);
  // A folder whose name only starts like output/packs.
  await mkdir(join(root, 'output', 'packs-extra'), { recursive: true });
  await writeFile(join(root, 'output', 'packs-extra', 'p.opendoc.zip'), 'zip');
  assert.equal(await revealablePackPath(root, join(root, 'output', 'packs-extra', 'p.opendoc.zip')), null);
});

test('Show in folder: a workspace that does not exist refuses everything', async () => {
  const folder = await scratch();
  assert.equal(await revealablePackPath(join(folder, 'no-workspace'), join(folder, 'no-workspace', 'output', 'packs', 'p.opendoc.zip')), null);
});
