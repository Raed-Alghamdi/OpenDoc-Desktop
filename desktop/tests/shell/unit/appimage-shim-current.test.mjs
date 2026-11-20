// The AppImage agent command (resources/cli/opendoc-appimage.sh) and runtime/current: after an update swapped in at quit, the command
// makes the runtime copy of the new build, and it must point `current` (which the workspaces' node_modules go through) at that copy
// when it is newer than the one `current` names, atomically, and never at an older one. Real shim, fake AppImage and fake runtimes in
// a scratch folder (HOME and the XDG folders inside it); nothing is mounted, no Electron runs.
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { lstat, mkdir, readdir, readFile, readlink, realpath, symlink, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { makeRuntime, scratch } from '../support/workspace-fixtures.mjs';

const shim = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..', 'resources', 'cli', 'opendoc-appimage.sh');
const available = ['setpriv', 'sort', 'seq', 'cmp'].every(tool => spawnSync('sh', ['-c', `command -v ${tool}`]).status === 0);
const options = { skip: available ? false : 'setpriv, sort, seq and cmp are needed' };

/**
 * A home folder and an AppImage stand-in. `mountFor(version, build)` makes the unpacked app a mount would show: a fake
 * opendoc-desktop (the CLI "runs" and exits 0) and resources/runtime with that version and build.
 */
async function world() {
  const base = await scratch('shim-current');
  const home = join(base, 'home');
  const data = join(home, '.local', 'share', 'opendoc-desktop');
  await mkdir(data, { recursive: true });
  const appImage = join(base, 'opendoc-desktop.AppImage');
  await writeFile(appImage, '#!/bin/sh\nif [ "$1" = "--appimage-mount" ]; then echo "$FAKE_MOUNT"; exec sleep 3600; fi\nexit 3\n', { mode: 0o755 });
  const command = join(base, 'opendoc');
  await writeFile(command, (await readFile(shim, 'utf8')).replace('APPIMAGE=@APPIMAGE@', `APPIMAGE=${JSON.stringify(appImage)}`), { mode: 0o755 });
  const mountFor = async (version, build) => {
    const mount = join(base, `mount-${version}-${build}`);
    await mkdir(mount, { recursive: true });
    await writeFile(join(mount, 'opendoc-desktop'), '#!/bin/sh\nexit 0\n', { mode: 0o755 });
    await makeRuntime(join(mount, 'resources', 'runtime'), { runtimeVersion: version, build });
    return mount;
  };
  const environment = { PATH: process.env.PATH, HOME: home, XDG_DATA_HOME: join(home, '.local', 'share'), XDG_CONFIG_HOME: join(home, '.config'), XDG_CACHE_HOME: join(home, '.cache'), LANG: 'C.UTF-8' };
  /** Run the command as the AppImage of `version`-`build`. */
  const run = async (version, build, args = ['--version']) => {
    const result = spawnSync(command, args, { encoding: 'utf8', env: { ...environment, FAKE_MOUNT: await mountFor(version, build) }, timeout: 60_000 });
    assert.equal(result.status, 0, result.stderr);
  };
  const current = () => readlink(join(data, 'runtime', 'current')).catch(() => null);
  const copies = async () => (await readdir(join(data, 'runtime'))).filter(name => !name.startsWith('.') && name !== 'current').sort();
  return { base, data, run, current, copies };
}

test('the first run makes the copy and creates current', options, async () => {
  const w = await world();
  await w.run('0.6.1', 1);
  assert.equal(await w.current(), '0.6.1-1');
  assert.deepEqual(await w.copies(), ['0.6.1-1']);
  assert.equal(await realpath(join(w.data, 'runtime', 'current', 'node_modules')), await realpath(join(w.data, 'runtime', '0.6.1-1', 'node_modules')));
});

test('an update that changes the version (0.6.1 to 0.6.2) moves current to the new copy; the old copy stays', options, async () => {
  const w = await world();
  await w.run('0.6.1', 3);
  await w.run('0.6.2', 1);
  assert.equal(await w.current(), '0.6.2-1');
  assert.deepEqual(await w.copies(), ['0.6.1-3', '0.6.2-1'], 'the command removes nothing; the app prunes');
  assert.deepEqual((await readdir(join(w.data, 'runtime'))).filter(name => name.endsWith('.tmp') || name.startsWith('.tmp.')), [], 'no temporary link or folder is left');
});

test('a newer build of the same version moves current, and so does 0.6.10 after 0.6.9 (numbers, not text)', options, async () => {
  const w = await world();
  await w.run('0.6.1', 1);
  await w.run('0.6.1', 2);
  assert.equal(await w.current(), '0.6.1-2');
  await w.run('0.6.9', 1);
  await w.run('0.6.10', 1);
  assert.equal(await w.current(), '0.6.10-1');
});

test('it never switches to an older copy: an older version, an older build, or the same build again', options, async () => {
  const w = await world();
  await w.run('0.6.2', 5);
  await w.run('0.6.1', 9);
  assert.equal(await w.current(), '0.6.2-5', 'an older version with a bigger build is still older');
  await w.run('0.6.2', 3);
  assert.equal(await w.current(), '0.6.2-5');
  const before = await lstat(join(w.data, 'runtime', 'current'));
  await w.run('0.6.2', 5);
  assert.equal(await w.current(), '0.6.2-5');
  assert.equal((await lstat(join(w.data, 'runtime', 'current'))).ino, before.ino, 'an unchanged link is not rewritten');
  assert.deepEqual(await w.copies(), ['0.6.1-9', '0.6.2-3', '0.6.2-5'], 'the older copies were still made for the command to run');
});

test('a release is newer than its own pre-release, and not the other way round', options, async () => {
  const w = await world();
  await w.run('0.7.0-rc.1', 1);
  assert.equal(await w.current(), '0.7.0-rc.1-1');
  await w.run('0.7.0', 1);
  assert.equal(await w.current(), '0.7.0-1');
  await w.run('0.7.0-rc.2', 4);
  assert.equal(await w.current(), '0.7.0-1');
});

test('current in a state the command cannot read (a link to nothing, a link to a folder without a runtime) is replaced; a real folder is left alone', options, async () => {
  const w = await world();
  await mkdir(join(w.data, 'runtime'), { recursive: true });
  await symlink('gone', join(w.data, 'runtime', 'current'), 'dir');
  await w.run('0.6.1', 1);
  assert.equal(await w.current(), '0.6.1-1');

  const hollow = await world();
  await mkdir(join(hollow.data, 'runtime', 'empty'), { recursive: true });
  await symlink('empty', join(hollow.data, 'runtime', 'current'), 'dir');
  await hollow.run('0.6.1', 1);
  assert.equal(await hollow.current(), '0.6.1-1');

  const odd = await world();
  await mkdir(join(odd.data, 'runtime', 'current'), { recursive: true });
  await writeFile(join(odd.data, 'runtime', 'current', 'mine.txt'), 'mine');
  await odd.run('0.6.1', 1);
  assert.equal((await lstat(join(odd.data, 'runtime', 'current'))).isDirectory(), true);
  assert.equal(await readFile(join(odd.data, 'runtime', 'current', 'mine.txt'), 'utf8'), 'mine');
  assert.deepEqual(await odd.copies(), ['0.6.1-1'], 'the command still ran');
});

test('while the app holds the current copy (a process runs from it) the switch happens and nothing is removed under it', options, async () => {
  const w = await world();
  await w.run('0.6.1', 3);
  const held = join(w.data, 'runtime', '0.6.1-3');
  // A stand-in for the running app: a process whose command line carries the copy's path, as the real service host's does.
  const app = spawn('/bin/sh', ['-c', 'exec sleep 3600', 'opendoc-desktop', held], { stdio: 'ignore' });
  try {
    await w.run('0.6.2', 1);
    assert.equal(await w.current(), '0.6.2-1');
    assert.equal((await lstat(join(held, 'node_modules', 'opendoc', 'bin', 'opendoc.mjs'))).isFile(), true, 'the held copy is intact');
    assert.equal(app.exitCode, null);
  } finally { app.kill(); }
});

test('the switch is atomic: a reader of current never finds it missing while it moves', options, async () => {
  const w = await world();
  await w.run('0.6.1', 1);
  await w.run('0.6.2', 1); // the copy exists now; later runs only switch
  await w.run('0.6.3', 1);
  // Move current back and forth through the command while a reader hammers it.
  let missing = 0;
  let reads = 0;
  let going = true;
  const reader = (async () => {
    while (going) {
      reads++;
      try { await realpath(join(w.data, 'runtime', 'current', 'node_modules', 'opendoc', 'bin', 'opendoc.mjs')); } catch { missing++; }
      await new Promise(resolve => setImmediate(resolve));
    }
  })();
  for (const [version, build] of [['0.6.4', 1], ['0.6.5', 1], ['0.6.6', 1]]) await w.run(version, build);
  going = false;
  await reader;
  assert.equal(await w.current(), '0.6.6-1');
  assert.ok(reads > 10, `the reader ran (${reads} reads)`);
  assert.equal(missing, 0, 'current was never absent');
});
