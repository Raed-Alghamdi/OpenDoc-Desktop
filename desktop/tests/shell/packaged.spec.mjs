// The app as it ships: desktop/src, package.json and the production dependencies packed into an app.asar, run by the same Electron. The service host
// is started from text (not from a file inside the asar), and the page, the bridge and the quit must all work from there.
import { _electron, expect, test } from '@playwright/test';
import { spawnSync } from 'node:child_process';
import { existsSync, realpathSync } from 'node:fs';
import { createRequire } from 'node:module';
import { appendFile, cp, mkdir, readFile, rm } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { appEnvironment, newProfile, newWorkspace } from './support/app.mjs';
import { hostPid, libraryReady } from './support/helpers.mjs';
import { cache, desktopDir, electronExecutable } from './support/paths.mjs';
import { waitForNoElectron } from './support/processes.mjs';

// @electron/asar is electron-builder's own packer (a dependency of app-builder-lib).
const require = createRequire(createRequire(join(desktopDir, 'package.json')).resolve('electron-builder/package.json'));
const asar = createRequire(require.resolve('app-builder-lib/package.json'))('@electron/asar');

// Where Node would find a package from a folder (pnpm links each package's dependencies beside it).
const findPackage = (fromDir, name) => {
  for (const base of createRequire(join(fromDir, 'index.js')).resolve.paths(name) ?? []) {
    if (existsSync(join(base, name, 'package.json'))) return realpathSync(join(base, name));
  }
  throw new Error(`${name} is not installed (looked from ${fromDir}).`);
};

// The production dependencies (electron-updater and what it needs) go into the asar's node_modules, as electron-builder
// puts them there: one copy per name at the top, and a different version nested under the package that needs it.
async function stageProductionDependencies(fromDir, appDir) {
  const top = new Map();
  const visit = async (dir, dependencies, nested) => {
    for (const name of Object.keys(dependencies ?? {})) {
      const source = findPackage(dir, name);
      const { version, dependencies: next } = JSON.parse(await readFile(join(source, 'package.json'), 'utf8'));
      let target;
      if (!top.has(name)) { top.set(name, version); target = join(appDir, 'node_modules', name); }
      else if (top.get(name) === version) continue;
      else target = join(nested, name);
      if (existsSync(target)) continue;
      await cp(source, target, { recursive: true, dereference: true });
      await visit(source, next, join(target, 'node_modules'));
    }
  };
  const manifest = JSON.parse(await readFile(join(fromDir, 'package.json'), 'utf8'));
  await visit(fromDir, manifest.dependencies, join(appDir, 'node_modules'));
}

test('packed into an asar, the app opens a workspace, runs the service and passes changes to the page', async () => {
  const staging = join(cache, 'packaged');
  await rm(staging, { recursive: true, force: true });
  await mkdir(join(staging, 'app'), { recursive: true });
  await cp(join(desktopDir, 'src'), join(staging, 'app', 'src'), { recursive: true });
  await cp(join(desktopDir, 'package.json'), join(staging, 'app', 'package.json'));
  await stageProductionDependencies(desktopDir, join(staging, 'app'));
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
