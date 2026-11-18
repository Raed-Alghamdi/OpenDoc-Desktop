// Robustness (plan E1 step 4): the service is restarted when it crashes or stops answering, a crash screen
// (served by the app) shows when restarting stops helping, nothing survives a quit or a kill -9 of the main process,
// and a second launch focuses the first instance.
import { expect, test } from '@playwright/test';
import { access, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { launchApp, nativeCalls, newProfile, newWorkspace, spawnApp, stubNative } from './support/app.mjs';
import { desktopRecord, libraryReady, nextServicePid, serverRecord, slow, waitFor, waitForExit, waitForOpen } from './support/helpers.mjs';
import { electronProcesses, killElectronProcesses, processAlive, waitForNoElectron } from './support/processes.mjs';

test.describe.serial('the service is supervised', () => {
  test.describe.configure({ timeout: 420_000 });
  let app; let page; let workspace; let profile;

  test.beforeAll(async () => {
    workspace = await newWorkspace('supervised');
    profile = await newProfile('supervised-profile', { defaultWorkspace: workspace });
    app = await launchApp({ profile, env: { OPENDOC_DESKTOP_HEALTH_MS: '700' } });
    await stubNative(app);
    page = await app.firstWindow();
    await libraryReady(page);
  });

  test.afterAll(async () => { await app?.close().catch(() => {}); });

  test('a service that crashes is started again on the same address and the window recovers', async () => {
    const before = await serverRecord(workspace);
    process.kill(before.pid, 'SIGKILL');
    const after = await nextServicePid(workspace, before.pid);
    expect(after.origin).toBe(before.origin);
    expect(page.url().startsWith(before.origin)).toBe(true);
    await libraryReady(page);
    expect(await page.evaluate(() => fetch('/api/session').then(response => response.ok))).toBe(true);
  });

  test('a service that stops answering is killed and replaced', async () => {
    const before = await serverRecord(workspace);
    process.kill(before.pid, 'SIGSTOP');
    const after = await nextServicePid(workspace, before.pid);
    expect(processAlive(before.pid)).toBe(false);
    expect(after.pid).not.toBe(before.pid);
    await libraryReady(page);
  });

  test('when restarting stops helping, the crash screen shows, with the log, and "Try again" brings the workspace back', async () => {
    // Earlier restarts count: two so far in this window of two minutes, so one more crash is allowed, the next is not.
    const crashScreen = () => page.url().startsWith('app://shell/crash.html');
    let record = await serverRecord(workspace);
    for (let round = 0; round < 4 && !crashScreen(); round++) {
      try { process.kill(record.pid, 'SIGKILL'); } catch { /* already gone */ }
      const old = record.pid;
      const outcome = await waitFor(async () => {
        if (crashScreen()) return 'crash';
        try {
          const next = await serverRecord(workspace);
          if (next.pid !== old && processAlive(next.pid) && (await fetch(`${next.origin}/api/session`, { signal: AbortSignal.timeout(2000) })).ok) return next;
        } catch { /* not yet */ }
        return false;
      }, { timeout: 120_000, interval: 250, what: 'a new service or the crash screen' });
      if (outcome === 'crash') break;
      record = outcome;
    }
    await waitFor(() => page.url().startsWith('app://shell/crash.html'), { timeout: 120_000, what: 'the crash screen' });
    await expect(page.getByRole('heading', { name: 'OpenDoc stopped' })).toBeVisible();
    await expect(page.locator('#workspace')).toHaveText(workspace);
    expect(page.url().startsWith('file:')).toBe(false);
    await page.getByRole('button', { name: 'Show the log' }).click();
    await waitFor(async () => (await nativeCalls(app)).folders.length > 0, { what: 'the log reveal' });
    const [logPath] = (await nativeCalls(app)).folders;
    expect(logPath).toMatch(/workspace-[0-9a-f]{8}\.log$/);
    expect(await readFile(logPath, 'utf8')).toContain('[app] host started');
    await page.getByRole('button', { name: 'Try again' }).click();
    await libraryReady(page);
    expect(page.url().startsWith('http://127.0.0.1:')).toBe(true);
  });
});

test.describe('process hygiene', () => {
  // A failed assertion must not leave an app running for the tests after it (each test checks its own hygiene first).
  test.afterEach(() => { killElectronProcesses(); });

  test('SIGTERM is a normal quit: nothing is left and desktop.json is removed', async () => {
    const workspace = await newWorkspace('sigterm');
    const child = spawnApp({ profile: await newProfile('sigterm-profile', { defaultWorkspace: workspace }) });
    child.stdout.resume(); child.stderr.resume();
    const service = await waitFor(async () => { try { const record = await serverRecord(workspace); return (await fetch(`${record.origin}/api/session`)).ok && record; } catch { return false; } }, { timeout: 120_000, what: 'the service' });
    await waitForOpen(workspace);
    child.kill('SIGTERM');
    expect(await waitForExit(child, 30_000)).toBe(true);
    expect(await waitForNoElectron(3000)).toEqual([]);
    expect(processAlive(service.pid)).toBe(false);
    await expect(access(join(workspace, '.opendoc', 'desktop.json'))).rejects.toThrow();
  });

  test('kill -9 of the main process leaves nothing running within 3 seconds, and the next launch cleans up', async () => {
    const workspace = await newWorkspace('kill9');
    const profile = await newProfile('kill9-profile', { defaultWorkspace: workspace });
    const child = spawnApp({ profile });
    child.stdout.resume(); child.stderr.resume();
    const service = await waitFor(async () => { try { const record = await serverRecord(workspace); return (await fetch(`${record.origin}/api/session`)).ok && record; } catch { return false; } }, { timeout: 120_000, what: 'the service' });
    await waitForOpen(workspace);
    expect(electronProcesses().length).toBeGreaterThan(2);
    child.kill('SIGKILL');
    const killedAt = Date.now();
    const left = await waitForNoElectron(3000);
    expect(left, `still running ${Date.now() - killedAt} ms after kill -9: ${JSON.stringify(left)}`).toEqual([]);
    expect(processAlive(service.pid)).toBe(false);
    // The records of the dead app stay behind: desktop.json names a pid that no longer exists.
    expect(await desktopRecord(workspace)).toMatchObject({ pid: child.pid });
    const again = await launchApp({ profile });
    try {
      await libraryReady(await again.firstWindow());
      expect((await desktopRecord(workspace)).pid).toBe(again.process().pid);
    } finally { await again.close(); }
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
      const record = await serverRecord(workspace);
      const second = spawnApp({ profile });
      second.stdout.resume(); second.stderr.resume();
      expect(await waitForExit(second, 60_000)).toBe(true);
      expect(second.exitCode).toBe(0);
      await waitFor(() => app.evaluate(() => globalThis.__second), { what: 'the second-instance event' });
      expect(await app.evaluate(() => globalThis.__second)).toBe(1);
      expect(await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].isMinimized())).toBe(false);
      expect(await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().length)).toBe(1);
      expect((await serverRecord(workspace)).pid).toBe(record.pid);
      expect((await desktopRecord(workspace)).pid).toBe(app.process().pid);
    } finally { await app.close(); }
  });
});
void slow;
