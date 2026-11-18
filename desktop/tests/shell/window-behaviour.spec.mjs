// Window behaviour (plan E1 step 3): the Leave/Stay dialog for the page's own prompt, the close guard for unsaved
// drafts (decision D-d), a cancelled quit that leaves a working app, window state, and the stubbed-out OS calls.
import { expect, test } from '@playwright/test';
import { access, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { launchApp, nativeCalls, newProfile, newWorkspace, setNative, stubNative } from './support/app.mjs';
import { libraryReady, readJson, serverRecord, slow, waitFor, waitForExit } from './support/helpers.mjs';
import { waitForNoElectron } from './support/processes.mjs';

const closeWindow = app => app.evaluate(({ BrowserWindow }) => { BrowserWindow.getAllWindows()[0].close(); });
const windowCount = app => app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().length);
const serviceAnswers = page => page.evaluate(() => fetch('/api/session').then(response => response.ok, () => false));
const leaveDialogs = async app => (await nativeCalls(app)).messages.filter(options => options.title === 'Leave OpenDoc?');

test.describe.serial('unsaved edits', () => {
  let app; let page; let workspace;

  test.beforeAll(async () => {
    workspace = await newWorkspace('unsaved');
    app = await launchApp({ profile: await newProfile('unsaved-profile', { defaultWorkspace: workspace }) });
    await stubNative(app, { messageChoice: 'Stay' });
    page = await app.firstWindow();
    await libraryReady(page);
  });

  test.afterAll(async () => { await app?.close().catch(() => {}); });

  test('a real text edit stores a draft the guard recognises', async () => {
    await page.getByText('Welcome to OpenDoc').first().click();
    await page.waitForSelector('canvas', { state: 'attached' });
    await page.locator('button[data-text-target][aria-label^="Paragraph: A local place"]').first().click({ timeout: slow.timeout });
    await page.getByRole('button', { name: 'Edit selected text' }).click();
    const field = page.getByLabel('Text correction');
    await field.fill((await field.inputValue()).replace('A local place', 'A tiny local place'));
    await page.keyboard.press('Control+Enter');
    await expect.poll(() => page.evaluate(() => Object.keys(sessionStorage).some(key => key.startsWith('opendoc:text-draft:')))).toBe(true);
  });

  test('closing the window asks; Stay keeps the window and the service', async () => {
    await closeWindow(app);
    await waitFor(async () => (await leaveDialogs(app)).length === 1, { what: 'the Leave/Stay dialog' });
    const [question] = await leaveDialogs(app);
    expect(question.buttons).toEqual(['Leave', 'Stay']);
    expect(question.defaultId).toBe(1);
    expect(await windowCount(app)).toBe(1);
    expect(await serviceAnswers(page)).toBe(true);
  });

  test('a cancelled quit leaves a working window (the service stops in will-quit, not before-quit)', async () => {
    await app.evaluate(({ app: electron }) => electron.quit());
    await waitFor(async () => (await leaveDialogs(app)).length === 2, { what: 'the second Leave/Stay dialog' });
    expect(await windowCount(app)).toBe(1);
    expect(await serviceAnswers(page)).toBe(true);
    expect((await serverRecord(workspace)).pid).toBeGreaterThan(0);
  });

  test('Leave closes the window, ends the app and stops the service', async () => {
    const child = app.process();
    const service = (await serverRecord(workspace)).pid;
    await setNative(app, { messageChoice: 'Leave' });
    await closeWindow(app);
    expect(await waitForExit(child, 30_000)).toBe(true);
    expect(await waitForNoElectron(5000)).toEqual([]);
    expect(() => process.kill(service, 0)).toThrow();
    await expect(access(join(workspace, '.opendoc', 'desktop.json'))).rejects.toThrow();
  });
});

test.describe.serial('the page\'s own unload prompt', () => {
  let app; let page;

  test.beforeAll(async () => {
    const workspace = await newWorkspace('unload');
    app = await launchApp({ profile: await newProfile('unload-profile', { defaultWorkspace: workspace }) });
    await stubNative(app, { messageChoice: 'Stay' });
    page = await app.firstWindow();
    await libraryReady(page);
    // The page registers beforeunload only when it cannot store a draft; do the same, with a click for user activation.
    await page.getByText('Welcome to OpenDoc').first().hover();
    await page.mouse.click(300, 300);
    await page.evaluate(() => window.addEventListener('beforeunload', event => { event.preventDefault(); event.returnValue = ''; }));
  });

  test.afterAll(async () => { await app?.close().catch(() => {}); });

  test('Stay keeps the window open (without an answer Electron would ignore the close for good)', async () => {
    await closeWindow(app);
    await waitFor(async () => (await leaveDialogs(app)).length >= 1, { what: 'the Leave/Stay dialog' });
    await new Promise(accept => setTimeout(accept, 500));
    expect(await windowCount(app)).toBe(1);
  });

  test('Leave closes it and ends the app', async () => {
    const child = app.process();
    await setNative(app, { messageChoice: 'Leave' });
    await closeWindow(app);
    expect(await waitForExit(child, 30_000)).toBe(true);
    expect(await waitForNoElectron(5000)).toEqual([]);
  });
});

test('the window comes back where it was', async () => {
  const workspace = await newWorkspace('geometry');
  const profile = await newProfile('geometry-profile', { defaultWorkspace: workspace });
  let app = await launchApp({ profile });
  const bounds = { x: 120, y: 90, width: 1111, height: 777 };
  try {
    await libraryReady(await app.firstWindow());
    await app.evaluate(({ BrowserWindow }, next) => BrowserWindow.getAllWindows()[0].setBounds(next), bounds);
    await waitFor(async () => (await readJson(join(profile, 'window-state.json')).catch(() => null))?.width === bounds.width, { what: 'the saved window state' });
  } finally { await app.close(); }
  app = await launchApp({ profile });
  try {
    await libraryReady(await app.firstWindow());
    expect(await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].getBounds())).toEqual(bounds);
  } finally { await app.close(); }
});

test('a window whose saved place is off every screen opens at the default size on screen', async () => {
  const workspace = await newWorkspace('offscreen');
  const profile = await newProfile('offscreen-profile', { defaultWorkspace: workspace });
  await (await import('node:fs/promises')).writeFile(join(profile, 'window-state.json'), JSON.stringify({ x: 90000, y: 90000, width: 900, height: 700 }));
  const app = await launchApp({ profile });
  try {
    await libraryReady(await app.firstWindow());
    const bounds = await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].getBounds());
    expect(bounds).toMatchObject({ width: 900, height: 700 });
    expect(bounds.x).toBeLessThan(5000);
  } finally { await app.close(); }
});
void readFile;
