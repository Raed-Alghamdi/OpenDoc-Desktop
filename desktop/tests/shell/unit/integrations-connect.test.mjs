import assert from 'node:assert/strict';
import { chmod, mkdir, readFile, realpath, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { createIntegrations } from '../../../src/main/integrations/index.mjs';
import { runProgram } from '../../../src/main/integrations/run.mjs';
import { dump, fakeCommand, listing, scratch } from './integrations-support.mjs';

/** A world with the three fake vendor commands on the path and a config folder for Claude Code and Codex. */
async function setup(extraEnv = {}, options = {}) {
  const world = await scratch();
  for (const name of ['claude', 'codex', 'agy']) await fakeCommand(world, name);
  world.claudeConfig = join(world.root, 'claude-config');
  world.codexHome = join(world.root, 'codex-home');
  world.integrations = createIntegrations(world.options({ env: world.env({ CLAUDE_CONFIG_DIR: world.claudeConfig, CODEX_HOME: world.codexHome, ...extraEnv }), ...options }));
  world.manifest = async () => JSON.parse(await readFile(world.integrations.manifestFile, 'utf8'));
  world.vendorCalls = async tool => (await world.calls()).filter(call => call.tool === tool).map(call => call.args.join(' '));
  return world;
}

test('Claude Code: connect adds the marketplace from the stable copy, installs, verifies and records', async () => {
  const world = await setup();
  const outcome = await world.integrations.connect(['claude']);
  assert.equal(outcome.ok, true, JSON.stringify(outcome, null, 1));
  const [claude] = outcome.results;
  assert.deepEqual([claude.app, claude.ok, claude.code, claude.changed], ['claude', true, 'connected', true]);
  assert.match(claude.summary, /Installed opendoc@opendoc in Claude Code \(version 1\.0\.0\)/);
  assert.deepEqual(claude.steps.map(step => step.ok), claude.steps.map(() => true));
  assert.ok(claude.steps.some(step => step.command === `claude plugin marketplace add ${join(world.data, 'integrations', 'claude')}`), 'the marketplace is the stable copy, never the app bundle');
  assert.ok(claude.steps.every(step => !step.command || !step.command.includes(world.source)), 'nothing points at the source');
  assert.equal(outcome.copy.ok, true);
  const calls = await world.calls();
  assert.ok(calls.every(call => call.CLAUDE_CONFIG_DIR === world.claudeConfig && call.HOME === world.home), 'the user\'s config folder is passed through');
  assert.ok(calls.every(call => call.XDG.every(folder => folder.startsWith(world.home))), 'the XDG variables of the scratch world reach the vendor command, so nothing resolves to real folders');

  const manifest = await world.manifest();
  assert.equal(manifest.version, 1);
  assert.equal(manifest.copy.path, join(world.data, 'integrations'));
  assert.deepEqual(Object.keys(manifest.apps), ['claude']);
  const record = manifest.apps.claude;
  assert.deepEqual(record.marketplace, { name: 'opendoc', path: join(world.data, 'integrations', 'claude') });
  assert.equal(record.plugin.id, 'opendoc@opendoc');
  assert.equal(record.pending, undefined);
  assert.deepEqual(record.environment, { CLAUDE_CONFIG_DIR: world.claudeConfig });
  assert.equal((await stat(world.integrations.manifestFile)).mode & 0o777, 0o600);
});

test('Claude Code: disconnect removes exactly what connect added, and nothing mentions OpenDoc afterwards', async () => {
  const world = await setup();
  await world.integrations.connect(['claude']);
  const before = await dump(world.claudeConfig);
  assert.match(before, /opendoc/);
  const outcome = await world.integrations.disconnect(['claude']);
  assert.equal(outcome.ok, true, JSON.stringify(outcome, null, 1));
  assert.equal(outcome.results[0].code, 'disconnected');
  assert.ok(outcome.results[0].steps.some(step => step.label === 'Remove the unused plugin copy'), 'the folder Claude Code keeps after an uninstall is removed');
  assert.ok(!(await dump(world.claudeConfig)).replaceAll(world.root, '').match(/opendoc/i), 'no file or folder in the config folder mentions OpenDoc');
  assert.deepEqual((await listing(world.claudeConfig)).filter(name => /opendoc/i.test(name)), []);
  assert.deepEqual(JSON.parse(await readFile(join(world.claudeConfig, 'fake-claude.json'), 'utf8')), { marketplaces: [], plugins: [] });
  await assert.rejects(stat(world.integrations.manifestFile), { code: 'ENOENT' }, 'an empty manifest is removed');
  await assert.rejects(stat(join(world.data, 'integrations')), { code: 'ENOENT' }, 'the stable copy goes with the last app');
  await world.integrations.status();
  await assert.rejects(stat(world.data), { code: 'ENOENT' }, 'the data folder this app made is gone too, and checking the status does not bring it back');
});

test('Codex: connect, verify through plugin list, disconnect, with CODEX_HOME passed through', async () => {
  const world = await setup();
  const outcome = await world.integrations.connect(['codex']);
  assert.equal(outcome.ok, true, JSON.stringify(outcome, null, 1));
  assert.ok(outcome.results[0].steps.some(step => step.command === `codex plugin marketplace add ${join(world.data, 'integrations', 'codex')}`));
  assert.ok((await world.calls()).every(call => call.CODEX_HOME === world.codexHome));
  assert.ok((await world.vendorCalls('codex')).includes('plugin list --json'));
  const manifest = await world.manifest();
  assert.equal(manifest.apps.codex.plugin.id, 'opendoc@opendoc');

  const removed = await world.integrations.disconnect(['codex']);
  assert.equal(removed.ok, true, JSON.stringify(removed, null, 1));
  assert.deepEqual((await listing(world.codexHome)).filter(name => /opendoc/.test(name)), [], 'the empty cache folders Codex leaves are removed too');
  assert.deepEqual(JSON.parse(await readFile(join(world.codexHome, 'fake-codex.json'), 'utf8')), { marketplaces: [], plugins: [] });
});

test('Antigravity: install from the Codex plugin folder of the stable copy, HOME passed through, undo', async () => {
  const world = await setup();
  const outcome = await world.integrations.connect(['antigravity']);
  assert.equal(outcome.ok, true, JSON.stringify(outcome, null, 1));
  assert.ok(outcome.results[0].steps.some(step => step.command === `agy plugin install ${join(world.data, 'integrations', 'codex', 'opendoc')}`));
  assert.ok((await world.calls()).every(call => call.HOME === world.home));
  assert.ok((await listing(join(world.home, '.gemini'))).includes('config/plugins/opendoc/'));
  const removed = await world.integrations.disconnect(['antigravity']);
  assert.equal(removed.ok, true);
  assert.deepEqual((await listing(join(world.home, '.gemini'))).filter(name => /opendoc/.test(name)), []);
});

test('Cursor and Copilot: the plain skill is copied to the one place, recorded, and removed with the folders this app made', async () => {
  const world = await setup();
  await mkdir(join(world.home, '.copilot'), { recursive: true });
  await writeFile(join(world.home, '.copilot', 'keep.txt'), 'mine');
  await mkdir(join(world.home, '.cursor'), { recursive: true });
  const outcome = await world.integrations.connect(['cursor', 'copilot']);
  assert.equal(outcome.ok, true, JSON.stringify(outcome, null, 1));
  const skill = await readFile(join(world.source, 'skills', 'opendoc', 'SKILL.md'), 'utf8');
  for (const folder of ['.cursor', '.copilot']) assert.equal(await readFile(join(world.home, folder, 'skills', 'opendoc', 'SKILL.md'), 'utf8'), skill);
  assert.deepEqual(await world.calls(), [], 'no vendor command runs for plain copies (cursor-agent and copilot are never run)');
  const manifest = await world.manifest();
  assert.equal(manifest.apps.cursor.destination, join(world.home, '.cursor', 'skills', 'opendoc'));
  assert.deepEqual(manifest.apps.cursor.files.map(file => file.path), ['SKILL.md']);
  assert.deepEqual(manifest.apps.cursor.createdFolders, [join(world.home, '.cursor', 'skills')]);
  assert.deepEqual(manifest.apps.copilot.createdFolders, [join(world.home, '.copilot', 'skills')]);

  const removed = await world.integrations.disconnect(['cursor', 'copilot']);
  assert.equal(removed.ok, true, JSON.stringify(removed, null, 1));
  assert.deepEqual(await listing(join(world.home, '.cursor')), [], 'the folder this app did not create is kept, now empty');
  assert.deepEqual(await listing(join(world.home, '.copilot')), ['keep.txt']);
});

test('a skill folder that did not exist is removed with the folders created for it', async () => {
  const world = await setup();
  await mkdir(join(world.home, '.cursor'));
  await world.integrations.connect(['cursor']);
  await world.integrations.disconnect(['cursor']);
  assert.deepEqual(await listing(join(world.home, '.cursor')), []);
});

test('undo keeps a skill file the user changed, and files the user added', async () => {
  const world = await setup();
  await mkdir(join(world.home, '.cursor'));
  await world.integrations.connect(['cursor']);
  const folder = join(world.home, '.cursor', 'skills', 'opendoc');
  await writeFile(join(folder, 'notes.md'), 'my notes');
  const kept = await world.integrations.disconnect(['cursor']);
  assert.equal(kept.ok, true, 'a file the user added is theirs');
  assert.deepEqual(await listing(folder), ['notes.md']);
  assert.ok(kept.results[0].steps.some(step => /Kept notes\.md/.test(step.output)));

  const second = await setup();
  await mkdir(join(second.home, '.cursor'));
  await second.integrations.connect(['cursor']);
  await writeFile(join(second.home, '.cursor', 'skills', 'opendoc', 'SKILL.md'), 'edited by hand');
  const refused = await second.integrations.disconnect(['cursor']);
  assert.equal(refused.ok, false);
  assert.equal(refused.results[0].code, 'modified');
  assert.match(refused.results[0].summary, /SKILL\.md/);
  assert.equal(await readFile(join(second.home, '.cursor', 'skills', 'opendoc', 'SKILL.md'), 'utf8'), 'edited by hand');
  assert.ok((await second.manifest()).apps.cursor, 'the record stays so undo can be tried again');
});

test('a skill folder that exists and is not this app\'s is left alone and not recorded', async () => {
  const world = await setup();
  await mkdir(join(world.home, '.cursor', 'skills', 'opendoc'), { recursive: true });
  await writeFile(join(world.home, '.cursor', 'skills', 'opendoc', 'SKILL.md'), 'mine');
  const outcome = await world.integrations.connect(['cursor']);
  assert.equal(outcome.ok, true);
  assert.equal(outcome.results[0].code, 'already-present');
  assert.equal(await readFile(join(world.home, '.cursor', 'skills', 'opendoc', 'SKILL.md'), 'utf8'), 'mine');
  await assert.rejects(stat(world.integrations.manifestFile), { code: 'ENOENT' });
  assert.equal((await world.integrations.disconnect(['cursor'])).results[0].code, 'not-connected');
});

test('a command that fails is reported with its output, and what had been added is undone', async () => {
  const world = await setup({ FAKE_MODE: 'fail-install' });
  const outcome = await world.integrations.connect(['claude', 'codex']);
  assert.equal(outcome.ok, false);
  for (const result of outcome.results) {
    assert.equal(result.ok, false);
    assert.equal(result.code, 'failed');
    const failedStep = result.steps.find(step => !step.ok);
    assert.match(failedStep.output, /could not be (loaded|installed)/, 'the vendor\'s own text is shown');
    assert.equal(failedStep.exitCode, 1);
    assert.match(result.summary, /Everything that had been added was removed again/);
    assert.ok(result.steps.some(step => step.label.startsWith('Undo: ')));
  }
  assert.deepEqual(JSON.parse(await readFile(join(world.claudeConfig, 'fake-claude.json'), 'utf8')), { marketplaces: [], plugins: [] });
  assert.deepEqual(JSON.parse(await readFile(join(world.codexHome, 'fake-codex.json'), 'utf8')).marketplaces, []);
  await assert.rejects(stat(world.integrations.manifestFile), { code: 'ENOENT' });
  await assert.rejects(stat(join(world.data, 'integrations')), { code: 'ENOENT' }, 'a failed connect leaves no copy behind');
});

test('an organisation policy that blocks the install is reported as blocked, with the vendor\'s words', async () => {
  const world = await setup({ FAKE_MODE: 'policy' });
  const outcome = await world.integrations.connect(['claude', 'codex', 'antigravity']);
  assert.equal(outcome.ok, false);
  assert.deepEqual(outcome.results.map(result => result.code), ['blocked', 'blocked', 'blocked']);
  assert.match(outcome.results[0].steps.at(-1).output, /blocked by your organization's managed settings/);
  assert.match(outcome.results[1].steps.at(-1).output, /disabled by requirements set by your administrator/);
  assert.match(outcome.results[0].summary, /blocked by your organization/);
  await assert.rejects(stat(world.integrations.manifestFile), { code: 'ENOENT' });
});

test('an install the vendor reports as done but does not list is a verify failure, and is undone', async () => {
  const world = await setup({ FAKE_MODE: 'ghost-install' });
  const outcome = await world.integrations.connect(['claude', 'antigravity']);
  assert.deepEqual(outcome.results.map(result => result.code), ['verify-failed', 'verify-failed']);
  assert.match(outcome.results[0].summary, /does not list the plugin/);
  assert.deepEqual((await listing(join(world.home, '.gemini'))).filter(name => /plugins\/opendoc/.test(name)), []);
  await assert.rejects(stat(world.integrations.manifestFile), { code: 'ENOENT' });
});

test('a plugin that installs but is switched off is not called connected', async () => {
  const world = await setup({ FAKE_MODE: 'disabled-install' });
  const outcome = await world.integrations.connect(['claude']);
  assert.equal(outcome.results[0].code, 'verify-failed');
  assert.match(outcome.results[0].summary, /switched off/);
});

test('a command that does not finish is stopped and reported as a timeout', async () => {
  const world = await setup({ FAKE_MODE: 'slow' }, { commandTimeoutMs: 400 });
  const started = Date.now();
  const outcome = await world.integrations.connect(['claude']);
  assert.equal(outcome.results[0].code, 'timeout');
  assert.equal(outcome.results[0].steps[0].timedOut, true);
  assert.ok(Date.now() - started < 10_000);
});

test('OpenDoc installed outside the app is left alone and not recorded, and undo does not touch it', async () => {
  const world = await setup();
  // Someone installed it from their own checkout.
  const other = join(world.root, 'checkout');
  await mkdir(join(other, '.claude-plugin'), { recursive: true });
  await writeFile(join(other, '.claude-plugin', 'marketplace.json'), JSON.stringify({ name: 'opendoc' }));
  const env = { ...world.env({ CLAUDE_CONFIG_DIR: world.claudeConfig }) };
  await runProgram(join(world.bin, 'claude'), ['plugin', 'marketplace', 'add', other], { env });
  await runProgram(join(world.bin, 'claude'), ['plugin', 'install', 'opendoc@opendoc'], { env });
  const outcome = await world.integrations.connect(['claude']);
  assert.equal(outcome.ok, true);
  assert.equal(outcome.results[0].code, 'already-present');
  assert.equal(outcome.results[0].changed, false);
  assert.match(outcome.results[0].summary, /not from this app/);
  const status = await world.integrations.status();
  assert.deepEqual(status.apps.find(app => app.id === 'claude'), { id: 'claude', name: 'Claude Code', present: true, connected: true, managed: false, stale: false, problem: null, summary: status.apps[0].summary });
  assert.match(status.apps[0].summary, /not from this app/);
  assert.equal((await world.integrations.disconnect(['claude'])).results[0].code, 'not-connected');
  const state = JSON.parse(await readFile(join(world.claudeConfig, 'fake-claude.json'), 'utf8'));
  assert.equal(state.plugins.length, 1, 'still installed');
});

test('a marketplace called opendoc that points elsewhere is a conflict and is not changed', async () => {
  const world = await setup();
  const other = join(world.root, 'checkout');
  await mkdir(join(other, '.claude-plugin'), { recursive: true });
  await writeFile(join(other, '.claude-plugin', 'marketplace.json'), JSON.stringify({ name: 'opendoc' }));
  await runProgram(join(world.bin, 'claude'), ['plugin', 'marketplace', 'add', other], { env: world.env({ CLAUDE_CONFIG_DIR: world.claudeConfig }) });
  const outcome = await world.integrations.connect(['claude']);
  assert.equal(outcome.results[0].code, 'conflict');
  assert.match(outcome.results[0].summary, /already has a marketplace called opendoc/);
  const state = JSON.parse(await readFile(join(world.claudeConfig, 'fake-claude.json'), 'utf8'));
  assert.deepEqual(state.marketplaces, [{ name: 'opendoc', path: other }]);
});

test('an app that is not there is reported as absent, an unknown id as unknown, and nothing else runs', async () => {
  const world = await scratch();
  const integrations = createIntegrations(world.options());
  const outcome = await integrations.connect(['cursor', 'nonsense']);
  assert.equal(outcome.ok, false);
  assert.deepEqual(outcome.results.map(result => [result.app, result.code]), [['nonsense', 'unknown-app'], ['cursor', 'absent']]);
  assert.match(outcome.results[1].summary, /no cursor-agent command/i);
  assert.deepEqual(await world.calls(), []);
  await assert.rejects(stat(world.data), { code: 'ENOENT' }, 'nothing was written');
});

test('one app failing does not stop the next, and the manifest holds only what worked', async () => {
  const world = await setup();
  await mkdir(join(world.home, '.cursor'));
  const outcome = await world.integrations.connect(['antigravity', 'copilot', 'cursor']);
  assert.deepEqual(outcome.results.map(result => [result.app, result.ok]), [['antigravity', true], ['copilot', false], ['cursor', true]]);
  assert.deepEqual(Object.keys((await world.manifest()).apps), ['antigravity', 'cursor']);
  assert.ok((await stat(join(world.data, 'integrations'))).isDirectory());
});

test('connecting twice does not run the add commands twice, and the record keeps its first time', async () => {
  const world = await setup();
  await world.integrations.connect(['claude', 'codex']);
  const first = (await world.manifest()).apps;
  const again = await world.integrations.connect(['claude', 'codex']);
  assert.equal(again.ok, true, JSON.stringify(again, null, 1));
  assert.equal((await world.vendorCalls('claude')).filter(call => call.startsWith('plugin marketplace add')).length, 1);
  assert.equal((await world.vendorCalls('claude')).filter(call => call.startsWith('plugin install')).length, 1);
  assert.equal((await world.manifest()).apps.claude.connectedAt, first.claude.connectedAt);
});

test('a failed undo reports it and keeps the record so it can be tried again; a missing command offers forgetting', async () => {
  const world = await setup();
  await world.integrations.connect(['claude']);
  const broken = createIntegrations(world.options({ env: world.env({ CLAUDE_CONFIG_DIR: world.claudeConfig, FAKE_MODE: 'fail-uninstall' }) }));
  const outcome = await broken.disconnect(['claude']);
  assert.equal(outcome.ok, false);
  assert.equal(outcome.results[0].code, 'failed');
  assert.match(outcome.results[0].steps.find(step => !step.ok).output, /in use/);
  assert.ok((await world.manifest()).apps.claude);
  assert.ok((await stat(join(world.data, 'integrations'))).isDirectory(), 'the copy stays while something still points at it');
  assert.equal((await world.integrations.disconnect(['claude'])).ok, true, 'a later try succeeds');

  await world.integrations.connect(['claude']);
  const noClaude = createIntegrations(world.options({ env: world.env({ PATH: join(world.root, 'empty') }) }));
  const stuck = await noClaude.disconnect(['claude']);
  assert.equal(stuck.results[0].code, 'not-found');
  assert.match(stuck.results[0].summary, /drop this app's record/);
  const forgotten = await noClaude.disconnect(['claude'], { forget: true });
  assert.equal(forgotten.results[0].code, 'forgotten');
  assert.deepEqual((await noClaude.status({ verify: false })).apps.find(app => app.id === 'claude').managed, false);
});

test('undo uses the config folder the install used, even when the environment changed since', async () => {
  const world = await setup();
  await world.integrations.connect(['claude']);
  const moved = createIntegrations(world.options({ env: world.env({ CLAUDE_CONFIG_DIR: join(world.root, 'another-folder') }) }));
  const outcome = await moved.disconnect(['claude']);
  assert.equal(outcome.ok, true, JSON.stringify(outcome, null, 1));
  assert.deepEqual(JSON.parse(await readFile(join(world.claudeConfig, 'fake-claude.json'), 'utf8')), { marketplaces: [], plugins: [] });
});

test('the vendor commands run without the Electron variables, and the login shell\'s config folder wins', async () => {
  const world = await scratch();
  await fakeCommand(world, 'codex');
  const shell = join(world.root, 'fake-shell');
  await writeFile(shell, `#!/bin/sh\necho "CODEX_HOME=${join(world.root, 'from-login-shell')}"\n`);
  await chmod(shell, 0o755);
  const integrations = createIntegrations(world.options({ readLoginShell: true, shell, env: world.env({ CODEX_HOME: join(world.root, 'from-app'), ELECTRON_RUN_AS_NODE: '1' }) }));
  assert.equal((await integrations.connect(['codex'])).ok, true);
  const calls = await world.calls();
  assert.ok(calls.length > 0);
  assert.ok(calls.every(call => call.CODEX_HOME === join(world.root, 'from-login-shell') && call.ELECTRON_RUN_AS_NODE === null));
  assert.equal((await integrations.disconnect(['codex'])).ok, true);
});

test('vendor commands run in a private folder under the app\'s data folder, never in the shared temp folder', async () => {
  const world = await setup();
  assert.equal((await world.integrations.connect(['claude', 'codex'])).ok, true);
  const calls = (await world.calls()).filter(call => call.tool === 'claude' || call.tool === 'codex');
  assert.ok(calls.length >= 4);
  const folder = join(world.data, 'integrations-work');
  for (const call of calls) {
    assert.equal(call.cwd, folder, call.args.join(' '));
    assert.equal(call.cwdMode, 0o700, 'only the user can enter it');
  }
  assert.notEqual(folder, await realpath(tmpdir()));
  assert.ok((await stat(folder)).isDirectory(), 'it stays while an app is connected');
  assert.equal((await world.integrations.disconnect(['claude', 'codex'])).ok, true);
  await assert.rejects(stat(folder), { code: 'ENOENT' }, 'and goes with the last app');
  await assert.rejects(stat(world.data), { code: 'ENOENT' });
});

test('an explicit working folder is still honoured, and left in place', async () => {
  const world = await setup();
  const custom = join(world.root, 'custom-cwd');
  await mkdir(custom);
  const integrations = createIntegrations(world.options({ env: world.env({ CLAUDE_CONFIG_DIR: world.claudeConfig }), workingDirectory: custom }));
  assert.equal((await integrations.connect(['claude'])).ok, true);
  const calls = (await world.calls()).filter(entry => entry.tool === 'claude');
  assert.ok(calls.length >= 2);
  for (const call of calls) assert.equal(call.cwd, custom);
  assert.ok((await stat(custom)).isDirectory());
});
