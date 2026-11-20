// Robustness: the service is restarted when it crashes or stops answering, a crash screen
// (served by the app) shows when restarting stops helping, nothing survives a quit or a kill -9 of the main process,
// and a second launch focuses the first instance.
import { expect, test } from '@playwright/test';
import { access, readFile } from 'node:fs/promises';
import { createServer } from 'node:net';
import { join } from 'node:path';
import { launchApp, nativeCalls, newProfile, newWorkspace, spawnApp, stubNative } from './support/app.mjs';
import { desktopRecord, hostPid, isWorkspaceUrl, libraryReady, nextHostPid, slow, waitFor, waitForExit, waitForOpen } from './support/helpers.mjs';
import { electronProcesses, killElectronProcesses, listeners, processAlive, processTree, serviceHostOf, waitForNoElectron } from './support/processes.mjs';

test.describe.serial('the service is supervised', () => {
  test.describe.configure({ timeout: 420_000 });
  let app; let page; let workspace; let profile;
  const states = () => page.evaluate(() => window.__states);

  test.beforeAll(async () => {
    workspace = await newWorkspace('supervised');
    profile = await newProfile('supervised-profile', { defaultWorkspace: workspace });
    app = await launchApp({ profile, env: { OPENDOC_DESKTOP_HEALTH_MS: '700' } });
    await stubNative(app);
    page = await app.firstWindow();
    await libraryReady(page);
    // What the page is told about the host (the page's own message listens to the same bridge), and a marker that shows the page is never reloaded.
    await page.evaluate(() => { window.__states = []; window.__marker = 'same page'; window.opendocDesktop.onHostState(({ state }) => window.__states.push(state)); });
  });

  test.afterAll(async () => { await app?.close().catch(() => {}); });

  test('a service host that is killed gives restarting, then running, and the page keeps working without a reload', async () => {
    const before = hostPid(app);
    expect(await states()).toEqual([]);
    process.kill(before, 'SIGKILL');
    const after = await nextHostPid(app, before);
    expect(after).not.toBe(before);
    await waitFor(async () => (await states()).includes('running'), { timeout: 120_000, what: 'the running state' });
    expect(await states()).toEqual(['restarting', 'running']);
    expect(isWorkspaceUrl(page.url())).toBe(true);
    expect(await page.evaluate(() => window.__marker)).toBe('same page');
    await libraryReady(page);
    expect(await page.evaluate(() => fetch('/api/session').then(response => response.ok))).toBe(true);
    // The new host has a new session token: a change the page makes still works (it asks for the token again).
    expect(await page.evaluate(async () => (await fetch('/api/context', { method: 'POST', headers: { 'content-type': 'application/json', 'x-opendoc-token': (await (await fetch('/api/session')).json()).token }, body: JSON.stringify({ documentId: 'welcome', blockId: null, page: 1, selection: null, editing: false, pendingEdits: 0, draftPreview: false }) })).status)).toBeLessThan(500);
  });

  test('a service host that stops answering is killed and replaced, with the same two states', async () => {
    const before = hostPid(app);
    process.kill(before, 'SIGSTOP');
    const after = await nextHostPid(app, before);
    expect(processAlive(before)).toBe(false);
    expect(after).not.toBe(before);
    await waitFor(async () => (await states()).length === 4, { timeout: 120_000, what: 'the second restart to finish' });
    expect(await states()).toEqual(['restarting', 'running', 'restarting', 'running']);
    await libraryReady(page);
  });

  test('when restarting stops helping, the crash screen shows, with the log, and "Try again" brings the workspace back', async () => {
    // Earlier restarts count: two so far in this window of two minutes, so one more crash is allowed, the next is not.
    const crashScreen = () => page.url().startsWith('app://shell/crash.html');
    for (let round = 0; round < 4 && !crashScreen(); round++) {
      const old = hostPid(app);
      if (old) { try { process.kill(old, 'SIGKILL'); } catch { /* already gone */ } }
      await waitFor(() => crashScreen() || (hostPid(app) && hostPid(app) !== old && processAlive(hostPid(app))), { timeout: 120_000, interval: 250, what: 'a new service host or the crash screen' });
      if (!crashScreen()) await waitFor(() => crashScreen() || page.evaluate(() => fetch('/api/session').then(response => response.ok, () => false)).catch(() => false), { timeout: 120_000, interval: 250, what: 'the service to answer again' });
    }
    await waitFor(() => crashScreen(), { timeout: 120_000, what: 'the crash screen' });
    await expect(page.getByRole('heading', { name: 'OpenDoc stopped' })).toBeVisible();
    await expect(page.locator('#workspace')).toHaveText(workspace);
    expect(page.url().startsWith('file:')).toBe(false);
    expect(await page.evaluate(() => typeof window.opendocDesktop)).toBe('undefined'); // the crash screen has no workspace bridge
    await page.getByRole('button', { name: 'Show the log' }).click();
    await waitFor(async () => (await nativeCalls(app)).folders.length > 0, { what: 'the log reveal' });
    const [logPath] = (await nativeCalls(app)).folders;
    expect(logPath).toMatch(/workspace-[0-9a-f]{8}\.log$/);
    expect(await readFile(logPath, 'utf8')).toContain('[app] host started');
    await page.getByRole('button', { name: 'Try again' }).click();
    await libraryReady(page);
    expect(isWorkspaceUrl(page.url())).toBe(true);
  });
});

test.describe('process hygiene', () => {
  // A failed assertion must not leave an app running for the tests after it (each test checks its own hygiene first).
  test.afterEach(() => { killElectronProcesses(); });

  test('SIGTERM is a normal quit: nothing is left and desktop.json is removed', async () => {
    const workspace = await newWorkspace('sigterm');
    const child = spawnApp({ profile: await newProfile('sigterm-profile', { defaultWorkspace: workspace }) });
    child.stdout.resume(); child.stderr.resume();
    const service = await waitFor(() => serviceHostOf(child.pid), { timeout: 120_000, what: 'the service host' });
    await waitForOpen(workspace);
    child.kill('SIGTERM');
    expect(await waitForExit(child, 30_000)).toBe(true);
    expect(await waitForNoElectron(5000)).toEqual([]);
    expect(processAlive(service)).toBe(false);
    await expect(access(join(workspace, '.opendoc', 'desktop.json'))).rejects.toThrow();
  });

  test('kill -9 of the main process leaves nothing running within 3 seconds, and the next launch cleans up', async () => {
    const workspace = await newWorkspace('kill9');
    const profile = await newProfile('kill9-profile', { defaultWorkspace: workspace });
    const child = spawnApp({ profile });
    child.stdout.resume(); child.stderr.resume();
    const service = await waitFor(() => serviceHostOf(child.pid), { timeout: 120_000, what: 'the service host' });
    await waitForOpen(workspace);
    expect(electronProcesses().length).toBeGreaterThan(2);
    child.kill('SIGKILL');
    const killedAt = Date.now();
    // No process may run from the app's executable path five seconds later (the match is on the path, not on any name).
    const left = await waitForNoElectron(5000);
    expect(left, `still running ${Date.now() - killedAt} ms after kill -9: ${JSON.stringify(left)}`).toEqual([]);
    expect(processAlive(service)).toBe(false);
    // The records of the dead app stay behind: desktop.json names a pid that no longer exists.
    expect(await desktopRecord(workspace)).toMatchObject({ pid: child.pid });
    const again = await launchApp({ profile });
    try {
      await libraryReady(await again.firstWindow());
      expect((await desktopRecord(workspace)).pid).toBe(again.process().pid);
    } finally { await again.close(); }
  });

  test('no process of the app listens on a port while it is open, and the app writes no session record', async () => {
    // The check must be able to see a listener at all: one of this test's own.
    const probe = createServer();
    await new Promise(accept => probe.listen(0, '127.0.0.1', accept));
    try { expect(listeners().some(item => item.pid === process.pid && item.protocol === 'tcp')).toBe(true); }
    finally { probe.close(); }
    // The app runs by itself here, not under Playwright: its driver adds a DevTools port and a Node inspector port of its own.
    const workspace = await newWorkspace('no-port');
    const child = spawnApp({ profile: await newProfile('no-port-profile', { defaultWorkspace: workspace }) });
    child.stdout.resume(); child.stderr.resume();
    await waitFor(() => serviceHostOf(child.pid), { timeout: 120_000, what: 'the service host' });
    await waitForOpen(workspace);
    // Sample for a while: the window loads, the service renders (workers start, esbuild runs) and nothing may listen.
    const offending = [];
    let largest = 0;
    for (let sample = 0; sample < 30; sample++) {
      const owned = new Set([...electronProcesses().map(item => item.pid), ...processTree(child.pid)]);
      largest = Math.max(largest, owned.size);
      offending.push(...listeners().filter(item => owned.has(item.pid)).map(item => item.line));
      await new Promise(accept => setTimeout(accept, 400));
    }
    expect(largest).toBeGreaterThan(4); // main, zygote, GPU, renderer, network, the service host
    expect([...new Set(offending)], 'the app listens on').toEqual([]);
    await expect(access(join(workspace, '.opendoc', 'server.json'))).rejects.toThrow();
    child.kill('SIGTERM');
    expect(await waitForExit(child, 30_000)).toBe(true);
    expect(await waitForNoElectron(5000)).toEqual([]);
  });

  test('a second launch focuses the first instance and starts nothing of its own', async () => {
    const workspace = await newWorkspace('single');
    const profile = await newProfile('single-profile', { defaultWorkspace: workspace });
    const app = await launchApp({ profile });
    try {
      const page = await app.firstWindow();
      await libraryReady(page);
      await app.evaluate(({ app: electron, BrowserWindow }) => {
        globalThis.__second = 0;
        electron.on('second-instance', () => { globalThis.__second++; });
        BrowserWindow.getAllWindows()[0].minimize();
      });
      const host = hostPid(app);
      const second = spawnApp({ profile });
      second.stdout.resume(); second.stderr.resume();
      expect(await waitForExit(second, 60_000)).toBe(true);
      expect(second.exitCode).toBe(0);
      await waitFor(() => app.evaluate(() => globalThis.__second), { what: 'the second-instance event' });
      expect(await app.evaluate(() => globalThis.__second)).toBe(1);
      expect(await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].isMinimized())).toBe(false);
      expect(await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().length)).toBe(1);
      expect(hostPid(app)).toBe(host);
      expect((await desktopRecord(workspace)).pid).toBe(app.process().pid);
    } finally { await app.close(); }
  });
});
void slow;
