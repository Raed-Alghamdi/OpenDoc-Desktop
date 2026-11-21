// "Connect your AI apps" under Electron on the virtual display: the first-run offer, Skip, the menu item, the list that shows while a
// vendor command is slow, an app's page (Claude Code with two settings folders), Connect and Disconnect with fake vendor commands in a
// scratch world, the "Other app" page, a blocked result with the vendor's words, and the refresh at launch.
// Every launch points the app's integration module at a scratch world (support/integrations.mjs): the real Claude Code and Codex
// configuration is never read or written. Screenshots go to $OPENDOC_I3_SHOTS when it is set.
import { expect, test } from '@playwright/test';
import { createIntegrations } from '../../src/main/integrations/index.mjs';
import { access, mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { launchApp, nativeCalls, newHome, newProfile, newWorkspace, readConfig, setNative, stubNative, dataFolder } from './support/app.mjs';
import { integrationsWorld } from './support/integrations.mjs';
import { isWorkspaceUrl, libraryReady, waitFor, waitForOpen } from './support/helpers.mjs';

const shots = process.env.OPENDOC_I3_SHOTS;
const shoot = async (page, name) => { if (shots) await page.screenshot({ path: join(shots, `${name}.png`) }); };
const aiWindow = app => app.windows().find(page => page.url().startsWith('app://shell/ai-apps.html'));
const waitForScreen = async app => { await waitFor(() => aiWindow(app), { timeout: 120_000, what: 'the AI apps window' }); return aiWindow(app); };
const row = (page, id) => page.locator(`li.app[data-app="${id}"]`);
const folder = (page, id) => page.locator(`li.target[data-target="${id}"]`);
const openApp = (page, id) => row(page, id).getByRole('button').click();
const badges = locator => locator.locator('.badge').allTextContents();
const settled = page => expect(page.locator('#checking')).toBeHidden();
const goBack = async page => { await page.getByRole('button', { name: /all AI apps/i }).click(); await expect(page.locator('#apps')).toBeVisible(); };
const helpItem = (app, label) => app.evaluate(({ Menu }, name) => Menu.getApplicationMenu().items.find(item => item.role === 'help' || item.label === 'Help').submenu.items.find(item => item.label === name).click(), label);
const exists = file => access(file).then(() => true, () => false);

test.describe.serial('first run and the menu', () => {
  let app; let world; let workspace; let profile; let page; let work;

  test.beforeAll(async () => {
    world = await integrationsWorld();
    // A second Claude Code settings folder, the kind the Claude desktop app uses.
    work = join(world.home, '.claude-Work');
    await mkdir(work, { recursive: true });
    await writeFile(join(work, 'settings.json'), '{}');
    workspace = await newWorkspace('ai-apps');
    profile = await newProfile('ai-apps-profile', { defaultWorkspace: workspace }, { offerAiApps: true });
    app = await launchApp({ profile, env: world.appEnvironment });
    await stubNative(app, {});
    page = await waitForScreen(app);
  });

  test.afterAll(async () => { await app?.close().catch(() => {}); });

  test('the first run offers the screen once the workspace is open, and records that it was shown', async () => {
    await waitFor(() => app.windows().some(item => isWorkspaceUrl(item.url())), { what: 'the workspace window' });
    expect(page.url()).toBe('app://shell/ai-apps.html?first=1');
    await expect(page.getByRole('heading', { name: 'Connect your AI apps' })).toBeVisible();
    await waitFor(async () => (await readConfig(profile)).aiAppsOffered === true, { what: 'the flag' });
    expect((await readConfig(profile)).defaultWorkspace).toBe(workspace);
    expect(await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().length)).toBe(2);
  });

  test('the list shows every app at once, each a button: installed or not, and the Other app row; no vendor command has run', async () => {
    await expect(page.locator('li.app')).toHaveCount(6);
    await expect(page.locator('#checking')).toBeHidden();
    for (const id of ['claude', 'codex', 'antigravity']) {
      expect(await badges(row(page, id))).toEqual(['Installed']);
      await expect(row(page, id).getByRole('button')).toBeEnabled();
    }
    for (const id of ['cursor', 'copilot']) expect(await badges(row(page, id))).toEqual(['Not installed']);
    await expect(row(page, 'other').getByRole('button')).toContainText('Other app');
    await expect(page.getByRole('button', { name: 'Skip' })).toBeVisible();
    await expect(page.getByRole('button', { name: 'Check again' })).toBeEnabled();
    await shoot(page, '01-list');
    // Looking is not connecting, and not even a read-only vendor command: those run on an app's own page.
    expect(await world.calls()).toEqual([]);
    // Check again reads the login shell afresh and lists again, with no spinner for vendor checks.
    await page.getByRole('button', { name: 'Check again' }).click();
    await expect(page.locator('li.app')).toHaveCount(6);
    await expect(page.locator('#checking')).toBeHidden();
    expect(await world.calls()).toEqual([]);
  });

  test('a row opens the app\'s page: where it is installed, and its two Claude Code settings folders, after the read-only check of that app', async () => {
    await openApp(page, 'claude');
    await expect(page.getByRole('heading', { level: 1, name: 'Claude Code' })).toBeFocused();
    await expect(page.getByRole('button', { name: /all AI apps/i })).toBeVisible();
    await expect(page.locator('#where')).toContainText(`Installed at ${join(world.bin, 'claude')}`);
    await settled(page);
    await expect(page.locator('li.target')).toHaveCount(2);
    await expect(folder(page, 'claude').locator('.name')).toHaveText('~/.claude');
    await expect(folder(page, 'claude')).toContainText('the claude command in a terminal uses, unless CLAUDE_CONFIG_DIR is set');
    await expect(folder(page, 'claude@.claude-Work').locator('.name')).toHaveText('~/.claude-Work');
    for (const id of ['claude', 'claude@.claude-Work']) {
      await expect(folder(page, id).locator('.badge').first()).toHaveText('Not connected');
      await expect(folder(page, id).getByRole('checkbox')).not.toBeChecked();
    }
    await expect(page.getByRole('button', { name: 'Connect', exact: true })).toBeDisabled();
    await expect(page.locator('#try')).toBeHidden();
    await shoot(page, '02-claude-two-folders');
    // Only read-only list commands, only Claude Code, once for each folder.
    const calls = await world.calls();
    expect(calls.length).toBeGreaterThan(0);
    expect(calls.every(call => call.tool === 'claude' && call.args.includes('list'))).toBe(true);
    expect(new Set(calls.map(call => call.CLAUDE_CONFIG_DIR))).toEqual(new Set([null, work]));
  });

  test('ticking the second folder and pressing Connect installs there only; the result has its steps, and the Try it box appears', async () => {
    await folder(page, 'claude@.claude-Work').getByRole('checkbox').check();
    await expect(page.getByRole('button', { name: 'Connect', exact: true })).toBeEnabled();
    const before = (await world.calls()).length;
    await page.getByRole('button', { name: 'Connect', exact: true }).click();
    await expect(page.locator('section.result')).toHaveCount(1, { timeout: 60_000 });
    await expect(page.locator('section.result')).toHaveAttribute('data-target', 'claude@.claude-Work');
    await expect(page.locator('section.result')).toHaveAttribute('data-code', 'connected');
    await expect(page.locator('section.result h3')).toHaveText('Claude Code (~/.claude-Work): Connected');
    await settled(page);
    await expect(folder(page, 'claude@.claude-Work').locator('.badge').first()).toHaveText('Connected');
    await expect(folder(page, 'claude').locator('.badge').first()).toHaveText('Not connected');
    await expect(folder(page, 'claude@.claude-Work').getByRole('button', { name: 'Disconnect Claude Code in ~/.claude-Work' })).toBeVisible();
    // Try it: the prompt, a Copy button, and one sentence about a new session.
    await expect(page.locator('#try')).toBeVisible();
    await expect(page.locator('#try h2')).toHaveText('Try it');
    await expect(page.locator('#prompt')).toHaveText('Make a one-page PDF with OpenDoc: a short memo titled Test.');
    await expect(page.locator('#try-text')).toHaveText('Start a new session of Claude Code in any folder and paste this prompt.');
    await page.locator('.scroll').evaluate(element => { element.scrollTop = 0; });
    await shoot(page, '03-claude-connected');
    await page.getByRole('button', { name: 'Copy', exact: true }).click();
    await expect(page.locator('#copied')).toHaveText('Copied');
    expect(await app.evaluate(({ clipboard }) => clipboard.readText())).toBe('Make a one-page PDF with OpenDoc: a short memo titled Test.');
    // The steps are folded away until asked for, and each shows the exact command (with the folder) and its output.
    const details = page.locator('section.result details.steps');
    await expect(details).not.toHaveAttribute('open', '');
    await details.locator('summary').click();
    await expect(details).toContainText(`CLAUDE_CONFIG_DIR=${work} claude plugin marketplace add`);
    await expect(details).toContainText('plugin install opendoc@opendoc');
    // Every vendor command for the connect ran in the scratch world, for the second folder, and ~/.claude was not touched.
    const connectCalls = (await world.calls()).slice(before).filter(call => !call.args.includes('list'));
    expect(connectCalls.length).toBeGreaterThan(0);
    for (const call of connectCalls) {
      expect(call.HOME.startsWith(world.root)).toBe(true);
      expect(call.CLAUDE_CONFIG_DIR).toBe(work);
      expect(call.XDG.every(entry => entry.startsWith(world.root))).toBe(true);
    }
    expect(await exists(join(world.home, '.claude', 'fake-claude.json'))).toBe(false);
    expect(await exists(join(work, 'fake-claude.json'))).toBe(true);
    expect(await exists(join(app.dataFolder, 'integrations', 'claude', '.claude-plugin', 'marketplace.json'))).toBe(true);
    const manifest = JSON.parse(await readFile(join(app.dataFolder, 'integrations.json'), 'utf8'));
    expect(Object.keys(manifest.apps)).toEqual(['claude@.claude-Work']);
  });

  test('Back returns to the list, which counts the connected folders from its record; Codex, with one folder, is ticked at once', async () => {
    await goBack(page);
    expect(await badges(row(page, 'claude'))).toEqual(['Installed', 'Connected in 1 of 2 folders']);
    await expect(row(page, 'claude').getByRole('button')).toBeFocused();
    await expect(page.getByRole('heading', { level: 1, name: 'Connect your AI apps' })).toBeVisible();
    await shoot(page, '04-list-connected');
    await openApp(page, 'codex');
    await settled(page);
    await expect(page.locator('li.target')).toHaveCount(1);
    await expect(folder(page, 'codex').getByRole('checkbox')).toBeChecked();
    await page.getByRole('button', { name: 'Connect', exact: true }).click();
    await expect(page.locator('section.result[data-app="codex"]')).toHaveAttribute('data-code', 'connected', { timeout: 60_000 });
    await expect(page.locator('section.result h3')).toHaveText('Codex: Connected');
    await settled(page);
    await expect(folder(page, 'codex').locator('.badge').first()).toHaveText('Connected');
    await expect(page.locator('#try-text')).toHaveText('Start a new session of Codex in any folder and paste this prompt.');
    expect(await exists(join(world.home, '.gemini', 'config', 'fake-agy.json'))).toBe(false);
    const manifest = JSON.parse(await readFile(join(app.dataFolder, 'integrations.json'), 'utf8'));
    expect(Object.keys(manifest.apps).sort()).toEqual(['claude@.claude-Work', 'codex']);
    await goBack(page);
    expect(await badges(row(page, 'codex'))).toEqual(['Installed', 'Connected']);
    expect(await badges(row(page, 'antigravity'))).toEqual(['Installed']);
  });

  test('an app that is not installed has a page that says how to get it, with Check again, and no folder to connect', async () => {
    await openApp(page, 'cursor');
    await expect(page.getByRole('heading', { level: 1, name: 'Cursor' })).toBeVisible();
    await expect(page.locator('#where')).toContainText('Cursor is not installed on this computer.');
    await expect(page.locator('#where')).toContainText('cursor.com');
    await expect(page.locator('#where')).toContainText('press Check again');
    await expect(page.locator('li.target')).toHaveCount(0);
    await expect(page.getByRole('button', { name: 'Connect', exact: true })).toBeHidden();
    await expect(page.getByRole('button', { name: 'Check again' })).toBeEnabled();
    await goBack(page);
  });

  test('the Other app page has the skill folder and the opendoc command to copy, and says which apps cannot use OpenDoc', async () => {
    await openApp(page, 'other');
    await expect(page.getByRole('heading', { level: 1, name: 'Other app' })).toBeFocused();
    await expect(page.locator('#other-skill')).toHaveText(join(world.source, 'skills', 'opendoc'));
    await expect(page.locator('#other')).toContainText('Point your agent at this skill, or copy the folder');
    await expect(page.locator('#other')).toContainText('must be able to run the opendoc command');
    await expect(page.locator('#other')).toContainText('ChatGPT');
    await expect(page.locator('#other')).toContainText('cannot use OpenDoc');
    // No opendoc command on this scratch PATH: the page says so and offers no Copy for it.
    await expect(page.locator('#other-command-text')).toContainText('was not found');
    await expect(page.getByRole('button', { name: 'Copy path' })).toHaveCount(1);
    await page.getByRole('button', { name: 'Copy path' }).click();
    await expect(page.locator('#copied-skill')).toHaveText('Copied');
    expect(await app.evaluate(({ clipboard }) => clipboard.readText())).toBe(join(world.source, 'skills', 'opendoc'));
    await shoot(page, '05-other-app');
    await goBack(page);
  });

  test('Disconnect is the undo: the result is shown, the folder is not connected again and its record is gone', async () => {
    await openApp(page, 'claude');
    await settled(page);
    await folder(page, 'claude@.claude-Work').getByRole('button', { name: 'Disconnect Claude Code in ~/.claude-Work' }).click();
    await expect(page.locator('section.result[data-code="disconnected"]')).toHaveCount(1, { timeout: 60_000 });
    await expect(page.locator('section.result h3')).toHaveText('Claude Code (~/.claude-Work): Disconnected');
    await settled(page);
    await expect(folder(page, 'claude@.claude-Work').locator('.badge').first()).toHaveText('Not connected');
    await expect(page.locator('#try')).toBeHidden();
    await shoot(page, '06-disconnected');
    const manifest = JSON.parse(await readFile(join(app.dataFolder, 'integrations.json'), 'utf8'));
    expect(Object.keys(manifest.apps)).toEqual(['codex']);
    expect(JSON.parse(await readFile(join(work, 'fake-claude.json'), 'utf8'))).toEqual({ marketplaces: [], plugins: [] });
    await goBack(page);
    expect(await badges(row(page, 'claude'))).toEqual(['Installed']);
    expect(await badges(row(page, 'codex'))).toEqual(['Installed', 'Connected']);
  });

  test('Skip closes the screen and leaves the app open; the flag stays', async () => {
    // The click ends with the page's own window closing under it.
    await page.getByRole('button', { name: 'Skip' }).click({ noWaitAfter: true }).catch(() => {});
    await waitFor(() => !aiWindow(app), { what: 'the window to close' });
    expect((await readConfig(profile)).aiAppsOffered).toBe(true);
    expect(app.windows().some(item => isWorkspaceUrl(item.url()))).toBe(true);
  });

  test('Connect AI Apps… in the Help menu opens the screen again (not the first-run one), and shows what is connected', async () => {
    const help = await app.evaluate(({ Menu }) => Menu.getApplicationMenu().items.find(item => item.role === 'help').submenu.items.map(item => item.label || `[${item.type}]`));
    expect(help).toContain('Connect AI Apps…');
    await helpItem(app, 'Connect AI Apps…');
    page = await waitForScreen(app);
    expect(page.url()).toBe('app://shell/ai-apps.html');
    await settled(page);
    await expect(page.getByRole('button', { name: 'Close' })).toBeVisible();
    await expect(page.getByRole('button', { name: 'Skip' })).toHaveCount(0);
    expect(await badges(row(page, 'codex'))).toEqual(['Installed', 'Connected']);
    await shoot(page, '07-from-menu');
    // A second choice of the item focuses the same window.
    await helpItem(app, 'Connect AI Apps…');
    expect(app.windows().filter(item => item.url().startsWith('app://shell/ai-apps.html'))).toHaveLength(1);
  });

  test('the screen cannot be driven from another window: the calls are for its own window only', async () => {
    const workspacePage = app.windows().find(item => isWorkspaceUrl(item.url()));
    expect(await workspacePage.evaluate(() => typeof window.opendocShell)).toBe('undefined');
  });

  test('Disconnect for the last app leaves nothing behind; Close ends the screen', async () => {
    await openApp(page, 'codex');
    await page.getByRole('button', { name: 'Disconnect Codex' }).click();
    await expect(page.locator('section.result[data-code="disconnected"]')).toHaveCount(1, { timeout: 60_000 });
    await settled(page);
    expect(await exists(join(app.dataFolder, 'integrations.json'))).toBe(false);
    expect(await exists(join(app.dataFolder, 'integrations'))).toBe(false);
    await page.getByRole('button', { name: 'Close' }).click({ noWaitAfter: true }).catch(() => {});
    await waitFor(() => !aiWindow(app), { what: 'the window to close' });
  });
});

test('a second launch does not offer the screen again', async () => {
  const world = await integrationsWorld();
  const workspace = await newWorkspace('ai-apps-again');
  const profile = await newProfile('ai-apps-again-profile', { defaultWorkspace: workspace, aiAppsOffered: true }, { offerAiApps: true });
  const app = await launchApp({ profile, env: world.appEnvironment });
  try {
    const page = await app.firstWindow();
    await libraryReady(page);
    await new Promise(accept => setTimeout(accept, 1500));
    expect(aiWindow(app)).toBeUndefined();
    expect(app.windows()).toHaveLength(1);
  } finally { await app.close(); }
});

test('first run through the picker: the screen comes after the first workspace is open, not before', async () => {
  const world = await integrationsWorld();
  const workspace = await newWorkspace('ai-apps-picker');
  const profile = await newProfile('ai-apps-picker-profile', undefined, { offerAiApps: true });
  const app = await launchApp({ profile, env: world.appEnvironment });
  try {
    await stubNative(app, { openDialog: { canceled: false, filePaths: [workspace] } });
    const picker = await app.firstWindow();
    expect(picker.url()).toBe('app://shell/picker.html');
    await new Promise(accept => setTimeout(accept, 1500));
    expect(aiWindow(app)).toBeUndefined();
    expect((await readConfig(profile).catch(() => ({}))).aiAppsOffered).toBeUndefined();
    await picker.getByRole('button', { name: /Open existing workspace/ }).click();
    const screen = await waitForScreen(app);
    expect(screen.url()).toBe('app://shell/ai-apps.html?first=1');
    await waitForOpen(workspace);
    expect((await readConfig(profile)).aiAppsOffered).toBe(true);
  } finally { await app.close(); }
});

test('a blocked app shows the vendor\'s own words under what went wrong, and the other results stay readable; a missing app is not installed', async () => {
  const world = await integrationsWorld({ commands: ['claude', 'codex'], mode: 'policy' });
  const workspace = await newWorkspace('ai-apps-blocked');
  const profile = await newProfile('ai-apps-blocked-profile', { defaultWorkspace: workspace }, { offerAiApps: true });
  const app = await launchApp({ profile, env: world.appEnvironment });
  try {
    await stubNative(app, {});
    const page = await waitForScreen(app);
    await expect(page.locator('li.app')).toHaveCount(6);
    expect(await badges(row(page, 'antigravity'))).toEqual(['Not installed']);
    await openApp(page, 'claude');
    await settled(page);
    await page.getByRole('button', { name: 'Connect', exact: true }).click();
    await expect(page.locator('section.result.bad')).toHaveCount(1, { timeout: 60_000 });
    await expect(page.locator('section.result[data-app="claude"]')).toHaveAttribute('data-code', 'blocked');
    await expect(page.locator('section.result[data-app="claude"] h3')).toHaveText('Claude Code: Blocked');
    await expect(page.locator('section.result[data-app="claude"] pre.failure')).toContainText("blocked by your organization's managed settings");
    await settled(page);
    // Nothing is left connected, and the folder can be ticked again.
    await expect(folder(page, 'claude').locator('.badge').first()).toHaveText('Not connected');
    await expect(folder(page, 'claude').getByRole('checkbox')).toBeVisible();
    await page.locator('section.result[data-app="claude"] details.steps summary').click();
    await expect(page.locator('section.result[data-app="claude"] details.steps .step.failed')).toContainText('claude plugin marketplace add');
    await shoot(page, '08-blocked');
    await goBack(page);
    await openApp(page, 'codex');
    await settled(page);
    await page.getByRole('button', { name: 'Connect', exact: true }).click();
    await expect(page.locator('section.result.bad')).toHaveCount(1, { timeout: 60_000 });
    await expect(page.locator('section.result[data-app="codex"] pre.failure')).toContainText('disabled by requirements set by your administrator');
    await settled(page);
    expect(await exists(join(app.dataFolder, 'integrations.json'))).toBe(false);
  } finally { await app.close(); }
});

test('the list shows at once while a vendor command is slow, with installed and connected from the records; an app\'s page checks only that app and stays usable meanwhile', async () => {
  const world = await integrationsWorld({ delayMs: 3000 });
  const home = newHome('ai-apps-slow-home');
  const workspace = await newWorkspace('ai-apps-slow');
  // Codex was connected earlier (the module made here answers quickly, the app's own launches below answer after three seconds).
  const earlier = createIntegrations(world.options({ dataDirectory: dataFolder(home) }));
  expect((await earlier.connect(['codex'])).ok).toBe(true);
  const profile = await newProfile('ai-apps-slow-profile', { defaultWorkspace: workspace, aiAppsOffered: true });
  const app = await launchApp({ profile, env: { HOME: home, ...world.appEnvironment } });
  try {
    await stubNative(app, {});
    await waitFor(() => app.windows().some(item => isWorkspaceUrl(item.url())), { timeout: 120_000, what: 'the workspace window' });
    await helpItem(app, 'Connect AI Apps…');
    const page = await waitForScreen(app);
    const callsBefore = (await world.calls()).length;
    const opened = Date.now();
    await expect(page.locator('li.app')).toHaveCount(6, { timeout: 2500 });
    expect(Date.now() - opened).toBeLessThan(2500);
    expect(await badges(row(page, 'codex'))).toEqual(['Installed', 'Connected']);
    expect(await badges(row(page, 'claude'))).toEqual(['Installed']);
    expect(await badges(row(page, 'cursor'))).toEqual(['Not installed']);
    await expect(page.locator('#checking')).toBeHidden();
    expect((await world.calls()).length).toBe(callsBefore); // the list ran nothing
    await shoot(page, '09-list-while-slow');

    // The page of one app checks that app: the line says so, the page is usable, and Back works before the check is done.
    await openApp(page, 'claude');
    await expect(page.locator('#checking')).toBeVisible();
    await expect(page.locator('#checking')).toHaveText('Checking Claude Code…');
    await expect(page.locator('li.target')).toHaveCount(1);
    await expect(page.getByRole('button', { name: /all AI apps/i })).toBeEnabled();
    await expect(page.getByRole('button', { name: 'Check again' })).toBeEnabled();
    await shoot(page, '10-checking');
    await goBack(page);
    await expect(page.locator('#checking')).toBeHidden();
    await expect(page.locator('li.app')).toHaveCount(6);
    // Opening it again and waiting: the check finishes, only Claude Code was asked, and the line goes away.
    await openApp(page, 'claude');
    await expect(page.locator('#checking')).toBeHidden({ timeout: 30_000 });
    await expect(folder(page, 'claude').locator('.badge').first()).toHaveText('Not connected');
    expect((await world.calls()).slice(callsBefore).every(call => call.tool === 'claude' && call.args.includes('list'))).toBe(true);
  } finally { await app.close(); }
});

test('at launch, what is connected is brought up to date; a failure for a connected app is shown, with a way to the screen', async () => {
  const world = await integrationsWorld();
  const home = newHome('ai-apps-refresh-home');
  const workspace = await newWorkspace('ai-apps-refresh');
  // Connect Codex the way the screen does, in the data folder this launch will use.
  const module = createIntegrations(world.options({ dataDirectory: dataFolder(home) }));
  expect((await module.connect(['codex'])).ok).toBe(true);
  const skill = join(world.source, 'skills', 'opendoc', 'SKILL.md');
  await writeFile(skill, `${await readFile(skill, 'utf8')}\nA line from a newer app.\n`);
  const adds = async () => (await world.calls()).filter(call => call.tool === 'codex' && call.args[1] === 'add').length;
  expect(await adds()).toBe(1);

  const profile = await newProfile('ai-apps-refresh-profile', { defaultWorkspace: workspace });
  let app = await launchApp({ profile, env: { HOME: home, ...world.appEnvironment } });
  try {
    await stubNative(app, {});
    await waitFor(async () => (await adds()) === 2, { timeout: 120_000, what: 'Codex to be installed again' });
    await waitForOpen(workspace);
    await waitFor(async () => (await module.status({ verify: false })).apps.find(item => item.id === 'codex')?.stale === false, { what: 'the record to follow the files' });
    expect((await nativeCalls(app)).messages).toEqual([]);
    expect(aiWindow(app)).toBeUndefined();
  } finally { await app.close(); }

  // Newer files again, and now Codex refuses.
  await writeFile(skill, `${await readFile(skill, 'utf8')}\nAnother line.\n`);
  const failing = await world.appEnvironmentFor('fail-install');
  app = await launchApp({ profile, env: { HOME: home, ...failing } });
  try {
    await stubNative(app, {});
    await waitFor(async () => (await nativeCalls(app)).messages.length > 0, { timeout: 120_000, what: 'the warning' });
    const [message] = (await nativeCalls(app)).messages;
    expect(message.title).toBe('AI apps could not be updated');
    expect(message.detail).toContain('Codex:');
    expect(message.buttons).toEqual(['Open Connect AI Apps', 'Close']);
    const page = await waitForScreen(app);
    expect(page.url()).toBe('app://shell/ai-apps.html');
    await settled(page);
    // The failed install left a record that is not finished: the list says so from the record alone.
    expect(await badges(row(page, 'codex'))).toEqual(['Installed', 'Needs attention']);
    await openApp(page, 'codex');
    await settled(page);
    await expect(page.getByRole('button', { name: 'Disconnect Codex' })).toBeVisible();
    await shoot(page, '11-refresh-failed');
    // Undo from the screen, so the scratch world ends clean.
    await setNative(app, { messageChoice: 1 });
    await page.getByRole('button', { name: 'Disconnect Codex' }).click();
    await expect(page.locator('section.result[data-code="disconnected"]')).toHaveCount(1, { timeout: 60_000 });
  } finally { await app.close(); }
});

test.describe.serial('the screen fits the display it opens on: the list scrolls inside the window and the buttons stay in view', () => {
  let app;

  test.beforeAll(async () => {
    const world = await integrationsWorld();
    const workspace = await newWorkspace('ai-apps-fit');
    const profile = await newProfile('ai-apps-fit-profile', { defaultWorkspace: workspace });
    app = await launchApp({ profile, env: world.appEnvironment });
    await stubNative(app, {});
    await waitFor(() => app.windows().find(item => isWorkspaceUrl(item.url())), { timeout: 120_000, what: 'the workspace page' });
    await waitForOpen(workspace);
  });

  test.afterAll(async () => { await app?.close().catch(() => {}); });

  /** Pretend every display has this work area (the screen minus panels), then open the screen from the Help menu. */
  async function openOn(workArea) {
    await app.evaluate(({ screen }, area) => {
      const real = globalThis.__realDisplay ??= screen.getPrimaryDisplay();
      const fake = { ...real, workArea: { x: 0, y: 0, ...area }, workAreaSize: area, bounds: { x: 0, y: 0, width: area.width, height: area.height + 30 } };
      screen.getPrimaryDisplay = () => fake;
      screen.getDisplayMatching = () => fake;
    }, workArea);
    await helpItem(app, 'Connect AI Apps…');
    const page = await waitForScreen(app);
    await settled(page);
    return page;
  }
  const windowSize = () => app.evaluate(({ BrowserWindow }) => { const window = BrowserWindow.getAllWindows().find(item => item.webContents.getURL().startsWith('app://shell/ai-apps.html')); const [width, height] = window.getSize(); return { width, height }; });
  const closeScreen = async () => { await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().find(item => item.webContents.getURL().startsWith('app://shell/ai-apps.html'))?.close()); await waitFor(() => !aiWindow(app), { what: 'the window to close' }); };
  const layout = page => page.evaluate(() => {
    const scroll = document.querySelector('.scroll');
    const box = selector => { const rect = document.querySelector(selector).getBoundingClientRect(); return { top: Math.round(rect.top), bottom: Math.round(rect.bottom), shown: rect.height > 0 }; };
    return { inner: innerHeight, page: document.documentElement.scrollHeight, scrolls: scroll.scrollHeight > scroll.clientHeight + 1, back: box('#back'), close: box('#close'), recheck: box('#recheck'), connect: box('#connect') };
  });

  test('a 1280x800 screen with a panel (work area 1280x770): the window fits it and every button is in view', async () => {
    const page = await openOn({ width: 1280, height: 770 });
    const size = await windowSize();
    expect(size.height).toBeLessThanOrEqual(770 - 24);
    expect(size.width).toBeLessThanOrEqual(1280 - 24);
    const shown = await layout(page);
    for (const button of [shown.close, shown.recheck]) { expect(button.shown).toBe(true); expect(button.top).toBeGreaterThanOrEqual(0); expect(button.bottom).toBeLessThanOrEqual(shown.inner); }
    expect(shown.page).toBeLessThanOrEqual(shown.inner + 1); // the window itself never scrolls
    // An app's page too: Back above, Connect and the others below, all in view.
    await openApp(page, 'claude');
    await settled(page);
    const onPage = await layout(page);
    for (const button of [onPage.back, onPage.connect, onPage.close, onPage.recheck]) { expect(button.shown).toBe(true); expect(button.top).toBeGreaterThanOrEqual(0); expect(button.bottom).toBeLessThanOrEqual(onPage.inner); }
    expect(onPage.page).toBeLessThanOrEqual(onPage.inner + 1);
    await shoot(page, 'fit-1280x800');
    await closeScreen();
  });

  test('a small work area: the list scrolls inside the window, the buttons stay in view, and the window is never below its minimum', async () => {
    const page = await openOn({ width: 1024, height: 420 });
    const size = await windowSize();
    expect(size.height).toBeLessThanOrEqual(420 - 24);
    expect(size.height).toBeGreaterThanOrEqual(380);
    const shown = await layout(page);
    expect(shown.scrolls).toBe(true);
    for (const button of [shown.close, shown.recheck]) { expect(button.top).toBeGreaterThanOrEqual(0); expect(button.bottom).toBeLessThanOrEqual(shown.inner); }
    await page.locator('#apps').scrollIntoViewIfNeeded();
    await page.locator('.scroll').evaluate(element => { element.scrollTop = element.scrollHeight; });
    await expect(page.locator('li.app').last()).toBeInViewport();
    await shoot(page, 'fit-small');
    await closeScreen();
  });

  test('a roomy display keeps the usual size', async () => {
    await openOn({ width: 2560, height: 1400 });
    expect(await windowSize()).toEqual({ width: 800, height: 760 });
    await closeScreen();
  });
});
