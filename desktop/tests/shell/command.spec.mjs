// The `opendoc` command for agents (plan 3.5, work package E4), against a linux-unpacked layout: the Linux packages'
// launcher with the app closed and open, a tripwire where a system Node would be, and the AppImage launcher and its
// writer. Everything runs with a scratch HOME: nothing here may touch a real ~/.local/bin or a real PATH folder.
import { expect, test } from '@playwright/test';
import { spawn } from 'node:child_process';
import { chmod, copyFile, lstat, mkdir, readFile, readdir, readlink, rm, stat, writeFile } from 'node:fs/promises';
import { existsSync, readlinkSync } from 'node:fs';
import { join } from 'node:path';
import { installAppImageShim, readShimTarget } from '../../src/main/cli-shim.mjs';
import { launchApp, newProfile, newWorkspace, readConfig } from './support/app.mjs';
import { libraryReady, waitFor } from './support/helpers.mjs';
import { cliResources, unpackedDir, unpackedExecutable, workDir } from './support/paths.mjs';
import { processAlive, waitForNoElectron } from './support/processes.mjs';

const launcher = join(unpackedDir, 'resources', 'cli', 'opendoc');
let counter = 0;
const scratch = async name => { const folder = join(workDir, `${name}-${++counter}`); await mkdir(folder, { recursive: true }); expect(folder.startsWith(workDir)).toBe(true); return folder; };

/** Run a program with exactly this environment (never the test runner's), collecting its output. */
function run(file, args, { cwd, env, timeout = 240_000 } = {}) {
  return new Promise((accept, reject) => {
    const child = spawn(file, args, { cwd, env, stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = ''; let stderr = '';
    child.stdout.on('data', chunk => { stdout += chunk; });
    child.stderr.on('data', chunk => { stderr += chunk; });
    const timer = setTimeout(() => child.kill('SIGKILL'), timeout);
    child.once('error', reject);
    child.once('close', code => { clearTimeout(timer); accept({ code, stdout, stderr }); });
  });
}

/** A PATH with a Node, npm and npx that fail loudly and leave a note: any use of a system Node shows. */
async function tripwire() {
  const folder = await scratch('tripwire');
  const note = join(folder, 'USED');
  for (const name of ['node', 'npm', 'npx', 'pnpm']) {
    await writeFile(join(folder, name), `#!/bin/sh\necho "${name} $*" >> '${note}'\necho 'a system ${name} was used' >&2\nexit 99\n`, { mode: 0o755 });
  }
  return { folder, note };
}

const cleanEnvironment = (home, path, extra = {}) => ({ PATH: path, HOME: home, LANG: 'C.UTF-8', ...extra });
const runtimeBuild = async () => JSON.parse(await readFile(join(unpackedDir, 'resources', 'runtime', 'build-info.json'), 'utf8')).build;
const runtimeVersion = async () => JSON.parse(await readFile(join(unpackedDir, 'resources', 'runtime', 'node_modules', 'opendoc', 'package.json'), 'utf8')).version;

/** What an agent runs: the version, a read, and the heavy one. Returns the three results. */
async function agentCommands(command, { cwd, env }) {
  return {
    version: await run(command, ['--version'], { cwd, env }),
    comments: await run(command, ['comments', 'list', 'welcome', '--json'], { cwd, env }),
    review: await run(command, ['review', 'welcome', '--export', '--json'], { cwd, env }),
  };
}

async function expectAgentWork(results) {
  expect(results.version).toMatchObject({ code: 0 });
  expect(results.version.stdout.trim()).toBe(await runtimeVersion());
  expect(results.comments).toMatchObject({ code: 0 });
  expect(JSON.parse(results.comments.stdout)).toEqual([]);
  expect(results.review.code, results.review.stderr).toBe(0);
  expect(() => JSON.parse(results.review.stdout)).not.toThrow();
}

test.describe.serial('the Linux packages\' launcher', () => {
  let workspace; let home; let wire; let environment;

  test.beforeAll(async () => {
    workspace = await newWorkspace('command');
    home = await scratch('command-home');
    wire = await tripwire();
    environment = cleanEnvironment(home, `${wire.folder}:/usr/bin:/bin`);
  });

  test('the app\'s files are in place the way a package lays them out', async () => {
    expect(existsSync(unpackedExecutable)).toBe(true);
    expect((await stat(launcher)).mode & 0o111).not.toBe(0);
    expect(existsSync(join(unpackedDir, 'resources', 'runtime', 'node_modules', 'opendoc', 'bin', 'opendoc.mjs'))).toBe(true);
  });

  test('version, comments list and review --export work with the app closed, with no Node on the PATH', async () => {
    await expectAgentWork(await agentCommands(launcher, { cwd: workspace, env: environment }));
    expect(existsSync(wire.note), await readFile(wire.note, 'utf8').catch(() => '')).toBe(false);
  });

  test('a copy installed as /usr/bin/opendoc works too, found through OPENDOC_DESKTOP_HOME', async () => {
    const installed = join(await scratch('usr-bin'), 'opendoc');
    await copyFile(launcher, installed);
    await chmod(installed, 0o755);
    const results = await agentCommands(installed, { cwd: workspace, env: { ...environment, OPENDOC_DESKTOP_HOME: unpackedDir } });
    expect(results.version.stdout.trim()).toBe(await runtimeVersion());
    expect(JSON.parse(results.comments.stdout)).toEqual([]);
  });

  test('the launcher replaces itself with the app\'s executable, so signals and exit codes are the CLI\'s own', async () => {
    const child = spawn(launcher, ['review', 'welcome', '--export'], { cwd: workspace, env: environment, stdio: 'ignore' });
    await waitFor(() => { try { return readlinkSync(`/proc/${child.pid}/exe`) === unpackedExecutable; } catch { return false; } }, { timeout: 10_000, what: 'the launcher to become the app executable' });
    const closed = new Promise(accept => child.once('close', (code, signal) => accept({ code, signal })));
    child.kill('SIGTERM');
    expect((await closed).signal).toBe('SIGTERM');
    // An unknown command is a usage error, which the CLI ends with exit status 2 (C2).
    const unknown = await run(launcher, ['no-such-command'], { cwd: workspace, env: environment });
    expect(unknown.code).toBe(2);
  });

  test('arguments reach the CLI byte for byte', async () => {
    const odd = "no such 'doc' $HOME";
    const result = await run(launcher, ['export', odd], { cwd: workspace, env: environment });
    expect(result.code).not.toBe(0);
    expect(result.stdout + result.stderr).toContain(odd);
  });

  test('version, comments list and review --export work with the app open on the same workspace', async () => {
    const profile = await newProfile('command-open', { defaultWorkspace: workspace });
    const app = await launchApp({ profile });
    try {
      await libraryReady(await app.firstWindow());
      const before = JSON.parse(await readFile(join(workspace, '.opendoc', 'desktop.json'), 'utf8'));
      await expectAgentWork(await agentCommands(launcher, { cwd: workspace, env: environment }));
      // The app is untouched: still the owner, still answering.
      expect(JSON.parse(await readFile(join(workspace, '.opendoc', 'desktop.json'), 'utf8'))).toEqual(before);
      expect(processAlive(before.pid)).toBe(true);
      expect(await (await app.firstWindow()).evaluate(() => fetch('/api/session').then(response => response.ok))).toBe(true);
    } finally { await app.close(); }
    expect(await waitForNoElectron(5000)).toEqual([]);
    expect(existsSync(wire.note)).toBe(false);
  });

  test('without the app the launcher says what is wrong', async () => {
    const lonely = join(await scratch('lonely'), 'opendoc');
    await copyFile(launcher, lonely);
    await chmod(lonely, 0o755);
    const result = await run(lonely, ['--version'], { env: { ...environment, OPENDOC_DESKTOP_HOME: join(home, 'nothing') } });
    if (existsSync('/opt/opendoc-desktop')) return; // a real install here would answer instead
    expect(result.code).toBe(127);
    expect(result.stderr).toContain('opendoc-desktop app was not found');
  });
});

/** A stand-in for the AppImage file: it can only do what the shim asks of it, mounting the unpacked app. */
async function fakeAppImage(folder, name = 'opendoc-desktop.AppImage') {
  const file = join(folder, name);
  await mkdir(folder, { recursive: true });
  await writeFile(file, `#!/bin/sh
if [ "$1" = "--appimage-mount" ]; then
  echo "$FAKE_MOUNT"
  echo $$ > "$FAKE_PIDFILE"
  exec sleep 3600
fi
echo "fake AppImage run with: $*" >&2
exit 3
`, { mode: 0o755 });
  return file;
}

test.describe.serial('the AppImage command', () => {
  let workspace; let home; let environment; let command; let appImage; let pidFile; let wire; let template;

  const runtimeCopy = () => join(home, '.local', 'share', 'opendoc-desktop', 'runtime');
  const mountAlive = async () => { try { return processAlive(Number((await readFile(pidFile, 'utf8')).trim())); } catch { return false; } };

  test.beforeAll(async () => {
    test.skip(spawnPresent('setpriv') === false, 'setpriv (util-linux) is needed for the mount helper rule');
    workspace = await newWorkspace('appimage');
    home = await scratch('appimage-home');
    wire = await tripwire();
    pidFile = join(home, 'mount.pid');
    environment = cleanEnvironment(home, `${wire.folder}:/usr/bin:/bin`, { FAKE_MOUNT: unpackedDir, FAKE_PIDFILE: pidFile });
    appImage = await fakeAppImage(join(home, 'Downloads'));
    template = await readFile(join(cliResources, 'opendoc-appimage.sh'), 'utf8');
    const result = await installAppImageShim({ template, appImage, home });
    command = result.path;
    expect(command).toBe(join(home, '.local', 'bin', 'opendoc'));
  });

  test('the first call makes the runtime copy and runs the CLI on it; nothing stays mounted', async () => {
    const result = await run(command, ['--version'], { cwd: workspace, env: environment });
    expect(result, result.stderr).toMatchObject({ code: 0 });
    expect(result.stdout.trim()).toBe(await runtimeVersion());
    const copies = await readdir(runtimeCopy());
    expect(copies.filter(name => !name.startsWith('.'))).toEqual([`${await runtimeVersion()}-${await runtimeBuild()}`]);
    await waitFor(async () => !(await mountAlive()), { timeout: 5000, what: 'the mount helper to stop' });
    expect(existsSync(wire.note)).toBe(false);
  });

  test('the runtime copy keeps its relative links, and the agent commands work through the shim', async () => {
    const copy = join(runtimeCopy(), `${await runtimeVersion()}-${await runtimeBuild()}`);
    const links = (await readdir(join(copy, 'node_modules', '.bin'))).slice(0, 5);
    expect(links.length).toBeGreaterThan(0);
    for (const name of links) {
      const info = await lstat(join(copy, 'node_modules', '.bin', name));
      if (info.isSymbolicLink()) expect((await readlink(join(copy, 'node_modules', '.bin', name))).startsWith('/')).toBe(false);
    }
    await expectAgentWork(await agentCommands(command, { cwd: workspace, env: environment }));
  });

  test('a missing or foreign runtime copy is made again by the next call', async () => {
    const copy = join(runtimeCopy(), `${await runtimeVersion()}-${await runtimeBuild()}`);
    await rm(copy, { recursive: true, force: true });
    expect((await run(command, ['--version'], { cwd: workspace, env: environment })).code).toBe(0);
    expect(existsSync(join(copy, 'node_modules', 'opendoc', 'bin', 'opendoc.mjs'))).toBe(true);
    await writeFile(join(copy, 'build-info.json'), JSON.stringify({ build: await runtimeBuild(), commit: 'another', builtAt: 'x' }));
    expect((await run(command, ['--version'], { cwd: workspace, env: environment })).code).toBe(0);
    expect(await readFile(join(copy, 'build-info.json'), 'utf8')).toBe(await readFile(join(unpackedDir, 'resources', 'runtime', 'build-info.json'), 'utf8'));
  });

  test('arguments and the exit code pass through the shim', async () => {
    const odd = "no such 'doc' $HOME";
    const result = await run(command, ['export', odd], { cwd: workspace, env: environment });
    expect(result.code).not.toBe(0);
    expect(result.stdout + result.stderr).toContain(odd);
    // An unknown command is a usage error, which the CLI ends with exit status 2 (C2).
    expect((await run(command, ['no-such-command'], { cwd: workspace, env: environment })).code).toBe(2);
  });

  test('a moved AppImage is explained, and writing the command again repairs it', async () => {
    const moved = await fakeAppImage(join(home, "Apps 'and' things"), 'opendoc-desktop-0.6.2.AppImage');
    await rm(appImage);
    const lost = await run(command, ['--version'], { cwd: workspace, env: environment });
    expect(lost.code).toBe(127);
    expect(lost.stderr).toMatch(/no longer at .*opendoc-desktop\.AppImage.*Open it once from its new place/);
    const result = await installAppImageShim({ template, appImage: moved, home });
    expect([result.action, result.repointed]).toEqual(['updated', true]);
    expect(readShimTarget(await readFile(command, 'utf8'))).toBe(moved);
    expect((await run(command, ['--version'], { cwd: workspace, env: environment })).code).toBe(0);
    appImage = moved;
  });

  test('killing the shim leaves no mount helper behind', async () => {
    const child = spawn(command, ['review', 'welcome', '--export'], { cwd: workspace, env: environment, stdio: 'ignore' });
    await waitFor(mountAlive, { timeout: 30_000, what: 'the mount helper' });
    child.kill('SIGKILL');
    await waitFor(async () => !(await mountAlive()), { timeout: 8000, what: 'the mount helper to stop after kill -9 of the shim' });
  });
});

function spawnPresent(program) {
  return ['/usr/bin', '/bin', '/usr/sbin', '/sbin'].some(folder => existsSync(join(folder, program)));
}

test.describe.serial('the app writes the AppImage command at launch', () => {
  let home; let template;
  const bin = () => join(home, '.local', 'bin', 'opendoc');
  const launch = async (appImage, { onPath = false, profile } = {}) => {
    const shell = join(home, 'stub-shell');
    await writeFile(shell, '#!/bin/sh\nshift; exec env PATH=/usr/bin:/bin /bin/sh "$@"\n', { mode: 0o755 });
    const path = onPath ? `${join(home, '.local', 'bin')}:/usr/bin:/bin` : '/usr/bin:/bin';
    return launchApp({ profile, env: { HOME: home, XDG_DATA_HOME: join(home, '.local', 'share'), XDG_CONFIG_HOME: join(home, '.config'), APPIMAGE: appImage, SHELL: shell, PATH: path } });
  };

  test.beforeAll(async () => {
    home = await scratch('launch-home');
    template = await readFile(join(cliResources, 'opendoc-appimage.sh'), 'utf8');
  });

  test('the first launch writes ~/.local/bin/opendoc for the AppImage and tells the user once about the PATH', async () => {
    const profile = await newProfile('launch-profile');
    const first = await fakeAppImage(join(home, 'Downloads'));
    const app = await launch(first, { profile });
    try {
      await waitFor(() => existsSync(bin()), { timeout: 60_000, what: 'the command to be written' });
      expect(readShimTarget(await readFile(bin(), 'utf8'))).toBe(first);
      expect((await stat(bin())).mode & 0o777).toBe(0o755);
      await waitFor(async () => (await readConfig(profile).catch(() => ({}))).commandLineNotices?.path === true, { timeout: 60_000, what: 'the PATH notice to be recorded' });
    } finally { await app.close(); }
    expect(await readdir(join(home, '.local', 'bin'))).toEqual(['opendoc']);
  });

  test('the next launch from another place points the command at the new file', async () => {
    const profile = await newProfile('launch-profile-2');
    const moved = await fakeAppImage(join(home, 'Applications'), 'opendoc-desktop-0.6.2.AppImage');
    const app = await launch(moved, { profile });
    try {
      await waitFor(async () => readShimTarget(await readFile(bin(), 'utf8')) === moved, { timeout: 60_000, what: 'the command to follow the AppImage' });
    } finally { await app.close(); }
    expect(await readdir(join(home, '.local', 'bin'))).toEqual(['opendoc']);
  });

  test('a command that is not ours is left alone, and the user is told once', async () => {
    const profile = await newProfile('launch-profile-3');
    await writeFile(bin(), '#!/bin/sh\necho my own opendoc\n', { mode: 0o755 });
    const app = await launch(await fakeAppImage(join(home, 'Applications')), { profile });
    try {
      await waitFor(async () => (await readConfig(profile).catch(() => ({}))).commandLineNotices?.foreign === true, { timeout: 60_000, what: 'the notice to be recorded' });
    } finally { await app.close(); }
    expect(await readFile(bin(), 'utf8')).toBe('#!/bin/sh\necho my own opendoc\n');
    void template;
  });

  test('with ~/.local/bin on the PATH there is no notice', async () => {
    const profile = await newProfile('launch-profile-4');
    await rm(bin());
    const app = await launch(await fakeAppImage(join(home, 'Applications')), { profile, onPath: true });
    try {
      await waitFor(() => existsSync(bin()), { timeout: 60_000, what: 'the command to be written' });
      await new Promise(accept => setTimeout(accept, 2500));
      expect((await readConfig(profile).catch(() => ({}))).commandLineNotices).toBeUndefined();
    } finally { await app.close(); }
  });

  test('a launch that is not from an AppImage writes nothing', async () => {
    const quiet = await scratch('quiet-home');
    const app = await launchApp({ profile: await newProfile('launch-profile-5'), env: { HOME: quiet, XDG_DATA_HOME: join(quiet, '.local', 'share') } });
    try {
      await app.firstWindow();
      await new Promise(accept => setTimeout(accept, 2500));
    } finally { await app.close(); }
    expect(existsSync(join(quiet, '.local', 'bin'))).toBe(false);
  });
});
