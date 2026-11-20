// A design pack opened from outside the page, with the page's real Import dialog (src/app/PackDialogs.tsx, mounted in src/app/main.tsx),
// under Electron on the virtual display (plan E9, end to end). Two apps take part, each with its own profile and workspace:
//   * the sender exports two themes through the Export dialog (so the packs are real files in output/packs/), and its Show in folder
//     button reaches the shell, which reveals the file it just wrote;
//   * the recipient (a workspace without those themes) is opened with a pack on the command line, then given packs by a second
//     launch and by File > Import Design Pack…, and must always show the review step with the trust box unticked and Install disabled.
// Nothing is installed until the test ticks the box on purpose, and the OS file manager is never started (shell calls are recorded).
// Screenshots go to $OPENDOC_I3_SHOTS when it is set.
import { expect, test } from '@playwright/test';
import { access, readFile, realpath, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { launchApp, nativeCalls, newProfile, newWorkspace, setNative, spawnApp, stubNative } from './support/app.mjs';
import { isWorkspaceUrl, waitFor, waitForExit, waitForOpen } from './support/helpers.mjs';

const shots = process.env.OPENDOC_I3_SHOTS;
const shoot = async (page, name) => { if (shots) await page.screenshot({ path: join(shots, `${name}.png`) }); };
const workspacePage = app => app.windows().find(page => isWorkspaceUrl(page.url()));
const exists = file => access(file).then(() => true, () => false);
const clickItem = (app, path) => app.evaluate(({ Menu }, names) => {
  let items = Menu.getApplicationMenu().items;
  let item;
  for (const name of names) { item = items.find(entry => entry.label === name); items = item.submenu?.items ?? []; }
  item.click();
}, path);
const openFile = (app, path) => app.evaluate(({ app: electron }, file) => { electron.emit('open-file', { preventDefault() {} }, file); }, path);

const themes = [{ id: 'civic-spectrum', name: 'Civic Spectrum', pack: 'e2e-civic' }, { id: 'field-manual', name: 'Field Manual', pack: 'e2e-field' }];
const long = { timeout: 180_000 };

/** Export one theme from the sender's Themes gallery with the page's own dialogs. Resolves to the path the dialog shows. */
async function exportTheme(page, theme) {
  await page.evaluate(() => { location.hash = 'themes'; });
  await page.locator('#pack-export-theme').click();
  await page.getByRole('checkbox', { name: `Include ${theme.name} in the pack` }).check();
  await page.getByRole('region', { name: 'Export a pack' }).getByRole('button', { name: 'Export…' }).click();
  const dialog = page.getByRole('dialog');
  await dialog.getByLabel('Pack name').fill(theme.pack);
  await dialog.getByRole('button', { name: 'Export pack' }).click();
  await expect(dialog.getByText('Pack saved')).toBeVisible(long);
  return dialog;
}

// The title changes with the step (Import a pack, then Pack installed), so the dialog is found by its class.
const importDialog = page => page.locator('.pack-import-dialog');
const trustBox = page => importDialog(page).getByLabel('I trust where this pack came from, and I want OpenDoc to run its code.');
const installButton = page => importDialog(page).getByRole('button', { name: 'Install pack' });

/** The review step of the Import dialog for this pack name, with nothing ticked and nothing installable yet. */
async function expectReview(page, name) {
  const dialog = importDialog(page);
  await expect(dialog.getByRole('heading', { name })).toBeVisible(long);
  await expect(dialog.getByText('Review what is inside. Nothing is installed yet.')).toBeVisible();
  await expect(trustBox(page)).not.toBeChecked();
  await expect(installButton(page)).toBeDisabled();
}
const cancelImport = async page => { await importDialog(page).getByRole('button', { name: 'Cancel' }).click(); await expect(importDialog(page)).toBeHidden(); };

test.describe.serial('a pack from the command line, a second launch, open-file and the File menu reaches the real Import dialog', () => {
  let sender; let senderWorkspace; let packs;
  let app; let page; let workspace; let profile;

  test.beforeAll(async () => {
    senderWorkspace = await newWorkspace('e2e-sender');
    const senderProfile = await newProfile('e2e-sender-profile', { defaultWorkspace: senderWorkspace });
    sender = await launchApp({ profile: senderProfile });
    await stubNative(sender, {});
    await waitFor(() => workspacePage(sender), { timeout: 120_000, what: 'the sender workspace page' });
    await waitForOpen(senderWorkspace);
  });

  test.afterAll(async () => { await sender?.close().catch(() => {}); await app?.close().catch(() => {}); });

  test('the sender exports a theme, and Show in folder reveals the file the dialog names, and only that', async () => {
    test.setTimeout(420_000);
    const senderPage = workspacePage(sender);
    packs = [];
    for (const theme of themes) {
      const dialog = await exportTheme(senderPage, theme);
      const file = await dialog.getByLabel('Pack file location').inputValue();
      expect(file).toBe(join(await realpath(senderWorkspace), 'output', 'packs', `${theme.pack}-1.0.0.opendoc.zip`));
      expect(await exists(file)).toBe(true);
      packs.push(file);
      if (theme === themes[0]) {
        await shoot(senderPage, 'e2e-01-sender-pack-saved');
        await dialog.getByRole('button', { name: 'Show in folder' }).click();
        await waitFor(async () => (await nativeCalls(sender)).folders.length === 1, { what: 'the reveal' });
        expect((await nativeCalls(sender)).folders[0]).toBe(file);
      }
      await dialog.getByRole('button', { name: 'Done' }).click();
      await expect(senderPage.getByRole('dialog')).toBeHidden();
    }
    // A path the page invents, even next to the real pack, is refused (the shell logs it and shows nothing).
    const refused = await senderPage.evaluate(path => window.opendocDesktop.showInFolder(path), join(senderWorkspace, 'output', 'packs', '..', '..', 'package.json'));
    expect(refused).toBeUndefined();
    await new Promise(accept => setTimeout(accept, 400));
    expect((await nativeCalls(sender)).folders).toHaveLength(1);
    await sender.close();
  });

  test('a .opendoc.zip on the command line opens the Import dialog at the review step: trust unticked, Install disabled', async () => {
    workspace = await newWorkspace('e2e-recipient');
    for (const theme of themes) await rm(join(workspace, 'themes', theme.id), { recursive: true, force: true });
    profile = await newProfile('e2e-recipient-profile', { defaultWorkspace: workspace });
    app = await launchApp({ profile, appArgs: [packs[0]] });
    await stubNative(app, {});
    await waitFor(() => workspacePage(app), { timeout: 120_000, what: 'the recipient workspace page' });
    page = workspacePage(app);
    await waitForOpen(workspace);
    await expectReview(page, 'e2e-civic');
    const dialog = importDialog(page);
    await expect(dialog.getByText('Civic Spectrum', { exact: false }).or(dialog.getByText('civic-spectrum')).first()).toBeVisible();
    await expect(dialog.getByRole('button', { name: 'Cancel' })).toBeEnabled();
    await shoot(page, 'e2e-02-command-line-review');
  });

  test('nothing was installed by the pack arriving, and Cancel leaves the workspace as it was', async () => {
    await cancelImport(page);
    expect(await exists(join(workspace, 'themes', 'civic-spectrum'))).toBe(false);
    expect(await exists(join(workspace, 'themes', 'field-manual'))).toBe(false);
  });

  test('a second launch with another pack hands it to the running app, which shows its review step', async () => {
    const child = spawnApp({ profile, appArgs: [packs[1]] });
    expect(await waitForExit(child, 60_000)).toBe(true);
    await expectReview(page, 'e2e-field');
    await shoot(page, 'e2e-03-second-instance-review');
    await expect(importDialog(page).getByRole('heading', { name: 'e2e-civic' })).toBeHidden();
  });

  test('a pack that arrives while a review is open replaces it, and the new one starts unticked', async () => {
    await trustBox(page).check();
    await expect(installButton(page)).toBeEnabled();
    const child = spawnApp({ profile, appArgs: [packs[0]] });
    expect(await waitForExit(child, 60_000)).toBe(true);
    await expectReview(page, 'e2e-civic');
    expect(await exists(join(workspace, 'themes', 'civic-spectrum'))).toBe(false);
  });

  test('open-file (as macOS sends it) reaches the dialog while the page is on Documents', async () => {
    await cancelImport(page);
    await page.evaluate(() => { location.hash = ''; });
    await expect(page.getByText('Welcome to OpenDoc').first()).toBeVisible(long);
    await openFile(app, packs[1]);
    await expectReview(page, 'e2e-field');
    await shoot(page, 'e2e-04-open-file-on-documents');
    await cancelImport(page);
  });

  test('File > Import Design Pack… with a file chosen in the native dialog reaches the dialog', async () => {
    await setNative(app, { openDialog: { canceled: false, filePaths: [packs[0]] } });
    await clickItem(app, ['File', 'Import Design Pack…']);
    await expectReview(page, 'e2e-civic');
    await cancelImport(page);
    expect((await nativeCalls(app)).folders).toEqual([]);
  });

  test('ticking the box on purpose enables Install, and installing adds the theme to the workspace and the gallery', async () => {
    test.setTimeout(420_000);
    await openFile(app, packs[0]);
    await expectReview(page, 'e2e-civic');
    await trustBox(page).check();
    await expect(installButton(page)).toBeEnabled();
    await shoot(page, 'e2e-05-trusted-install-enabled');
    await installButton(page).click();
    const dialog = importDialog(page);
    await expect(dialog.getByText('Pack installed')).toBeVisible(long);
    await shoot(page, 'e2e-06-installed');
    await dialog.getByRole('button', { name: 'Done' }).click();
    expect(await exists(join(workspace, 'themes', 'civic-spectrum', 'design.md'))).toBe(true);
    expect(await readFile(join(workspace, 'themes', 'civic-spectrum', 'design.md'), 'utf8')).toContain('Civic Spectrum');
    expect(await exists(join(workspace, 'themes', 'field-manual'))).toBe(false);
    await page.evaluate(() => { location.hash = 'themes'; });
    await expect(page.getByText('Civic Spectrum').first()).toBeVisible(long);
  });

  test('opening the pack again shows that there is nothing new to install, with no trust box', async () => {
    await openFile(app, packs[0]);
    const dialog = importDialog(page);
    await expect(dialog.getByRole('heading', { name: 'e2e-civic' })).toBeVisible(long);
    await expect(trustBox(page)).toHaveCount(0);
    await expect(installButton(page)).toHaveCount(0);
    await shoot(page, 'e2e-07-nothing-new');
    await dialog.getByRole('button', { name: 'Close' }).first().click();
    await expect(importDialog(page)).toBeHidden();
  });

  test('the pages ran clean', async () => {
    // A staged pack's preview PDF can be asked for just after Cancel discarded the pack: a 404 the page ignores, and the one message allowed.
    const known = /Failed to load resource: the server responded with a status of 404/;
    expect(app.consoleProblems.filter(line => !known.test(line))).toEqual([]);
    expect(sender.consoleProblems.filter(line => !known.test(line))).toEqual([]);
  });
});
