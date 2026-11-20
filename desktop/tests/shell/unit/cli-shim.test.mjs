// The agent command: the AppImage writer, the PATH check, the macOS installer and the Linux launcher.
// Every file goes into a temporary folder: nothing here touches a real ~/.local/bin or a real PATH folder.
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { chmod, copyFile, lstat, mkdir, mkdtemp, readFile, readdir, realpath, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import {
  commandOnPath, directoryOnPath, installAppImageShim, installMacCommand, macInstallFolder, pathNotice, readMacShimTarget,
  readShimTarget, refreshMacCommand, renderAppImageShim, renderMacShim, shellQuote, writeShim, shimMarker,
} from '../../../src/main/cli-shim.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const cliFolder = join(here, '../../../resources/cli');
// The real path: on macOS the temporary folder is under /var, a link to /private/var, and the launchers resolve links.
const scratch = async () => realpath(await mkdtemp(join(tmpdir(), 'opendoc-shim-')));
const isRoot = process.getuid?.() === 0;
const template = `#!/bin/bash\n# ${shimMarker} (test)\nAPPIMAGE=@APPIMAGE@\necho "$APPIMAGE"\n`;
const awkward = "/tmp/it's a $dir/\"quoted\"/`tick`/My App.AppImage";

test('a quoted path survives the shell and reads back unchanged', () => {
  const quoted = shellQuote(awkward);
  const result = spawnSync('/bin/sh', ['-c', `printf %s ${quoted}`], { encoding: 'utf8' });
  assert.equal(result.stdout, awkward);
  assert.throws(() => shellQuote('/tmp/a\nb'), /line break/);
});

test('the AppImage command template is filled in and the target reads back', () => {
  const content = renderAppImageShim(template, awkward);
  assert.equal(readShimTarget(content), awkward);
  const run = spawnSync('/bin/bash', ['-c', content], { encoding: 'utf8' });
  assert.equal(run.stdout.trim(), awkward);
  assert.throws(() => renderAppImageShim('no placeholder', awkward), /placeholder/);
  // The template that ships has the placeholder and the marker.
  return readFile(join(cliFolder, 'opendoc-appimage.sh'), 'utf8').then(shipped => {
    assert.ok(shipped.includes('APPIMAGE=@APPIMAGE@') && shipped.includes(shimMarker));
    assert.equal(readShimTarget(renderAppImageShim(shipped, awkward)), awkward);
  });
});

test('writeShim creates an executable file, leaves identical content alone, and replaces changed content', async () => {
  const folder = join(await scratch(), 'new', 'bin');
  const file = join(folder, 'opendoc');
  const first = await writeShim({ file, content: `# ${shimMarker}\none\n` });
  assert.equal(first.action, 'created');
  assert.equal((await lstat(file)).mode & 0o777, 0o755);
  assert.equal((await writeShim({ file, content: `# ${shimMarker}\none\n` })).action, 'unchanged');
  assert.equal((await writeShim({ file, content: `# ${shimMarker}\ntwo\n` })).action, 'updated');
  assert.equal(await readFile(file, 'utf8'), `# ${shimMarker}\ntwo\n`);
  assert.deepEqual(await readdir(folder), ['opendoc'], 'no temporary file is left behind');
});

test('writeShim never replaces a file or a link that is not ours', async () => {
  const folder = await scratch();
  const own = join(folder, 'opendoc');
  await writeFile(own, '#!/bin/sh\necho somebody else\n', { mode: 0o755 });
  assert.equal((await writeShim({ file: own, content: `# ${shimMarker}\n` })).action, 'foreign');
  assert.equal(await readFile(own, 'utf8'), '#!/bin/sh\necho somebody else\n');
  const link = join(folder, 'linked');
  await symlink(own, link);
  assert.equal((await writeShim({ file: link, content: `# ${shimMarker}\n` })).action, 'foreign');
  assert.ok((await lstat(link)).isSymbolicLink());
  const directory = join(folder, 'dir');
  await mkdir(directory);
  assert.equal((await writeShim({ file: directory, content: `# ${shimMarker}\n` })).action, 'foreign');
});

test('a write that fails leaves the old command working and no temporary file', { skip: isRoot }, async () => {
  const folder = await scratch();
  const file = join(folder, 'opendoc');
  await writeShim({ file, content: `# ${shimMarker}\nold\n` });
  await chmod(folder, 0o555);
  try {
    await assert.rejects(writeShim({ file, content: `# ${shimMarker}\nnew\n` }), { code: 'EACCES' });
  } finally { await chmod(folder, 0o755); }
  assert.equal(await readFile(file, 'utf8'), `# ${shimMarker}\nold\n`);
  assert.deepEqual(await readdir(folder), ['opendoc']);
});

test('a reader never sees half a command while it is rewritten', async () => {
  const folder = await scratch();
  const file = join(folder, 'opendoc');
  const bodies = ['A', 'B'].map(letter => `# ${shimMarker}\n${letter.repeat(200_000)}\n`);
  await writeShim({ file, content: bodies[0] });
  let writing = true;
  const writer = (async () => { for (let i = 0; i < 60; i++) await writeShim({ file, content: bodies[i % 2 === 0 ? 1 : 0] }); writing = false; })();
  let reads = 0;
  while (writing) {
    const seen = await readFile(file, 'utf8');
    reads++;
    assert.ok(bodies.includes(seen), 'a partial file was visible');
  }
  await writer;
  assert.ok(reads > 0);
});

test('installAppImageShim writes ~/.local/bin/opendoc and follows the AppImage when it moves', async () => {
  const home = await scratch();
  const old = join(home, 'Downloads', 'opendoc-desktop.AppImage');
  const moved = join(home, "Apps and 'things'", 'opendoc-desktop.AppImage');
  const first = await installAppImageShim({ template, appImage: old, home });
  assert.deepEqual([first.action, first.repointed, first.path], ['created', false, join(home, '.local', 'bin', 'opendoc')]);
  assert.equal(readShimTarget(await readFile(first.path, 'utf8')), old);
  assert.equal((await installAppImageShim({ template, appImage: old, home })).action, 'unchanged');
  const second = await installAppImageShim({ template, appImage: moved, home });
  assert.deepEqual([second.action, second.repointed], ['updated', true]);
  assert.equal(readShimTarget(await readFile(first.path, 'utf8')), moved);
  // A command somebody else put there stays.
  await writeFile(first.path, '#!/bin/sh\necho mine\n');
  assert.equal((await installAppImageShim({ template, appImage: moved, home })).action, 'foreign');
  assert.equal(await readFile(first.path, 'utf8'), '#!/bin/sh\necho mine\n');
});

test('directoryOnPath compares resolved folders, through links, and ignores empty and relative entries', async () => {
  const base = await scratch();
  const bin = join(base, 'bin');
  await mkdir(bin);
  await symlink(bin, join(base, 'alias'));
  assert.equal(await directoryOnPath(bin, `/usr/bin:${bin}`), true);
  assert.equal(await directoryOnPath(bin, `/usr/bin:${bin}/`), true);
  assert.equal(await directoryOnPath(bin, `/usr/bin:${join(base, 'alias')}`), true);
  assert.equal(await directoryOnPath(bin, `/usr/bin::bin:.:${join(base, 'nope')}`), false);
  assert.equal(await directoryOnPath(bin, undefined), false);
});

/** A stand-in for the user's shell: a banner, then the PATH it was told to have for a login or an interactive run. */
async function stubShell(base, { login, interactive, delay = 0 }) {
  const file = join(base, 'stub-shell');
  await writeFile(file, `#!/bin/sh
echo "Welcome to the stub shell"
[ ${delay} -gt 0 ] && sleep ${delay}
mode=$1
shift
if [ "$mode" = "-l" ]; then PATH='${login}'; else PATH='${interactive}'; fi
exec /bin/sh "$@"
`, { mode: 0o755 });
  return file;
}

test('commandOnPath asks the login and the interactive shell, and the app\'s own PATH first', async () => {
  const base = await scratch();
  const directory = join(base, 'bin');
  await mkdir(directory);
  const env = { PATH: '/usr/bin:/bin' };
  assert.deepEqual(await commandOnPath({ directory, env: { PATH: directory }, shell: '/nonexistent' }), { onPath: true, shell: '/nonexistent', checked: true });
  const loginOnly = await stubShell(base, { login: `/usr/bin:${directory}`, interactive: '/usr/bin' });
  assert.equal((await commandOnPath({ directory, env, shell: loginOnly })).onPath, true);
  const interactiveOnly = await stubShell(base, { login: '/usr/bin', interactive: `${directory}:/usr/bin` });
  assert.equal((await commandOnPath({ directory, env, shell: interactiveOnly })).onPath, true);
  const neither = await stubShell(base, { login: '/usr/bin', interactive: '/usr/bin' });
  assert.deepEqual(await commandOnPath({ directory, env, shell: neither }), { onPath: false, shell: neither, checked: true });
});

test('commandOnPath says "not checked" when no shell answers, so nobody is told something unproven', async () => {
  const base = await scratch();
  const directory = join(base, 'bin');
  const env = { PATH: '/usr/bin:/bin' };
  assert.equal((await commandOnPath({ directory, env, shell: join(base, 'no-such-shell') })).checked, false);
  const slow = await stubShell(base, { login: '/usr/bin', interactive: '/usr/bin', delay: 5 });
  const started = Date.now();
  const answer = await commandOnPath({ directory, env, shell: slow, timeout: 400 });
  assert.equal(answer.checked, false);
  assert.ok(Date.now() - started < 4000, 'the check gave up at its timeout');
});

test('the PATH notice names the folder and the line to add for the user\'s shell', () => {
  const home = '/home/someone';
  const directory = '/home/someone/.local/bin';
  const bash = pathNotice({ directory, home, shell: '/bin/bash' });
  assert.match(bash.message, /~\/\.local\/bin/);
  assert.match(bash.detail, /~\/\.bashrc/);
  assert.match(bash.detail, /export PATH="\$HOME\/\.local\/bin:\$PATH"/);
  assert.match(pathNotice({ directory, home, shell: '/usr/bin/fish' }).detail, /fish_add_path ~\/\.local\/bin/);
  assert.match(pathNotice({ directory: '/usr/local/bin', home, shell: '/bin/zsh' }).detail, /~\/\.zshrc[\s\S]*export PATH="\/usr\/local\/bin:\$PATH"/);
});

// ---------- macOS ----------

async function fakeApp(base) {
  const executable = join(base, 'Applications', 'opendoc-desktop.app', 'Contents', 'MacOS', 'opendoc-desktop');
  const runtime = join(base, 'Applications', 'opendoc-desktop.app', 'Contents', 'Resources', 'runtime');
  await mkdir(dirname(executable), { recursive: true });
  await mkdir(join(runtime, 'node_modules', 'opendoc', 'bin'), { recursive: true });
  await writeFile(executable, '#!/bin/sh\nprintf "RUN_AS_NODE=%s\\n" "$ELECTRON_RUN_AS_NODE"\nprintf "%s\\n" "$@"\n', { mode: 0o755 });
  await writeFile(join(runtime, 'node_modules', 'opendoc', 'bin', 'opendoc.mjs'), '');
  return { executable, runtime };
}

test('macInstallFolder prefers a writable /usr/local/bin and otherwise makes ~/.local/bin', async () => {
  const base = await scratch();
  const home = join(base, 'home');
  await mkdir(home);
  const usable = join(base, 'usr-local-bin');
  await mkdir(usable);
  assert.equal(await macInstallFolder({ home, candidates: [usable] }), usable);
  assert.equal(await macInstallFolder({ home, candidates: [join(base, 'missing')] }), join(home, '.local', 'bin'));
  if (!isRoot) {
    const locked = join(base, 'locked');
    await mkdir(locked);
    await chmod(locked, 0o555);
    assert.equal(await macInstallFolder({ home, candidates: [locked] }), join(home, '.local', 'bin'));
    const stuck = join(base, 'stuck-home');
    await mkdir(stuck);
    await chmod(stuck, 0o555);
    try { assert.equal(await macInstallFolder({ home: stuck, candidates: [join(base, 'missing')] }), null); } finally { await chmod(stuck, 0o755); await chmod(locked, 0o755); }
  }
});

test('the macOS command runs the app as Node on the app\'s runtime, passes arguments through, and explains a moved app', async () => {
  const base = await scratch();
  const app = await fakeApp(base);
  const folder = join(base, 'bin');
  await mkdir(folder);
  const home = join(base, 'home');
  const result = await installMacCommand({ ...app, home, candidates: [folder] });
  assert.deepEqual([result.ok, result.action, result.path], [true, 'created', join(folder, 'opendoc')]);
  assert.equal(readMacShimTarget(await readFile(result.path, 'utf8')), app.executable);
  const run = spawnSync(result.path, ['review', 'a b', "it's", '--json'], { encoding: 'utf8' });
  assert.equal(run.status, 0);
  assert.deepEqual(run.stdout.trim().split('\n'), ['RUN_AS_NODE=1', join(app.runtime, 'node_modules/opendoc/bin/opendoc.mjs'), 'review', 'a b', "it's", '--json']);
  assert.equal((await installMacCommand({ ...app, home, candidates: [folder] })).action, 'unchanged');
  // The app moved: the command says so instead of failing in a confusing way.
  const moved = renderMacShim({ executable: join(base, 'gone', 'opendoc-desktop'), runtime: app.runtime });
  await writeFile(join(base, 'moved-command'), moved, { mode: 0o755 });
  const lost = spawnSync(join(base, 'moved-command'), ['--version'], { encoding: 'utf8' });
  assert.equal(lost.status, 127);
  assert.match(lost.stderr, /no longer at .*gone\/opendoc-desktop.*Install Command-Line Tool again/);
});

test('the macOS installer refuses a command that is not ours, a translocated app, and a machine with no writable folder', async () => {
  const base = await scratch();
  const app = await fakeApp(base);
  const folder = join(base, 'bin');
  await mkdir(folder);
  await writeFile(join(folder, 'opendoc'), '#!/bin/sh\necho homebrew\n', { mode: 0o755 });
  const foreign = await installMacCommand({ ...app, home: join(base, 'home'), candidates: [folder] });
  assert.deepEqual([foreign.ok, foreign.reason], [false, 'foreign']);
  assert.equal(await readFile(join(folder, 'opendoc'), 'utf8'), '#!/bin/sh\necho homebrew\n');
  const translocated = await installMacCommand({ executable: '/private/var/folders/x/AppTranslocation/ABC/d/opendoc-desktop.app/Contents/MacOS/opendoc-desktop', runtime: app.runtime, home: base, candidates: [folder] });
  assert.deepEqual([translocated.ok, translocated.reason], [false, 'translocated']);
  assert.match(translocated.message, /Applications/);
  if (!isRoot) {
    const stuck = join(base, 'stuck');
    await mkdir(stuck);
    await chmod(stuck, 0o555);
    try {
      const none = await installMacCommand({ ...app, home: stuck, candidates: [join(base, 'missing')] });
      assert.deepEqual([none.ok, none.reason], [false, 'no-folder']);
      assert.match(none.message, /administrator/);
    } finally { await chmod(stuck, 0o755); }
  }
});

test('an installed macOS command is kept current when the app moves, and nothing is created when none was installed', async () => {
  const base = await scratch();
  const app = await fakeApp(base);
  const folder = join(base, 'bin');
  const home = join(base, 'home');
  await mkdir(folder);
  assert.equal((await refreshMacCommand({ ...app, home, candidates: [folder] })).action, 'none');
  await assert.rejects(lstat(join(folder, 'opendoc')), { code: 'ENOENT' });
  await installMacCommand({ ...app, home, candidates: [folder] });
  const next = { executable: join(base, 'Moved', 'opendoc-desktop'), runtime: join(base, 'Moved', 'runtime') };
  assert.equal((await refreshMacCommand({ ...next, home, candidates: [folder] })).action, 'updated');
  assert.equal(readMacShimTarget(await readFile(join(folder, 'opendoc'), 'utf8')), next.executable);
});

// ---------- the Linux packages' launcher ----------

async function fakeLinuxApp(base) {
  const app = join(base, 'opt', 'opendoc-desktop');
  await mkdir(join(app, 'resources', 'cli'), { recursive: true });
  await mkdir(join(app, 'resources', 'runtime', 'node_modules', 'opendoc', 'bin'), { recursive: true });
  await writeFile(join(app, 'opendoc-desktop'), '#!/bin/sh\nprintf "RUN_AS_NODE=%s\\n" "$ELECTRON_RUN_AS_NODE"\nprintf "%s\\n" "$@"\nexit "${FAKE_EXIT:-0}"\n', { mode: 0o755 });
  await writeFile(join(app, 'resources', 'runtime', 'node_modules', 'opendoc', 'bin', 'opendoc.mjs'), '');
  await copyFile(join(cliFolder, 'opendoc'), join(app, 'resources', 'cli', 'opendoc'));
  await chmod(join(app, 'resources', 'cli', 'opendoc'), 0o755);
  return app;
}
const launcherEnvironment = extra => ({ PATH: '/usr/bin:/bin', ...extra });

test('the Linux launcher runs the bundled CLI as Node, passes arguments and the exit code through, and is found through a link', async () => {
  const base = await scratch();
  const app = await fakeLinuxApp(base);
  const cli = join(app, 'resources', 'runtime', 'node_modules', 'opendoc', 'bin', 'opendoc.mjs');
  const direct = spawnSync(join(app, 'resources', 'cli', 'opendoc'), ['comments', 'list', 'a b', "it's", '$HOME', ''], { encoding: 'utf8', env: launcherEnvironment({ FAKE_EXIT: '3' }) });
  assert.equal(direct.status, 3);
  assert.deepEqual(direct.stdout.split('\n').slice(0, -1), ['RUN_AS_NODE=1', cli, 'comments', 'list', 'a b', "it's", '$HOME', '']);
  // /usr/bin/opendoc as a link into the app (the AUR route), and as the override used by a copied file.
  await mkdir(join(base, 'usr', 'bin'), { recursive: true });
  await symlink(join(app, 'resources', 'cli', 'opendoc'), join(base, 'usr', 'bin', 'opendoc'));
  const linked = spawnSync(join(base, 'usr', 'bin', 'opendoc'), ['--version'], { encoding: 'utf8', env: launcherEnvironment() });
  assert.deepEqual([linked.status, linked.stdout.split('\n')[1]], [0, cli]);
  await copyFile(join(cliFolder, 'opendoc'), join(base, 'usr', 'bin', 'copied'));
  await chmod(join(base, 'usr', 'bin', 'copied'), 0o755);
  const copied = spawnSync(join(base, 'usr', 'bin', 'copied'), ['--version'], { encoding: 'utf8', env: launcherEnvironment({ OPENDOC_DESKTOP_HOME: app }) });
  assert.deepEqual([copied.status, copied.stdout.split('\n')[1]], [0, cli]);
});

test('the Linux launcher says what is wrong when the app is not there', async () => {
  const base = await scratch();
  await mkdir(join(base, 'bin'));
  await copyFile(join(cliFolder, 'opendoc'), join(base, 'bin', 'opendoc'));
  await chmod(join(base, 'bin', 'opendoc'), 0o755);
  const run = spawnSync(join(base, 'bin', 'opendoc'), ['--version'], { encoding: 'utf8', env: launcherEnvironment({ OPENDOC_DESKTOP_HOME: join(base, 'nothing') }) });
  // A real /opt/opendoc-desktop on this machine would answer instead: the test is about the empty case.
  if (run.status === 0) return;
  assert.equal(run.status, 127);
  assert.match(run.stderr, /opendoc-desktop app was not found/);
});
