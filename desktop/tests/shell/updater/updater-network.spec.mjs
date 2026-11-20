// No network when the updater is off: with the switch off, with the package manager's marker, and in a development run,
// the feed server's request log stays empty. The control run, switched on, shows the log would have caught a request. A second server,
// the "canary", stands in for the built-in address (the app-update.yml of the stand-in resources folder): it must see nothing unless the
// app is switched on or the user clicks "Check for Updates…".
import { expect, test } from '@playwright/test';
import { join } from 'node:path';
import { readConfig } from '../support/app.mjs';
import { waitFor } from '../support/helpers.mjs';
import { workDir } from '../support/paths.mjs';
import { fakePackage, publish, startFeed } from './support/feed.mjs';
import { clickItem, menuItem, menuLabels, updaterApp } from './support/launch.mjs';

const updateItems = ['Check for Updates…', 'Check for Updates Automatically', 'Restart to Update'];
const quiet = milliseconds => new Promise(accept => setTimeout(accept, milliseconds));

test.describe('the updater makes no request when it is off', () => {
  let feed;
  let canary;
  const deb = { name: 'opendoc-desktop_0.6.1-8_amd64.deb', bytes: fakePackage(50_000) };

  test.beforeAll(async () => {
    feed = await startFeed(join(workDir, 'feed-network'));
    await publish(feed, { version: '0.6.1', build: 8, files: [deb] });
    canary = await startFeed(join(workDir, 'feed-canary'));
    await publish(canary, { version: '0.6.1', build: 8, files: [deb] });
  });
  test.afterAll(async () => { await feed?.stop(); await canary?.stop(); });

  const requests = async () => (await feed.requests()).filter(request => request.path !== '/favicon.ico');
  const canaryRequests = async () => (await canary.requests()).map(request => request.path.split('?')[0]);
  /** What the packaged app's resources/app-update.yml says: the built-in address, here the canary. */
  const builtIn = () => ({ 'app-update.yml': `provider: generic\nurl: ${canary.url}\nupdaterCacheDirName: opendoc-desktop-updater\n` });

  test('switched off in config.json: the feed is never asked, and the menu offers the way back on', async () => {
    const run = await updaterApp({ config: { checkForUpdates: false, updateFeed: feed.url }, resources: { 'package-type': 'deb' } });
    try {
      await run.app.firstWindow();
      await quiet(5000);
      expect(await requests()).toEqual([]);
      expect(await menuItem(run.app, ['Help', 'Check for Updates Automatically'])).toMatchObject({ checked: false, type: 'checkbox' });
      expect(await menuItem(run.app, ['Help', 'Check for Updates…'])).toMatchObject({ enabled: true }); // a click is always one check
      expect(await menuLabels(run.app, ['Help'])).not.toContain('Restart to Update');
      expect(await run.dialogs()).toEqual([]);
    } finally { await run.app.close(); }
  });

  test('switched off with no updateFeed at all: the built-in address is never asked, until the user clicks Check for Updates', async () => {
    const run = await updaterApp({ config: { checkForUpdates: false }, resources: { 'package-type': 'deb', ...builtIn() }, answers: [['A new version is ready', 'Later']] });
    try {
      await run.app.firstWindow();
      await quiet(5000);
      expect(await canaryRequests()).toEqual([]);
      expect(await requests()).toEqual([]);
      expect(await run.dialogs()).toEqual([]);

      await clickItem(run.app, ['Help', 'Check for Updates…']);
      await run.waitForDialog('A new version is ready');
      expect((await canaryRequests()).slice(0, 1)).toEqual(['/generic/latest-linux.yml']);
      expect(await canaryRequests()).toContain(`/generic/${deb.name}`);
      expect((await readConfig(run.profile)).checkForUpdates).toBe(false);
      expect(await menuItem(run.app, ['Help', 'Check for Updates Automatically'])).toMatchObject({ checked: false });
      // The click did not turn automatic checks back on: nothing more is asked.
      const after = (await canaryRequests()).length;
      await quiet(3000);
      expect((await canaryRequests()).length).toBe(after);
    } finally { await run.app.close(); }
  });

  test('control: switched on with no updateFeed, the same app asks the built-in address (so the canary would have seen a request)', async () => {
    const before = (await canaryRequests()).length;
    const run = await updaterApp({ config: {}, resources: { 'package-type': 'deb', ...builtIn() }, answers: [['A new version is ready', 'Later']] });
    try {
      await run.app.firstWindow();
      await waitFor(async () => (await canaryRequests()).length > before, { what: 'a new request to the built-in address' });
    } finally { await run.app.close(); }
  });

  test('resources/update-disabled (the AUR package): no request, no menu items, even with the switch on and a newer build waiting (build 8 against the running 7)', async () => {
    const before = (await canaryRequests()).length;
    const run = await updaterApp({ config: { checkForUpdates: true, updateFeed: feed.url }, resources: { 'update-disabled': '', 'package-type': 'pacman', ...builtIn() } });
    try {
      await run.app.firstWindow();
      await quiet(5000);
      expect(await requests()).toEqual([]);
      expect((await canaryRequests()).length).toBe(before);
      const help = await menuLabels(run.app, ['Help']);
      for (const label of updateItems) expect(help).not.toContain(label);
      expect(await run.dialogs()).toEqual([]);
    } finally { await run.app.close(); }
  });

  test('a development run (no packaged resources) checks nothing, whatever config.json says', async () => {
    const run = await updaterApp({ config: { checkForUpdates: true, updateFeed: feed.url }, env: { OPENDOC_DESKTOP_UPDATE_RESOURCES: '' } });
    try {
      await run.app.firstWindow();
      await quiet(5000);
      expect(await requests()).toEqual([]);
      for (const label of updateItems) expect(await menuLabels(run.app, ['Help'])).not.toContain(label);
    } finally { await run.app.close(); }
  });

  test('an address that is not allowed is refused and nothing is requested', async () => {
    const before = (await canaryRequests()).length;
    const run = await updaterApp({ config: { updateFeed: 'http://example.invalid/feed/' }, resources: { 'package-type': 'deb', ...builtIn() } });
    try {
      await run.app.firstWindow();
      await waitFor(async () => /refused the update address/.test(await run.updaterLog()), { what: 'the refusal in the updater log' });
      await quiet(2000);
      expect(await requests()).toEqual([]);
      expect((await canaryRequests()).length).toBe(before); // a refused override does not fall back to the built-in address
    } finally { await run.app.close(); }
  });

  test('control: switched on, the same app asks the feed (so an empty log above means something)', async () => {
    const run = await updaterApp({ config: { checkForUpdates: true, updateFeed: feed.url }, resources: { 'package-type': 'deb' }, answers: [['A new version is ready', 'Later']] });
    try {
      await run.app.firstWindow();
      await waitFor(async () => (await requests()).some(request => request.path.startsWith('/generic/latest-linux.yml')), { what: 'the metadata request' });
      expect(await menuItem(run.app, ['Help', 'Check for Updates Automatically'])).toMatchObject({ checked: true });
    } finally { await run.app.close(); }
  });

  test('switching it off from the menu while the app is open writes the switch and stops further requests', async () => {
    await feed.requests(); // the log so far
    const run = await updaterApp({ config: { updateFeed: feed.url }, resources: { 'package-type': 'deb' }, answers: [['A new version is ready', 'Later']] });
    try {
      await run.app.firstWindow();
      await run.waitForDialog('A new version is ready');
      await clickItem(run.app, ['Help', 'Check for Updates Automatically']);
      await waitFor(async () => (await readConfig(run.profile)).checkForUpdates === false, { what: 'the switch in config.json' });
      expect(await menuItem(run.app, ['Help', 'Check for Updates…'])).toMatchObject({ enabled: true });
      const before = (await requests()).length;
      await quiet(3000);
      expect((await requests()).length).toBe(before);
      expect(await menuItem(run.app, ['Help', 'Check for Updates Automatically'])).toMatchObject({ checked: false });
    } finally { await run.app.close(); }
  });
});
