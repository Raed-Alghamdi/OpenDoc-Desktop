// The update controller: what each install type does at launch, what the user is told and offered, the switch, the daily check, the
// swap at quit, and "what changed" once. A scripted updater stands in for electron-updater; the config file is real.
import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { test } from 'node:test';
import { createConfig } from '../../../src/main/config.mjs';
import { UpdateController } from '../../../src/main/updater/controller.mjs';
import { dayMilliseconds } from '../../../src/main/updater/schedule.mjs';
import { FakeUpdater, downloadedUpdate, scratch } from '../support/updater.mjs';

const settle = () => new Promise(accept => setImmediate(accept));

/**
 * @param options.type package-type file to write ('deb' ...), or 'appimage' (an APPIMAGE variable), 'managed', 'mac' (platform)
 * @param options.config what config.json holds
 * @param options.script what the scripted updater does (see FakeUpdater)
 * @param options.answers dialog answers: a number (button index), a function from the dialog options, or a list taken in order
 */
async function setup({ type = 'deb', config = {}, script = {}, build = 1, version = '0.6.1', answers = 0, packaged = true, allowLoopbackFeed = true } = {}) {
  const folder = await scratch('controller');
  const resources = join(folder, 'resources');
  await mkdir(resources);
  if (['deb', 'rpm', 'pacman'].includes(type)) await writeFile(join(resources, 'package-type'), `${type}\n`);
  if (type === 'managed') await writeFile(join(resources, 'update-disabled'), '');
  const configFile = createConfig(join(folder, 'config.json'));
  if (Object.keys(config).length) await configFile.update(config);
  const env = type === 'appimage' ? { APPIMAGE: '/home/u/Apps/opendoc-desktop-x86_64.AppImage' } : {};
  const log = [];
  const shown = [];
  const external = [];
  const calls = { created: [], relaunch: 0, quit: 0, changes: 0, moved: [] };
  const queue = Array.isArray(answers) ? [...answers] : null;
  const updater = new FakeUpdater(script);
  const controller = new UpdateController({
    config: configFile,
    packaged,
    allowLoopbackFeed,
    resourcesDir: resources,
    getVersion: () => version,
    getBuild: () => build,
    platform: type === 'mac' ? 'darwin' : 'linux',
    env,
    createUpdater: (kind, options) => {
      calls.created.push({ kind, ...options });
      return updater;
    },
    show: async options => {
      shown.push(options);
      const answer = queue ? (queue.shift() ?? 0) : answers;
      return { response: typeof answer === 'function' ? answer(options) : answer };
    },
    openExternal: url => external.push(url),
    relaunch: () => { calls.relaunch++; },
    quit: () => { calls.quit++; },
    onChange: () => { calls.changes++; },
    onAppImageMoved: async path => { calls.moved.push(path); },
    log: line => log.push(line),
  });
  return { controller, config: configFile, log, shown, external, calls, updater, resources };
}

const titles = shown => shown.map(options => options.message);

// ---------- no updater, no network ----------

test('a managed install (the AUR package) builds no updater and starts no timer', async () => {
  const { controller, calls, shown } = await setup({ type: 'managed' });
  await controller.start();
  assert.equal(calls.created.length, 0);
  assert.equal(controller.schedule.running, false);
  assert.deepEqual(controller.menuState, { show: false, automatic: true, checkEnabled: false, restartReady: false, installing: false });
  assert.deepEqual(shown, []);
});

test('switched off in the app: no updater, no timer, and the menu offers the way back on (a manual check still works)', async () => {
  const { controller, calls } = await setup({ config: { checkForUpdates: false } });
  await controller.start();
  assert.equal(calls.created.length, 0);
  assert.equal(controller.schedule.running, false);
  assert.deepEqual(controller.menuState, { show: true, automatic: false, checkEnabled: true, restartReady: false, installing: false });
});

test('a development run and an unknown install are inactive: no updater, nothing in the menu', async () => {
  for (const options of [{ packaged: false }, { type: 'unknown' }]) {
    const { controller, calls } = await setup(options);
    await controller.start();
    assert.equal(calls.created.length, 0);
    assert.equal(controller.menuState.show, false);
  }
});

// ---------- the address ----------

test('an address that is not https (or loopback http) is refused and logged: no updater, so no network', async () => {
  const { controller, calls, log, shown } = await setup({ config: { updateFeed: 'http://updates.example.org/feed' } });
  await controller.start();
  assert.equal(calls.created.length, 0);
  assert.ok(log.some(line => /refused the update address/.test(line)));
  await controller.checkNow();
  assert.equal(shown.at(-1).message, 'Could not check for updates');
  assert.match(shown.at(-1).detail, /must start with https/);
});

test('an accepted address reaches the updater as a provider (a generic folder here), and none means the built-in one', async () => {
  const custom = await setup({ config: { updateFeed: 'http://127.0.0.1:8099/generic' } });
  await custom.controller.start();
  assert.deepEqual(custom.calls.created[0].feed, { provider: 'generic', url: 'http://127.0.0.1:8099/generic/' });
  const builtIn = await setup();
  await builtIn.controller.start();
  assert.equal(builtIn.calls.created[0].feed, null);
});

test('an installed app that is not a test build refuses a plain-http loopback address: no updater, nothing requested, the reason shown', async () => {
  const { controller, calls, log, shown } = await setup({ allowLoopbackFeed: false, config: { updateFeed: 'http://127.0.0.1:8099/generic' } });
  await controller.start();
  assert.equal(calls.created.length, 0);
  assert.ok(log.some(line => /refused the update address.*not accepted by this build/.test(line)));
  await controller.checkNow();
  assert.equal(shown.at(-1).message, 'Could not check for updates');
  assert.match(shown.at(-1).detail, /not accepted by this build/);
});

test('an https address is allowed in an installed app, and the restart prompt names where the update comes from', async () => {
  const custom = await setup({ allowLoopbackFeed: false, config: { updateFeed: 'https://updates.example.org:8443/opendoc/' }, script: { check: downloadedUpdate('0.6.1', 2) }, answers: 1 });
  await custom.controller.start();
  await settle();
  await custom.controller.idle();
  assert.deepEqual(custom.calls.created[0].feed, { provider: 'generic', url: 'https://updates.example.org:8443/opendoc/' });
  assert.equal(custom.calls.created[0].feedLabel, 'https://updates.example.org:8443');
  const prompt = custom.shown.find(options => /ready/.test(options.message));
  assert.match(prompt.detail, /comes from https:\/\/updates\.example\.org:8443, the update address set in config\.json/);
  const github = await setup({ config: { updateFeed: 'https://github.com/Someone/Fork' }, script: { check: downloadedUpdate('0.6.1', 2) }, answers: 1 });
  await github.controller.start();
  await settle();
  await github.controller.idle();
  assert.equal(github.calls.created[0].feedLabel, 'https://github.com/Someone/Fork');
  assert.match(github.shown.find(options => /ready/.test(options.message)).detail, /comes from https:\/\/github\.com\/Someone\/Fork/);
});

test('the built-in address (none set, or the packaged repository named in config.json) shows no feed in the prompt', async () => {
  const none = await setup({ script: { check: downloadedUpdate('0.6.1', 2) }, answers: 1 });
  await none.controller.start();
  await settle();
  await none.controller.idle();
  assert.equal(none.calls.created[0].feedLabel, null);
  assert.doesNotMatch(none.shown.find(options => /ready/.test(options.message)).detail, /comes from/);
  const same = await setup({ config: { updateFeed: 'https://github.com/Raed-Alghamdi/OpenDoc-Desktop' }, script: { check: downloadedUpdate('0.6.1', 2) }, answers: 1 });
  await same.controller.start();
  await settle();
  await same.controller.idle();
  assert.equal(same.calls.created[0].feedLabel, null);
});

// ---------- AppImage ----------

test('AppImage: downloads in the background and says nothing; the swap is for the quit', async () => {
  const { controller, updater, shown, calls } = await setup({ type: 'appimage', script: { check: downloadedUpdate() } });
  await controller.start();
  await settle();
  await controller.idle();
  assert.equal(updater.checks, 1, 'one check at launch');
  assert.equal(updater.lastAutoDownload, false, 'the check itself never downloads');
  assert.equal(updater.downloads, 1, 'the download starts after the metadata came back');
  assert.equal(updater.autoInstallOnAppQuit, true);
  assert.deepEqual(shown, [], 'no prompt');
  assert.equal(controller.menuState.restartReady, false);
  assert.equal(calls.created[0].kind, 'appimage');
  assert.equal(await controller.installOnQuit(), true);
  assert.equal(updater.quitInstalls, 1);
});

test('AppImage: nothing is swapped at quit when nothing was downloaded, or when the switch is off', async () => {
  const none = await setup({ type: 'appimage', script: { check: { isUpdateAvailable: false } } });
  await none.controller.start();
  await settle();
  assert.equal(await none.controller.installOnQuit(), false);
  assert.equal(none.updater.quitInstalls, 0);

  const off = await setup({ type: 'appimage', script: { check: downloadedUpdate() } });
  await off.controller.start();
  await settle();
  await off.controller.setAutomatic(false);
  assert.equal(await off.controller.installOnQuit(), false, 'switched off after the download: not swapped');
  assert.equal(off.updater.autoInstallOnAppQuit, false, 'electron-updater\'s own quit handler is off too');
});

test('AppImage: a file renamed by the update takes the opendoc command along, in time when the swap runs from the shutdown', async () => {
  const { controller, updater, calls } = await setup({ type: 'appimage', script: { check: downloadedUpdate(), installAtQuit: u => { u.emit('appimage-filename-updated', '/home/u/Apps/opendoc-desktop-0.6.2-x86_64.AppImage'); return true; } } });
  await controller.start();
  await settle();
  assert.equal(await controller.installOnQuit(), true);
  assert.equal(updater.quitInstalls, 1);
  assert.deepEqual(calls.moved, ['/home/u/Apps/opendoc-desktop-0.6.2-x86_64.AppImage'], 'once, and finished before installOnQuit returned');
});

test('AppImage: a rename seen by electron-updater\'s own quit handler (the fallback) still asks the command to follow', async () => {
  const { controller, updater, calls } = await setup({ type: 'appimage', script: { check: { isUpdateAvailable: false } } });
  await controller.start();
  await settle();
  updater.emit('appimage-filename-updated', '/home/u/Apps/renamed.AppImage');
  await settle();
  assert.deepEqual(calls.moved, ['/home/u/Apps/renamed.AppImage']);
});

test('AppImage: an install that throws at quit is logged and never throws out of the shutdown', async () => {
  const { controller, log } = await setup({ type: 'appimage', script: { check: downloadedUpdate(), installAtQuit: () => { throw new Error('EACCES'); } } });
  await controller.start();
  await settle();
  assert.equal(await controller.installOnQuit(), false);
  assert.ok(log.some(line => /EACCES/.test(line)));
});

test('AppImage in a folder the user cannot write to: told once, and nothing is downloaded', async () => {
  const blocked = { ok: false, reason: 'not-writable', folder: '/opt/apps', message: 'The folder /opt/apps cannot be written.' };
  const first = await setup({ type: 'appimage', script: { preflight: blocked, check: { isUpdateAvailable: true, updateInfo: { version: '0.6.1', build: 2 }, downloadPromise: null } } });
  await first.controller.start();
  await first.controller.idle();
  await settle();
  assert.equal(first.updater.lastAutoDownload, false, 'autoDownload is off for the check');
  assert.equal(first.shown.length, 1);
  assert.equal(first.shown[0].message, 'opendoc-desktop cannot update itself here');
  assert.match(first.shown[0].detail, /\/opt\/apps/);
  assert.equal((await first.config.read()).updateNotices.folder, '/opt/apps');
  assert.deepEqual(first.external, []);

  // The same folder at the next launch: no second notice.
  const again = await setup({ type: 'appimage', config: { updateNotices: { folder: '/opt/apps' } }, script: { preflight: blocked } });
  await again.controller.start();
  await again.controller.idle();
  assert.deepEqual(again.shown, []);
});

// ---------- deb, rpm, pacman ----------

test('a package: after the download the user is offered "Restart to Update", and Restart installs, relaunches and quits', async () => {
  const { controller, updater, shown, calls } = await setup({ type: 'deb', script: { check: downloadedUpdate('0.6.1', 2) }, answers: 0 });
  await controller.start();
  await settle();
  await controller.idle();
  assert.equal(shown.length, 1);
  assert.equal(shown[0].message, 'A new version is ready: 0.6.1, build 2');
  assert.deepEqual(shown[0].buttons, ['Restart to Update', 'Later']);
  assert.match(shown[0].detail, /password/);
  assert.equal(updater.autoInstallOnAppQuit, false, 'never installed silently at quit');
  assert.equal(updater.installs, 1);
  assert.deepEqual([calls.relaunch, calls.quit], [1, 1]);
  assert.equal(controller.menuState.restartReady, false, 'the offer is used up once installed');
});

test('a package: "Later" keeps the download, a menu item stays, and it installs when chosen', async () => {
  const { controller, updater, shown, calls } = await setup({ type: 'rpm', script: { check: downloadedUpdate() }, answers: 1 });
  await controller.start();
  await settle();
  await controller.idle();
  assert.equal(updater.installs, 0);
  assert.equal(controller.menuState.restartReady, true, 'the menu shows Restart to Update');
  assert.deepEqual([calls.relaunch, calls.quit], [0, 0]);
  await controller.restartToUpdate();
  assert.equal(updater.installs, 1);
  assert.deepEqual([calls.relaunch, calls.quit], [1, 1]);
  assert.equal(shown.length, 1, 'only the one offer');
});

test('a cancelled password prompt says "Update cancelled", keeps the download and offers again later', async () => {
  let attempt = 0;
  const { controller, updater, shown, calls } = await setup({ type: 'deb', script: { check: downloadedUpdate(), install: () => ({ outcome: ++attempt === 1 ? 'cancelled' : 'installed' }) }, answers: [0, 0, 0] });
  await controller.start();
  await settle();
  await controller.idle();
  assert.deepEqual(titles(shown), ['A new version is ready: 0.6.1, build 2', 'Update cancelled']);
  assert.match(shown[1].detail, /stays downloaded/);
  assert.deepEqual([calls.relaunch, calls.quit], [0, 0], 'the app carries on');
  assert.equal(controller.menuState.restartReady, true);
  await controller.restartToUpdate();
  assert.equal(updater.installs, 2);
  assert.deepEqual([calls.relaunch, calls.quit], [1, 1]);
});

test('a failed install says why and shows the command to install the file by hand', async () => {
  const { controller, shown } = await setup({ type: 'deb', script: { check: downloadedUpdate(), install: () => ({ outcome: 'failed', message: 'dpkg: dependency problems' }) }, answers: 0 });
  await controller.start();
  await settle();
  await controller.idle();
  const failure = shown.at(-1);
  assert.equal(failure.message, 'The update could not be installed');
  assert.match(failure.detail, /dependency problems/);
  assert.match(failure.detail, /sudo apt install '\/cache\/update\.deb'/);
  assert.equal(controller.menuState.restartReady, true);
});

test('while the install runs the menu offers no second click, and a second call is ignored', async () => {
  let release;
  const gate = new Promise(accept => { release = accept; });
  const { controller, updater } = await setup({ type: 'deb', script: { check: downloadedUpdate(), install: async () => { await gate; return { outcome: 'cancelled' }; } }, answers: 1 });
  await controller.start();
  await settle();
  await controller.idle();
  const first = controller.restartToUpdate();
  await settle();
  assert.equal(controller.menuState.installing, true);
  assert.equal(controller.menuState.restartReady, false);
  assert.equal((await controller.restartToUpdate()).outcome, 'none');
  release();
  await first;
  assert.equal(updater.installs, 1);
});

// ---------- macOS ----------

test('macOS: a bundle that cannot replace itself is not downloaded; a notice with a button opens the release page, once', async () => {
  const blocked = { ok: false, reason: 'translocated', message: 'Move opendoc-desktop to your Applications folder.' };
  const found = { isUpdateAvailable: true, updateInfo: { version: '0.6.1', build: 2 }, downloadPromise: null };
  const { controller, updater, shown, external } = await setup({ type: 'mac', script: { preflight: blocked, check: found }, answers: 0 });
  await controller.start();
  await settle();
  await controller.idle();
  assert.equal(updater.lastAutoDownload, false);
  assert.equal(shown.length, 1);
  assert.equal(shown[0].message, 'A new version is available: 0.6.1, build 2');
  assert.equal(shown[0].detail, blocked.message);
  assert.equal(shown[0].buttons[0], 'Open the Release Page');
  assert.deepEqual(external, ['https://github.com/Raed-Alghamdi/OpenDoc-Desktop/releases/tag/desktop-v0.6.1-2']);
  await controller.check({ manual: false });
  assert.equal(shown.length, 1, 'the daily check does not repeat the notice');
  await controller.check({ manual: true });
  assert.equal(shown.length, 2, 'a manual check always answers');
});

test('macOS: a swap that is blocked after the download falls back to the same notice', async () => {
  const { controller, shown, external } = await setup({ type: 'mac', script: { check: downloadedUpdate(), install: { outcome: 'blocked', reason: 'not-writable', message: 'Cannot write to /Applications.' } }, answers: 0 });
  await controller.start();
  await settle();
  await controller.idle();
  assert.deepEqual(titles(shown), ['A new version is ready: 0.6.1, build 2', 'A new version is available: 0.6.1, build 2']);
  assert.equal(shown[1].detail, 'Cannot write to /Applications.');
  assert.equal(external.length, 1);
});

test('macOS: Restart to Update quits without a relaunch (the helper opens the new bundle)', async () => {
  const { controller, calls } = await setup({ type: 'mac', script: { check: downloadedUpdate() }, answers: 0 });
  await controller.start();
  await settle();
  await controller.idle();
  assert.deepEqual([calls.relaunch, calls.quit], [0, 1]);
});

// ---------- manual checks ----------

test('Check for Updates: up to date, an error, and an AppImage download each get an answer', async () => {
  const upToDate = await setup({ type: 'deb', script: { check: { isUpdateAvailable: false } }, build: 3 });
  await upToDate.controller.start();
  await settle();
  const quiet = upToDate.shown.length;
  assert.equal(quiet, 0, 'the launch check says nothing when there is nothing to do');
  await upToDate.controller.checkNow();
  assert.equal(upToDate.shown.at(-1).message, 'opendoc-desktop is up to date');
  assert.match(upToDate.shown.at(-1).detail, /0\.6\.1, build 3/);

  const failing = await setup({ type: 'deb', script: { check: new Error('getaddrinfo ENOTFOUND\nsecond line') } });
  await failing.controller.start();
  await settle();
  assert.deepEqual(failing.shown, [], 'a failed launch check is only logged');
  await failing.controller.checkNow();
  assert.equal(failing.shown.at(-1).message, 'Could not check for updates');
  assert.equal(failing.shown.at(-1).detail, 'getaddrinfo ENOTFOUND');

  const image = await setup({ type: 'appimage', script: { check: downloadedUpdate('0.6.1', 4) } });
  await image.controller.start();
  await settle();
  await image.controller.checkNow();
  assert.equal(image.shown.at(-1).message, 'An update is ready');
  assert.match(image.shown.at(-1).detail, /0\.6\.1, build 4.*installed when you quit/);
});

test('two checks at once are one request', async () => {
  let release;
  const gate = new Promise(accept => { release = accept; });
  const { controller, updater } = await setup({ type: 'deb', script: { check: async () => { await gate; return { isUpdateAvailable: false }; } } });
  const start = controller.start();
  await settle();
  const second = controller.check({ manual: true });
  await settle();
  release();
  await Promise.all([start, second]);
  assert.equal(updater.checks, 1);
});

// ---------- the schedule and the switch ----------

test('a check at launch and then once a day', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const { controller, updater } = await setup({ type: 'deb', script: { check: { isUpdateAvailable: false } } });
  await controller.start();
  await settle();
  assert.equal(updater.checks, 1);
  t.mock.timers.tick(dayMilliseconds);
  await settle();
  assert.equal(updater.checks, 2);
  t.mock.timers.tick(dayMilliseconds);
  await settle();
  assert.equal(updater.checks, 3);
  controller.stop();
});

test('switching off mid-run cancels the timer at once and writes the switch; switching on checks right away', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const cancelled = [];
  const { controller, updater, config } = await setup({ type: 'deb', script: { check: { isUpdateAvailable: false } } });
  await controller.start();
  await settle();
  t.mock.timers.tick(dayMilliseconds);
  await settle();
  assert.equal(updater.checks, 2);
  controller.cancellation = { cancel: () => cancelled.push(true) };

  await controller.setAutomatic(false);
  assert.equal((await config.read()).checkForUpdates, false);
  assert.equal(controller.schedule.running, false);
  assert.equal(controller.menuState.automatic, false);
  assert.equal(controller.menuState.checkEnabled, true, 'the user can still ask for one check');
  assert.deepEqual(cancelled, [true], 'a download in progress is cancelled');
  t.mock.timers.tick(dayMilliseconds * 3);
  await settle();
  assert.equal(updater.checks, 2, 'no check after the switch');

  await controller.setAutomatic(true);
  await settle();
  assert.equal((await config.read()).checkForUpdates, true);
  assert.equal(updater.checks, 3, 'switched on: a check right away, on the same updater');
  assert.equal(controller.menuState.automatic, true);
  controller.stop();
});

test('the switch keeps every other key in config.json', async () => {
  const { controller, config } = await setup({ type: 'deb', config: { defaultWorkspace: '/w', updateFeed: 'http://127.0.0.1:1/x', somethingNew: [1] }, script: { check: { isUpdateAvailable: false } } });
  await controller.start();
  await controller.setAutomatic(false);
  const stored = await config.read();
  assert.deepEqual([stored.defaultWorkspace, stored.updateFeed, stored.somethingNew, stored.checkForUpdates], ['/w', 'http://127.0.0.1:1/x', [1], false]);
  controller.stop();
});

test('the menu is rebuilt when the state changes', async () => {
  const { controller, calls } = await setup({ type: 'deb', script: { check: downloadedUpdate() }, answers: 1 });
  await controller.start();
  await settle();
  await controller.idle();
  assert.ok(calls.changes >= 2);
});

// ---------- what changed, once ----------

test('after an update: the hooks run, what changed is shown once, and the last run is recorded', async () => {
  const { controller, shown, external, config } = await setup({ type: 'managed', build: 2, config: { lastRun: { version: '0.6.1', build: 1 } }, answers: 1 });
  const seen = [];
  controller.onUpdated(change => seen.push(change));
  await controller.start();
  await controller.idle();
  assert.deepEqual(seen, [{ previous: { version: '0.6.1', build: 1 }, current: { version: '0.6.1', build: 2 } }]);
  assert.equal(shown.length, 1);
  assert.equal(shown[0].message, 'opendoc-desktop was updated to 0.6.1, build 2');
  assert.equal(shown[0].detail, 'Before: 0.6.1, build 1.');
  assert.deepEqual(shown[0].buttons, ['OK', 'What Changed']);
  assert.deepEqual(external, ['https://github.com/Raed-Alghamdi/OpenDoc-Desktop/releases/tag/desktop-v0.6.1-2']);
  assert.deepEqual((await config.read()).lastRun, { version: '0.6.1', build: 2 });
});

test('the notice is not shown again at the next launch', async () => {
  const first = await setup({ type: 'managed', build: 2, config: { lastRun: { version: '0.6.1', build: 1 } } });
  await first.controller.start();
  await first.controller.idle();
  assert.equal(first.shown.length, 1);
  const next = new UpdateController({ config: first.config, packaged: true, resourcesDir: first.resources, getVersion: () => '0.6.1', getBuild: () => 2, createUpdater: () => null, show: async options => { first.shown.push(options); return { response: 0 }; }, openExternal() {}, platform: 'linux', env: {} });
  const seen = [];
  next.onUpdated(change => seen.push(change));
  await next.start();
  await next.idle();
  assert.equal(first.shown.length, 1);
  assert.deepEqual(seen, []);
});

test('the notice is recorded before its dialog opens, so closing the app while it is up does not repeat it', async () => {
  let release;
  const gate = new Promise(accept => { release = accept; });
  const { controller, config } = await setup({ type: 'managed', build: 2, config: { lastRun: { version: '0.6.1', build: 1 } } });
  controller.show = async () => { await gate; return { response: 0 }; };
  await controller.start();
  assert.deepEqual((await config.read()).lastRun, { version: '0.6.1', build: 2 }, 'while the dialog is still open');
  release();
  await controller.idle();
});

test('a version change shows what changed too, and the link uses the new tag', async () => {
  const { controller, external } = await setup({ type: 'managed', version: '0.6.2', build: 1, config: { lastRun: { version: '0.6.1', build: 5 } }, answers: 1 });
  await controller.start();
  await controller.idle();
  assert.deepEqual(external, ['https://github.com/Raed-Alghamdi/OpenDoc-Desktop/releases/tag/desktop-v0.6.2-1']);
});

test('the link follows the repository in app-update.yml', async () => {
  const { controller, external, resources } = await setup({ type: 'managed', build: 2, config: { lastRun: { version: '0.6.1', build: 1 } }, answers: 1 });
  await writeFile(join(resources, 'app-update.yml'), 'owner: RyanYahya\nrepo: OpenDoc\nprovider: github\n');
  await controller.start();
  await controller.idle();
  assert.deepEqual(external, ['https://github.com/RyanYahya/OpenDoc/releases/tag/desktop-v0.6.1-2']);
});

test('a fresh install, the same build, an older build and a development run show nothing', async () => {
  const cases = [
    { config: {}, build: 2, recorded: { version: '0.6.1', build: 2 } },
    { config: { lastRun: { version: '0.6.1', build: 2 } }, build: 2, recorded: { version: '0.6.1', build: 2 } },
    { config: { lastRun: { version: '0.6.1', build: 3 } }, build: 2, recorded: { version: '0.6.1', build: 2 } },
    { config: { lastRun: { version: '0.6.1', build: 1 } }, build: null, recorded: { version: '0.6.1', build: 1 } },
  ];
  for (const { config, build, recorded } of cases) {
    const result = await setup({ type: 'managed', build, config });
    const seen = [];
    result.controller.onUpdated(change => seen.push(change));
    await result.controller.start();
    await result.controller.idle();
    assert.deepEqual(result.shown, [], JSON.stringify(config));
    assert.deepEqual(seen, []);
    assert.deepEqual((await result.config.read()).lastRun, recorded, 'a development run records nothing');
  }
});

test('a hook that throws is logged and does not stop the notice or the other hooks', async () => {
  const { controller, shown, log } = await setup({ type: 'managed', build: 2, config: { lastRun: { version: '0.6.1', build: 1 } } });
  const seen = [];
  controller.onUpdated(() => { throw new Error('refresh failed'); });
  const remove = controller.onUpdated(change => seen.push(change.current.build));
  controller.onUpdated(change => seen.push(`second ${change.current.build}`));
  await controller.start();
  await controller.idle();
  assert.deepEqual(seen, [2, 'second 2']);
  assert.equal(shown.length, 1);
  assert.ok(log.some(line => /refresh failed/.test(line)));
  remove();
});

test('the notice appears for an AppImage that was swapped at quit as well (the next launch is the new build)', async () => {
  const { controller, shown } = await setup({ type: 'appimage', build: 2, config: { lastRun: { version: '0.6.1', build: 1 } }, script: { check: { isUpdateAvailable: false } } });
  await controller.start();
  await controller.idle();
  assert.equal(shown.length, 1);
  assert.equal(shown[0].message, 'opendoc-desktop was updated to 0.6.1, build 2');
});

// ---------- the switch governs automatic checks; a click is always one check ----------

const defer = () => { let accept; let reject; const promise = new Promise((resolve, fail) => { accept = resolve; reject = fail; }); return { promise, accept, reject }; };

test('with the switch off, "Check for Updates…" runs one check on a lazily made updater and does not turn the switch back on', async () => {
  const { controller, calls, updater, config, shown } = await setup({ config: { checkForUpdates: false }, script: { check: downloadedUpdate('0.6.1', 2) }, answers: [1] });
  await controller.start();
  assert.equal(calls.created.length, 0, 'nothing is made while the switch is off');
  assert.deepEqual(await controller.check({ manual: false }), { status: 'none' }, 'a background check is never run while off');
  assert.equal(updater.checks, 0);
  const result = await controller.checkNow();
  assert.equal(result.status, 'downloaded');
  assert.equal(calls.created.length, 1);
  assert.equal(calls.created[0].kind, 'deb');
  assert.equal(updater.checks, 1);
  assert.equal(titles(shown).at(-1), 'A new version is ready: 0.6.1, build 2', 'a package update is offered the normal way');
  assert.equal((await config.read()).checkForUpdates, false, 'the switch stays off');
  assert.equal(controller.menuState.automatic, false);
  assert.equal(controller.schedule.running, false, 'no daily timer');
  assert.equal(controller.menuState.restartReady, true);
});

test('with the switch off, a manual AppImage download is still swapped in at quit; an automatic one is not once the switch goes off', async () => {
  const manual = await setup({ type: 'appimage', config: { checkForUpdates: false }, script: { check: downloadedUpdate() } });
  await manual.controller.start();
  await manual.controller.checkNow();
  assert.equal(manual.updater.autoInstallOnAppQuit, false, 'electron-updater\'s own quit handler stays off');
  assert.equal(await manual.controller.installOnQuit(), true);
  assert.equal(manual.updater.quitInstalls, 1);

  const automatic = await setup({ type: 'appimage', script: { check: downloadedUpdate() } });
  await automatic.controller.start();
  await settle();
  await automatic.controller.setAutomatic(false);
  assert.equal(await automatic.controller.installOnQuit(), false);
});

test('a managed install answers a manual check with "not available" and never builds an updater', async () => {
  const { controller, calls, shown } = await setup({ type: 'managed' });
  await controller.start();
  await controller.checkNow();
  assert.equal(calls.created.length, 0);
  assert.equal(shown.at(-1).message, 'Updates are not available');
});

// ---------- switching off during a check ----------

test('a check still fetching its metadata when the switch goes off neither downloads nor opens a dialog', async () => {
  const metadata = defer();
  const { controller, updater, shown, log } = await setup({ type: 'deb', script: { check: () => metadata.promise } });
  await controller.start();
  await settle();
  assert.equal(updater.checks, 1, 'the launch check is waiting for the metadata');
  await controller.setAutomatic(false);
  metadata.accept({ isUpdateAvailable: true, updateInfo: { version: '0.6.1', build: 2 }, downloadPromise: Promise.resolve([]), cancellationToken: { cancel() {} } });
  await settle();
  await controller.idle();
  assert.equal(updater.downloads ?? 0, 0, 'the download never started');
  assert.deepEqual(shown, [], 'no dialog after the switch went off');
  assert.equal(controller.ready, null);
  assert.equal(controller.menuState.restartReady, false);
  assert.ok(log.some(line => /no automatic update checks/.test(line)));
});

test('a download that finishes after the switch went off opens no dialog and leaves nothing ready', async () => {
  const download = defer();
  const { controller, updater, shown } = await setup({ type: 'deb', script: { check: { isUpdateAvailable: true, updateInfo: { version: '0.6.1', build: 2 }, downloadPromise: download.promise, cancellationToken: { cancel() {} } } } });
  await controller.start();
  await settle();
  assert.equal(updater.downloads, 1);
  await controller.setAutomatic(false);
  download.accept([]);
  await settle();
  await controller.idle();
  assert.deepEqual(shown, []);
  assert.equal(controller.ready, null);
});

test('a manual click right after switching off does not join the dropped check and gets its own answer', async () => {
  const first = defer();
  let calls = 0;
  const { controller, updater, shown } = await setup({ type: 'deb', script: { check: () => (++calls === 1 ? first.promise : { isUpdateAvailable: false }) } });
  await controller.start();
  await settle();
  await controller.setAutomatic(false);
  const click = controller.checkNow();
  await settle();
  first.accept({ isUpdateAvailable: false });
  assert.equal((await click).status, 'up-to-date');
  assert.equal(updater.checks, 2, 'a second, separate check');
  assert.equal(shown.at(-1).message, 'opendoc-desktop is up to date');
});

// ---------- a newer download clears the ready one ----------

test('a newer download starting makes "Restart to Update" go away until it has finished', async () => {
  const second = defer();
  let round = 0;
  const { controller, updater } = await setup({ type: 'deb', answers: 1, script: { check: () => (++round === 1 ? downloadedUpdate('0.6.1', 2) : { isUpdateAvailable: true, updateInfo: { version: '0.6.1', build: 3 }, downloadPromise: second.promise, cancellationToken: { cancel() {} } }) } });
  await controller.start();
  await settle();
  await controller.idle();
  assert.equal(controller.menuState.restartReady, true);
  assert.equal(controller.ready.info.build, 2);
  const again = controller.checkNow();
  await settle();
  assert.equal(controller.menuState.restartReady, false, 'the older file is gone when the newer one starts');
  assert.equal(controller.ready, null);
  second.accept([]);
  await again;
  assert.equal(controller.ready.info.build, 3);
  assert.equal(controller.menuState.restartReady, true);
  assert.equal(updater.downloads, 2);
});

test('AppImage: no room beside the AppImage is reported like a read-only folder: nothing is downloaded', async () => {
  const blocked = { ok: false, reason: 'no-space', folder: '/home/u/Apps', message: 'There is not enough free space in /home/u/Apps to put the update beside opendoc-desktop (180 MB needed, 2 MB free). Free some space and check again.' };
  const { controller, updater, shown } = await setup({ type: 'appimage', script: { preflight: blocked, check: { isUpdateAvailable: true, updateInfo: { version: '0.6.1', build: 2 }, downloadPromise: null, cancellationToken: { cancel() {} } } }, answers: 1 });
  await controller.start();
  await settle();
  await controller.checkNow();
  assert.equal(updater.downloads ?? 0, 0);
  assert.equal(shown.at(-1).message, 'A new version is available: 0.6.1, build 2');
  assert.match(shown.at(-1).detail, /not enough free space/);
});

// ---------- a swap at quit that failed is told once at the next launch ----------

test('AppImage: a swap at quit that fails is recorded with its reason, and the next launch says so once, without blocking', async () => {
  const failing = { check: downloadedUpdate('0.6.1', 2), installAtQuit: updater => { updater.emit('error', new Error('There is not enough free space in /home/u/Apps to put the update beside opendoc-desktop (180 MB needed, 2 MB free).')); return false; } };
  const first = await setup({ type: 'appimage', script: failing });
  await first.controller.start();
  await settle();
  assert.equal(await first.controller.installOnQuit(), false);
  const recorded = (await first.config.read()).updateNotices.swapFailed;
  assert.deepEqual([recorded.folder, recorded.build], ['/home/u/Apps', 2]);
  assert.match(recorded.reason, /not enough free space/);
  assert.deepEqual(first.shown, [], 'nothing is shown while quitting');

  // The next launch: the same config file.
  const second = await setup({ type: 'appimage', config: { updateNotices: { swapFailed: recorded, folder: '/keep/me' } }, script: { check: { isUpdateAvailable: false } } });
  await second.controller.start();
  await second.controller.idle();
  assert.equal(second.shown.length, 1);
  assert.equal(second.shown[0].message, 'The last update could not be installed');
  assert.match(second.shown[0].detail, /in \/home\/u\/Apps: There is not enough free space/);
  assert.match(second.shown[0].detail, /still the version you had/);
  const kept = (await second.config.read()).updateNotices;
  assert.equal(kept.swapFailed, undefined, 'recorded as shown before the dialog');
  assert.equal(kept.folder, '/keep/me', 'other notices are kept');
  // And not again.
  await second.controller.start();
  await second.controller.idle();
  assert.equal(second.shown.length, 1);
});

test('AppImage: a swap that throws is recorded too; a swap that works records nothing', async () => {
  const throwing = await setup({ type: 'appimage', script: { check: downloadedUpdate(), installAtQuit: () => { throw new Error('boom'); } } });
  await throwing.controller.start();
  await settle();
  assert.equal(await throwing.controller.installOnQuit(), false);
  assert.equal((await throwing.config.read()).updateNotices.swapFailed.reason, 'boom');
  const fine = await setup({ type: 'appimage', script: { check: downloadedUpdate() } });
  await fine.controller.start();
  await settle();
  assert.equal(await fine.controller.installOnQuit(), true);
  assert.equal((await fine.config.read()).updateNotices, undefined);
});

test('macOS: what the swap helper left behind is put in the log at the next launch, and a give-up says the next check offers it again', async () => {
  const { controller, log } = await setup({ type: 'mac', script: { check: { isUpdateAvailable: false } } });
  controller.helperLogs = async () => ['2026-11-18 10:00:00 gave up: the app (pid 4242) did not quit in time, nothing was swapped'];
  await controller.start();
  assert.ok(log.some(line => /the update helper said: .*did not quit in time, nothing was swapped/.test(line)));
  assert.ok(log.some(line => /the next check offers it again/.test(line)));
  const quiet = await setup({ type: 'mac', script: { check: { isUpdateAvailable: false } } });
  quiet.controller.helperLogs = async () => ['swapped'];
  await quiet.controller.start();
  assert.ok(quiet.log.some(line => /the update helper said: swapped/.test(line)));
  assert.ok(!quiet.log.some(line => /offers it again/.test(line)));
});

test('AppImage: a swap that returns false without an error (electron-updater\'s own install already ran) is not a failure: nothing is recorded or shown', async () => {
  const { controller, config, log, shown } = await setup({ type: 'appimage', script: { check: downloadedUpdate(), installAtQuit: () => false } });
  await controller.start();
  await settle();
  assert.equal(await controller.installOnQuit(), false);
  assert.equal((await config.read()).updateNotices, undefined);
  assert.ok(log.some(line => /already ran/.test(line)));
  assert.deepEqual(shown, []);
  // And the next launch has nothing to say.
  const next = await setup({ type: 'appimage', script: { check: { isUpdateAvailable: false } } });
  await next.controller.start();
  await next.controller.idle();
  assert.deepEqual(next.shown, []);
});

test('the real AppImage class: install() ignored because quitAndInstallCalled is already set raises no error', async () => {
  const { createUpdaterClass } = await import('../../../src/main/updater/classes.mjs');
  const { newUpdater } = await import('../support/updater.mjs');
  const updater = newUpdater(createUpdaterClass('appimage', { getBuild: () => 1 }), '0.6.1', await scratch('ignored'));
  updater.downloadedUpdateHelper = { file: '/cache/x.AppImage', downloadedFileInfo: { sha512: 'x' } };
  updater.quitAndInstallCalled = true;
  const errors = [];
  updater.on('error', error => errors.push(error));
  assert.equal(updater.installAtQuit(), false);
  assert.deepEqual(errors, []);
});
