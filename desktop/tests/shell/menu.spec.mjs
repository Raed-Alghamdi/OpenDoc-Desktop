// Menus (plan E1 step 5): Open and New Workspace, Reveal Workspace, Help, the Edit roles and the About dialog.
import { expect, test } from '@playwright/test';
import { realpath } from 'node:fs/promises';
import { launchApp, nativeCalls, newProfile, newWorkspace, readConfig, setNative, stubNative } from './support/app.mjs';
import { desktopRecord, isWorkspaceUrl, libraryReady, waitFor } from './support/helpers.mjs';

const menuLabels = (app, path = []) => app.evaluate(({ Menu }, names) => {
  let items = Menu.getApplicationMenu().items;
  for (const name of names) items = items.find(item => item.label === name).submenu.items;
  return items.map(item => item.label || `[${item.role ?? item.type}]`);
}, path);
const clickItem = (app, path) => app.evaluate(({ Menu }, names) => {
  let item = { submenu: { items: Menu.getApplicationMenu().items } };
  for (const name of names) item = item.submenu.items.find(entry => entry.label === name);
  item.click();
}, path);

test.describe.serial('menus', () => {
  let app; let page; let first; let second; let profile;

  test.beforeAll(async () => {
    first = await newWorkspace('menu-a');
    second = await newWorkspace('menu-b');
    profile = await newProfile('menu-profile', { defaultWorkspace: first });
    app = await launchApp({ profile });
    await stubNative(app, { openDialog: { canceled: false, filePaths: [second] } });
    page = await app.firstWindow();
    await libraryReady(page);
  });

  test.afterAll(async () => { await app?.close().catch(() => {}); });

  test('the menu has Open, New, Reveal, Help and the Edit roles, and no reload or developer tools', async () => {
    expect(await menuLabels(app)).toEqual(['File', 'Edit', 'View', 'Window', 'Help']);
    const file = await menuLabels(app, ['File']);
    expect(file).toEqual(expect.arrayContaining(['Open Workspace…', 'New Workspace…', 'Open Recent', 'Reveal Workspace', 'Show Log', 'Quit']));
    expect(await menuLabels(app, ['Edit'])).toEqual(expect.arrayContaining(['Undo', 'Redo', 'Cut', 'Copy', 'Paste', 'Select All']));
    const view = (await menuLabels(app, ['View'])).join(' ');
    expect(view).not.toMatch(/reload|devtools|developer/i);
    expect(await menuLabels(app, ['Help'])).toEqual(expect.arrayContaining(['OpenDoc on GitHub', 'About opendoc-desktop']));
  });

  test('About credits the original project, with its link, the version and the build number', async () => {
    await clickItem(app, ['Help', 'About opendoc-desktop']);
    await waitFor(async () => (await nativeCalls(app)).messages.length > 0, { what: 'the About dialog' });
    const [about] = (await nativeCalls(app)).messages;
    expect(about.title).toBe('About opendoc-desktop');
    expect(about.message).toBe('opendoc-desktop 0.6.1');
    expect(about.detail).toContain('Build 7');
    expect(about.detail).toContain('0123456789ab');
    expect(about.detail).toContain('original OpenDoc project by RyanYahya');
    expect(about.detail).toContain('https://github.com/RyanYahya/OpenDoc');
    await setNative(app, { messageChoice: 1 });
    await clickItem(app, ['Help', 'About opendoc-desktop']);
    await waitFor(async () => (await nativeCalls(app)).external.includes('https://github.com/RyanYahya/OpenDoc'), { what: 'the project link' });
    await setNative(app, { messageChoice: 0 });
  });

  test('Help links to the original project', async () => {
    await clickItem(app, ['Help', 'OpenDoc on GitHub']);
    await waitFor(async () => (await nativeCalls(app)).external.length >= 2, { what: 'the help link' });
  });

  test('Reveal Workspace shows the workspace folder', async () => {
    await clickItem(app, ['File', 'Reveal Workspace']);
    await waitFor(async () => (await nativeCalls(app)).folders.length > 0, { what: 'the reveal' });
    expect((await nativeCalls(app)).folders.at(-1)).toBe(await realpath(first));
  });

  test('Open Workspace switches: one window, one workspace, desktop.json follows', async () => {
    await clickItem(app, ['File', 'Open Workspace…']);
    await waitFor(async () => (await desktopRecord(second).catch(() => null))?.pid === app.process().pid, { timeout: 120_000, what: 'the second workspace' });
    await waitFor(() => app.windows().some(window => isWorkspaceUrl(window.url())), { what: 'the window' });
    expect(await desktopRecord(first).catch(() => null)).toBeNull();
    const windows = await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().length);
    expect(windows).toBe(1);
    expect((await readConfig(profile)).recentWorkspaces).toEqual([await realpath(second), await realpath(first)]);
    await libraryReady(app.windows().find(window => isWorkspaceUrl(window.url())));
    expect(await menuLabels(app, ['File', 'Open Recent'])).toHaveLength(2);
  });

  test('New Workspace asks for a new or empty folder', async () => {
    await setNative(app, { openDialog: { canceled: true, filePaths: [] } });
    await clickItem(app, ['File', 'New Workspace…']);
    await waitFor(async () => (await nativeCalls(app)).opens.length >= 2, { what: 'the folder dialog' });
    const dialog = (await nativeCalls(app)).opens.at(-1);
    expect(dialog.properties).toEqual(expect.arrayContaining(['openDirectory', 'createDirectory']));
    expect(dialog.message).toMatch(/new or empty/);
  });
});
