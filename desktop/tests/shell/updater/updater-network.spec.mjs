// No network when the updater is off (plan E7): with the switch off, with the package manager's marker, and in a development run,
// the feed server's request log stays empty. The control run, switched on, shows the log would have caught a request.
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
  const deb = { name: 'opendoc-desktop_0.6.1-8_amd64.deb', bytes: fakePackage(50_000) };

  test.beforeAll(async () => {
    feed = await startFeed(join(workDir, 'feed-network'));
    await publish(feed, { version: '0.6.1', build: 8, files: [deb] });
  });
  test.afterAll(async () => { await feed?.stop(); });

  const requests = async () => (await feed.requests()).filter(request => request.path !== '/favicon.ico');

  test('switched off in config.json: the feed is never asked, and the menu offers the way back on', async () => {
    const run = await updaterApp({ config: { checkForUpdates: false, updateFeed: feed.url }, resources: { 'package-type': 'deb' } });
    try {
      await run.app.firstWindow();
      await quiet(5000);
      expect(await requests()).toEqual([]);
      expect(await menuItem(run.app, ['Help', 'Check for Updates Automatically'])).toMatchObject({ checked: false, type: 'checkbox' });
      expect(await menuItem(run.app, ['Help', 'Check for Updates…'])).toMatchObject({ enabled: false });
      expect(await menuLabels(run.app, ['Help'])).not.toContain('Restart to Update');
      expect(await run.dialogs()).toEqual([]);
    } finally { await run.app.close(); }
  });

  test('resources/update-disabled (the AUR package): no request, no menu items, even with the switch on and a newer build waiting (build 8 against the running 7)', async () => {
    const run = await updaterApp({ config: { checkForUpdates: true, updateFeed: feed.url }, resources: { 'update-disabled': '', 'package-type': 'pacman' } });
    try {
      await run.app.firstWindow();
      await quiet(5000);
      expect(await requests()).toEqual([]);
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
    const run = await updaterApp({ config: { updateFeed: 'http://example.invalid/feed/' }, resources: { 'package-type': 'deb' } });
    try {
      await run.app.firstWindow();
      await waitFor(async () => /refused the update address/.test(await run.updaterLog()), { what: 'the refusal in the updater log' });
      expect(await requests()).toEqual([]);
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
      await waitFor(async () => (await menuItem(run.app, ['Help', 'Check for Updates…'])).enabled === false, { what: 'the disabled check item' });
      const before = (await requests()).length;
      await quiet(3000);
      expect((await requests()).length).toBe(before);
      expect(await menuItem(run.app, ['Help', 'Check for Updates Automatically'])).toMatchObject({ checked: false });
    } finally { await run.app.close(); }
  });
});
