// "Connect your AI apps", below the screen: the module's options, the rows the screen draws, and what Connect, Disconnect and
// Forget do through the real integration module with fake vendor commands. Every world is scratch: its own home, XDG folders, data
// folder and PATH, with the login shell not read, so nothing here can reach the real Claude Code or Codex.
import assert from 'node:assert/strict';
import { mkdir, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { test } from 'node:test';
import { AiApps, cleanIds, describeApp, integrationOptions, refreshProblem } from '../../../src/main/ai-apps.mjs';
import { aiAppsOffered, createConfig, markAiAppsOffered } from '../../../src/main/config.mjs';
import { createIntegrations } from '../../../src/main/integrations/index.mjs';
import { fakeCommand, scratch } from './integrations-support.mjs';

async function setup({ commands = ['claude', 'codex', 'agy'], mode = '' } = {}) {
  const world = await scratch();
  for (const name of commands) await fakeCommand(world, name);
  world.apps = new AiApps(createIntegrations(world.options({ env: world.env(mode ? { FAKE_MODE: mode } : {}) })));
  world.byId = info => Object.fromEntries(info.apps.map(app => [app.id, app]));
  return world;
}

test('an installed app gets the app\'s data folder, build number and its own integration files', () => {
  const options = integrationOptions({ packaged: true, resourcesPath: '/opt/app/resources', dataDir: '/data/app', build: 7, env: {} });
  assert.deepEqual(options, { dataDirectory: '/data/app', build: 7, sourceDirectory: '/opt/app/resources/integrations' });
});

test('a development run leaves the source folder to the module (desktop/integrations)', () => {
  const options = integrationOptions({ packaged: false, resourcesPath: '/electron/resources', dataDir: '/data/app', build: null, env: {} });
  assert.deepEqual(options, { dataDirectory: '/data/app', build: null });
});

test('the test options file is read by an unpackaged run only, takes the listed names only, and keeps the login shell off unless told', () => {
  const file = '/tmp/options.json';
  const given = { home: '/scratch/home', env: { PATH: '/scratch/bin' }, extraPathDirectories: [], sourceDirectory: '/scratch/source', commandTimeoutMs: 5000, somethingElse: 'ignored' };
  const env = { OPENDOC_DESKTOP_INTEGRATIONS_OPTIONS: file };
  const readText = path => { assert.equal(path, file); return JSON.stringify(given); };
  const options = integrationOptions({ packaged: false, resourcesPath: '/x', dataDir: '/data', build: 3, env, readText });
  assert.deepEqual(options, { dataDirectory: '/data', build: 3, readLoginShell: false, home: '/scratch/home', env: { PATH: '/scratch/bin' }, extraPathDirectories: [], sourceDirectory: '/scratch/source', commandTimeoutMs: 5000 });
  assert.equal(integrationOptions({ packaged: false, resourcesPath: '/x', dataDir: '/data', build: 3, env, readText: () => JSON.stringify({ readLoginShell: true }) }).readLoginShell, true);

  // An installed app never reads it: a variable in its environment changes nothing.
  const packaged = integrationOptions({ packaged: true, resourcesPath: '/opt/app/resources', dataDir: '/data', build: 3, env, readText: () => { throw new Error('a packaged app must not read the file'); } });
  assert.deepEqual(packaged, { dataDirectory: '/data', build: 3, sourceDirectory: '/opt/app/resources/integrations' });
});

test('a page can name known apps only, each once', () => {
  assert.deepEqual(cleanIds(['claude', 'claude', 'codex', 'rm -rf', 5, null, 'constructor']), ['claude', 'codex']);
  assert.deepEqual(cleanIds('claude'), []);
  assert.deepEqual(cleanIds(undefined), []);
});

test('the state of a row follows what was found and what this app recorded', () => {
  const found = { id: 'claude', name: 'Claude Code', present: true, canConnect: true, reason: 'Found claude.' };
  const missing = { id: 'codex', name: 'Codex', present: false, canConnect: false, reason: 'No codex.' };
  const state = (detected, checked) => describeApp(detected, checked).state;
  assert.equal(state(found, { managed: false, connected: false }), 'available');
  assert.equal(state(found, { managed: false, connected: null }), 'available');
  assert.equal(state(missing, { managed: false, connected: null }), 'absent');
  assert.equal(state(found, { managed: true, connected: true }), 'connected');
  assert.equal(state(found, { managed: false, connected: true }), 'outside');
  assert.equal(state(found, { managed: true, connected: false }), 'broken');
  assert.equal(state(found, { managed: true, connected: null }), 'broken');
  assert.equal(state(found, { managed: true, connected: true, problem: 'A connect did not finish.' }), 'broken');
  assert.equal(state(missing, { managed: true, connected: null }), 'gone');
  assert.equal(describeApp(found, { managed: true, connected: true, stale: true }).stale, true);
});

test('the screen lists every app: found ones can be connected, the others say why not, and nothing is connected', async () => {
  const world = await setup({ commands: ['claude', 'codex'] });
  const info = world.byId(await world.apps.info());
  assert.deepEqual(Object.keys(info), ['claude', 'codex', 'antigravity', 'cursor', 'copilot']);
  assert.deepEqual([info.claude.state, info.codex.state], ['available', 'available']);
  assert.deepEqual([info.claude.canConnect, info.codex.canConnect], [true, true]);
  for (const id of ['antigravity', 'cursor', 'copilot']) {
    assert.equal(info[id].state, 'absent', id);
    assert.equal(info[id].canConnect, false, id);
    assert.match(info[id].reason, /no .* command on the search path/i, `${id} says why it is absent`);
  }
  assert.ok(Object.values(info).every(app => app.managed === false && app.connected !== true));
  // Looking runs nothing but read-only `list` commands.
  const calls = await world.calls();
  assert.ok(calls.every(call => call.args.includes('list')), JSON.stringify(calls.map(call => call.args)));
});

test('Connect: the apps asked for are connected, the others untouched, and the row says so', async () => {
  const world = await setup();
  const outcome = await world.apps.connect(['claude', 'codex']);
  assert.equal(outcome.ok, true, JSON.stringify(outcome, null, 1));
  assert.deepEqual(outcome.results.map(item => [item.app, item.code]), [['claude', 'connected'], ['codex', 'connected']]);
  assert.ok(outcome.results.every(item => item.steps.length > 0 && item.steps.every(step => typeof step.label === 'string' && 'command' in step && 'output' in step)));
  const info = world.byId(await world.apps.info());
  assert.deepEqual([info.claude.state, info.codex.state, info.antigravity.state], ['connected', 'connected', 'available']);
  assert.equal(info.claude.stale, false);
  assert.ok(!(await world.calls()).some(call => call.tool === 'agy' && !call.args.includes('list')), 'an app that was not asked for was not touched');
});

test('Connect with nothing named does nothing, and an unknown name is not passed on', async () => {
  const world = await setup();
  assert.deepEqual((await world.apps.connect([])).results, []);
  assert.deepEqual((await world.apps.connect(['not-an-app'])).results, []);
  assert.deepEqual(await world.calls(), []);
});

test('Disconnect is the undo: the app is available again and the vendor\'s own command ran', async () => {
  const world = await setup();
  await world.apps.connect(['claude']);
  const outcome = await world.apps.disconnect(['claude']);
  assert.deepEqual(outcome.results.map(item => [item.app, item.ok, item.code]), [['claude', true, 'disconnected']]);
  assert.ok(outcome.results[0].steps.some(step => /plugin uninstall/.test(step.command ?? '')));
  assert.equal(world.byId(await world.apps.info()).claude.state, 'available');
  assert.deepEqual((await world.apps.disconnect(['claude'])).results.map(item => item.code), ['not-connected']);
});

test('an app that is blocked by a policy says so, with the vendor\'s words in the failing step, and nothing stays behind', async () => {
  const world = await setup({ mode: 'policy' });
  const outcome = await world.apps.connect(['claude']);
  assert.equal(outcome.ok, false);
  const [claude] = outcome.results;
  assert.deepEqual([claude.ok, claude.code], [false, 'blocked']);
  const failing = claude.steps.find(step => step.ok === false);
  assert.match(failing.output, /managed settings/);
  assert.match(failing.command, /plugin marketplace add/);
  assert.equal(world.byId(await world.apps.info()).claude.state, 'available', 'no record is left');
});

test('an app whose install fails is reported as failed with its output, and what had been added is removed again', async () => {
  const world = await setup({ mode: 'fail-install' });
  const outcome = await world.apps.connect(['claude']);
  const [claude] = outcome.results;
  assert.deepEqual([claude.ok, claude.code], [false, 'failed']);
  assert.match(claude.steps.find(step => step.ok === false).output, /could not be loaded/);
  assert.match(claude.summary, /removed again/);
  assert.equal(world.byId(await world.apps.info()).claude.state, 'available');
});

test('an app that is not there cannot be connected, and the result says why', async () => {
  const world = await setup({ commands: ['claude'] });
  const outcome = await world.apps.connect(['codex']);
  assert.deepEqual(outcome.results.map(item => [item.app, item.ok, item.code]), [['codex', false, 'absent']]);
  assert.match(outcome.results[0].summary, /no codex command/i);
});

test('OpenDoc installed outside this app shows as such and is not touched by Disconnect', async () => {
  const world = await setup({ commands: ['claude'] });
  // Another copy of the app (its own data folder) installed it first.
  const other = createIntegrations(world.options({ dataDirectory: join(world.root, 'other-data'), env: world.env() }));
  assert.equal((await other.connect(['claude'])).ok, true);
  const info = world.byId(await world.apps.info());
  assert.equal(info.claude.state, 'outside');
  assert.equal(info.claude.managed, false);
  assert.deepEqual((await world.apps.disconnect(['claude'])).results.map(item => item.code), ['not-connected']);
  assert.equal(world.byId(await world.apps.info()).claude.state, 'outside', 'it is still installed');
});

test('an app that is gone shows as such; Forget drops the record and runs nothing', async () => {
  const world = await setup({ commands: ['claude'] });
  assert.equal((await world.apps.connect(['claude'])).ok, true);
  await rm(join(world.bin, 'claude'));
  const gone = world.byId(await world.apps.info()).claude;
  assert.deepEqual([gone.state, gone.managed, gone.canConnect], ['gone', true, false]);
  const before = (await world.calls()).length;
  const forgotten = await world.apps.disconnect(['claude'], { forget: true });
  assert.deepEqual(forgotten.results.map(item => item.code), ['forgotten']);
  assert.equal((await world.calls()).length, before, 'no vendor command ran');
  assert.equal(world.byId(await world.apps.info()).claude.state, 'absent');
});

test('without Forget, an app that is gone cannot be disconnected and the result points to Forget', async () => {
  const world = await setup({ commands: ['claude'] });
  await world.apps.connect(['claude']);
  await rm(join(world.bin, 'claude'));
  const [result] = (await world.apps.disconnect(['claude'])).results;
  assert.deepEqual([result.ok, result.code], [false, 'not-found']);
  assert.match(result.summary, /drop this app's record/);
});

test('a connect that was cut short shows as needing attention, and Disconnect cleans it up', async () => {
  const world = await setup({ commands: ['claude'] });
  await world.apps.connect(['claude']);
  const manifest = join(world.data, 'integrations.json');
  const record = JSON.parse(await readFile(manifest, 'utf8'));
  record.apps.claude.pending = true;
  await writeFile(manifest, JSON.stringify(record));
  const row = world.byId(await world.apps.info()).claude;
  assert.equal(row.state, 'broken');
  assert.match(row.problem, /did not finish/);
  assert.deepEqual((await world.apps.disconnect(['claude'])).results.map(item => item.code), ['disconnected']);
});

test('after an app update the files an app holds are older: the row says an update is available, and connecting again brings it up to date', async () => {
  const world = await setup({ commands: ['codex'] });
  await world.apps.connect(['codex']);
  const changed = join(world.source, 'skills', 'opendoc', 'SKILL.md');
  await writeFile(changed, `${await readFile(changed, 'utf8')}\nA new line from a newer app.\n`);
  // The stable copy still holds the old files and the record matches it, so nothing is stale until the app's own refresh makes the copy.
  const refreshed = await world.apps.integrations.refresh({ reinstall: false });
  assert.equal(refreshed.ok, true);
  const stale = world.byId(await world.apps.info()).codex;
  assert.deepEqual([stale.state, stale.stale], ['connected', true]);
  const again = await world.apps.connect(['codex']);
  assert.equal(again.results[0].ok, true);
  assert.equal(world.byId(await world.apps.info()).codex.stale, false);
});

test('the startup refresh does nothing when nothing is connected, and runs no vendor command', async () => {
  const world = await setup();
  const lines = [];
  const apps = new AiApps(world.apps.integrations, { log: line => lines.push(line) });
  const result = await apps.refresh();
  assert.equal(result.ok, true);
  assert.equal(refreshProblem(result), null);
  assert.deepEqual(await world.calls(), []);
  assert.match(lines[0], /^refresh: ok/);
});

test('the startup refresh reinstalls what keeps its own copy, and logs each result', async () => {
  const world = await setup({ commands: ['codex'] });
  await world.apps.connect(['codex']);
  const changed = join(world.source, 'skills', 'opendoc', 'SKILL.md');
  await writeFile(changed, `${await readFile(changed, 'utf8')}\nNewer.\n`);
  const lines = [];
  const apps = new AiApps(world.apps.integrations, { log: line => lines.push(line) });
  const result = await apps.refresh();
  assert.equal(result.ok, true, JSON.stringify(result, null, 1));
  assert.deepEqual(result.results.map(item => [item.app, item.code]), [['codex', 'refreshed']]);
  assert.ok(lines.some(line => line.startsWith('refresh codex: ok (refreshed)')));
  assert.equal(world.byId(await world.apps.info()).codex.stale, false);
});

test('a failed startup refresh of a connected app is a problem to show; one for an app that is gone is not', () => {
  assert.equal(refreshProblem({ ok: true, results: [] }), null);
  assert.deepEqual(refreshProblem({ ok: false, results: [{ ok: false, code: 'failed', name: 'Codex', summary: 'It did not work.' }, { ok: true, code: 'refreshed', name: 'Claude Code', summary: 'fine' }] }), ['Codex: It did not work.']);
  assert.equal(refreshProblem({ ok: false, results: [{ ok: false, code: 'absent', name: 'Codex', summary: 'Codex was not found.' }] }), null);
  assert.deepEqual(refreshProblem({ ok: false, results: [], summary: 'The integration files could not be copied.' }), ['The integration files could not be copied.']);
});

test('a startup refresh that throws is reported as a failed result, not thrown', async () => {
  const apps = new AiApps({ detect() {}, refresh: async () => { throw new Error('boom'); } });
  const result = await apps.refresh();
  assert.equal(result.ok, false);
  assert.match(refreshProblem(result)[0], /boom/);
});

test('the first-run flag: absent until the screen is shown, true afterwards, and other keys survive', async () => {
  const world = await scratch();
  const config = createConfig(join(world.root, 'profile', 'config.json'));
  assert.equal(await aiAppsOffered(config), false);
  await config.update({ defaultWorkspace: '/somewhere' });
  assert.equal(await aiAppsOffered(config), false);
  await markAiAppsOffered(config);
  assert.equal(await aiAppsOffered(config), true);
  assert.deepEqual(await config.read(), { defaultWorkspace: '/somewhere', aiAppsOffered: true });
  await markAiAppsOffered(config); // Skip records it again: harmless
  assert.equal(await aiAppsOffered(config), true);
  assert.equal((await stat(config.file)).mode & 0o777, 0o600);
  await mkdir(join(world.root, 'other'), { recursive: true });
  await writeFile(join(world.root, 'other', 'config.json'), JSON.stringify({ aiAppsOffered: 'yes' }));
  assert.equal(await aiAppsOffered(createConfig(join(world.root, 'other', 'config.json'))), false, 'only the boolean true counts');
});
