// Startup: config.json, desktop.json, the first-run picker (open, create, recent), and what the
// app does with a stale desktop.json, a stale or live lock and a workspace whose browser service is running.
import { expect, test } from '@playwright/test';
import { spawn } from 'node:child_process';
import { access, mkdir, readFile, realpath, stat, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { launchApp, nativeCalls, newProfile, newWorkspace, readConfig, setNative, stubNative } from './support/app.mjs';
import { deadPid, desktopRecord, hostPid, isWorkspaceUrl, libraryReady, serverRecord, slow, waitFor } from './support/helpers.mjs';
import { runtimeDir, workDir } from './support/paths.mjs';
import { electronProcesses, waitForNoElectron } from './support/processes.mjs';

const pickerHeading = page => page.getByRole('heading', { name: 'Choose a workspace' });
const gone = file => expect(access(file)).rejects.toThrow();

test.describe('startup', () => {
  test('a default workspace opens at launch: desktop.json and config.json are written, and removed or kept on quit', async () => {
    const workspace = await newWorkspace('startup');
    const profile = await newProfile('startup-profile', { defaultWorkspace: workspace, checkForUpdates: false });
    const app = await launchApp({ profile });
    try {
      const page = await app.firstWindow();
      await libraryReady(page);
      const record = await desktopRecord(workspace);
      expect(Object.keys(record).sort()).toEqual(['build', 'pid', 'startedAt', 'version']);
      expect(record).toMatchObject({ version: '0.6.1', build: 7 });
      expect(record.pid).toBe(app.process().pid);
      // The host runs with the workspace as its working directory (theme modules are read relative to it).
      expect(await realpath(`/proc/${hostPid(app)}/cwd`)).toBe(await realpath(workspace));
      // No listener, so no browser-edition session record either.
      await gone(join(workspace, '.opendoc', 'server.json'));
      const config = await readConfig(profile);
      expect(config.defaultWorkspace).toBe(workspace);
      expect(config.recentWorkspaces).toEqual([workspace]);
      expect(config.checkForUpdates).toBe(false); // unknown to the shell, kept on rewrite
      expect((await stat(join(profile, 'config.json'))).mode & 0o777).toBe(0o600);
    } finally { await app.close(); }
    await gone(join(workspace, '.opendoc', 'desktop.json'));
    expect(await waitForNoElectron(5000)).toEqual([]);
  });

  test('first run: the picker shows, opens an existing workspace and remembers it', async () => {
    const workspace = await newWorkspace('picked');
    const profile = await newProfile('first-run');
    const app = await launchApp({ profile });
    try {
      await stubNative(app, { openDialog: { canceled: false, filePaths: [workspace] } });
      const picker = await app.firstWindow();
      expect(picker.url()).toBe('app://shell/picker.html');
      await expect(pickerHeading(picker)).toBeVisible();
      await expect(picker.getByText('No workspaces yet.')).toBeVisible();
      expect(await app.evaluate(({ Menu }) => Menu.getApplicationMenu().items.find(item => item.label === 'File').submenu.items.find(item => item.label === 'Reveal Workspace').enabled)).toBe(false);
      await picker.getByRole('button', { name: /Open existing workspace/ }).click();
      await waitFor(() => app.windows().some(page => isWorkspaceUrl(page.url())), { timeout: 120_000, what: 'the workspace window' });
      const page = app.windows().find(item => isWorkspaceUrl(item.url()));
      await libraryReady(page);
      expect(app.windows().length).toBe(1);
      expect(await readConfig(profile)).toMatchObject({ defaultWorkspace: workspace, recentWorkspaces: [workspace] });
    } finally { await app.close(); }
  });

  test('first run: "Create new workspace" builds one with the CLI\'s init and opens it', async () => {
    const target = join(workDir, 'created-by-picker');
    const profile = await newProfile('create-run');
    const app = await launchApp({ profile });
    try {
      await stubNative(app, { openDialog: { canceled: false, filePaths: [target] } });
      const picker = await app.firstWindow();
      await picker.getByRole('button', { name: /Create new workspace/ }).click();
      await waitFor(() => app.windows().some(page => isWorkspaceUrl(page.url())), { timeout: 240_000, what: 'the new workspace window' });
      await libraryReady(app.windows().find(item => isWorkspaceUrl(item.url())));
      expect(JSON.parse(await readFile(join(target, '.opendoc', 'workspace.json'), 'utf8')).edition).toBe('normal');
      expect(await readConfig(profile)).toMatchObject({ defaultWorkspace: target });
      expect((await nativeCalls(app)).opens[0]).toMatchObject({ properties: expect.arrayContaining(['openDirectory', 'createDirectory']) });
    } finally { await app.close(); }
  });

  test('the recent list opens, forgets, and reports a folder that is gone', async () => {
    const first = await newWorkspace('recent-a');
    const second = await newWorkspace('recent-b');
    const missing = join(workDir, 'no-such-workspace');
    const profile = await newProfile('recent-run', { recentWorkspaces: [first, missing, second] });
    const app = await launchApp({ profile });
    try {
      const picker = await app.firstWindow();
      await expect(picker.locator('ul.recent li')).toHaveCount(3);
      await expect(picker.getByText(`${missing} (not found)`)).toBeVisible();
      await picker.getByRole('button', { name: new RegExp(`no-such-workspace`) }).first().click();
      await expect(picker.locator('#message')).toContainText('was not found');
      await picker.getByRole('button', { name: 'Remove no-such-workspace from the list' }).click();
      await expect(picker.locator('ul.recent li')).toHaveCount(2);
      expect((await readConfig(profile)).recentWorkspaces).toEqual([first, second]);
      await picker.getByRole('button', { name: /recent-b/ }).first().click();
      await waitFor(() => app.windows().some(page => isWorkspaceUrl(page.url())), { timeout: 120_000, what: 'the workspace window' });
      expect((await readConfig(profile)).recentWorkspaces).toEqual([second, first]);
    } finally { await app.close(); }
  });

  test('a folder that is not a workspace is refused with a clear message', async () => {
    const empty = join(workDir, 'empty-folder');
    await mkdir(empty, { recursive: true });
    const app = await launchApp({ profile: await newProfile('not-workspace') });
    try {
      await stubNative(app, { openDialog: { canceled: false, filePaths: [empty] } });
      const picker = await app.firstWindow();
      await picker.getByRole('button', { name: /Open existing workspace/ }).click();
      await expect(picker.locator('#message')).toContainText('is not an OpenDoc workspace');
      expect(electronProcesses().length).toBeGreaterThan(0);
    } finally { await app.close(); }
  });

  test('a stale desktop.json (its pid is gone) is replaced at open', async () => {
    const workspace = await newWorkspace('stale-record');
    const dead = await deadPid();
    await writeFile(join(workspace, '.opendoc', 'desktop.json'), JSON.stringify({ pid: dead, startedAt: '2026-01-01T00:00:00.000Z', version: '0.6.1', build: 1 }));
    const app = await launchApp({ profile: await newProfile('stale-record-profile', { defaultWorkspace: workspace }) });
    try {
      await libraryReady(await app.firstWindow());
      expect((await desktopRecord(workspace)).pid).toBe(app.process().pid);
    } finally { await app.close(); }
  });

  test('a workspace another opendoc-desktop has open is refused, and the first app is not disturbed', async () => {
    const workspace = await newWorkspace('open-elsewhere');
    const first = await launchApp({ profile: await newProfile('owner-profile', { defaultWorkspace: workspace }) });
    try {
      await libraryReady(await first.firstWindow());
      const second = await launchApp({ profile: await newProfile('visitor-profile', { defaultWorkspace: workspace }) });
      try {
        const picker = await second.firstWindow();
        await expect(picker.locator('#message')).toContainText('already open in another copy of OpenDoc Desktop');
        expect((await desktopRecord(workspace)).pid).toBe(first.process().pid);
      } finally { await second.close(); }
      expect((await desktopRecord(workspace)).pid).toBe(first.process().pid);
    } finally { await first.close(); }
  });

  test('a stale lock is reported, cleared only on request, and then the workspace opens', async () => {
    const workspace = await newWorkspace('stale-lock');
    const lock = join(workspace, '.opendoc', 'update.lock');
    await writeFile(lock, JSON.stringify({ pid: await deadPid(), id: 'left-behind' }));
    const app = await launchApp({ profile: await newProfile('stale-lock-profile', { defaultWorkspace: workspace }) });
    try {
      const picker = await app.firstWindow();
      await expect(picker.locator('#message')).toContainText('stopped before it released');
      expect(await readFile(lock, 'utf8')).toContain('left-behind'); // not cleared by itself
      await picker.getByRole('button', { name: 'Clear stale lock' }).click();
      await waitFor(() => app.windows().some(page => isWorkspaceUrl(page.url())), { timeout: 120_000, what: 'the workspace window' });
      await waitFor(() => access(lock).then(() => false, () => true), { timeout: 60_000, what: 'the lock to be released once the workspace is open' });
    } finally { await app.close(); }
  });

  test('a lock held by a running command is never offered for clearing', async () => {
    const workspace = await newWorkspace('live-lock');
    const lock = join(workspace, '.opendoc', 'update.lock');
    await writeFile(lock, JSON.stringify({ pid: process.pid, id: 'running-command' }));
    const app = await launchApp({ profile: await newProfile('live-lock-profile', { defaultWorkspace: workspace }) });
    try {
      const picker = await app.firstWindow();
      await expect(picker.locator('#message')).toContainText('Another OpenDoc command is working');
      await expect(picker.getByRole('button', { name: 'Clear stale lock' })).toHaveCount(0);
      expect(await readFile(lock, 'utf8')).toContain('running-command');
    } finally { await app.close(); }
  });

  test('a workspace whose browser service is running is refused, with the way to stop it', async () => {
    const workspace = await newWorkspace('browser-service');
    const service = spawn(process.execPath, [join(runtimeDir, 'node_modules', 'opendoc', 'bin', 'opendoc.mjs'), 'start', '--no-open'], { cwd: workspace, stdio: 'ignore', detached: true });
    try {
      await waitFor(async () => { try { return (await fetch(`${(await serverRecord(workspace)).origin}/api/session`)).ok; } catch { return false; } }, { timeout: 120_000, what: 'the browser service' });
      const app = await launchApp({ profile: await newProfile('browser-service-profile', { defaultWorkspace: workspace }) });
      try {
        const picker = await app.firstWindow();
        await expect(picker.locator('#message')).toContainText('already running for this workspace in a browser');
        await expect(picker.getByRole('button', { name: /Stop it with opendoc stop/ })).toBeVisible();
        await gone(join(workspace, '.opendoc', 'desktop.json'));
      } finally { await app.close(); }
    } finally { try { process.kill(-service.pid, 'SIGKILL'); } catch { /* already gone */ } }
  });

  test('the workspace picker shows when the default workspace has gone', async () => {
    const app = await launchApp({ profile: await newProfile('gone-default', { defaultWorkspace: join(workDir, 'deleted-workspace') }) });
    try {
      await expect(pickerHeading(await app.firstWindow())).toBeVisible();
    } finally { await app.close(); }
  });
});
void slow; void setNative; void stat;
