// App smoke test (E10): the packaged build, the one users install, does the everyday flow end to end on a scratch workspace.
// It proves what the shell's own tests (which run the unpackaged app) cannot: that the service host starts when the binary
// carries the production fuses (RunAsNode on, ASAR integrity on, only-load-from-asar on), that the bundled runtime is found
// inside the package, and that `opendoc --version` works through the launcher. Then it quits and checks nothing is left.
//
//   node desktop/tests/smoke/run.mjs                      the packaged app in desktop/dist (or $OPENDOC_E10_APP)
import { expect, test } from '@playwright/test';
import { execFile } from 'node:child_process';
import { access, mkdir, mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import { appEnvironment, desktop, appProcesses, isMac, launchApp, locateApp, readFuses, sentinelsOf, serviceHostOf, waitUntil } from './support/app.mjs';
import { makeWorkspace } from './support/workspace.mjs';

const app = locateApp();
const runtime = path.join(app.resources, 'runtime');

test.describe.serial('the packaged app', () => {
  let scratch; let workspace; let profile; let running; let page; let version;

  test.beforeAll(async () => {
    scratch = await mkdtemp(path.join(os.tmpdir(), 'opendoc-e10-'));
    for (const folder of ['tmp', 'config', 'data', 'cache']) await mkdir(path.join(scratch, folder), { recursive: true });
    version = JSON.parse(await readFile(path.join(runtime, 'package.json'), 'utf8')).version;
    workspace = path.join(scratch, 'workspace');
    makeWorkspace(runtime, workspace, version);
    profile = path.join(scratch, 'profile');
    await mkdir(profile);
    await writeFile(path.join(profile, 'config.json'), JSON.stringify({ defaultWorkspace: workspace }));
    expect(appProcesses(app.root), 'an earlier copy of the app is still running').toEqual([]);
    running = await launchApp({ app, profile, env: appEnvironment(scratch) });
    page = running.page;
  });

  test.afterAll(async () => {
    await running?.browser.close().catch(() => {});
    if (running && !running.exited()) running.child.kill('SIGKILL');
    for (const { pid } of appProcesses(app.root)) { try { process.kill(pid, 'SIGKILL'); } catch { /* gone */ } }
    await rm(scratch, { recursive: true, force: true });
  });

  test('the build carries the production fuses', async () => {
    const fuses = await readFuses(app.executable);
    expect(fuses).toMatchObject({ RunAsNode: true, EnableEmbeddedAsarIntegrityValidation: true, OnlyLoadAppFromAsar: true, EnableNodeCliInspectArguments: false, EnableNodeOptionsEnvironmentVariable: false });
    // The code is in the archive, not beside it.
    await expect(access(path.join(app.resources, 'app.asar'))).resolves.toBeUndefined();
  });

  test('the library shows', async () => {
    await expect(page.getByText('Welcome to OpenDoc').first()).toBeVisible({ timeout: 180_000 });
    expect(page.url()).toMatch(/^app:\/\/opendoc\//);
  });

  test('the service host runs under the binary, started by the app', async () => {
    const host = await waitUntil(() => serviceHostOf(running.child.pid), { what: 'the service host process' });
    expect(host.command.startsWith(app.executable)).toBe(true);
    // The watcher that outlives a crashed app is running too.
    expect(sentinelsOf(running.child.pid).length).toBeGreaterThan(0);
    await expect(access(path.join(workspace, '.opendoc', 'desktop.json'))).resolves.toBeUndefined();
  });

  test('a document opens and its PDF renders', async () => {
    await page.getByText('Welcome to OpenDoc').first().click();
    await page.waitForSelector('canvas', { state: 'attached' });
    await expect.poll(() => page.evaluate(() => [...document.querySelectorAll('canvas')].filter((canvas) => {
      const context = canvas.getContext('2d');
      if (!context || !canvas.width) return false;
      const data = context.getImageData(0, 0, Math.min(canvas.width, 200), Math.min(canvas.height, 200)).data;
      for (let i = 0; i < data.length; i += 4) if (data[i] < 245 || data[i + 1] < 245) return true;
      return false;
    }).length), { timeout: 120_000 }).toBeGreaterThan(0);
  });

  test('a comment is added and written to the workspace', async () => {
    await page.locator('button[data-text-target][aria-label^="Paragraph: Bring your idea"]').first().click();
    await page.getByRole('button', { name: 'Comment on selection' }).click();
    await page.getByLabel('Comment', { exact: true }).fill('Shorten this paragraph. اختصر هذه الفقرة من فضلك.');
    await page.getByRole('button', { name: 'Add comment' }).click();
    await expect.poll(() => readFile(path.join(workspace, 'documents/welcome/comments.json'), 'utf8').catch(() => ''), { timeout: 30_000 }).toContain('اختصر');
  });

  test('an export is saved as a PDF', async () => {
    await page.getByRole('button', { name: 'Export document' }).click();
    await page.getByRole('button', { name: /^Save PDF/ }).click();
    await page.getByText('PDF saved').waitFor({ timeout: 180_000 });
    const files = (await readdir(path.join(workspace, 'output'))).filter((name) => name.endsWith('.pdf'));
    expect(files.length).toBeGreaterThan(0);
    expect((await readFile(path.join(workspace, 'output', files[0]))).subarray(0, 5).toString()).toBe('%PDF-');
  });

  test('`opendoc --version` runs through the launcher', async () => {
    const run = promisify(execFile);
    // Linux: the launcher the deb, rpm and pacman packages install as /usr/bin/opendoc (the file fpm takes from resources/cli, which
    // is not copied into the app folder), pointed at this app by OPENDOC_DESKTOP_HOME. macOS has no launcher (the menu's "Install
    // Command-Line Tool" writes one), so the same command line is run by hand.
    const [command, args] = isMac
      ? [app.executable, [path.join(runtime, 'node_modules', 'opendoc', 'bin', 'opendoc.mjs'), '--version']]
      : [path.join(desktop, 'resources', 'cli', 'opendoc'), ['--version']];
    const env = { PATH: '/usr/bin:/bin', HOME: scratch, LANG: 'C.UTF-8', ...(isMac ? { ELECTRON_RUN_AS_NODE: '1' } : { OPENDOC_DESKTOP_HOME: app.root }) };
    const { stdout } = await run(command, args, { cwd: workspace, env, timeout: 240_000 });
    expect(stdout).toContain(version);
  });

  test('quitting leaves nothing running', async () => {
    await running.browser.close();
    process.kill(running.child.pid, 'SIGTERM');
    await waitUntil(() => running.exited(), { timeout: 30_000, what: 'the app to exit' });
    expect(running.child.exitCode).toBe(0);
    await waitUntil(() => appProcesses(app.root).length === 0 && sentinelsOf(running.child.pid).length === 0, { timeout: 15_000, what: 'every process of the app to end' });
    expect(appProcesses(app.root)).toEqual([]);
    await expect(access(path.join(workspace, '.opendoc', 'desktop.json'))).rejects.toThrow();
  });
});
