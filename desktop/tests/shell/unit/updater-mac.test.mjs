// The macOS update without a paid certificate: when it may swap, the command lines it runs (a Mac is not available here, so a fake
// `run` answers), and the swap helper itself, which is plain sh and runs for real on a stand-in bundle.
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { chmod, mkdir, readFile, readdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { test } from 'node:test';
import { createUpdaterClass } from '../../../src/main/updater/classes.mjs';
import { decideMacInstall, installMacUpdate, macBundleState, swapArguments, swapScript, waitSteps } from '../../../src/main/updater/mac-install.mjs';
import { scratch } from '../support/updater.mjs';

const state = (overrides = {}) => ({ execPath: '/Applications/opendoc-desktop.app/Contents/MacOS/opendoc-desktop', bundle: '/Applications/opendoc-desktop.app', folder: '/Applications', translocated: false, writable: true, quarantine: null, ...overrides });

test('where the bundle is: three levels above the executable, and whether its folder and itself can be written', async () => {
  const seen = [];
  const found = await macBundleState({ execPath: '/Users/a/Applications/opendoc-desktop.app/Contents/MacOS/opendoc-desktop', canWrite: async path => { seen.push(path); return true; } });
  assert.equal(found.bundle, '/Users/a/Applications/opendoc-desktop.app');
  assert.equal(found.folder, '/Users/a/Applications');
  assert.deepEqual(seen, ['/Users/a/Applications', '/Users/a/Applications/opendoc-desktop.app']);
  assert.equal(found.writable, true);
  assert.equal((await macBundleState({ execPath: '/Applications/x.app/Contents/MacOS/x', canWrite: async path => path !== '/Applications' })).writable, false, 'a folder that cannot be written');
  assert.equal((await macBundleState({ execPath: '/Applications/x.app/Contents/MacOS/x', canWrite: async path => path === '/Applications' })).writable, false, 'a bundle that cannot be written');
});

test('a translocated app is told to move to Applications', async () => {
  const found = await macBundleState({ execPath: '/private/var/folders/zz/T/AppTranslocation/7C1E/d/opendoc-desktop.app/Contents/MacOS/opendoc-desktop', canWrite: async () => false });
  assert.equal(found.translocated, true);
  const decision = decideMacInstall(found);
  assert.deepEqual([decision.action, decision.reason], ['notice', 'translocated']);
  assert.match(decision.message, /Applications/);
});

test('the decision: swap in a folder the user can write, otherwise a notice (translocation comes first)', () => {
  assert.deepEqual(decideMacInstall(state()), { action: 'swap' });
  assert.deepEqual(decideMacInstall(state({ folder: '/Users/a/Downloads', bundle: '/Users/a/Downloads/x.app' })), { action: 'swap' }, 'a writable folder outside Applications works when the app is not translocated');
  const readOnly = decideMacInstall(state({ writable: false }));
  assert.deepEqual([readOnly.action, readOnly.reason], ['notice', 'not-writable']);
  assert.match(readOnly.message, /\/Applications/);
  assert.equal(decideMacInstall(state({ translocated: true, writable: false })).reason, 'translocated');
  assert.equal(decideMacInstall(state({ quarantine: '0081;5f;Safari;' })).action, 'swap', 'a quarantine flag alone does not stop it (translocation does)');
});

/** A `run` that records command lines and answers the way macOS would. */
function fakeRun({ fail = {}, plist = {} } = {}) {
  const commands = [];
  const run = async (command, args) => {
    commands.push([command, ...args]);
    if (fail[command]) throw new Error(`${command} failed`);
    if (command === '/usr/libexec/PlistBuddy') {
      const key = args[1].replace('Print :', '');
      const bundle = args[2].includes('.opendoc-desktop-update-') ? 'fresh' : 'old';
      return `${plist[`${bundle}:${key}`] ?? { CFBundleIdentifier: 'io.github.ryanyahya.OpenDocDesktop', CFBundleShortVersionString: '0.6.1', CFBundleVersion: '2' }[key]}\n`;
    }
    return '';
  };
  return { run, commands };
}

async function stageSetup() {
  const folder = await scratch('mac');
  const bundle = join(folder, 'opendoc-desktop.app');
  await mkdir(bundle);
  return { folder, bundle, started: [], state: state({ folder, bundle }) };
}

test('the install: unzip with ditto, verify the signature and the bundle id, then start the helper with the swap arguments', async () => {
  const setup = await stageSetup();
  const { run, commands } = fakeRun();
  const result = await installMacUpdate({
    zipFile: '/cache/update.zip', state: setup.state, pid: 4242, run,
    start: async (command, args) => { setup.started.push([command, args]); },
    list: () => ['opendoc-desktop.app'],
    expected: { version: '0.6.1', build: 2 },
    helperLogFolder: setup.folder,
  });
  const stage = (await readdir(setup.folder)).find(name => name.startsWith('.opendoc-desktop-update-'));
  assert.ok(stage, 'the staging folder is next to the app, so the swap is a rename on one volume');
  const fresh = join(setup.folder, stage, 'opendoc-desktop.app');
  assert.deepEqual(commands, [
    ['ditto', '-xk', '/cache/update.zip', join(setup.folder, stage)],
    ['/usr/libexec/PlistBuddy', '-c', 'Print :CFBundleIdentifier', join(fresh, 'Contents', 'Info.plist')],
    ['/usr/libexec/PlistBuddy', '-c', 'Print :CFBundleIdentifier', join(setup.bundle, 'Contents', 'Info.plist')],
    ['codesign', '--verify', '--deep', '--strict', fresh],
    ['/usr/libexec/PlistBuddy', '-c', 'Print :CFBundleShortVersionString', join(fresh, 'Contents', 'Info.plist')],
    ['/usr/libexec/PlistBuddy', '-c', 'Print :CFBundleVersion', join(fresh, 'Contents', 'Info.plist')],
  ]);
  assert.deepEqual(result.info, { version: '0.6.1', build: 2 });
  assert.deepEqual(setup.started, [['/bin/sh', swapArguments({ bundle: setup.bundle, old: `${setup.bundle}.old-4242`, fresh, stage: join(setup.folder, stage), helperLog: join(setup.folder, 'opendoc-update-helper-4242.log'), pid: 4242 })]]);
  assert.equal(setup.started[0][1][0], '-c');
  assert.equal(setup.started[0][1][1], swapScript);
});

test('a translocated or read-only bundle never reaches the commands: nothing is unzipped', async () => {
  for (const [overrides, code] of [[{ translocated: true }, 'MOVE_TO_APPLICATIONS'], [{ writable: false }, 'NOT_WRITABLE']]) {
    const { run, commands } = fakeRun();
    await assert.rejects(installMacUpdate({ zipFile: '/z.zip', state: state(overrides), run, start: () => assert.fail('no helper') }), { code });
    assert.deepEqual(commands, []);
  }
});

test('a bad update stops before the helper starts, and the staging folder is removed', async () => {
  const cases = [
    ['a zip without the app', fakeRun(), { list: () => ['README.txt'] }, /holds no app/],
    ['a signature that does not verify', fakeRun({ fail: { codesign: true } }), {}, /codesign failed/],
    ['another bundle identifier', fakeRun({ plist: { 'fresh:CFBundleIdentifier': 'com.example.other' } }), {}, /another bundle identifier/],
    ['an unzip that fails', fakeRun({ fail: { ditto: true } }), {}, /ditto failed/],
    ['another version than the release announced', fakeRun({ plist: { 'fresh:CFBundleShortVersionString': '0.6.0' } }), { expected: { version: '0.6.1', build: 2 } }, /version 0\.6\.0, build 2, but the release announced 0\.6\.1, build 2/],
    ['another build than the release announced', fakeRun({ plist: { 'fresh:CFBundleVersion': '1' } }), { expected: { version: '0.6.1', build: 2 } }, /build 1, but the release announced 0\.6\.1, build 2/],
    ['a helper that cannot be started', fakeRun(), { start: async () => { throw new Error('spawn /bin/sh ENOENT'); } }, /ENOENT/],
  ];
  for (const [label, { run }, extra, message] of cases) {
    const setup = await stageSetup();
    await assert.rejects(installMacUpdate({ zipFile: '/z.zip', state: setup.state, run, start: () => assert.fail('no helper'), list: () => ['opendoc-desktop.app'], ...extra }), message, label);
    assert.deepEqual(await readdir(setup.folder), ['opendoc-desktop.app'], `${label}: the staging folder is gone`);
  }
});

test('the new bundle is found by its bundle identifier, whatever the .app is called in the zip, and installed under the running name', async () => {
  const setup = await stageSetup();
  const { run } = fakeRun({ plist: { 'fresh:CFBundleIdentifier': 'com.example.other' } });
  // Two apps in the zip: the first has another identifier (the fake answers "other" for every fresh bundle except by name below).
  const ids = { 'Helper.app': 'com.example.helper', 'OpenDoc Desktop.app': 'io.github.ryanyahya.OpenDocDesktop' };
  const asking = async (command, args) => {
    if (command === '/usr/libexec/PlistBuddy' && args[2].includes('.opendoc-desktop-update-') && args[1] === 'Print :CFBundleIdentifier') return `${ids[args[2].split('/').at(-3)]}\n`;
    return run(command, args);
  };
  const started = [];
  const result = await installMacUpdate({ zipFile: '/z.zip', state: setup.state, pid: 7, run: asking, start: async (command, args) => { started.push(args); }, list: () => ['Helper.app', 'OpenDoc Desktop.app'], helperLogFolder: setup.folder });
  assert.deepEqual(result.info, { version: '0.6.1', build: 2 });
  assert.ok(started[0][5].endsWith('/OpenDoc Desktop.app'), 'the swap moves the matching bundle in');
  assert.equal(started[0][3], setup.bundle, 'over the running bundle, so the installed name stays');
});

test('the helper that cannot be started (no /bin/sh) rejects instead of leaving the app to quit for nothing', async () => {
  const { startHelper } = await import('../../../src/main/updater/mac-install.mjs');
  await assert.rejects(startHelper('/nonexistent/sh', ['-c', 'true']), /ENOENT/);
  await startHelper('/bin/sh', ['-c', 'true']);
});

test('the class decides before the download, and maps an install that was stopped or failed', async () => {
  const make = seams => {
    const Updater = createUpdaterClass('mac', { getBuild: () => 1, seams });
    // No constructor: a MacUpdater needs Electron's autoUpdater, which only an Electron process has.
    return Object.assign(Object.create(Updater.prototype), { downloadedZip: '/cache/update.zip', _logger: { info() {} } });
  };
  assert.deepEqual(await make({ macState: async () => state() }).preflight(), { ok: true });
  const blocked = await make({ macState: async () => state({ translocated: true }) }).preflight();
  assert.deepEqual([blocked.ok, blocked.reason], [false, 'translocated']);
  assert.equal((await make({ macState: async () => state({ writable: false }) }).preflight()).reason, 'not-writable');

  const stopped = code => make({ macState: async () => state(), macInstall: async () => { throw Object.assign(new Error('stopped'), { code }); } }).installDownloaded();
  assert.deepEqual(await stopped('MOVE_TO_APPLICATIONS'), { outcome: 'blocked', reason: 'translocated', message: 'stopped' });
  assert.equal((await stopped('NOT_WRITABLE')).reason, 'not-writable');
  assert.deepEqual(await make({ macState: async () => state(), macInstall: async () => { throw new Error('the update has another bundle identifier'); } }).installDownloaded(), { outcome: 'failed', message: 'the update has another bundle identifier' });
  assert.equal((await make({ macState: async () => state(), macInstall: async ({ zipFile }) => ({ info: { version: '0.6.1', build: 2 }, zipFile }) }).installDownloaded()).outcome, 'installed');
  const none = Object.assign(make({}), { downloadedZip: null });
  assert.equal((await none.installDownloaded()).outcome, 'failed');
});

/** Run the swap helper on stand-in folders: a fake `open` on PATH records what it was asked to open. */
async function runHelper({ fresh = true, failSecondMove = false } = {}) {
  const folder = await scratch('swap');
  const bin = join(folder, 'bin');
  await mkdir(bin);
  await writeFile(join(bin, 'open'), `#!/bin/sh\necho "$@" >> "${join(folder, 'opened')}"\n`);
  await chmod(join(bin, 'open'), 0o755);
  const bundle = join(folder, 'App.app');
  const stage = join(folder, '.stage');
  const incoming = join(stage, 'App.app');
  await mkdir(join(bundle, 'Contents'), { recursive: true });
  await writeFile(join(bundle, 'Contents', 'version'), 'old');
  if (fresh) { await mkdir(join(incoming, 'Contents'), { recursive: true }); await writeFile(join(incoming, 'Contents', 'version'), 'new'); } else await mkdir(stage);
  const exited = spawn(process.execPath, ['-e', '0']);
  await new Promise(accept => exited.once('exit', accept));
  const old = join(folder, 'App.app.old-1');
  const log = join(folder, 'helper.log');
  const result = spawnSync('/bin/sh', swapArguments({ bundle, old, fresh: failSecondMove ? join(stage, 'missing.app') : incoming, stage, helperLog: log, pid: exited.pid }), { env: { PATH: `${bin}:/usr/bin:/bin` }, encoding: 'utf8', timeout: 20_000 });
  return { folder, bundle, old, stage, log, result, version: await readFile(join(bundle, 'Contents', 'version'), 'utf8').catch(() => null), opened: await readFile(join(folder, 'opened'), 'utf8').catch(() => '') };
}

test('the swap helper waits for the app to exit, swaps the bundles, opens the new one and cleans up', async () => {
  const run = await runHelper();
  assert.equal(run.result.status, 0);
  assert.equal(run.version, 'new');
  assert.equal(existsSync(run.old), false);
  assert.equal(existsSync(run.stage), false);
  assert.equal(run.opened.trim(), run.bundle);
  assert.equal((await readFile(run.log, 'utf8')).trim(), 'swapped');
});

test('the swap helper puts the old bundle back when the new one cannot be moved in', async () => {
  const run = await runHelper({ failSecondMove: true });
  assert.equal(run.result.status, 1);
  assert.equal(run.version, 'old', 'the app is still there');
  assert.equal(existsSync(run.old), false);
  assert.equal(run.opened, '', 'nothing was opened');
  assert.equal((await readFile(run.log, 'utf8')).trim(), 'swap failed');
});

test('the swap helper keeps waiting while the app is alive', async () => {
  const sleeper = spawn('sleep', ['30']);
  const started = Date.now();
  const folder = await scratch('wait');
  const helper = spawn('/bin/sh', swapArguments({ bundle: join(folder, 'A.app'), old: join(folder, 'old'), fresh: join(folder, 'new'), stage: join(folder, 's'), helperLog: join(folder, 'log'), pid: sleeper.pid }), { stdio: 'ignore' });
  await new Promise(accept => setTimeout(accept, 700));
  assert.equal(helper.exitCode, null, 'still waiting for the app');
  sleeper.kill();
  await new Promise(accept => helper.once('exit', accept));
  assert.ok(Date.now() - started >= 700);
});

test('the swap helper gives up without swapping when the app never exits, and cleans up its staging folder', async () => {
  const sleeper = spawn('sleep', ['30']);
  try {
    const folder = await scratch('giveup');
    const stage = join(folder, 'stage');
    await mkdir(stage);
    const bundle = join(folder, 'A.app');
    await mkdir(bundle);
    const log = join(folder, 'log');
    const started = Date.now();
    const result = spawnSync('/bin/sh', swapArguments({ bundle, old: join(folder, 'old'), fresh: join(stage, 'A.app'), stage, helperLog: log, pid: sleeper.pid, steps: 3 }), { encoding: 'utf8', timeout: 15_000 });
    assert.equal(result.status, 1);
    assert.ok(Date.now() - started < 10_000, 'about 0.6 seconds, not forever');
    assert.match(await readFile(log, 'utf8'), /did not quit in time, nothing was swapped/);
    assert.equal(existsSync(bundle), true, 'the app is untouched');
    assert.equal(existsSync(stage), false);
  } finally { sleeper.kill(); }
});

test('the default wait is 60 seconds', () => {
  assert.equal(waitSteps * 0.2, 60);
  assert.equal(swapArguments({ bundle: 'a', old: 'b', fresh: 'c', stage: 'd', helperLog: 'e', pid: 1 }).at(-1), String(waitSteps));
});
