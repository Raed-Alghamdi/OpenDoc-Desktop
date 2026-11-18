// A deb, rpm or pacman install end to end in the real app (plan E7): the update downloads in the background, "Restart to Update" runs
// one pkexec call (a fake one on PATH, with fake package tools), a cancelled prompt keeps the download and the app keeps running, a
// corrupted download is refused, and the window stays alive while the password prompt is open. Also "what changed", shown once.
import { expect, test } from '@playwright/test';
import { chmod, readFile, readdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { readConfig } from '../support/app.mjs';
import { waitFor } from '../support/helpers.mjs';
import { workDir } from '../support/paths.mjs';
import { fakeTools } from '../support/updater.mjs';
import { fakePackage, publish, sha512, startFeed } from './support/feed.mjs';
import { clickItem, menuLabels, updaterApp } from './support/launch.mjs';

// The tests' runtime is build 7 (global-setup.mjs), so the feed offers build 8.
const deb = { name: 'opendoc-desktop_0.6.1-8_amd64.deb', bytes: fakePackage(120_000) };
const ready = 'A new version is ready: 0.6.1, build 8';
const exited = (app, milliseconds) => Promise.race([new Promise(accept => app.process().once('exit', () => accept(true))), new Promise(accept => setTimeout(accept, milliseconds, false))]);

test.describe('a package install updates through one pkexec call', () => {
  let feed;
  let tools;

  test.beforeEach(async () => {
    feed = await startFeed(join(workDir, `feed-packages-${Date.now()}`));
    tools = await fakeTools(['pkexec', 'dpkg', 'apt-get']);
  });
  test.afterEach(async () => { await feed?.stop(); });

  test('download, Later, then Restart to Update: one prompt, the checked copy is installed, the app relaunches', async () => {
    await publish(feed, { version: '0.6.1', build: 8, files: [deb] });
    const run = await updaterApp({ config: { updateFeed: feed.url }, resources: { 'package-type': 'deb' }, path: [tools.bin], answers: [[ready, 'Later']] });
    try {
      await run.app.firstWindow();
      const offer = await run.waitForDialog(ready);
      expect(offer.buttons).toEqual(['Restart to Update', 'Later']);
      await waitFor(async () => (await menuLabels(run.app, ['Help'])).includes('Restart to Update'), { what: 'the Restart to Update menu item' });

      // Nothing was installed while the offer was pending, and the download is in the app's cache folder.
      expect(await tools.calls('pkexec')).toEqual([]);
      expect(await readdir(join(run.updaterCache, 'pending'))).toContain(deb.name);

      await clickItem(run.app, ['Help', 'Restart to Update']);
      expect(await exited(run.app, 60_000)).toBe(true);
      expect(await run.relaunched()).toBe(true);

      const [call] = await tools.calls('pkexec');
      expect(await tools.calls('pkexec')).toHaveLength(1);
      expect(call.slice(0, 3)).toEqual(['--disable-internal-agent', '/bin/sh', '-c']);
      expect(call.slice(4, 5)).toEqual(['opendoc-desktop-update']);
      expect(call[5]).toBe(join(run.updaterCache, 'pending', deb.name));
      expect(call[6]).toBe(Buffer.from(sha512(deb.bytes), 'base64').toString('hex'));
      expect(call[7]).toBe('deb');
      const [dpkg] = await tools.calls('dpkg');
      expect(dpkg[0]).toBe('-i');
      expect(dpkg[1]).toMatch(/\/update\.deb$/);
      expect(dpkg[1]).not.toBe(call[5]);
      expect(await tools.calls('apt-get')).toEqual([]);

      // Only the metadata and the one file were asked for, and the dialogs were the offer and nothing else.
      const asked = (await feed.requests()).map(request => request.path.split('?')[0]);
      expect(asked).toEqual(['/generic/latest-linux.yml', `/generic/${deb.name}`]);
      expect((await run.dialogs()).map(dialog => dialog.message)).toEqual([ready]);
    } finally { await run.app.close().catch(() => {}); }
  });

  test('a cancelled password prompt says so, keeps the download, and the app carries on', async () => {
    await publish(feed, { version: '0.6.1', build: 8, files: [deb] });
    const run = await updaterApp({ config: { updateFeed: feed.url }, resources: { 'package-type': 'deb' }, path: [tools.bin], env: { FAKE_PKEXEC_EXIT: '126' }, answers: [[ready, 'Restart to Update']] });
    try {
      await run.app.firstWindow();
      await run.waitForDialog('Update cancelled');
      expect(await tools.calls('pkexec')).toHaveLength(1);
      expect(await tools.calls('dpkg')).toEqual([]);
      expect(await run.relaunched()).toBe(false);
      expect(await exited(run.app, 1500)).toBe(false);
      expect(await readdir(join(run.updaterCache, 'pending'))).toContain(deb.name);
      await waitFor(async () => (await menuLabels(run.app, ['Help'])).includes('Restart to Update'), { what: 'the offer to come back' });
      expect(await run.app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().length)).toBeGreaterThan(0);
    } finally { await run.app.close().catch(() => {}); }
  });

  test('the app stays alive while the password prompt is open, and the menu offers no second click', async () => {
    await publish(feed, { version: '0.6.1', build: 8, files: [deb] });
    await writeFile(join(tools.bin, 'pkexec'), '#!/bin/sh\nsleep 4\nexit 126\n');
    await chmod(join(tools.bin, 'pkexec'), 0o755);
    const run = await updaterApp({ config: { updateFeed: feed.url }, resources: { 'package-type': 'deb' }, path: [tools.bin], answers: [[ready, 'Later']] });
    try {
      await run.app.firstWindow();
      await run.waitForDialog(ready);
      await waitFor(async () => (await menuLabels(run.app, ['Help'])).includes('Restart to Update'), { what: 'the menu item' });
      await clickItem(run.app, ['Help', 'Restart to Update']);
      await waitFor(async () => !(await menuLabels(run.app, ['Help'])).includes('Restart to Update'), { what: 'the item to go while the prompt is open' });
      // The main process answers at once: nothing is frozen behind the prompt.
      const started = Date.now();
      for (let round = 0; round < 5; round++) await run.app.evaluate(() => process.pid);
      expect(Date.now() - started).toBeLessThan(2000);
      await run.waitForDialog('Update cancelled');
    } finally { await run.app.close().catch(() => {}); }
  });

  test('a download that does not match its checksum is refused: nothing is offered, nothing is installed', async () => {
    await publish(feed, { version: '0.6.1', build: 8, files: [deb], corrupt: deb.name });
    const run = await updaterApp({ config: { updateFeed: feed.url }, resources: { 'package-type': 'deb' }, path: [tools.bin], answers: [['Could not check', 'OK']] });
    try {
      await run.app.firstWindow();
      await waitFor(async () => /checksum mismatch/i.test(await run.updaterLog()), { what: 'the refusal in the updater log' });
      await waitFor(async () => (await feed.requests()).filter(request => request.path.includes(deb.name)).length >= 1, { what: 'the download' });
      expect(await menuLabels(run.app, ['Help'])).not.toContain('Restart to Update');
      expect(await run.dialogs()).toEqual([]);
      expect(await tools.calls('pkexec')).toEqual([]);
      // The refused file does not stay in the cache, and a manual check tells the user.
      expect(await readdir(join(run.updaterCache, 'pending')).catch(() => [])).not.toContain(deb.name);
      await clickItem(run.app, ['Help', 'Check for Updates…']);
      const failure = await run.waitForDialog('Could not check for updates');
      expect(failure.detail).toMatch(/sha512 checksum mismatch/i);
      expect(await tools.calls('pkexec')).toEqual([]);
    } finally { await run.app.close().catch(() => {}); }
  });

  test('a release that lists no file for this install is not offered', async () => {
    await publish(feed, { version: '0.6.1', build: 8, files: [{ name: 'opendoc-desktop-x86_64.AppImage', bytes: fakePackage(1000) }] });
    const run = await updaterApp({ config: { updateFeed: feed.url }, resources: { 'package-type': 'deb' }, path: [tools.bin] });
    try {
      await run.app.firstWindow();
      await waitFor(async () => /is not offered/.test(await run.updaterLog()), { what: 'the reason in the updater log' });
      expect(await run.dialogs()).toEqual([]);
      expect((await feed.requests()).map(request => request.path.split('?')[0])).toEqual(['/generic/latest-linux.yml']);
    } finally { await run.app.close().catch(() => {}); }
  });
});

test.describe('what changed, shown once', () => {
  test('after an update the new version and build are shown with the release page link, and not again at the next launch', async () => {
    const run = await updaterApp({ config: { checkForUpdates: false, lastRun: { version: '0.6.1', build: 3 } }, resources: { 'package-type': 'deb' }, answers: [['was updated', 'What Changed']] });
    try {
      await run.app.firstWindow();
      const shown = await run.waitForDialog('was updated');
      expect(shown.message).toBe('opendoc-desktop was updated to 0.6.1, build 7');
      expect(shown.detail).toBe('Before: 0.6.1, build 3.');
      await waitFor(async () => (await run.external()).length > 0, { what: 'the release page link' });
      expect(await run.external()).toEqual(['https://github.com/Raed-Alghamdi/OpenDoc-Desktop/releases/tag/desktop-v0.6.1-7']);
      await waitFor(async () => (await readConfig(run.profile)).lastRun?.build === 7, { what: 'the last run to be recorded' });
    } finally { await run.app.close(); }

    const again = await updaterApp({ useProfile: run.profile, resources: { 'package-type': 'deb' }, answers: [['was updated', 'What Changed']] });
    try {
      await again.app.firstWindow();
      await waitFor(async () => (await readFile(join(run.profile, 'config.json'), 'utf8')).includes('"build": 7'), { what: 'the config' });
      await new Promise(accept => setTimeout(accept, 2500));
      expect(await again.dialogs()).toEqual([]);
    } finally { await again.app.close(); }
  });
});

test.describe('what the updater refuses to follow', () => {
  let feed;
  test.beforeEach(async () => { feed = await startFeed(join(workDir, `feed-refuse-${Date.now()}`)); });
  test.afterEach(async () => { await feed?.stop(); });

  test('a download that is redirected to plain http is refused: the redirect is not followed, nothing is installed', async () => {
    const deb = { name: 'opendoc-desktop_0.6.1-8_amd64.deb', bytes: fakePackage(50_000) };
    await publish(feed, { version: '0.6.1', build: 8, files: [deb] });
    await writeFile(join(feed.root, 'redirects.json'), JSON.stringify({ [`/generic/${deb.name}`]: `http://example.invalid/${deb.name}` }));
    const tools = await fakeTools(['pkexec', 'dpkg', 'apt-get']);
    const run = await updaterApp({ config: { updateFeed: feed.url }, resources: { 'package-type': 'deb' }, path: [tools.bin] });
    try {
      await run.app.firstWindow();
      await waitFor(async () => /refused a redirect/.test(await run.updaterLog()), { what: 'the refused redirect in the updater log' });
      expect(await run.updaterLog()).toMatch(/redirected to http:\/\/example\.invalid.*not https/);
      expect(await menuLabels(run.app, ['Help'])).not.toContain('Restart to Update');
      expect(await run.dialogs()).toEqual([]);
      expect(await tools.calls('pkexec')).toEqual([]);
      const asked = await feed.requests();
      expect(asked.map(request => request.path.split('?')[0])).toEqual(['/generic/latest-linux.yml', `/generic/${deb.name}`]);
      expect(asked.at(-1).status).toBe(302);
    } finally { await run.app.close().catch(() => {}); }
  });

  test('a release whose file is named by an absolute address is not offered, and that address is never requested', async () => {
    const deb = { name: 'opendoc-desktop_0.6.1-8_amd64.deb', bytes: fakePackage(50_000) };
    await publish(feed, { version: '0.6.1', build: 8, files: [deb] });
    const yml = join(feed.root, 'generic', 'latest-linux.yml');
    await writeFile(yml, (await readFile(yml, 'utf8')).replace(`url: ${deb.name}`, `url: http://127.0.0.1:1/${deb.name}`));
    const run = await updaterApp({ config: { updateFeed: feed.url }, resources: { 'package-type': 'deb' } });
    try {
      await run.app.firstWindow();
      await waitFor(async () => /outside the feed/.test(await run.updaterLog()), { what: 'the reason in the updater log' });
      expect(await run.dialogs()).toEqual([]);
      expect((await feed.requests()).map(request => request.path.split('?')[0])).toEqual(['/generic/latest-linux.yml']);
    } finally { await run.app.close().catch(() => {}); }
  });
});
