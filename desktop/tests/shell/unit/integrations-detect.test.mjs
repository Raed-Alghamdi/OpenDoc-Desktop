import assert from 'node:assert/strict';
import { chmod, mkdir, symlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { test } from 'node:test';
import { createIntegrations } from '../../../src/main/integrations/index.mjs';
import { findMiseInstall, isMiseShim } from '../../../src/main/integrations/detect.mjs';
import { environmentCommand } from '../../../src/main/integrations/run.mjs';
import { fakeCommand, miseInstall, miseShims, scratch } from './integrations-support.mjs';

const byId = (detection, id) => detection.apps.find(app => app.id === id);

test('a real command on the path is found, and nothing is run to find it', async () => {
  const world = await scratch();
  await fakeCommand(world, 'claude');
  await fakeCommand(world, 'codex');
  const detection = await createIntegrations(world.options()).detect();
  const claude = byId(detection, 'claude');
  assert.equal(claude.present, true);
  assert.equal(claude.canConnect, true);
  assert.equal(claude.executable, join(world.bin, 'claude'));
  assert.equal(claude.viaShim, null);
  assert.match(claude.reason, /Found claude at /);
  assert.deepEqual(await world.calls(), [], 'detecting must not run any command');
});

test('a command that is not on the path is absent, with the reason', async () => {
  const world = await scratch();
  const detection = await createIntegrations(world.options()).detect();
  assert.deepEqual(detection.apps.map(app => [app.id, app.present]), [['claude', false], ['codex', false], ['antigravity', false], ['cursor', false], ['copilot', false]]);
  assert.match(byId(detection, 'claude').reason, /no claude command/i);
});

test('a mise shim for a tool that is not installed counts as absent and is never run', async () => {
  const world = await scratch();
  const { shims, data } = await miseShims(world, ['claude', 'codex', 'agy', 'cursor-agent', 'copilot']);
  await miseInstall(world, data, 'codex', '1.0.0', 'codex');
  const detection = await createIntegrations(world.options({ env: world.env({ PATH: shims }) })).detect();
  for (const id of ['claude', 'antigravity', 'cursor', 'copilot']) {
    const app = byId(detection, id);
    assert.equal(app.present, false, id);
    assert.match(app.reason, /mise shim for a tool that is not installed/);
    assert.equal(app.executable, null);
  }
  const codex = byId(detection, 'codex');
  assert.equal(codex.present, true);
  assert.equal(codex.executable, join(data, 'installs', 'codex', '1.0.0', 'bin', 'codex'), 'the real program, not the shim');
  assert.equal(codex.viaShim, join(shims, 'codex'));
  assert.match(codex.reason, /installed with mise \(codex 1.0.0\)/);
  assert.deepEqual(await world.calls(), [], 'neither the shims nor the installed program may run');
});

test('mise finds a tool by its install folders: aliases first, links followed, dangling links ignored', async () => {
  const world = await scratch();
  const data = join(world.root, 'm');
  assert.equal(await findMiseInstall('agy', [data]), null, 'no install folder at all');
  const real = await fakeCommand(world, 'antigravity', join(data, 'installs', 'antigravity-cli', '1.5.12'));
  await symlink('./1.5.12', join(data, 'installs', 'antigravity-cli', 'latest'));
  await symlink('antigravity', join(data, 'installs', 'antigravity-cli', '1.5.12', 'agy'));
  assert.equal((await findMiseInstall('agy', [data])).executable, join(data, 'installs', 'antigravity-cli', 'latest', 'agy'), 'the latest alias is preferred');
  assert.ok(real);
  await mkdir(join(data, 'installs', 'cursor-agent', 'latest', 'bin'), { recursive: true });
  await symlink('../dist-package/cursor-agent', join(data, 'installs', 'cursor-agent', 'latest', 'bin', 'cursor-agent'));
  assert.equal(await findMiseInstall('cursor-agent', [data]), null, 'a link to nothing is not an installed tool');
  await fakeCommand(world, 'gh', join(data, 'installs', 'gh', '2.1.0', 'gh_2.1.0_linux_amd64', 'bin'));
  assert.equal((await findMiseInstall('gh', [data])).tool, 'gh', 'archives with one top folder');
});

test('a shim is recognised by what it is: a link to mise, or a tiny script handing over to it', async () => {
  const world = await scratch();
  const { shims } = await miseShims(world, ['one']);
  assert.equal(await isMiseShim(join(shims, 'one')), true);
  await writeFile(join(shims, 'two'), '#!/bin/sh\nexec mise x -- two "$@"\n');
  await chmod(join(shims, 'two'), 0o755);
  assert.equal(await isMiseShim(join(shims, 'two')), true);
  await writeFile(join(shims, 'three'), '#!/bin/sh\necho hello\n');
  await chmod(join(shims, 'three'), 0o755);
  assert.equal(await isMiseShim(join(shims, 'three')), false);
  assert.equal(await isMiseShim(join(shims, 'missing')), false);
});

test('a real program later on the path is used when an earlier shim has no install', async () => {
  const world = await scratch();
  const { shims } = await miseShims(world, ['claude']);
  const real = await fakeCommand(world, 'claude', join(world.root, 'elsewhere'));
  const detection = await createIntegrations(world.options({ env: world.env({ PATH: [shims, join(world.root, 'elsewhere')].join(':') }) })).detect();
  assert.equal(byId(detection, 'claude').executable, real);
  assert.deepEqual(await world.calls(), []);
});

test('Cursor and Copilot only need their config folder; the plugin apps need the command', async () => {
  const world = await scratch();
  await mkdir(join(world.home, '.cursor'), { recursive: true });
  await mkdir(join(world.home, '.claude'), { recursive: true });
  const detection = await createIntegrations(world.options()).detect();
  const cursor = byId(detection, 'cursor');
  assert.equal(cursor.present, true);
  assert.equal(cursor.canConnect, true);
  assert.match(cursor.reason, /config folder .*\.cursor exists/);
  const claude = byId(detection, 'claude');
  assert.equal(claude.present, false, 'a leftover config folder is not an installed Claude Code');
  assert.equal(claude.configFolderExists, true);
  assert.match(claude.reason, /needs the claude command/);
  assert.equal(byId(detection, 'copilot').present, false);
});

test('the config folders come from the app environment, and from the login shell when it knows better', async () => {
  const world = await scratch();
  await fakeCommand(world, 'claude');
  await fakeCommand(world, 'codex');
  const fromApp = await createIntegrations(world.options({ env: world.env({ CLAUDE_CONFIG_DIR: join(world.root, 'c1'), CODEX_HOME: join(world.root, 'x1') }) })).detect();
  assert.equal(byId(fromApp, 'claude').configFolder, join(world.root, 'c1'));
  assert.equal(byId(fromApp, 'claude').configFolderSource, 'app environment');
  assert.equal(byId(fromApp, 'codex').configFolder, join(world.root, 'x1'));
  assert.equal(byId(fromApp, 'antigravity').configFolder, join(world.home, '.gemini'));
  assert.equal(byId(fromApp, 'claude').configFolderSource, 'app environment');
  assert.equal(byId(await createIntegrations(world.options()).detect(), 'claude').configFolder, join(world.home, '.claude'), 'the default folder');

  const shell = join(world.root, 'fake-shell');
  await writeFile(shell, `#!/bin/sh\n[ "$1" = "-lc" ] && { [ "$2" = "env" ] || [ "$2" = "/usr/bin/env" ]; } || exit 9\necho "welcome banner"\necho "CLAUDE_CONFIG_DIR=${join(world.root, 'c2')}"\necho "CODEX_HOME=~/codex-in-home"\necho "PATH=${world.bin}:/usr/bin"\necho "SECRET_TOKEN=do-not-keep"\n`);
  await chmod(shell, 0o755);
  const integrations = createIntegrations(world.options({ readLoginShell: true, shell, env: world.env({ CLAUDE_CONFIG_DIR: join(world.root, 'c1'), PATH: '/nonexistent' }) }));
  const detection = await integrations.detect();
  assert.equal(byId(detection, 'claude').configFolder, join(world.root, 'c2'));
  assert.equal(byId(detection, 'claude').configFolderSource, 'login shell');
  assert.equal(byId(detection, 'codex').configFolder, join(world.home, 'codex-in-home'), '~ in the variable is expanded for the check');
  assert.equal(byId(detection, 'claude').present, true, 'the login shell PATH is searched');
  assert.deepEqual(detection.environment.loginShell, { read: true, error: null });
  assert.deepEqual(Object.keys(detection.environment.variables), ['CLAUDE_CONFIG_DIR', 'CODEX_HOME']);
  assert.ok(!JSON.stringify(detection).includes('do-not-keep'), 'variables that were not asked for are dropped');
});

test('a login shell that hangs, fails or is missing falls back to the app environment, and says so', async () => {
  const world = await scratch();
  const slow = join(world.root, 'slow-shell');
  await writeFile(slow, `#!/bin/sh\nexec "${process.execPath}" -e "setTimeout(() => {}, 30000)"\n`);
  await chmod(slow, 0o755);
  const broken = join(world.root, 'broken-shell');
  await writeFile(broken, '#!/bin/sh\nexit 3\n');
  await chmod(broken, 0o755);
  const env = world.env({ CODEX_HOME: join(world.root, 'x1') });
  for (const [shell, pattern] of [[slow, /did not finish within/], [broken, /exited with 3/], [join(world.root, 'nope'), /cannot be run/], [undefined, /No login shell is set/]]) {
    const started = Date.now();
    const detection = await createIntegrations(world.options({ readLoginShell: true, shell, env, loginShellTimeoutMs: 400 })).detect();
    assert.equal(detection.environment.loginShell.read, false);
    assert.match(detection.environment.loginShell.error, pattern);
    assert.equal(byId(detection, 'codex').configFolder, join(world.root, 'x1'));
    assert.ok(Date.now() - started < 10_000);
  }
});

test('the environment is read even when the login shell\'s PATH has no system folders (Ubuntu\'s /etc/profile sets none)', async () => {
  const world = await scratch();
  // A stand-in login shell whose profile leaves PATH useless: it runs the command it is given with PATH pointing nowhere.
  const shell = join(world.root, 'bare-shell');
  await writeFile(shell, `#!/bin/sh\n[ "$1" = "-lc" ] || exit 9\nPATH=/nonexistent\nexport PATH\nexport CLAUDE_CONFIG_DIR=${join(world.root, 'from-bare-shell')}\neval "$2"\n`);
  await chmod(shell, 0o755);
  const detection = await createIntegrations(world.options({ readLoginShell: true, shell })).detect();
  assert.deepEqual(detection.environment.loginShell, { read: true, error: null });
  assert.equal(byId(detection, 'claude').configFolder, join(world.root, 'from-bare-shell'));
  assert.equal(detection.environment.variables.CLAUDE_CONFIG_DIR.source, 'login shell');
});

test('a real login shell reads what the user profile sets', async () => {
  const world = await scratch();
  await writeFile(join(world.home, '.profile'), `export CLAUDE_CONFIG_DIR=${join(world.root, 'from-profile')}\n`);
  const detection = await createIntegrations(world.options({ readLoginShell: true, shell: '/bin/sh', env: world.env() })).detect();
  assert.equal(byId(detection, 'claude').configFolder, join(world.root, 'from-profile'));
  assert.equal(detection.environment.variables.CLAUDE_CONFIG_DIR.source, 'login shell');
});

test('the environment command is the absolute /usr/bin/env when it exists, and plain env otherwise', () => {
  assert.equal(environmentCommand(path => path === '/usr/bin/env'), '/usr/bin/env');
  assert.equal(environmentCommand(() => false), 'env');
});
