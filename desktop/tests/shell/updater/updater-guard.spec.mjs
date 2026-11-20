// The updater's request guard in the real app: a differential (ranged) AppImage download that is redirected to a
// non-allowed address is refused, and the catch-all on the updater's own session cancels requests and redirect hops the rule refuses.
import { expect, test } from '@playwright/test';
import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { waitFor } from '../support/helpers.mjs';
import { workDir } from '../support/paths.mjs';
import { fakePackage, publish, startFeed } from './support/feed.mjs';
import { updaterApp } from './support/launch.mjs';

test.describe('the request guard', () => {
  let feed;
  test.beforeEach(async () => { feed = await startFeed(join(workDir, `feed-guard-${Date.now()}`)); });
  test.afterEach(async () => { await feed?.stop(); });

  test('a differential download (a ranged request, as GitHub release downloads use) redirected to plain http is refused, then so is the full download', async () => {
    const image = { name: 'opendoc-desktop-x86_64.AppImage', bytes: fakePackage(200_000) };
    await publish(feed, { version: '0.6.1', build: 8, files: [image] });
    // The block map size makes electron-updater ask for the end of the file with a Range header first.
    const yml = join(feed.root, 'generic', 'latest-linux.yml');
    const text = (await (await import('node:fs/promises')).readFile(yml, 'utf8')).replace(/(    size: \d+\n)/, '$1    blockMapSize: 100\n');
    await writeFile(yml, text);
    await writeFile(join(feed.root, 'redirects.json'), JSON.stringify({ [`/generic/${image.name}`]: `http://example.invalid/${image.name}` }));
    const installed = join(workDir, `installed-${Date.now()}.AppImage`);
    await writeFile(installed, fakePackage(1000));
    const run = await updaterApp({ config: { updateFeed: feed.url }, env: { APPIMAGE: installed } });
    try {
      await run.app.firstWindow();
      await waitFor(async () => /Cannot download differentially/.test(await run.updaterLog()), { what: 'the differential attempt to fail' });
      const log = await run.updaterLog();
      expect(log).toMatch(/Cannot download differentially, fallback to full download: .*redirected to http:\/\/example\.invalid.*not https/);
      expect(log).toMatch(/refused a redirect/);
      const asked = (await feed.requests()).filter(request => request.path.includes(image.name));
      expect(asked[0].range).toMatch(/^bytes=/);
      expect(asked[0].status).toBe(302);
      await waitFor(async () => (await feed.requests()).filter(request => request.path.includes(image.name)).length >= 2, { what: 'the full download attempt' });
      expect(await run.dialogs()).toEqual([]);
      expect(await run.updaterLog()).not.toMatch(/Z downloaded /);
    } finally { await run.app.close().catch(() => {}); }
  });

  test('the catch-all on the updater session: http to another host is cancelled, a redirect hop to one is cancelled, the loopback feed itself works', async () => {
    await writeFile(join(feed.root, 'redirects.json'), JSON.stringify({ '/generic/hop': 'http://example.invalid/x' }));
    const deb = { name: 'opendoc-desktop_0.6.1-8_amd64.deb', bytes: fakePackage(1000) };
    await publish(feed, { version: '0.6.1', build: 8, files: [deb] });
    const run = await updaterApp({ config: { updateFeed: feed.url, checkForUpdates: true }, resources: { 'package-type': 'deb' }, answers: [['A new version is ready', 'Later']] });
    try {
      await run.app.firstWindow();
      await run.waitForDialog('A new version is ready'); // the updater (and its session) exists now
      const probe = url => run.app.evaluate(({ net, session }, target) => new Promise(accept => {
        const request = net.request({ url: target, session: session.fromPartition('electron-updater') });
        request.on('response', response => { response.on('data', () => {}); response.on('end', () => accept(`status ${response.statusCode}`)); });
        request.on('error', error => accept(String(error.message)));
        request.end();
      }), url);
      expect(await probe('http://example.invalid/anything')).toMatch(/ERR_BLOCKED_BY_CLIENT/);
      expect(await probe(`${feed.url}latest-linux.yml`)).toBe('status 200');
      expect(await probe(`${feed.url}hop`)).toMatch(/ERR_BLOCKED_BY_CLIENT/);
      expect(await run.updaterLog()).toMatch(/blocked a request: .*example\.invalid/);
    } finally { await run.app.close().catch(() => {}); }
  });
});
