// An installed app is not steered by the environment: with the app told it is packaged (ELECTRON_FORCE_IS_PACKAGED, which a
// development Electron honours), the test switches (the stand-in resources folder, the runtime folder, ...) are ignored and logged,
// (readable from the main process's environment) and a plain-http loopback update address is not used. The control run, unpackaged, honours the same switches and asks the feed.
// (A packaged app that was built as a test build keeps the switches; that case is the unit test of build-mode.mjs, because making
// the mark means building the app.)
import { expect, test } from '@playwright/test';
import { join } from 'node:path';
import { waitFor } from '../support/helpers.mjs';
import { workDir } from '../support/paths.mjs';
import { fakePackage, publish, startFeed } from './support/feed.mjs';
import { updaterApp } from './support/launch.mjs';

const quiet = milliseconds => new Promise(accept => setTimeout(accept, milliseconds));

test.describe('an installed app ignores the test switches and a plain-http update address', () => {
  let feed;
  const deb = { name: 'opendoc-desktop_0.6.1-8_amd64.deb', bytes: fakePackage(50_000) };

  test.beforeAll(async () => {
    feed = await startFeed(join(workDir, 'feed-installed'));
    await publish(feed, { version: '0.6.1', build: 8, files: [deb] });
  });
  test.afterAll(async () => { await feed?.stop(); });

  const requests = async () => (await feed.requests()).filter(request => request.path !== '/favicon.ico');

  const switches = ['OPENDOC_DESKTOP_UPDATE_RESOURCES', 'OPENDOC_DESKTOP_RUNTIME', 'OPENDOC_PACKAGE_TARBALL', 'OPENDOC_DESKTOP_HEALTH_MS'];
  const environmentOf = app => app.evaluate((_electron, names) => Object.fromEntries(names.map(name => [name, process.env[name] ?? null])), switches);

  test('packaged: the switches are removed from the main process\'s environment, the loopback feed is never asked, and no update is offered', async () => {
    const run = await updaterApp({ config: { checkForUpdates: true, updateFeed: feed.url }, resources: { 'package-type': 'deb' }, env: { ELECTRON_FORCE_IS_PACKAGED: 'true', OPENDOC_DESKTOP_HEALTH_MS: '900', OPENDOC_PACKAGE_TARBALL: '/nowhere/opendoc.tgz' } });
    try {
      await run.app.firstWindow();
      expect(await run.app.evaluate(({ app }) => app.isPackaged)).toBe(true);
      expect(await environmentOf(run.app)).toEqual(Object.fromEntries(switches.map(name => [name, null])));
      await quiet(5000);
      expect(await requests()).toEqual([]);
      expect(await run.dialogs()).toEqual([]);
      expect(await run.updaterLog()).not.toMatch(/the update address is/);
    } finally { await run.app.close().catch(() => {}); }
  });

  test('control: the same app, not packaged, honours the switches and asks the loopback feed', async () => {
    const run = await updaterApp({ config: { checkForUpdates: true, updateFeed: feed.url }, resources: { 'package-type': 'deb' }, answers: [['A new version is ready', 'Later']] });
    try {
      await waitFor(async () => (await requests()).some(request => request.path.startsWith('/generic/latest-linux.yml')), { timeout: 60_000, what: 'the metadata request' });
      expect(await run.app.evaluate(({ app }) => app.isPackaged)).toBe(false);
      const environment = await environmentOf(run.app);
      expect(environment.OPENDOC_DESKTOP_UPDATE_RESOURCES).toBe(run.resourcesDir);
      expect(environment.OPENDOC_DESKTOP_RUNTIME).not.toBeNull();
    } finally { await run.app.close().catch(() => {}); }
  });
});
