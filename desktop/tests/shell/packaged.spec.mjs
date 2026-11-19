// The app as it ships: desktop/src and package.json packed into an app.asar, run by the same Electron. The service host
// is started from text (not from a file inside the asar), and the page, the bridge and the quit must all work from there.
import { _electron, expect, test } from '@playwright/test';
import { spawnSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { appendFile, cp, mkdir, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { appEnvironment, newProfile, newWorkspace } from './support/app.mjs';
import { hostPid, libraryReady } from './support/helpers.mjs';
import { cache, desktopDir, electronExecutable } from './support/paths.mjs';
import { waitForNoElectron } from './support/processes.mjs';

// @electron/asar is electron-builder's own packer (a dependency of app-builder-lib).
const require = createRequire(createRequire(join(desktopDir, 'package.json')).resolve('electron-builder/package.json'));
const asar = createRequire(require.resolve('app-builder-lib/package.json'))('@electron/asar');

test('packed into an asar, the app opens a workspace, runs the service and passes changes to the page', async () => {
  const staging = join(cache, 'packaged');
  await rm(staging, { recursive: true, force: true });
  await mkdir(join(staging, 'app'), { recursive: true });
  await cp(join(desktopDir, 'src'), join(staging, 'app', 'src'), { recursive: true });
  await cp(join(desktopDir, 'package.json'), join(staging, 'app', 'package.json'));
  await asar.createPackage(join(staging, 'app'), join(staging, 'app.asar'));
  expect(spawnSync('test', ['-f', join(staging, 'app.asar')]).status).toBe(0);

  const workspace = await newWorkspace('packaged');
  const profile = await newProfile('packaged-profile', { defaultWorkspace: workspace });
  const app = await _electron.launch({ executablePath: electronExecutable, args: ['--ozone-platform=x11', `--user-data-dir=${profile}`, join(staging, 'app.asar')], env: appEnvironment(), timeout: 90_000 });
  try {
    const page = await app.firstWindow();
    await libraryReady(page);
    expect(await app.evaluate(({ app: electron }) => electron.getAppPath())).toMatch(/app\.asar$/);
    expect(page.url()).toBe('app://opendoc/');
    expect(hostPid(app)).toBeGreaterThan(0);
    expect(await page.evaluate(() => typeof window.opendocDesktop?.onChange)).toBe('function');
    // The page is told of a change: edit a document file; the service's watcher reports it over the channel from the packed layout.
    await page.evaluate(() => { window.__changes = 0; window.opendocDesktop.onChange(() => { window.__changes++; }); });
    await appendFile(join(workspace, 'documents', 'welcome', 'index.tsx'), '\n');
    await expect.poll(() => page.evaluate(() => window.__changes), { timeout: 60_000 }).toBeGreaterThan(0);
  } finally { await app.close(); }
  expect(await waitForNoElectron(5000)).toEqual([]);
});
