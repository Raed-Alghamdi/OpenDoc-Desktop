// The app's side of the agent command: what happens at launch (AppImage, macOS), what the user is told and how
// often, and the macOS menu item. Plain Node: Electron's dialog is replaced by a recorder.
import assert from 'node:assert/strict';
import { chmod, mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { CommandLineTool, appImageTemplatePath } from '../../../src/main/command-line-tool.mjs';
import { readShimTarget, shimMarker } from '../../../src/main/cli-shim.mjs';
import { createConfig } from '../../../src/main/config.mjs';
import { menuTemplate } from '../../../src/main/menu-template.mjs';

const templatePath = join(dirname(fileURLToPath(import.meta.url)), '../../../resources/cli/opendoc-appimage.sh');
const scratch = () => mkdtemp(join(tmpdir(), 'opendoc-tool-'));

/** A shell that reports a PATH without the command's folder, like a fresh account would have. */
async function plainShell(base) {
  const file = join(base, 'plain-shell');
  await writeFile(file, '#!/bin/sh\nshift; exec env PATH=/usr/bin:/bin /bin/sh "$@"\n', { mode: 0o755 });
  return file;
}

async function setup(overrides = {}) {
  const base = await scratch();
  const home = join(base, 'home');
  await mkdir(join(home, 'Downloads'), { recursive: true });
  const appImage = join(home, 'Downloads', 'opendoc-desktop.AppImage');
  await writeFile(appImage, '#!/bin/sh\n', { mode: 0o755 });
  const shown = [];
  const lines = [];
  const config = createConfig(join(base, 'profile', 'config.json'));
  const env = { PATH: '/usr/bin:/bin', SHELL: await plainShell(base), APPIMAGE: appImage, ...overrides.env };
  const tool = new CommandLineTool({ config, runtime: join(base, 'runtime'), templatePath, home, env, platform: 'linux', show: async options => { shown.push(options); return { response: 0 }; }, log: line => lines.push(line), ...overrides.options });
  return { base, home, appImage, shown, lines, config, tool, env };
}

test('an AppImage launch writes the command, and tells the user once that the folder is not on the PATH', async () => {
  const { home, appImage, shown, config, tool } = await setup();
  const result = await tool.launch();
  assert.equal(result.action, 'created');
  assert.equal(readShimTarget(await readFile(join(home, '.local', 'bin', 'opendoc'), 'utf8')), appImage);
  assert.equal(shown.length, 1);
  assert.match(shown[0].message, /~\/\.local\/bin.*not on your PATH/);
  assert.match(shown[0].detail, /export PATH=/);
  assert.equal((await config.read()).commandLineNotices.path, true);
  assert.equal((await tool.launch()).action, 'unchanged');
  assert.equal(shown.length, 1, 'the second launch does not ask again');
});

test('the notice is recorded before the dialog opens, so a quit while it is up does not repeat it', async () => {
  const { config, tool } = await setup({ options: { show: () => new Promise(() => {}) } });
  void tool.launch();
  for (let i = 0; i < 200 && !(await config.read()).commandLineNotices?.path; i++) await new Promise(accept => setTimeout(accept, 50));
  assert.equal((await config.read()).commandLineNotices.path, true);
});

test('no notice when the folder is on the PATH, and one is not invented when no shell answers', async () => {
  const onPath = await setup();
  onPath.env.PATH = `${join(onPath.home, '.local', 'bin')}:/usr/bin:/bin`;
  await onPath.tool.launch();
  assert.equal(onPath.shown.length, 0);
  const silent = await setup({ env: { SHELL: '/nonexistent/shell' } });
  await silent.tool.launch();
  assert.equal(silent.shown.length, 0);
  assert.equal((await silent.config.read()).commandLineNotices, undefined);
});

test('the command follows the AppImage to a new place', async () => {
  const { home, shown, tool, env } = await setup();
  await tool.launch();
  const moved = join(home, 'Applications', 'opendoc-desktop-0.6.2.AppImage');
  await mkdir(dirname(moved), { recursive: true });
  await writeFile(moved, '#!/bin/sh\n', { mode: 0o755 });
  env.APPIMAGE = moved;
  const result = await tool.launch();
  assert.deepEqual([result.action, result.repointed], ['updated', true]);
  assert.equal(readShimTarget(await readFile(join(home, '.local', 'bin', 'opendoc'), 'utf8')), moved);
  assert.equal(shown.length, 1);
});

test('a command that is not ours is left alone and the user is told once', async () => {
  const { home, shown, tool } = await setup();
  await mkdir(join(home, '.local', 'bin'), { recursive: true });
  await writeFile(join(home, '.local', 'bin', 'opendoc'), '#!/bin/sh\necho mine\n', { mode: 0o755 });
  assert.equal((await tool.launch()).action, 'foreign');
  assert.equal((await tool.launch()).action, 'foreign');
  assert.equal(await readFile(join(home, '.local', 'bin', 'opendoc'), 'utf8'), '#!/bin/sh\necho mine\n');
  assert.equal(shown.length, 1);
  assert.match(shown[0].message, /already exists/);
});

test('nothing is written without an AppImage, with a missing AppImage file, or on another platform', async () => {
  const none = await setup({ env: { APPIMAGE: undefined } });
  assert.equal((await none.tool.launch()).action, 'none');
  const gone = await setup({ env: { APPIMAGE: '/nonexistent/x.AppImage' } });
  assert.equal((await gone.tool.launch()).action, 'none');
  const windows = await setup({ options: { platform: 'win32' } });
  assert.equal((await windows.tool.launch()).action, 'none');
  for (const item of [none, gone, windows]) await assert.rejects(readFile(join(item.home, '.local', 'bin', 'opendoc')), { code: 'ENOENT' });
});

test('a problem with the command never stops the app: launch swallows it and logs it', async () => {
  const { tool, lines } = await setup({ options: { templatePath: '/nonexistent/template.sh' } });
  assert.equal((await tool.launch()).action, 'none');
  assert.match(lines.join('\n'), /could not set up the command/);
});

// ---------- macOS ----------

async function macSetup(overrides = {}) {
  const base = await scratch();
  const home = join(base, 'home');
  const bin = join(base, 'usr-local-bin');
  await mkdir(home, { recursive: true });
  await mkdir(bin);
  const executable = join(base, 'Applications', 'opendoc-desktop.app', 'Contents', 'MacOS', 'opendoc-desktop');
  const runtime = join(base, 'Applications', 'opendoc-desktop.app', 'Contents', 'Resources', 'runtime');
  const shown = [];
  const tool = new CommandLineTool({ config: createConfig(join(base, 'config.json')), runtime, templatePath, home, env: { PATH: `${bin}:/usr/bin:/bin`, SHELL: await plainShell(base) }, platform: 'darwin', executable, macCandidates: [bin], show: async options => { shown.push(options); return { response: 0 }; }, log: () => {}, ...overrides });
  return { base, home, bin, executable, runtime, shown, tool };
}

test('the macOS menu item installs the command and says where, with no PATH advice when the folder is on it', async () => {
  const { bin, shown, tool } = await macSetup();
  const result = await tool.installFromMenu();
  assert.equal(result.ok, true);
  assert.ok((await readFile(join(bin, 'opendoc'), 'utf8')).includes(shimMarker));
  assert.equal(shown.length, 1);
  assert.match(shown[0].message, /installed at .*usr-local-bin\/opendoc/);
  assert.doesNotMatch(shown[0].detail, /not on your PATH/);
  await tool.installFromMenu();
  assert.match(shown[1].message, /already installed/);
});

test('the macOS menu item explains when the folder is not on the PATH, and when it cannot install at all', async () => {
  const stuck = await macSetup();
  await chmod(stuck.bin, 0o555);
  // /usr/local/bin is not writable, so the command goes to ~/.local/bin, which is not on the PATH.
  if (process.getuid?.() !== 0) {
    const result = await stuck.tool.installFromMenu();
    assert.equal(result.ok, true);
    assert.equal(result.folder, join(stuck.home, '.local', 'bin'));
    assert.match(stuck.shown[0].detail, /not on your PATH/);
    assert.match(stuck.shown[0].detail, /export PATH=/);
  }
  await chmod(stuck.bin, 0o755);
  const translocated = await macSetup({ executable: '/private/var/x/AppTranslocation/Y/d/opendoc-desktop.app/Contents/MacOS/opendoc-desktop' });
  assert.equal((await translocated.tool.installFromMenu()).reason, 'translocated');
  assert.equal(translocated.shown[0].type, 'error');
  assert.match(translocated.shown[0].detail, /Applications/);
});

test('an installed macOS command is kept current at launch; the menu item does nothing off macOS', async () => {
  const { bin, tool, base, runtime } = await macSetup();
  await tool.installFromMenu();
  const moved = new CommandLineTool({ config: createConfig(join(base, 'c2.json')), runtime, templatePath, home: join(base, 'home'), env: {}, platform: 'darwin', executable: join(base, 'New', 'opendoc-desktop'), macCandidates: [bin], show: async () => ({}), log: () => {} });
  assert.equal((await moved.launch()).action, 'updated');
  assert.match(await readFile(join(bin, 'opendoc'), 'utf8'), /New\/opendoc-desktop/);
  const linux = await setup();
  assert.equal((await linux.tool.installFromMenu()).reason, 'not-macos');
  assert.equal(linux.shown.length, 0);
});

test('the AppImage template is found in the resources when packaged and in the source tree otherwise', () => {
  assert.equal(appImageTemplatePath({ packaged: true, resourcesPath: '/opt/app/resources', developmentRoot: '/src/desktop' }), '/opt/app/resources/cli/opendoc-appimage.sh');
  assert.equal(appImageTemplatePath({ packaged: false, resourcesPath: '/opt/app/resources', developmentRoot: '/src/desktop' }), '/src/desktop/resources/cli/opendoc-appimage.sh');
});

test('the application menu offers Install Command-Line Tool on macOS only, and its click runs the action', () => {
  const labels = platform => menuTemplate({ platform, actions: {}, state: { workspaceOpen: false, recent: [] } }).flatMap(menu => (menu.submenu ?? []).map(item => item.label));
  assert.ok(labels('darwin').includes('Install Command-Line Tool…'));
  assert.ok(!labels('linux').includes('Install Command-Line Tool…'));
  let ran = 0;
  const mac = menuTemplate({ platform: 'darwin', actions: { installCommand: () => { ran++; } }, state: { workspaceOpen: false, recent: [] } });
  mac[0].submenu.find(item => item.label === 'Install Command-Line Tool…').click();
  assert.equal(ran, 1);
});
