import assert from 'node:assert/strict';
import { chmod, mkdir, readFile, readdir, rm, stat, symlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { test } from 'node:test';
import { createIntegrations, defaultSourceDirectory } from '../../../src/main/integrations/index.mjs';
import { runProgram } from '../../../src/main/integrations/run.mjs';
import { createManifest } from '../../../src/main/integrations/manifest.mjs';
import { copyDigest, ensureCopy, readSource } from '../../../src/main/integrations/stable-copy.mjs';
import { fakeCommand, scratch } from './integrations-support.mjs';

async function setup(extraEnv = {}) {
  const world = await scratch();
  for (const name of ['claude', 'codex', 'agy']) await fakeCommand(world, name);
  world.claudeConfig = join(world.root, 'claude-config');
  world.codexHome = join(world.root, 'codex-home');
  world.create = (options = {}) => createIntegrations(world.options({ env: world.env({ CLAUDE_CONFIG_DIR: world.claudeConfig, CODEX_HOME: world.codexHome, ...extraEnv }), ...options }));
  world.integrations = world.create();
  world.skillFile = join(world.source, 'skills', 'opendoc', 'SKILL.md');
  return world;
}

/** The app updates: the skill text changes in all three copies. */
async function updateSource(world, text) {
  for (const path of ['skills/opendoc/SKILL.md', 'claude/opendoc/skills/opendoc/SKILL.md', 'codex/opendoc/skills/opendoc/SKILL.md']) {
    await writeFile(join(world.source, path), `${await readFile(join(world.source, path), 'utf8')}\n${text}\n`);
  }
}

test('the stable copy holds exactly the app\'s files, and a copy that already matches is left alone', async () => {
  const world = await scratch();
  const target = join(world.root, 'copy');
  const first = await ensureCopy({ source: world.source, target });
  assert.deepEqual([first.ok, first.changed], [true, true]);
  assert.equal(first.digest, await copyDigest(target));
  const marker = join(target, 'README.md');
  const time = (await stat(marker)).mtimeMs;
  const second = await ensureCopy({ source: world.source, target });
  assert.deepEqual([second.ok, second.changed], [true, false]);
  assert.equal((await stat(marker)).mtimeMs, time, 'nothing was rewritten');
  assert.deepEqual((await readdir(world.root)).filter(name => name.includes('.tmp-') || name.includes('.old-')), [], 'no temporary folders are left');
});

test('a read-only source (an AppImage mount, a package) gives a copy that can be replaced and removed', async () => {
  const world = await scratch();
  const walk = async folder => {
    for (const entry of await readdir(folder, { withFileTypes: true })) {
      const path = join(folder, entry.name);
      if (entry.isDirectory()) { await walk(path); await chmod(path, 0o555); } else await chmod(path, 0o444);
    }
  };
  await walk(world.source);
  await chmod(world.source, 0o555);
  const target = join(world.root, 'copy');
  try {
    assert.equal((await ensureCopy({ source: world.source, target })).ok, true);
    assert.equal((await stat(join(target, 'skills', 'opendoc', 'SKILL.md'))).mode & 0o222, 0o200, 'owner can write');
    assert.equal((await stat(join(target, 'skills'))).mode & 0o700, 0o700);
    await writeFile(join(target, 'skills', 'opendoc', 'SKILL.md'), 'damaged');
    const repaired = await ensureCopy({ source: world.source, target });
    assert.deepEqual([repaired.ok, repaired.changed], [true, true], 'a damaged copy is rewritten');
    assert.equal((await readFile(join(target, 'skills', 'opendoc', 'SKILL.md'), 'utf8')).includes('damaged'), false);
  } finally {
    await chmod(world.source, 0o755); // the scratch folder is removed when the process ends
  }
});

test('a source that lacks a required file, or holds a symbolic link, is refused and nothing is copied', async () => {
  const world = await scratch();
  const target = join(world.root, 'copy');
  await rm(join(world.source, 'claude', '.claude-plugin'), { recursive: true });
  const incomplete = await ensureCopy({ source: world.source, target });
  assert.equal(incomplete.ok, false);
  assert.match(incomplete.summary, /incomplete \(missing claude\/\.claude-plugin\/marketplace\.json\)/);
  await assert.rejects(stat(target), { code: 'ENOENT' });

  const other = await scratch();
  await symlink('/etc/hostname', join(other.source, 'link'));
  const linked = await readSource(other.source);
  assert.equal(linked.ok, false);
  assert.match(linked.summary, /link is a symbolic link/);
  assert.equal((await readSource(join(other.root, 'missing'))).ok, false);
});

test('connect with an incomplete source fails for every app, with the reason, and leaves nothing', async () => {
  const world = await setup();
  await rm(join(world.source, 'codex', '.agents'), { recursive: true });
  const outcome = await world.integrations.connect(['claude', 'codex']);
  assert.equal(outcome.ok, false);
  assert.deepEqual(outcome.results.map(result => result.code), ['copy-failed', 'copy-failed']);
  assert.match(outcome.results[0].summary, /incomplete/);
  assert.deepEqual(await world.calls(), []);
});

test('refresh does nothing, and writes nothing, when nothing is connected', async () => {
  const world = await setup();
  const outcome = await world.integrations.refresh();
  assert.deepEqual([outcome.ok, outcome.changed, outcome.copy], [true, false, null]);
  await assert.rejects(stat(world.data), { code: 'ENOENT' });
  assert.deepEqual(await world.calls(), []);
});

test('refresh after an app update: new copy, plugins that keep their own copy are installed again, Claude Code needs no command', async () => {
  const world = await setup();
  await mkdir(join(world.home, '.cursor'));
  assert.equal((await world.integrations.connect(['claude', 'codex', 'antigravity', 'cursor'])).ok, true);
  const unchanged = await world.integrations.refresh();
  assert.deepEqual([unchanged.ok, unchanged.changed], [true, false]);

  await updateSource(world, 'A new paragraph from the next app build.');
  const calls = (await world.calls()).length;
  const outcome = await world.integrations.refresh();
  assert.equal(outcome.ok, true, JSON.stringify(outcome, null, 1));
  assert.equal(outcome.changed, true);
  assert.equal(outcome.copy.changed, true);
  assert.deepEqual(Object.fromEntries(outcome.results.map(result => [result.app, result.code])), { claude: 'refreshed', codex: 'refreshed', antigravity: 'refreshed', cursor: 'refreshed' });
  const after = (await world.calls()).slice(calls);
  assert.deepEqual([...new Set(after.map(call => call.tool))].sort(), ['agy', 'codex'], 'Claude Code was not run: it reads the copy in place');
  assert.ok(after.some(call => call.tool === 'codex' && call.args.join(' ') === 'plugin add opendoc@opendoc'));
  assert.ok(after.some(call => call.tool === 'agy' && call.args[1] === 'install'));
  assert.equal(await readFile(join(world.home, '.cursor', 'skills', 'opendoc', 'SKILL.md'), 'utf8'), await readFile(world.skillFile, 'utf8'));
  assert.equal(await readFile(join(world.data, 'integrations', 'skills', 'opendoc', 'SKILL.md'), 'utf8'), await readFile(world.skillFile, 'utf8'));

  const status = await world.integrations.status({ verify: false });
  assert.deepEqual(status.apps.filter(app => app.managed).map(app => app.stale), [false, false, false, false]);
  assert.equal(status.copy.upToDate, true);
  assert.equal((await world.integrations.refresh()).changed, false, 'and a second refresh has nothing to do');
});

test('refresh with reinstall off refreshes the copy only; status shows the apps that keep their own copy as stale', async () => {
  const world = await setup();
  await world.integrations.connect(['claude', 'codex']);
  await updateSource(world, 'Another change.');
  const calls = (await world.calls()).length;
  const outcome = await world.integrations.refresh({ reinstall: false });
  assert.equal(outcome.ok, true);
  assert.deepEqual(Object.fromEntries(outcome.results.map(result => [result.app, result.code])), { claude: 'refreshed', codex: 'stale' });
  assert.equal((await world.calls()).length, calls, 'no vendor command ran');
  const status = await world.integrations.status({ verify: false });
  assert.deepEqual(status.apps.filter(app => app.managed).map(app => [app.id, app.stale]), [['claude', false], ['codex', true]]);
  // The next refresh, with reinstall on, brings it up to date.
  assert.equal((await world.integrations.refresh()).results[0].code, 'refreshed');
  assert.equal((await world.integrations.status({ verify: false })).apps.find(app => app.id === 'codex').stale, false);
});

test('a copy the user deleted is made again by refresh', async () => {
  const world = await setup();
  await world.integrations.connect(['claude']);
  await rm(join(world.data, 'integrations'), { recursive: true });
  assert.equal((await world.integrations.status({ verify: false })).copy.exists, false);
  const outcome = await world.integrations.refresh();
  assert.deepEqual([outcome.ok, outcome.copy.changed], [true, true]);
  assert.equal((await world.integrations.status({ verify: false })).copy.upToDate, true);
});

test('status reports connected, not connected and not found, and what could not be checked', async () => {
  const world = await setup();
  await mkdir(join(world.home, '.cursor'));
  await world.integrations.connect(['claude', 'cursor']);
  const status = await world.integrations.status();
  const byId = Object.fromEntries(status.apps.map(app => [app.id, app]));
  assert.deepEqual([byId.claude.connected, byId.claude.managed, byId.claude.present], [true, true, true]);
  assert.match(byId.claude.summary, /Installed and enabled \(opendoc@opendoc, version 1\.0\.0\)/);
  assert.deepEqual([byId.codex.connected, byId.codex.managed], [false, false]);
  assert.match(byId.codex.summary, /not installed in Codex/);
  assert.deepEqual([byId.cursor.connected, byId.cursor.managed], [true, true]);
  assert.deepEqual([byId.copilot.present, byId.copilot.connected], [false, null]);
  assert.match(byId.copilot.summary, /no copilot command/i);
  assert.equal(status.copy.upToDate, true);
  assert.equal(status.problem, null);

  await writeFile(join(world.home, '.cursor', 'skills', 'opendoc', 'SKILL.md'), 'changed');
  const changed = (await world.integrations.status()).apps.find(app => app.id === 'cursor');
  assert.equal(changed.connected, false);
  assert.match(changed.summary, /not the ones this app wrote/);

  const broken = createIntegrations(world.options({ env: world.env({ CLAUDE_CONFIG_DIR: world.claudeConfig, FAKE_MODE: 'slow' }), commandTimeoutMs: 300 }));
  const timedOut = (await broken.status()).apps.find(app => app.id === 'claude');
  assert.equal(timedOut.connected, null);
  assert.match(timedOut.summary, /would not list its plugins/);
});

test('status says when an app that was set up is no longer found', async () => {
  const world = await setup();
  await world.integrations.connect(['antigravity']);
  const gone = createIntegrations(world.options({ env: world.env({ PATH: join(world.root, 'empty') }) }));
  const app = (await gone.status()).apps.find(item => item.id === 'antigravity');
  assert.deepEqual([app.present, app.connected, app.managed], [false, null, true]);
  assert.match(app.summary, /set up OpenDoc in it earlier/);
});

test('the manifest is written atomically with mode 0600, an empty one is removed, and a damaged one is moved aside and reported', async () => {
  const world = await scratch();
  const manifest = createManifest(join(world.root, 'sub', 'integrations.json'));
  assert.deepEqual((await manifest.read()).manifest, { version: 1, apps: {} });
  await manifest.update(current => { current.apps.claude = { app: 'claude' }; return current; });
  assert.equal((await stat(manifest.file)).mode & 0o777, 0o600);
  assert.deepEqual(await readdir(join(world.root, 'sub')), ['integrations.json'], 'no temporary file is left');
  await manifest.update(current => { delete current.apps.claude; return current; });
  await assert.rejects(stat(manifest.file), { code: 'ENOENT' });

  await mkdir(join(world.root, 'sub'), { recursive: true });
  await writeFile(manifest.file, '{ not json');
  const read = await manifest.read();
  assert.deepEqual(read.manifest, { version: 1, apps: {} });
  assert.match(read.problem, /could not be read\. It was moved to .*integrations\.json\.damaged-/);
  assert.deepEqual((await readdir(join(world.root, 'sub'))).length, 1);
  await writeFile(manifest.file, JSON.stringify({ apps: { claude: { app: 'claude' } }, somethingNew: 1 }));
  await manifest.update(current => { current.apps.codex = {}; return current; });
  assert.equal(JSON.parse(await readFile(manifest.file, 'utf8')).somethingNew, 1, 'unknown keys survive');
});

test('an interrupted connect leaves a pending record that status reports and disconnect cleans up', async () => {
  const world = await setup();
  await world.integrations.connect(['claude']);
  // Simulate the app dying after the marketplace was added: the plugin is not installed, and the record is pending without it.
  await runProgram(join(world.bin, 'claude'), ['plugin', 'uninstall', 'opendoc@opendoc'], { env: world.env({ CLAUDE_CONFIG_DIR: world.claudeConfig }) });
  const file = world.integrations.manifestFile;
  const manifest = JSON.parse(await readFile(file, 'utf8'));
  manifest.apps.claude.pending = true;
  delete manifest.apps.claude.plugin;
  await writeFile(file, JSON.stringify(manifest));
  const status = (await world.integrations.status({ verify: false })).apps.find(app => app.id === 'claude');
  assert.match(status.problem, /did not finish/);
  const outcome = await world.integrations.disconnect(['claude']);
  assert.equal(outcome.ok, true, JSON.stringify(outcome, null, 1));
  assert.deepEqual(JSON.parse(await readFile(join(world.claudeConfig, 'fake-claude.json'), 'utf8')).marketplaces, []);
  await assert.rejects(stat(file), { code: 'ENOENT' });
});

test('the default source is the packaged resources folder when it holds integrations, else the source tree', async () => {
  const world = await scratch();
  assert.equal(defaultSourceDirectory({ resourcesPath: world.root }), defaultSourceDirectory({ resourcesPath: undefined }));
  await mkdir(join(world.root, 'integrations'));
  assert.equal(defaultSourceDirectory({ resourcesPath: world.root }), join(world.root, 'integrations'));
  assert.ok((await readSource(defaultSourceDirectory({ resourcesPath: undefined }))).ok, 'the repository\'s own folder is complete');
});

test('without an explicit data folder the app\'s own rules decide it: XDG_DATA_HOME on Linux, Application Support on macOS', async () => {
  const world = await scratch();
  const env = world.env();
  assert.equal(createIntegrations({ home: world.home, env, platform: 'linux', sourceDirectory: world.source }).copyDirectory, join(world.home, '.local', 'share', 'opendoc-desktop', 'integrations'));
  assert.equal(createIntegrations({ home: world.home, env: { ...env, XDG_DATA_HOME: join(world.root, 'xdg') }, platform: 'linux', sourceDirectory: world.source }).copyDirectory, join(world.root, 'xdg', 'opendoc-desktop', 'integrations'));
  assert.equal(createIntegrations({ home: world.home, env, platform: 'darwin', sourceDirectory: world.source }).copyDirectory, join(world.home, 'Library', 'Application Support', 'opendoc-desktop', 'integrations'));
});
