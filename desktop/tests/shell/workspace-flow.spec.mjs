// The everyday flow, end to end on a scratch workspace: the library shows, a document opens and its PDF renders,
// a comment is added, an export is saved through the (stubbed) save dialog, "Show in folder" and the PDF window
// work, links leave through the system browser, and quitting leaves nothing running.
import { expect, test } from '@playwright/test';
import { readFile, readdir, access } from 'node:fs/promises';
import { join } from 'node:path';
import { launchApp, nativeCalls, newProfile, newWorkspace, setNative, stubNative } from './support/app.mjs';
import { electronProcesses, waitForNoElectron } from './support/processes.mjs';

test.describe.serial('workspace flow', () => {
  let app; let page; let workspace; let profile; let saveTo;

  test.beforeAll(async () => {
    workspace = await newWorkspace('flow');
    profile = await newProfile('flow-profile', { defaultWorkspace: workspace });
    saveTo = join(profile, 'saved-copy.pdf');
    app = await launchApp({ profile });
    await stubNative(app, { saveDialog: { canceled: false, filePath: saveTo } });
    page = await app.firstWindow();
  });

  test.afterAll(async () => { await app?.close().catch(() => {}); });

  test('the library shows', async () => {
    // The first render of a fresh workspace can take a while on a busy machine.
    await expect(page.getByText('Welcome to OpenDoc').first()).toBeVisible({ timeout: 120_000 });
    expect(await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].getTitle())).toMatch(/opendoc-desktop$/);
  });

  test('a document opens and its PDF renders', async () => {
    await page.getByText('Welcome to OpenDoc').first().click();
    await page.waitForSelector('canvas', { state: 'attached' });
    await expect.poll(() => page.evaluate(() => [...document.querySelectorAll('canvas')].filter(canvas => {
      const context = canvas.getContext('2d');
      if (!context || !canvas.width) return false;
      const data = context.getImageData(0, 0, Math.min(canvas.width, 200), Math.min(canvas.height, 200)).data;
      for (let i = 0; i < data.length; i += 4) if (data[i] < 245 || data[i + 1] < 245) return true;
      return false;
    }).length), { timeout: 60_000, message: `console: ${app.consoleProblems.join(' | ')}` }).toBeGreaterThan(0);
  });

  test('a comment is added and written to the workspace', async () => {
    await page.locator('button[data-text-target][aria-label^="Paragraph: Bring your idea"]').first().click();
    await page.getByRole('button', { name: 'Comment on selection' }).click();
    await page.getByLabel('Comment', { exact: true }).fill('Shorten this paragraph. اختصر هذه الفقرة من فضلك.');
    await page.getByRole('button', { name: 'Add comment' }).click();
    await expect.poll(async () => readFile(join(workspace, 'documents/welcome/comments.json'), 'utf8').catch(() => ''), { timeout: 20_000 }).toContain('اختصر');
  });

  test('an export is saved, and "Download a copy" goes through the save dialog', async () => {
    await page.getByRole('button', { name: 'Export document' }).click();
    await page.getByRole('button', { name: /^Save PDF/ }).click();
    await page.getByText('PDF saved').waitFor({ timeout: 90_000 });
    expect((await readdir(join(workspace, 'output'))).some(name => name.endsWith('.pdf'))).toBe(true);
    await page.getByRole('link', { name: 'Download a copy' }).click();
    await expect.poll(async () => readFile(saveTo).then(bytes => bytes.subarray(0, 5).toString(), () => ''), { timeout: 20_000 }).toBe('%PDF-');
    const calls = await nativeCalls(app);
    expect(calls.saves).toHaveLength(1);
    expect(calls.saves[0].defaultPath).toMatch(/\.pdf$/);
  });

  test('a cancelled save dialog writes nothing', async () => {
    const other = join(profile, 'never.pdf');
    await setNative(app, { saveDialog: { canceled: true } });
    await page.getByRole('link', { name: 'Download a copy' }).click();
    await expect.poll(async () => (await nativeCalls(app)).saves.length, { timeout: 20_000 }).toBe(2);
    await new Promise(accept => setTimeout(accept, 500));
    await expect(access(other)).rejects.toThrow();
  });

  test('"Show in folder" is answered by the main process', async () => {
    await page.getByRole('button', { name: 'Show in folder' }).click();
    await expect.poll(async () => (await nativeCalls(app)).folders.length, { timeout: 20_000 }).toBeGreaterThan(0);
    const [path] = (await nativeCalls(app)).folders;
    expect(path.startsWith(join(workspace, 'output'))).toBe(true);
    expect(path.endsWith('.pdf')).toBe(true);
  });

  test('"Open PDF to print" opens the file in an app window', async () => {
    const [child] = await Promise.all([app.waitForEvent('window', { timeout: 30_000 }), page.getByRole('link', { name: 'Open PDF to print' }).click()]);
    await child.waitForLoadState('domcontentloaded');
    expect(child.url()).toMatch(/\/api\/exports\/[a-f0-9-]+\/open$/);
    await child.close();
  });

  test('an external link leaves through the system browser, not a new window', async () => {
    const windows = app.windows().length;
    await page.evaluate(() => { location.hash = '#library'; });
    await page.getByRole('link', { name: /OpenDoc on GitHub/ }).first().click();
    await expect.poll(async () => (await nativeCalls(app)).external, { timeout: 10_000 }).toContain('https://github.com/RyanYahya/OpenDoc');
    expect(app.windows().length).toBe(windows);
  });

  test('quitting leaves no process of this Electron', async () => {
    await app.close();
    expect(await waitForNoElectron(5000)).toEqual([]);
    await expect(access(join(workspace, '.opendoc', 'desktop.json'))).rejects.toThrow();
    expect(electronProcesses()).toEqual([]);
  });
});
