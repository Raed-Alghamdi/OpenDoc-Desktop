import assert from 'node:assert/strict';
import { cp, lstat, mkdir, readFile, readdir, readlink, realpath, symlink, utimes, writeFile } from 'node:fs/promises';
import { spawn } from 'node:child_process';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { test } from 'node:test';
import { inUse, prepareAppImageRuntime, pruneCopies } from '../../../src/main/workspace/appimage-runtime.mjs';
import { dataDirectory } from '../../../src/main/workspace/paths.mjs';
import { readOnlySupported, readRuntimeInfo, withoutComments } from '../../../src/main/workspace/runtime-info.mjs';
import { ensureModulesLink, inspectModules } from '../../../src/main/workspace/links.mjs';
import { makeRuntime, scratch } from '../support/workspace-fixtures.mjs';

async function fixture(options = {}) {
  const base = await scratch('appimage');
  const source = await makeRuntime(join(base, 'mount', 'resources', 'runtime'), { runtimeVersion: '0.6.1', ...options });
  return { base, source, dataDir: join(base, 'data') };
}
const names = async dataDir => (await readdir(join(dataDir, 'runtime'))).sort();

test('no copy yet: the runtime is copied to <data>/runtime/<version>-<build> and current points at it', async () => {
  const { source, dataDir } = await fixture();
  const result = await prepareAppImageRuntime({ source, dataDir });
  assert.equal(result.copied, true);
  assert.equal(result.runtime, join(dataDir, 'runtime', '0.6.1-7'));
  assert.equal(result.modules, join(dataDir, 'runtime', 'current', 'node_modules'));
  assert.equal(await readFile(join(result.runtime, 'node_modules', 'opendoc', 'bin', 'opendoc.mjs'), 'utf8'), '// the CLI\n');
  assert.equal(await readlink(join(dataDir, 'runtime', 'current')), '0.6.1-7');
  assert.equal(await realpath(result.modules), await realpath(join(result.runtime, 'node_modules')));
  assert.deepEqual(await names(dataDir), ['0.6.1-7', 'current']);
});

test('symlinks inside the runtime are copied as links, not followed', async () => {
  const { source, dataDir } = await fixture();
  await symlink('opendoc', join(source, 'node_modules', 'alias'), 'dir');
  const { runtime } = await prepareAppImageRuntime({ source, dataDir });
  assert.equal(await readlink(join(runtime, 'node_modules', 'alias')), 'opendoc');
});

test('a copy of this build that is already there is not made again (the agent command may have made it)', async () => {
  const { source, dataDir } = await fixture();
  await prepareAppImageRuntime({ source, dataDir });
  const before = await lstat(join(dataDir, 'runtime', '0.6.1-7'));
  let copies = 0;
  const result = await prepareAppImageRuntime({ source, dataDir, copy: async () => { copies += 1; } });
  assert.equal(result.copied, false);
  assert.equal(copies, 0);
  assert.equal((await lstat(join(dataDir, 'runtime', '0.6.1-7'))).ino, before.ino);
});

test('a copy the agent command made first (the same name, the same build-info.json) is used, and current is set', async () => {
  const { source, dataDir } = await fixture();
  const made = join(dataDir, 'runtime', '0.6.1-7');
  await mkdir(made, { recursive: true });
  await makeRuntime(made, { runtimeVersion: '0.6.1' });
  const result = await prepareAppImageRuntime({ source, dataDir, copy: async () => assert.fail('must not copy over a good copy') });
  assert.equal(result.copied, false);
  assert.equal(await readlink(join(dataDir, 'runtime', 'current')), '0.6.1-7');
});

test('a copy with another build-info.json (a rebuild of the same version) is replaced', async () => {
  const { source, dataDir } = await fixture();
  await prepareAppImageRuntime({ source, dataDir });
  await writeFile(join(source, 'build-info.json'), JSON.stringify({ build: 7, commit: 'b'.repeat(40), builtAt: '2026-02-02T00:00:00.000Z' }));
  const result = await prepareAppImageRuntime({ source, dataDir });
  assert.equal(result.copied, true);
  assert.equal(JSON.parse(await readFile(join(result.runtime, 'build-info.json'), 'utf8')).commit, 'b'.repeat(40));
});

test('another build: its copy is made, current moves, and the old copy is pruned', async () => {
  const { source, dataDir, base } = await fixture();
  await prepareAppImageRuntime({ source, dataDir });
  const next = await makeRuntime(join(base, 'mount2', 'resources', 'runtime'), { runtimeVersion: '0.6.2', build: 9 });
  const result = await prepareAppImageRuntime({ source: next, dataDir });
  assert.equal(result.runtime, join(dataDir, 'runtime', '0.6.2-9'));
  assert.deepEqual(result.pruned, ['0.6.1-7']);
  assert.deepEqual(await names(dataDir), ['0.6.2-9', 'current']);
  assert.equal(await readlink(join(dataDir, 'runtime', 'current')), '0.6.2-9');
});

test('workspace links survive pruning: they name current, which always reaches a copy that exists', async () => {
  const { source, dataDir, base } = await fixture();
  const first = await prepareAppImageRuntime({ source, dataDir });
  const root = join(base, 'ws');
  await mkdir(root);
  const wanted = { path: first.modules };
  await ensureModulesLink(root, wanted, { exact: true });
  assert.equal((await inspectModules(root, wanted, { exact: true })).state, 'correct');
  const next = await makeRuntime(join(base, 'mount2', 'resources', 'runtime'), { runtimeVersion: '0.6.2', build: 9 });
  const second = await prepareAppImageRuntime({ source: next, dataDir });
  assert.equal(second.modules, first.modules, 'the link target does not change between builds');
  assert.equal((await inspectModules(root, wanted, { exact: true })).state, 'correct', 'the link is still correct after the old copy was pruned');
  assert.equal(await realpath(join(root, 'node_modules')), await realpath(join(second.runtime, 'node_modules')));
  await readFile(join(root, 'node_modules', 'opendoc', 'package.json'));
});

test('a failed copy (disk full) is reported, leaves no half copy, and keeps the working one and current', async () => {
  const { source, dataDir, base } = await fixture();
  await prepareAppImageRuntime({ source, dataDir });
  const next = await makeRuntime(join(base, 'mount2', 'resources', 'runtime'), { runtimeVersion: '0.6.2', build: 9 });
  const full = async (from, to) => { await writeFile(join(to, 'partial'), 'half'); throw Object.assign(new Error('ENOSPC: no space left on device'), { code: 'ENOSPC' }); };
  await assert.rejects(prepareAppImageRuntime({ source: next, dataDir, copy: full }), error => /could not be copied to .*0\.6\.2-9/.test(error.message) && /no space left/.test(error.message));
  assert.deepEqual(await names(dataDir), ['0.6.1-7', 'current'], 'no .tmp folder and no 0.6.2-9');
  assert.equal(await readlink(join(dataDir, 'runtime', 'current')), '0.6.1-7');
});

test('a copy that finishes incomplete is not used', async () => {
  const { source, dataDir } = await fixture();
  await assert.rejects(prepareAppImageRuntime({ source, dataDir, copy: async () => {} }), /incomplete/);
  assert.deepEqual(await names(dataDir), []);
});

test('a runtime with no build-info.json or no version cannot be named, and is refused', async () => {
  const { source, dataDir } = await fixture();
  await writeFile(join(source, 'build-info.json'), '{}');
  await assert.rejects(prepareAppImageRuntime({ source, dataDir }), /no build-info\.json/);
  const other = await fixture({ runtimeVersion: undefined });
  await writeFile(join(other.source, 'node_modules', 'opendoc', 'package.json'), '{}');
  await assert.rejects(prepareAppImageRuntime({ source: other.source, dataDir: other.dataDir }), /does not say its version/);
});

test('with no version in the runtime package.json the OpenDoc package version names the copy', async () => {
  const { source, dataDir } = await fixture({ runtimeVersion: undefined });
  const result = await prepareAppImageRuntime({ source, dataDir });
  assert.equal(result.runtime, join(dataDir, 'runtime', '0.6.1-7'));
});

test('pruning removes other builds and old leftovers, and nothing else: not a fresh .tmp folder, a folder the user put there, or a copy in use', async () => {
  const { dataDir } = await fixture();
  const directory = join(dataDir, 'runtime');
  const now = Date.now();
  const copy = async name => { await mkdir(join(directory, name), { recursive: true }); await writeFile(join(directory, name, 'build-info.json'), '{"build":1}'); };
  for (const name of ['0.5.0-3', '0.4.0-2', '0.6.1-7']) await copy(name);
  for (const name of ['.tmp.fresh', '.tmp.old', 'my-notes', '0.5.0', 'not-a-copy-9']) await mkdir(join(directory, name), { recursive: true });
  await writeFile(join(directory, 'readme.txt'), 'mine');
  await writeFile(join(directory, 'my-notes', 'important.txt'), 'mine');
  const old = new Date(now - 3_600_000);
  await utimes(join(directory, '.tmp.old'), old, old);
  const removed = await pruneCopies(directory, '0.6.1-7', now, async path => path.endsWith('0.4.0-2'));
  assert.deepEqual(removed.sort(), ['.tmp.old', '0.5.0-3']);
  assert.deepEqual(await names(dataDir), ['.tmp.fresh', '0.4.0-2', '0.5.0', '0.6.1-7', 'my-notes', 'not-a-copy-9', 'readme.txt']);
  assert.equal(await readFile(join(directory, 'my-notes', 'important.txt'), 'utf8'), 'mine');
});

test('a copy that a running process has in its command line is never pruned (the real check reads /proc)', { skip: process.platform !== 'linux' }, async () => {
  const { dataDir } = await fixture();
  const directory = join(dataDir, 'runtime');
  await mkdir(join(directory, '0.5.0-3'), { recursive: true });
  await writeFile(join(directory, '0.5.0-3', 'build-info.json'), '{}');
  assert.equal(await inUse(join(directory, '0.5.0-3')), false);
  const child = spawn(process.execPath, ['-e', 'setTimeout(() => {}, 30000)', join(directory, '0.5.0-3', 'node_modules', 'opendoc', 'bin', 'opendoc.mjs')], { stdio: 'ignore' });
  try {
    await new Promise(accept => setTimeout(accept, 200));
    assert.equal(await inUse(join(directory, '0.5.0-3')), true);
    assert.deepEqual(await pruneCopies(directory, '0.6.1-7'), []);
    assert.deepEqual(await names(dataDir), ['0.5.0-3']);
  } finally { child.kill('SIGKILL'); }
  await new Promise(accept => child.once('exit', accept));
  assert.deepEqual(await pruneCopies(directory, '0.6.1-7'), ['0.5.0-3']);
});

test('a copy whose path has a space or a non-ASCII character is found in a file:// URL command line (as the service host carries it)', { skip: process.platform !== 'linux' }, async () => {
  const { dataDir } = await fixture();
  const directory = join(dataDir, 'my data \u00e9\u0627', 'runtime');
  await mkdir(join(directory, '0.5.0-3'), { recursive: true });
  await writeFile(join(directory, '0.5.0-3', 'build-info.json'), '{}');
  const url = pathToFileURL(join(directory, '0.5.0-3', 'node_modules', 'opendoc', 'src', 'server', 'service.ts')).href;
  assert.match(url, /%20/);
  const child = spawn(process.execPath, ['-e', 'setTimeout(() => {}, 30000)', url], { stdio: 'ignore' });
  try {
    await new Promise(accept => setTimeout(accept, 200));
    assert.equal(await inUse(join(directory, '0.5.0-3')), true);
    assert.deepEqual(await pruneCopies(directory, '0.6.1-7'), []);
  } finally { child.kill('SIGKILL'); }
  await new Promise(accept => child.once('exit', accept));
  assert.equal(await inUse(join(directory, '0.5.0-3')), false);
});

test('another process that finishes the same copy first wins: its complete copy is kept, never removed, and ours is dropped', async () => {
  const { source, dataDir } = await fixture();
  const target = join(dataDir, 'runtime', '0.6.1-7');
  let before;
  const copy = async (from, to) => {
    await cp(from, to, { recursive: true, verbatimSymlinks: true });
    // While we were copying, the agent command finished its own copy.
    await mkdir(target, { recursive: true });
    await cp(from, target, { recursive: true, verbatimSymlinks: true });
    await writeFile(join(target, 'marker-of-the-other-copy'), 'theirs');
    before = (await lstat(target)).ino;
  };
  const result = await prepareAppImageRuntime({ source, dataDir, copy });
  assert.equal(result.copied, false);
  assert.equal((await lstat(target)).ino, before);
  assert.equal(await readFile(join(target, 'marker-of-the-other-copy'), 'utf8'), 'theirs');
  assert.deepEqual(await names(dataDir), ['0.6.1-7', 'current']);
});

test('the data folder: XDG_DATA_HOME when absolute, else ~/.local/share; Application Support on macOS', () => {
  assert.equal(dataDirectory({ env: { XDG_DATA_HOME: '/x/data' }, platform: 'linux', home: '/h' }), '/x/data/opendoc-desktop');
  assert.equal(dataDirectory({ env: {}, platform: 'linux', home: '/h' }), '/h/.local/share/opendoc-desktop');
  assert.equal(dataDirectory({ env: { XDG_DATA_HOME: 'relative' }, platform: 'linux', home: '/h' }), '/h/.local/share/opendoc-desktop');
  assert.equal(dataDirectory({ env: {}, platform: 'darwin', home: '/Users/u' }), '/Users/u/Library/Application Support/opendoc-desktop');
});

test('runtime info is read from the runtime files; a runtime that does not say its format is refused', async () => {
  const base = await scratch('info');
  const runtime = await makeRuntime(join(base, 'rt'), { version: '0.6.1', format: 1 });
  assert.deepEqual(await readRuntimeInfo(runtime), { ok: true, version: '0.6.1', edition: 'normal', workspaceFormat: 1 });
  assert.equal((await readRuntimeInfo(await makeRuntime(join(base, 'rt2'), { format: 2 }))).workspaceFormat, 2);
  await writeFile(join(runtime, 'node_modules', 'opendoc', 'src', 'cli', 'workspace.ts'), '// nothing\n');
  assert.match((await readRuntimeInfo(runtime)).message, /does not say which workspace format/);
  assert.equal((await readRuntimeInfo(join(base, 'missing'))).ok, false);
  const bad = await makeRuntime(join(base, 'rt3'), { version: '0.6' });
  assert.equal((await readRuntimeInfo(bad)).ok, false);
});

test('read-only support is read from the service source (U4 marks readOnlySupported: true)', async () => {
  const base = await scratch('support');
  assert.equal(await readOnlySupported(await makeRuntime(join(base, 'a'))), false);
  assert.equal(await readOnlySupported(await makeRuntime(join(base, 'b'), { readOnly: true })), true);
  assert.equal(await readOnlySupported(join(base, 'missing')), false);
});

test('the read-only probe ignores comments and types: only the property of an object literal counts', async () => {
  const base = await scratch('probe');
  const write = async (name, text) => { const runtime = await makeRuntime(join(base, name)); await writeFile(join(runtime, 'node_modules', 'opendoc', 'src', 'server', 'service.ts'), text); return runtime; };
  assert.equal(await readOnlySupported(await write('comment', '// readOnlySupported: true,\n/* readOnlySupported: true } */\nexport const x = 1;\n')), false);
  assert.equal(await readOnlySupported(await write('type', 'export interface Prepared { readOnlySupported: true; service: unknown }\n')), false);
  assert.equal(await readOnlySupported(await write('false', 'return { readOnlySupported: false, service };\n')), false);
  assert.equal(await readOnlySupported(await write('literal', 'return { readOnlySupported: true, service, start };\n')), true);
  assert.equal(await readOnlySupported(await write('last', 'return { service, readOnlySupported: true };\n')), true);
  assert.equal(withoutComments("const a = 'http://x'; // gone\nconst b = 2; /* gone */"), "const a = 'http://x';  \nconst b = 2;  ");
});
