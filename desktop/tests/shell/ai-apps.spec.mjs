// "Connect your AI apps" (plan I3) under Electron on the virtual display: the first-run offer, Skip, the menu item, Connect and Disconnect
// with fake vendor commands in a scratch world, a blocked result with the vendor's words, and the refresh at launch.
// Every launch points the app's integration module at a scratch world (support/integrations.mjs): the real Claude Code and Codex
// configuration is never read or written. Screenshots go to $OPENDOC_I3_SHOTS when it is set.
import { expect, test } from '@playwright/test';
import { createIntegrations } from '../../src/main/integrations/index.mjs';
import { access, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { launchApp, nativeCalls, newHome, newProfile, newWorkspace, readConfig, setNative, stubNative, dataFolder } from './support/app.mjs';
import { integrationsWorld } from './support/integrations.mjs';
import { isWorkspaceUrl, libraryReady, waitFor, waitForOpen } from './support/helpers.mjs';

const shots = process.env.OPENDOC_I3_SHOTS;
const shoot = async (page, name) => { if (shots) await page.screenshot({ path: join(shots, `${name}.png`) }); };
const aiWindow = app => app.windows().find(page => page.url().startsWith('app://shell/ai-apps.html'));
const waitForScreen = async app => { await waitFor(() => aiWindow(app), { timeout: 120_000, what: 'the AI apps window' }); return aiWindow(app); };
const row = (page, id) => page.locator(`li.app[data-app="${id}"]`);
const settled = page => expect(page.locator('#checking')).toBeHidden();
const helpItem = (app, label) => app.evaluate(({ Menu }, name) => Menu.getApplicationMenu().items.find(item => item.role === 'help' || item.label === 'Help').submenu.items.find(item => item.label === name).click(), label);
const exists = file => access(file).then(() => true, () => false);

test.describe.serial('first run and the menu', () => {
  let app; let world; let workspace; let profile; let page;

  test.beforeAll(async () => {
    world = await integrationsWorld();
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

  test('every app is listed: found ones can be ticked (none ticked), the others say why not, and the buttons say what they do', async () => {
    await settled(page);
    await expect(page.locator('li.app')).toHaveCount(5);
    for (const id of ['claude', 'codex', 'antigravity']) {
      await expect(row(page, id).locator('.badge').first()).toHaveText('Found');
      await expect(row(page, id).getByRole('checkbox')).not.toBeChecked();
      await expect(row(page, id).locator('.note')).toContainText(`Found ${{ claude: 'claude', codex: 'codex', antigravity: 'agy' }[id]} at`);
    }
    for (const id of ['cursor', 'copilot']) {
      await expect(row(page, id).locator('.badge').first()).toHaveText('Not found');
      await expect(row(page, id).getByRole('checkbox')).toHaveCount(0);
      await expect(row(page, id).locator('.note')).toContainText('no cursor-agent command on the search path'.replace('cursor-agent', id === 'cursor' ? 'cursor-agent' : 'copilot'));
    }
    await expect(page.getByRole('button', { name: 'Connect', exact: true })).toBeDisabled();
    await expect(page.getByRole('button', { name: 'Skip' })).toBeVisible();
    await shoot(page, '01-first-run');
    // Nothing ran but read-only list commands: looking is not connecting.
    expect((await world.calls()).every(call => call.args.includes('list'))).toBe(true);
    // A spinner shows while the apps are checked.
    const checking = await page.evaluate(() => { document.getElementById('recheck').click(); return { hidden: document.getElementById('checking').hidden, text: document.getElementById('checking').textContent.trim() }; });
    expect(checking).toEqual({ hidden: false, text: 'Looking for AI apps on this computer…' });
    await settled(page);
  });

  test('ticking apps enables Connect; Connect installs only those, and shows each result with its steps under Details', async () => {
    await row(page, 'claude').getByRole('checkbox').check();
    await row(page, 'codex').getByRole('checkbox').check();
    await expect(page.getByRole('button', { name: 'Connect', exact: true })).toBeEnabled();
    await page.getByRole('button', { name: 'Connect', exact: true }).click();
    await expect(page.locator('section.result')).toHaveCount(2, { timeout: 60_000 });
    await expect(page.locator('section.result[data-app="claude"]')).toHaveAttribute('data-code', 'connected');
    await expect(page.locator('section.result[data-app="codex"]')).toHaveAttribute('data-code', 'connected');
    await expect(page.locator('section.result[data-app="claude"] h3')).toHaveText('Claude Code: Connected');
    await settled(page);
    await expect(row(page, 'claude').locator('.badge').first()).toHaveText('Connected');
    await expect(row(page, 'codex').locator('.badge').first()).toHaveText('Connected');
    await expect(row(page, 'antigravity').locator('.badge').first()).toHaveText('Found');
    await expect(row(page, 'claude').getByRole('button', { name: 'Disconnect Claude Code' })).toBeVisible();
    // The steps are folded away until asked for, and each shows the exact command and its output.
    const details = page.locator('section.result[data-app="claude"] details.steps');
    await expect(details).not.toHaveAttribute('open', '');
    await details.locator('summary').click();
    await expect(details).toContainText('claude plugin marketplace add');
    await expect(details).toContainText('plugin install opendoc@opendoc');
    await shoot(page, '02-connected');
    // The copy the vendors register is in the app's own data folder; the fake vendor state is in the scratch world.
    expect(await exists(join(app.dataFolder, 'integrations', 'claude', '.claude-plugin', 'marketplace.json'))).toBe(true);
    expect(await exists(join(world.home, '.claude', 'fake-claude.json'))).toBe(true);
    expect(await exists(join(world.home, '.gemini', 'config', 'fake-agy.json'))).toBe(false);
    const manifest = JSON.parse(await readFile(join(app.dataFolder, 'integrations.json'), 'utf8'));
    expect(Object.keys(manifest.apps).sort()).toEqual(['claude', 'codex']);
    // Every vendor command ran in the scratch world and nowhere else.
    for (const call of (await world.calls()).filter(item => !item.args.includes('list') || item.args.includes('--json'))) {
      expect(call.HOME.startsWith(world.root)).toBe(true);
      expect([call.CLAUDE_CONFIG_DIR, call.CODEX_HOME].every(value => value === null || value.startsWith(world.root))).toBe(true);
      expect(call.XDG.every(folder => folder.startsWith(world.root))).toBe(true);
    }
  });

  test('Disconnect is the undo: the result is shown, the app is found again and its record is gone', async () => {
    await row(page, 'claude').getByRole('button', { name: 'Disconnect Claude Code' }).click();
    await expect(page.locator('section.result[data-code="disconnected"]')).toHaveCount(1, { timeout: 60_000 });
    await expect(page.locator('section.result h3')).toHaveText('Claude Code: Disconnected');
    await settled(page);
    await expect(row(page, 'claude').locator('.badge').first()).toHaveText('Found');
    await expect(row(page, 'codex').locator('.badge').first()).toHaveText('Connected');
    await shoot(page, '03-disconnected');
    const manifest = JSON.parse(await readFile(join(app.dataFolder, 'integrations.json'), 'utf8'));
    expect(Object.keys(manifest.apps)).toEqual(['codex']);
    expect(JSON.parse(await readFile(join(world.home, '.claude', 'fake-claude.json'), 'utf8'))).toEqual({ marketplaces: [], plugins: [] });
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
    await expect(row(page, 'codex').locator('.badge').first()).toHaveText('Connected');
    await shoot(page, '04-from-menu');
    // A second choice of the item focuses the same window.
    await helpItem(app, 'Connect AI Apps…');
    expect(app.windows().filter(item => item.url().startsWith('app://shell/ai-apps.html'))).toHaveLength(1);
  });

  test('the screen cannot be driven from another window: the calls are for its own window only', async () => {
    const workspacePage = app.windows().find(item => isWorkspaceUrl(item.url()));
    expect(await workspacePage.evaluate(() => typeof window.opendocShell)).toBe('undefined');
  });

  test('Disconnect for the last app leaves nothing behind; Close ends the screen', async () => {
    await row(page, 'codex').getByRole('button', { name: 'Disconnect Codex' }).click();
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

test('a blocked app shows the vendor\'s own words under what went wrong, and the other results stay readable; a missing app has no tick box', async () => {
  const world = await integrationsWorld({ commands: ['claude', 'codex'], mode: 'policy' });
  const workspace = await newWorkspace('ai-apps-blocked');
  const profile = await newProfile('ai-apps-blocked-profile', { defaultWorkspace: workspace }, { offerAiApps: true });
  const app = await launchApp({ profile, env: world.appEnvironment });
  try {
    await stubNative(app, {});
    const page = await waitForScreen(app);
    await settled(page);
    await expect(row(page, 'antigravity').locator('.badge').first()).toHaveText('Not found');
    await expect(row(page, 'antigravity').getByRole('checkbox')).toHaveCount(0);
    await row(page, 'claude').getByRole('checkbox').check();
    await row(page, 'codex').getByRole('checkbox').check();
    await page.getByRole('button', { name: 'Connect', exact: true }).click();
    await expect(page.locator('section.result.bad')).toHaveCount(2, { timeout: 60_000 });
    await expect(page.locator('section.result[data-app="claude"]')).toHaveAttribute('data-code', 'blocked');
    await expect(page.locator('section.result[data-app="claude"] h3')).toHaveText('Claude Code: Blocked');
    await expect(page.locator('section.result[data-app="claude"] pre.failure')).toContainText("blocked by your organization's managed settings");
    await expect(page.locator('section.result[data-app="codex"] pre.failure')).toContainText('disabled by requirements set by your administrator');
    await settled(page);
    // Nothing is left connected, and the rows can be ticked again.
    await expect(row(page, 'claude').locator('.badge').first()).toHaveText('Found');
    await page.locator('section.result[data-app="claude"] details.steps summary').click();
    await expect(page.locator('section.result[data-app="claude"] details.steps .step.failed')).toContainText('claude plugin marketplace add');
    await shoot(page, '05-blocked');
    expect(await exists(join(app.dataFolder, 'integrations.json'))).toBe(false);
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
    await expect(row(page, 'codex').getByRole('button', { name: 'Disconnect Codex' })).toBeVisible();
    await shoot(page, '06-refresh-failed');
    // Undo from the screen, so the scratch world ends clean.
    await setNative(app, { messageChoice: 1 });
    await row(page, 'codex').getByRole('button', { name: 'Disconnect Codex' }).click();
    await expect(page.locator('section.result[data-code="disconnected"]')).toHaveCount(1, { timeout: 60_000 });
  } finally { await app.close(); }
});
