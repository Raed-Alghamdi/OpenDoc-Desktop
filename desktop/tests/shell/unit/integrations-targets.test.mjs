// Settings folders as connect targets (targets.mjs, index.mjs): the list that runs no vendor command, which Claude Code folders are
// found, connecting and disconnecting in a second folder, records from before targets existed, ids a page may not invent, and the refresh.
// Every world is scratch: its own home, XDG folders, data folder and PATH, so nothing here can reach a real Claude Code.
import assert from 'node:assert/strict';
import { chmod, mkdir, readFile, rename, stat, symlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { test } from 'node:test';
import { createIntegrations } from '../../../src/main/integrations/index.mjs';
import { appIdOfTarget, displayPath, looksLikeSettingsFolder, targetIdFor } from '../../../src/main/integrations/targets.mjs';
import { apps } from '../../../src/main/integrations/apps.mjs';
import { fakeCommand, scratch } from './integrations-support.mjs';

const claudeApp = apps.find(app => app.id === 'claude');

async function setup({ commands = ['claude', 'codex', 'agy'], env = {}, options = {} } = {}) {
  const world = await scratch();
  for (const name of commands) await fakeCommand(world, name);
  world.create = (extraEnv = {}, extraOptions = {}) => createIntegrations(world.options({ env: world.env({ ...env, ...extraEnv }), ...options, ...extraOptions }));
  world.integrations = world.create();
  world.manifest = async () => JSON.parse(await readFile(world.integrations.manifestFile, 'utf8'));
  /** A folder `~/.claude-<name>` that looks like a Claude Code settings folder. */
  world.settingsFolder = async (name, marker = 'settings.json') => { const folder = join(world.home, name); await mkdir(folder, { recursive: true }); await writeFile(join(folder, marker), '{}'); return folder; };
  world.claudeCalls = async () => (await world.calls()).filter(call => call.tool === 'claude');
  return world;
}
const claudeOf = overview => overview.apps.find(app => app.id === 'claude');
const ids = overview => claudeOf(overview).targets.map(target => target.id);

test('target ids: the default folder is the app id, any other is the app id, an at sign and the folder', () => {
  const home = '/home/someone';
  assert.equal(targetIdFor(claudeApp, '/home/someone/.claude', home), 'claude');
  assert.equal(targetIdFor(claudeApp, '/home/someone/.claude/', home), 'claude');
  assert.equal(targetIdFor(claudeApp, '/home/someone/.claude-Work', home), 'claude@.claude-Work');
  assert.equal(targetIdFor(claudeApp, '/srv/claude/profile', home), 'claude@/srv/claude/profile');
  assert.equal(appIdOfTarget('claude@.claude-Work'), 'claude');
  assert.equal(appIdOfTarget('codex'), 'codex');
  assert.equal(displayPath('/home/someone/.claude-Work', home), '~/.claude-Work');
  assert.equal(displayPath('/srv/x', home), '/srv/x');
});

test('the list runs no vendor command and reads the login shell once, until it is asked to look again', async () => {
  const world = await setup();
  const shell = join(world.root, 'fake-shell');
  const log = join(world.root, 'shell.log');
  await writeFile(shell, `#!/bin/sh\necho run >> ${log}\necho "PATH=${world.bin}:/usr/bin"\n`);
  await chmod(shell, 0o755);
  const integrations = world.create({}, { readLoginShell: true, shell });
  const reads = async () => (await readFile(log, 'utf8').catch(() => '')).split('\n').filter(Boolean).length;
  const first = await integrations.overview();
  assert.equal(await reads(), 1);
  await integrations.overview();
  assert.equal(await reads(), 1, 'the second list reuses the first read');
  assert.deepEqual(first.apps.map(app => [app.id, app.present]), [['claude', true], ['codex', true], ['antigravity', true], ['cursor', false], ['copilot', false]]);
  assert.deepEqual(await world.calls(), [], 'no vendor command ran, not even a read-only one');
  await integrations.overview({ fresh: true });
  assert.equal(await reads(), 2, 'Check again reads it afresh');
  await integrations.overview();
  assert.equal(await reads(), 2, 'and the fresh read is what is reused now');
  assert.deepEqual(await world.calls(), []);
});

test('the list reuses the login shell for a short time only', async () => {
  const world = await setup();
  const shell = join(world.root, 'fake-shell');
  const log = join(world.root, 'shell.log');
  await writeFile(shell, `#!/bin/sh\necho run >> ${log}\necho "PATH=${world.bin}"\n`);
  await chmod(shell, 0o755);
  let time = Date.parse('2026-01-01T00:00:00Z');
  const integrations = world.create({}, { readLoginShell: true, shell, now: () => new Date(time) });
  await integrations.overview();
  time += 30_000;
  await integrations.overview();
  time += 31_000;
  await integrations.overview();
  assert.equal((await readFile(log, 'utf8')).split('\n').filter(Boolean).length, 2, 'read at 0 s, reused at 30 s, read again at 61 s');
});

test('the list says where each app is and what the records say: nothing connected at first, a pending record needs attention', async () => {
  const world = await setup({ commands: ['claude'] });
  const overview = await world.integrations.overview();
  const claude = claudeOf(overview);
  assert.equal(claude.executable, join(world.bin, 'claude'));
  assert.equal(claude.website, 'claude.com/claude-code');
  assert.deepEqual(claude.targets.map(target => [target.id, target.recorded, target.pending, target.stale]), [['claude', false, false, false]]);
  assert.equal(overview.apps.find(app => app.id === 'codex').present, false);
  assert.equal(overview.other.skillFolder, join(world.source, 'skills', 'opendoc'));
  assert.equal(overview.other.skillFolderExists, true);
  assert.equal(overview.other.command, null);
  await world.integrations.connect(['claude']);
  const connected = claudeOf(await world.integrations.overview());
  assert.deepEqual(connected.targets.map(target => [target.id, target.recorded, target.pending]), [['claude', true, false]]);
  await writeFile(world.integrations.manifestFile, JSON.stringify({ ...(await world.manifest()), apps: { claude: { ...(await world.manifest()).apps.claude, pending: true } } }));
  assert.equal(claudeOf(await world.integrations.overview()).targets[0].pending, true);
});

test('the opendoc command is found on the path as a file, without running it', async () => {
  const world = await setup({ commands: [] });
  const file = join(world.bin, 'opendoc');
  await writeFile(file, `#!/bin/sh\necho ran >> ${join(world.root, 'ran')}\n`);
  await chmod(file, 0o755);
  assert.equal((await world.integrations.overview()).other.command, file);
  await assert.rejects(stat(join(world.root, 'ran')), { code: 'ENOENT' }, 'looking it up did not run it');
});

test('Claude Code folders: the default, every ~/.claude-<name> that holds settings, and nothing else', async () => {
  const world = await setup({ commands: ['claude'] });
  await world.settingsFolder('.claude-Work');
  await world.settingsFolder('.claude-Projects', '.credentials.json');
  await mkdir(join(world.home, '.claude-Plugins', 'plugins'), { recursive: true });
  await mkdir(join(world.home, '.claude-Empty'), { recursive: true });
  await writeFile(join(world.home, '.claude-file'), '{}');
  await mkdir(join(world.home, '.claude-Notes'), { recursive: true });
  await writeFile(join(world.home, '.claude-Notes', 'notes.txt'), 'not a settings folder');
  await mkdir(join(world.home, '.claude-Odd', 'settings.json'), { recursive: true }); // a folder where a file belongs
  await mkdir(join(world.home, '.claude-'), { recursive: true });
  await writeFile(join(world.home, '.claude-', 'settings.json'), '{}'); // only the prefix: no name
  await mkdir(join(world.home, 'claude-Other'), { recursive: true });
  await writeFile(join(world.home, 'claude-Other', 'settings.json'), '{}'); // wrong prefix
  const targets = claudeOf(await world.integrations.overview()).targets;
  assert.deepEqual(targets.map(target => target.id), ['claude', 'claude@.claude-Plugins', 'claude@.claude-Projects', 'claude@.claude-Work']);
  assert.deepEqual(targets.map(target => target.label), ['~/.claude', '~/.claude-Plugins', '~/.claude-Projects', '~/.claude-Work']);
  assert.match(targets[0].note, /claude command in a terminal uses, unless CLAUDE_CONFIG_DIR is set/);
  assert.deepEqual(targets.map(target => target.configFolder), [join(world.home, '.claude'), join(world.home, '.claude-Plugins'), join(world.home, '.claude-Projects'), join(world.home, '.claude-Work')]);
  assert.equal(targets[0].exists, false, 'the default folder is offered even before Claude Code has made it');
  assert.ok(targets.slice(1).every(target => target.exists && target.source === 'found'));
  assert.equal(await looksLikeSettingsFolder(join(world.home, '.claude-Notes'), claudeApp.multiFolder.markers), false);
});

test('Claude Code folders: a symbolic link to a settings folder counts, and the folder CLAUDE_CONFIG_DIR names is one more', async () => {
  const world = await setup({ commands: ['claude'] });
  const real = join(world.root, 'real-profile');
  await mkdir(real, { recursive: true });
  await writeFile(join(real, 'CLAUDE.md'), '# notes');
  await symlink(real, join(world.home, '.claude-Linked'));
  const elsewhere = join(world.root, 'elsewhere');
  const integrations = world.create({ CLAUDE_CONFIG_DIR: elsewhere });
  const targets = claudeOf(await integrations.overview()).targets;
  assert.deepEqual(targets.map(target => target.id), ['claude', 'claude@.claude-Linked', `claude@${elsewhere}`]);
  const named = targets[2];
  assert.deepEqual([named.source, named.terminal, named.exists, named.label], ['app environment', true, false, elsewhere]);
  assert.match(named.note, /Named by CLAUDE_CONFIG_DIR/);
  assert.equal(targets[0].terminal, false, 'a terminal uses the named folder, not ~/.claude');
  assert.match(targets[0].note, /CLAUDE_CONFIG_DIR points somewhere else/);
});

test('Claude Code folders: no folder is listed twice when the variable names one that is already there', async () => {
  const world = await setup({ commands: ['claude'] });
  const work = await world.settingsFolder('.claude-Work');
  const named = claudeOf(await world.create({ CLAUDE_CONFIG_DIR: work }).overview()).targets;
  assert.deepEqual(named.map(target => [target.id, target.terminal]), [['claude', false], ['claude@.claude-Work', true]]);
  assert.match(named[1].note, /CLAUDE_CONFIG_DIR points here/);
  const sameAsDefault = claudeOf(await world.create({ CLAUDE_CONFIG_DIR: join(world.home, '.claude') }).overview()).targets;
  assert.deepEqual(sameAsDefault.map(target => [target.id, target.terminal]), [['claude', true], ['claude@.claude-Work', false]]);
  // Written with a trailing slash or through a link, it is still the same folder.
  await symlink(work, join(world.root, 'link-to-work'));
  const linked = claudeOf(await world.create({ CLAUDE_CONFIG_DIR: join(world.root, 'link-to-work') }).overview()).targets;
  assert.deepEqual(linked.map(target => target.id), ['claude', 'claude@.claude-Work']);
});

test('the other apps keep one target each, in the folder their variable names', async () => {
  const world = await setup();
  const codexHome = join(world.root, 'codex-home');
  const overview = await world.create({ CODEX_HOME: codexHome }).overview();
  for (const app of overview.apps) assert.equal(app.targets.length, 1, app.id);
  assert.deepEqual(overview.apps.map(app => app.targets[0].id), ['claude', 'codex', 'antigravity', 'cursor', 'copilot']);
  assert.equal(overview.apps.find(app => app.id === 'codex').targets[0].configFolder, codexHome);
  assert.equal(overview.apps.find(app => app.id === 'cursor').targets[0].label, '~/.cursor');
});

test('connect in a second folder runs the vendor tool with CLAUDE_CONFIG_DIR set to it, and records it under its own id', async () => {
  const world = await setup({ commands: ['claude'] });
  const work = await world.settingsFolder('.claude-Work');
  const outcome = await world.integrations.connect(['claude@.claude-Work']);
  assert.equal(outcome.ok, true, JSON.stringify(outcome, null, 1));
  const [result] = outcome.results;
  assert.deepEqual([result.app, result.target, result.targetLabel, result.code], ['claude', 'claude@.claude-Work', '~/.claude-Work', 'connected']);
  const calls = await world.claudeCalls();
  assert.ok(calls.length > 0 && calls.every(call => call.CLAUDE_CONFIG_DIR === work && call.HOME === world.home), 'every command ran for that folder');
  assert.ok(result.steps.every(step => !step.command || step.command.startsWith(`CLAUDE_CONFIG_DIR=${work} claude `)), 'the steps say which folder');
  const manifest = await world.manifest();
  assert.deepEqual(Object.keys(manifest.apps), ['claude@.claude-Work']);
  assert.deepEqual([manifest.apps['claude@.claude-Work'].configFolder, manifest.apps['claude@.claude-Work'].environment], [work, { CLAUDE_CONFIG_DIR: work }]);
  assert.equal(JSON.parse(await readFile(join(work, 'fake-claude.json'), 'utf8')).plugins.length, 1);
  await assert.rejects(stat(join(world.home, '.claude', 'fake-claude.json')), { code: 'ENOENT' }, '~/.claude was not touched');
  const overview = claudeOf(await world.integrations.overview());
  assert.deepEqual(overview.targets.map(target => [target.id, target.recorded]), [['claude', false], ['claude@.claude-Work', true]]);
});

test('two folders connect together, each with its own record, and disconnect one at a time with the vendor tool run for that folder', async () => {
  const world = await setup({ commands: ['claude'] });
  const work = await world.settingsFolder('.claude-Work');
  const outcome = await world.integrations.connect(['claude', 'claude@.claude-Work']);
  assert.equal(outcome.ok, true, JSON.stringify(outcome, null, 1));
  assert.deepEqual(outcome.results.map(item => [item.target, item.code]), [['claude', 'connected'], ['claude@.claude-Work', 'connected']]);
  assert.deepEqual(Object.keys((await world.manifest()).apps).sort(), ['claude', 'claude@.claude-Work']);
  const home = (await world.claudeCalls()).filter(call => call.CLAUDE_CONFIG_DIR === null);
  assert.ok(home.length > 0, 'the plain ~/.claude ran with the variable unset');

  const removed = await world.integrations.disconnect(['claude@.claude-Work']);
  assert.equal(removed.ok, true, JSON.stringify(removed, null, 1));
  assert.deepEqual(removed.results.map(item => [item.target, item.code]), [['claude@.claude-Work', 'disconnected']]);
  assert.deepEqual(JSON.parse(await readFile(join(work, 'fake-claude.json'), 'utf8')), { marketplaces: [], plugins: [] });
  assert.equal(JSON.parse(await readFile(join(world.home, '.claude', 'fake-claude.json'), 'utf8')).plugins.length, 1, 'the other folder stays connected');
  assert.deepEqual(Object.keys((await world.manifest()).apps), ['claude']);
  await stat(join(world.data, 'integrations')); // the stable copy stays while a folder uses it

  assert.equal((await world.integrations.disconnect(['claude'])).ok, true);
  await assert.rejects(stat(world.integrations.manifestFile), { code: 'ENOENT' });
  await assert.rejects(stat(join(world.data, 'integrations')), { code: 'ENOENT' }, 'the copy goes with the last folder');
});

test('a folder named by CLAUDE_CONFIG_DIR is its own target, connected with that variable, and the default stays separate', async () => {
  const world = await setup({ commands: ['claude'] });
  const elsewhere = join(world.root, 'elsewhere');
  const integrations = world.create({ CLAUDE_CONFIG_DIR: elsewhere });
  const id = `claude@${elsewhere}`;
  const outcome = await integrations.connect([id]);
  assert.equal(outcome.ok, true, JSON.stringify(outcome, null, 1));
  assert.ok((await world.claudeCalls()).every(call => call.CLAUDE_CONFIG_DIR === elsewhere));
  assert.deepEqual(Object.keys((await world.manifest()).apps), [id]);
  assert.equal((await integrations.disconnect([id])).ok, true);
});

test('the read-only check of one app runs for that app only, once for each of its folders', async () => {
  const world = await setup();
  const work = await world.settingsFolder('.claude-Work');
  await world.integrations.connect(['claude@.claude-Work']);
  const before = (await world.calls()).length;
  const checked = await world.integrations.checkApp('claude');
  const calls = (await world.calls()).slice(before);
  assert.ok(calls.every(call => call.tool === 'claude' && call.args.includes('list')), 'only read-only list commands, only for Claude Code');
  assert.deepEqual([...new Set(calls.map(call => call.CLAUDE_CONFIG_DIR))].sort((a, b) => String(a).localeCompare(String(b))), [null, work].sort((a, b) => String(a).localeCompare(String(b))));
  assert.deepEqual(checked.status.targets.map(target => [target.id, target.connected, target.managed]), [['claude', false, false], ['claude@.claude-Work', true, true]]);
  assert.equal(checked.status.connected, true, 'an app is connected when any folder is');
  assert.deepEqual(checked.app.targets.map(target => target.id), ['claude', 'claude@.claude-Work']);
  assert.deepEqual(await world.calls().then(all => all.slice(before + calls.length)), []);
  assert.equal((await world.integrations.checkApp('nothing')).app, null);
});

test('a record from before targets existed is the ~/.claude target, with nothing to migrate', async () => {
  const world = await setup({ commands: ['claude'] });
  await world.integrations.connect(['claude']);
  // The file an earlier version wrote: apps.claude, folder ~/.claude, CLAUDE_CONFIG_DIR null.
  const old = await world.manifest();
  assert.deepEqual([old.apps.claude.configFolder, old.apps.claude.environment], [join(world.home, '.claude'), { CLAUDE_CONFIG_DIR: null }]);
  await world.settingsFolder('.claude-Work');
  const again = world.create();
  const overview = claudeOf(await again.overview());
  assert.deepEqual(overview.targets.map(target => [target.id, target.recorded]), [['claude', true], ['claude@.claude-Work', false]]);
  const status = (await again.status()).apps.find(app => app.id === 'claude');
  assert.deepEqual(status.targets.map(target => [target.id, target.connected, target.managed]), [['claude', true, true], ['claude@.claude-Work', false, false]]);
  const removed = await again.disconnect(['claude']);
  assert.deepEqual(removed.results.map(item => [item.target, item.ok, item.code]), [['claude', true, 'disconnected']]);
  assert.deepEqual(JSON.parse(await readFile(join(world.home, '.claude', 'fake-claude.json'), 'utf8')), { marketplaces: [], plugins: [] });
});

test('a record that pinned another folder (an earlier version with CLAUDE_CONFIG_DIR set) is read as that folder\'s target', async () => {
  const world = await setup({ commands: ['claude'] });
  const work = await world.settingsFolder('.claude-Work');
  await world.integrations.connect(['claude@.claude-Work']);
  // An earlier version kept this under `claude`, pinning the folder in the record.
  const file = world.integrations.manifestFile;
  const written = await world.manifest();
  written.apps = { claude: written.apps['claude@.claude-Work'] };
  await writeFile(file, JSON.stringify(written));
  const again = world.create();
  const overview = claudeOf(await again.overview());
  assert.deepEqual(overview.targets.map(target => [target.id, target.recorded]), [['claude', false], ['claude@.claude-Work', true]]);
  const removed = await again.disconnect(['claude@.claude-Work']);
  assert.deepEqual(removed.results.map(item => [item.ok, item.code]), [[true, 'disconnected']], JSON.stringify(removed, null, 1));
  assert.deepEqual(JSON.parse(await readFile(join(work, 'fake-claude.json'), 'utf8')), { marketplaces: [], plugins: [] });
});

test('ids that detection did not find are refused: an unknown folder, a folder without settings, a path, a made-up app', async () => {
  const world = await setup({ commands: ['claude'] });
  await mkdir(join(world.home, '.claude-Empty'), { recursive: true });
  const outside = join(world.root, 'outside');
  await mkdir(outside, { recursive: true });
  const ask = [`claude@.claude-Nope`, 'claude@.claude-Empty', `claude@${outside}`, 'claude@../outside', outside, join(world.home, '.claude-Work'), 'nothing@.claude-Work'];
  const connected = await world.integrations.connect(ask);
  assert.equal(connected.ok, false);
  assert.deepEqual(connected.results.map(item => [item.code]), [['unknown-app'], ['unknown-app'], ['unknown-app'], ['unknown-target'], ['unknown-target'], ['unknown-target'], ['unknown-target']]);
  const disconnected = await world.integrations.disconnect(ask);
  assert.deepEqual(disconnected.results.map(item => item.code), ['unknown-target', 'unknown-target', 'unknown-target', 'unknown-target', 'unknown-app', 'unknown-app', 'unknown-app']);
  assert.deepEqual(await world.calls(), [], 'no vendor command ran');
  await assert.rejects(stat(world.integrations.manifestFile), { code: 'ENOENT' });
  await assert.rejects(stat(outside + '/fake-claude.json'), { code: 'ENOENT' });
  await assert.rejects(stat(join(world.root, 'outside', 'plugins')), { code: 'ENOENT' });
});

test('a recorded folder that is not found any more can still be disconnected or forgotten by its id', async () => {
  const world = await setup({ commands: ['claude'] });
  const work = await world.settingsFolder('.claude-Work');
  await world.integrations.connect(['claude@.claude-Work']);
  await rename(work, join(world.root, 'moved-away'));
  const overview = claudeOf(await world.integrations.overview());
  const gone = overview.targets.find(target => target.id === 'claude@.claude-Work');
  assert.deepEqual([gone.recorded, gone.exists], [true, false]);
  const forgotten = await world.integrations.disconnect(['claude@.claude-Work'], { forget: true });
  assert.deepEqual(forgotten.results.map(item => [item.target, item.code]), [['claude@.claude-Work', 'forgotten']]);
  assert.deepEqual(claudeOf(await world.integrations.overview()).targets.map(target => target.id), ['claude']);
});

test('the startup refresh covers every Claude Code folder: no vendor command, and both records follow the new files', async () => {
  const world = await setup({ commands: ['claude'] });
  await world.settingsFolder('.claude-Work');
  assert.equal((await world.integrations.connect(['claude', 'claude@.claude-Work'])).ok, true);
  const before = (await world.calls()).length;
  for (const path of ['skills/opendoc/SKILL.md', 'claude/opendoc/skills/opendoc/SKILL.md', 'codex/opendoc/skills/opendoc/SKILL.md']) {
    await writeFile(join(world.source, path), `${await readFile(join(world.source, path), 'utf8')}\nA line from a newer app.\n`);
  }
  const refreshed = await world.integrations.refresh();
  assert.equal(refreshed.ok, true, JSON.stringify(refreshed, null, 1));
  assert.deepEqual(refreshed.results.map(item => [item.target, item.code]), [['claude', 'refreshed'], ['claude@.claude-Work', 'refreshed']]);
  assert.equal((await world.calls()).length, before, 'Claude Code reads the plugin in place: nothing was run');
  const manifest = await world.manifest();
  assert.deepEqual(Object.values(manifest.apps).map(record => record.copyDigest), [manifest.copy.digest, manifest.copy.digest]);
  const status = await world.integrations.status({ verify: false });
  assert.deepEqual(status.apps.find(app => app.id === 'claude').targets.map(target => target.stale), [false, false]);
  assert.equal((await world.integrations.refresh()).changed, false);
});

test('after the copy changes without a refresh of the records, each folder shows its own update', async () => {
  const world = await setup({ commands: ['claude'] });
  await world.settingsFolder('.claude-Work');
  await world.integrations.connect(['claude', 'claude@.claude-Work']);
  const file = world.integrations.manifestFile;
  const written = await world.manifest();
  written.apps['claude@.claude-Work'].copyDigest = 'older';
  await writeFile(file, JSON.stringify(written));
  const overview = claudeOf(await world.integrations.overview());
  assert.deepEqual(overview.targets.map(target => [target.id, target.stale]), [['claude', false], ['claude@.claude-Work', true]]);
});
