// E3 part 1 (plan 3.4): linking a workspace to the app's OpenDoc, the version table, the upgrade with its backup, the result
// screen and Restore, the AppImage's runtime copy, and the backups list. Every launch has a scratch HOME with its own XDG
// folders (support/app.mjs), so backups and runtime copies land inside tmp/shell-tests, never in the real data folder.
// The test runtime is OpenDoc 0.6.1 and does not support read-only yet (U4), so the read-only rows (a newer patch or minor,
// "Open read-only", Restore) are refused here: part 2 turns them into rows that open read-only.
import { expect, test } from '@playwright/test';
import { createRequire } from 'node:module';
import { lstat, mkdir, readFile, readdir, readlink, realpath, rm, symlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { launchApp, nativeCalls, newHome, newProfile, newWorkspace, readConfig, setNative, stubNative } from './support/app.mjs';
import { desktopRecord, hostPid, isWorkspaceUrl, readJson, waitFor, waitForOpen } from './support/helpers.mjs';
import { runtimeDir } from './support/paths.mjs';
import { commandLine, waitForNoElectron } from './support/processes.mjs';

const modulesOf = workspace => join(workspace, 'node_modules');
const linkedRuntime = join(runtimeDir, 'node_modules');
const pinOf = async workspace => (await readJson(join(workspace, 'package.json'))).dependencies.opendoc;
const pin = version => `npm:@ryanyahya/opendoc@${version}`;
const exists = path => lstat(path).then(() => true, () => false);
const workspaceWindow = app => app.windows().find(page => isWorkspaceUrl(page.url()));
const windowAt = (app, name) => app.windows().find(page => page.url() === `app://shell/${name}`);

async function setPin(workspace, version) {
  const file = join(workspace, 'package.json');
  const manifest = JSON.parse(await readFile(file, 'utf8'));
  manifest.dependencies.opendoc = pin(version);
  await writeFile(file, `${JSON.stringify(manifest, null, 2)}\n`);
}

/** Every path in the workspace with what it is (links by target, files by content), without the lock a refusal removes again. */
async function listing(workspace) {
  const found = {};
  const walk = async (path, relative) => {
    const info = await lstat(path);
    if (info.isSymbolicLink()) { found[relative] = `link ${await readlink(path)}`; return; }
    if (info.isDirectory()) { found[relative] = 'dir'; for (const name of (await readdir(path)).sort()) await walk(join(path, name), `${relative}/${name}`); return; }
    found[relative] = `file ${info.size}`;
  };
  await walk(workspace, '.');
  return found;
}

/** A workspace and the bytes of its package-lock.json, to check afterwards that nothing touched it. */
async function withLock(workspace) {
  const lock = join(workspace, 'package-lock.json');
  const before = await readFile(lock);
  return { unchanged: async () => expect((await readFile(lock)).equals(before)).toBe(true) };
}

async function pickerApp({ env, native = {} } = {}) {
  const app = await launchApp({ profile: await newProfile('versions-profile'), env });
  await stubNative(app, native);
  const picker = await app.firstWindow();
  expect(picker.url()).toBe('app://shell/picker.html');
  return { app, picker };
}

async function chooseInPicker(app, picker, workspace) {
  await setNative(app, { openDialog: { canceled: false, filePaths: [workspace] } });
  await picker.getByRole('button', { name: /Open existing workspace/ }).click();
}

/** File > Open Workspace… on a running app: the previous workspace is let go of, the new one opens. */
async function openByMenu(app, workspace) {
  await setNative(app, { openDialog: { canceled: false, filePaths: [workspace] } });
  await app.evaluate(({ Menu }) => Menu.getApplicationMenu().items.find(item => item.label === 'File').submenu.items.find(item => item.label === 'Open Workspace…').click());
}

async function opened(app, workspace) {
  await waitFor(async () => workspaceWindow(app) && await desktopRecord(workspace).then(record => record.pid === app.process().pid, () => false), { timeout: 240_000, what: `${workspace} to be open` });
  await waitForOpen(workspace);
}

const asked = async (app, title) => (await nativeCalls(app)).messages.filter(message => message.title === title);

test.describe('refusals: nothing is changed, the lock is released, and the picker says why', () => {
  test('a newer patch, a newer minor, a headless pin, a declined upgrade and a real node_modules kept', async () => {
    const { app, picker } = await pickerApp({ native: { messageChoice: { 'Upgrade this workspace?': 'Open read-only', 'Replace node_modules?': 'Leave it as it is' } } });
    try {
      const refuse = async (workspace, text) => {
        const lock = await withLock(workspace);
        const before = await listing(workspace);
        await chooseInPicker(app, picker, workspace);
        await expect(picker.locator('#message')).toContainText(text, { timeout: 60_000 });
        expect(await listing(workspace)).toEqual(before);
        expect(await exists(join(workspace, '.opendoc', 'update.lock'))).toBe(false);
        expect(await exists(join(workspace, '.opendoc', 'desktop.json'))).toBe(false);
        await lock.unchanged();
      };

      const patch = await newWorkspace('newer-patch');
      await setPin(patch, '0.6.9');
      await refuse(patch, 'newer than this app (0.6.1). Update the app to edit it.');
      expect(await pinOf(patch)).toBe(pin('0.6.9'));

      const minor = await newWorkspace('newer-minor');
      await setPin(minor, '0.7.0');
      await refuse(minor, 'This workspace was upgraded by OpenDoc 0.7. Update the app to edit it.');
      expect(await pinOf(minor)).toBe(pin('0.7.0'));

      // "Open read-only" in the upgrade dialog: refused while the service cannot open read-only; no backup, no change.
      const declined = await newWorkspace('declined');
      await setPin(declined, '0.5.0');
      await refuse(declined, 'Opening a workspace read-only needs a newer OpenDoc service');
      expect(await pinOf(declined)).toBe(pin('0.5.0'));
      const [question] = await asked(app, 'Upgrade this workspace?');
      expect(question.buttons).toEqual(['Upgrade', 'Open read-only', 'Cancel']);
      expect(question.checkboxLabel).toBe('Upgrade my workspaces without asking from now on');
      expect(await exists(join(app.dataFolder, 'backups'))).toBe(false);

      // "Cancel" in that dialog: not opened, nothing changed.
      await setNative(app, { messageChoice: { 'Upgrade this workspace?': 'Cancel' } });
      const before = await listing(declined);
      await chooseInPicker(app, picker, declined);
      await waitFor(async () => (await asked(app, 'Upgrade this workspace?')).length === 2, { what: 'the second question' });
      await waitFor(() => exists(join(declined, '.opendoc', 'update.lock')).then(found => !found), { what: 'the lock to be released' });
      expect(workspaceWindow(app)).toBeUndefined();
      expect(await listing(declined)).toEqual(before);

      // A real node_modules, and the answer "Leave it as it is": untouched, not opened.
      await setNative(app, { messageChoice: { 'Replace node_modules?': 'Leave it as it is' } });
      const real = await newWorkspace('real-modules', { npm: true });
      await mkdir(join(real, 'node_modules', 'mine'), { recursive: true });
      await writeFile(join(real, 'node_modules', 'mine', 'index.js'), 'mine');
      await refuse(real, 'was left as it is');
      expect((await lstat(modulesOf(real))).isDirectory()).toBe(true);
      expect(await readFile(join(modulesOf(real), 'mine', 'index.js'), 'utf8')).toBe('mine');
      const [replace] = await asked(app, 'Replace node_modules?');
      expect(replace.buttons).toEqual(["Use the app's OpenDoc", 'Leave it as it is']);
      expect((await nativeCalls(app)).trashed).toEqual([]);

      // A headless pin: refused with a clear message, and no question about adopting it.
      const headless = await newWorkspace('headless');
      await rm(join(headless, '.opendoc'), { recursive: true });
      await rm(modulesOf(headless), { force: true });
      const manifest = JSON.parse(await readFile(join(headless, 'package.json'), 'utf8'));
      manifest.dependencies.opendoc = 'npm:@ryanyahya/opendoc-headless@0.6.1';
      await writeFile(join(headless, 'package.json'), `${JSON.stringify(manifest, null, 2)}\n`);
      await refuse(headless, 'headless edition');
      expect(await exists(join(headless, '.opendoc'))).toBe(false); // the lock's folder is removed again
      expect(await asked(app, 'Use this workspace on this device?')).toEqual([]);
    } finally { await app.close(); }
    expect(await waitForNoElectron(5000)).toEqual([]);
  });
});

test.describe.serial('opening: the link, adoption and the pin', () => {
  let app; let picker;
  test.beforeAll(async () => {
    ({ app, picker } = await pickerApp({ native: { messageChoice: { 'Replace node_modules?': "Use the app's OpenDoc" } } }));
  });
  test.afterAll(async () => { await app?.close().catch(() => {}); });

  /** The first open uses the picker (the app has no workspace yet); later ones use the menu. */
  let first = true;
  async function open(workspace) {
    if (first) { first = false; await chooseInPicker(app, picker, workspace); } else await openByMenu(app, workspace);
    await opened(app, workspace);
  }

  test('pin 0.6.0 opens, and the pin moves up to 0.6.1; package-lock.json is unchanged', async () => {
    const workspace = await newWorkspace('pin-060');
    await setPin(workspace, '0.6.0');
    const lock = await withLock(workspace);
    await open(workspace);
    expect(await pinOf(workspace)).toBe(pin('0.6.1'));
    expect((await readFile(join(workspace, 'package.json'), 'utf8')).endsWith('}\n')).toBe(true);
    expect(await readlink(modulesOf(workspace))).toBe(linkedRuntime);
    expect((await readJson(join(workspace, '.opendoc', 'workspace.json'))).managed).toBe(true);
    await lock.unchanged();
  });

  test('pin 0.6.1 opens and package.json is not rewritten', async () => {
    const workspace = await newWorkspace('pin-061');
    const text = await readFile(join(workspace, 'package.json'), 'utf8');
    const lock = await withLock(workspace);
    await open(workspace);
    expect(await readFile(join(workspace, 'package.json'), 'utf8')).toBe(text);
    await lock.unchanged();
  });

  test('a theme\'s import of opendoc/themes resolves into the runtime the service runs from', async () => {
    const workspace = await newWorkspace('theme-import');
    await open(workspace);
    const theme = join(workspace, 'themes', 'neutral', 'index.ts');
    const resolved = await realpath(createRequire(theme).resolve('opendoc/themes'));
    expect(resolved).toBe(await realpath(join(runtimeDir, 'node_modules', 'opendoc', 'src', 'themes', 'index.ts')));
    // The service itself was started from that same runtime.
    const entry = commandLine(hostPid(app)).find(argument => argument.endsWith('/src/server/service.ts'));
    expect(entry).toContain(await realpath(runtimeDir));
    expect(resolved.startsWith(await realpath(join(runtimeDir, 'node_modules', 'opendoc')))).toBe(true);
  });

  test('a dangling link and a foreign link are repaired without a question', async () => {
    const dangling = await newWorkspace('dangling');
    await rm(modulesOf(dangling));
    await symlink(join(dangling, 'nowhere'), modulesOf(dangling), 'dir');
    await open(dangling);
    expect(await readlink(modulesOf(dangling))).toBe(linkedRuntime);

    const foreign = await newWorkspace('foreign');
    const other = join(foreign, '..', 'foreign-other', 'node_modules');
    await mkdir(other, { recursive: true });
    await rm(modulesOf(foreign));
    await symlink(other, modulesOf(foreign), 'dir');
    await open(foreign);
    expect(await readlink(modulesOf(foreign))).toBe(linkedRuntime);
    expect(await readdir(other)).toEqual([]);
    expect((await nativeCalls(app)).messages.filter(message => message.title === 'Replace node_modules?')).toEqual([]);
  });

  test('a real node_modules, answered "Use the app\'s OpenDoc", goes to the trash and is replaced by the link', async () => {
    const workspace = await newWorkspace('real-yes', { npm: true });
    await mkdir(join(modulesOf(workspace), 'mine'), { recursive: true });
    await writeFile(join(modulesOf(workspace), 'mine', 'index.js'), 'mine');
    const lock = await withLock(workspace);
    await open(workspace);
    expect(await readlink(modulesOf(workspace))).toBe(linkedRuntime);
    const { trashed } = await nativeCalls(app);
    expect(trashed).toEqual([join(await realpath(workspace), 'node_modules')]);
    expect((await readdir(join(app.home, '.local', 'share', 'Trash'))).some(name => name.startsWith('node_modules'))).toBe(true);
    await lock.unchanged();
  });

  test('a synced folder (a pin, no .opendoc, no node_modules, no .claude/skills) is adopted after one question, and opens', async () => {
    const workspace = await newWorkspace('synced');
    await rm(join(workspace, '.opendoc'), { recursive: true });
    await rm(modulesOf(workspace));
    await rm(join(workspace, '.claude', 'skills'));
    await setNative(app, { messageChoice: { 'Use this workspace on this device?': 'Use this workspace on this device', 'Replace node_modules?': "Use the app's OpenDoc" } });
    const lock = await withLock(workspace);
    await open(workspace);
    const [question] = await asked(app, 'Use this workspace on this device?');
    expect(question.buttons).toEqual(['Use this workspace on this device', 'Cancel']);
    expect(await readJson(join(workspace, '.opendoc', 'workspace.json'))).toEqual({ formatVersion: 1, edition: 'normal', managed: true });
    expect(await readlink(modulesOf(workspace))).toBe(linkedRuntime);
    expect(await readlink(join(workspace, '.claude', 'skills'))).toBe(join('..', '.agents', 'skills'));
    await lock.unchanged();
  });

  test('declining the adoption leaves the folder as it was', async () => {
    const workspace = await newWorkspace('synced-no');
    await rm(join(workspace, '.opendoc'), { recursive: true });
    await rm(modulesOf(workspace));
    await setNative(app, { messageChoice: { 'Use this workspace on this device?': 'Cancel' } });
    const before = await listing(workspace);
    await openByMenu(app, workspace);
    await waitFor(async () => (await asked(app, 'Use this workspace on this device?')).length === 2, { what: 'the second adoption question' });
    await waitFor(() => exists(join(workspace, '.opendoc')).then(found => !found), { what: 'the folder to be left alone' });
    expect(await listing(workspace)).toEqual(before);
  });
});

test.describe.serial('upgrade', () => {
  /** A workspace with the documents `ids` only (the template's welcome, and a document that cannot render when asked). */
  async function oldWorkspace(name, { broken = false } = {}) {
    const workspace = await newWorkspace(name);
    await rm(join(workspace, 'documents', 'welcome-presentation'), { recursive: true });
    if (broken) {
      await mkdir(join(workspace, 'documents', 'broken'), { recursive: true });
      await writeFile(join(workspace, 'documents', 'broken', 'index.tsx'), "export default function Broken(): never { throw new Error('broken on purpose'); }\n");
    }
    await setPin(workspace, '0.5.0');
    return workspace;
  }

  test('pin 0.5.0: the dialog, Upgrade with the box ticked, backup, check and review, then it opens; the next one does not ask; the backups list shows it', async () => {
    const one = await oldWorkspace('upgrade-one');
    const two = await oldWorkspace('upgrade-two');
    const locks = [await withLock(one), await withLock(two)];
    const { app, picker } = await pickerApp({ native: { messageChoice: { 'Upgrade this workspace?': 'Upgrade' }, checkboxChecked: true } });
    try {
      await chooseInPicker(app, picker, one);
      await opened(app, one);
      expect(await pinOf(one)).toBe(pin('0.6.1'));
      const [question] = await asked(app, 'Upgrade this workspace?');
      expect(question.message).toContain('0.5.0');
      expect(question.message).toContain('0.6.1');
      // The backup: outside the workspace, everything but node_modules, .opendoc and output, with its manifest.
      const backups = join(app.dataFolder, 'backups');
      const [name] = await readdir(backups);
      expect(name).toMatch(/^upgrade-one-\d+-\d{4}-\d{2}-\d{2}-\d{6}$/);
      const manifest = await readJson(join(backups, name, 'backup.json'));
      expect(manifest).toMatchObject({ source: await realpath(one), from: '0.5.0', to: '0.6.1', kind: 'upgrade' });
      expect(manifest.files).toBeGreaterThan(5);
      expect(manifest.bytes).toBeGreaterThan(1000);
      const copied = await readdir(join(backups, name, 'workspace'));
      expect(copied).toEqual(expect.arrayContaining(['package.json', 'package-lock.json', 'documents']));
      expect(copied).not.toContain('node_modules');
      expect(copied).not.toContain('.opendoc');
      expect(copied).not.toContain('output');
      expect((await readJson(join(backups, name, 'workspace', 'package.json'))).dependencies.opendoc).toBe(pin('0.5.0'));
      // check and review ran: the review left its output in the workspace.
      expect(await exists(join(one, 'output', 'reviews'))).toBe(true);
      // The success message says where the backup is.
      const [done] = await asked(app, 'Workspace upgraded');
      expect(done.detail).toContain(join(backups, name));
      expect((await readConfig(app.profile)).upgradeWithoutAsking).toBe(true);
      expect(Object.keys(await readConfig(app.profile)).includes('skipUpgradePrompt')).toBe(false);

      // The second workspace upgrades without the dialog.
      await openByMenu(app, two);
      await opened(app, two);
      expect(await pinOf(two)).toBe(pin('0.6.1'));
      expect(await asked(app, 'Upgrade this workspace?')).toHaveLength(1);
      expect(await readdir(backups)).toHaveLength(2);

      // Workspace Backups…: the list, Reveal and Delete (to the trash, after a question).
      await app.evaluate(({ Menu }) => Menu.getApplicationMenu().items.find(item => item.label === 'File').submenu.items.find(item => item.label === 'Workspace Backups…').click());
      await waitFor(() => windowAt(app, 'backups.html'), { what: 'the backups window' });
      const list = windowAt(app, 'backups.html');
      await expect(list.locator('tr[data-backup]')).toHaveCount(2);
      const row = list.locator(`tr[data-backup="${name}"]`);
      await expect(row).toContainText(await realpath(one));
      await expect(row).toContainText('0.5.0 to 0.6.1');
      await row.getByRole('button', { name: 'Reveal' }).click();
      await waitFor(async () => (await nativeCalls(app)).folders.includes(join(backups, name)), { what: 'Reveal' });
      await row.getByRole('button', { name: /Delete/ }).click();
      await expect(list.locator('tr[data-backup]')).toHaveCount(1);
      const [confirm] = await asked(app, 'Delete this backup?');
      expect(confirm.buttons).toEqual(['Move to trash', 'Cancel']);
      expect((await nativeCalls(app)).trashed).toContain(join(backups, name));
      expect(await exists(join(backups, name))).toBe(false);
    } finally { await app.close(); }
    for (const lock of locks) await lock.unchanged();
    expect(await waitForNoElectron(5000)).toEqual([]);
  });

  test('a document that fails review shows the result screen; Copy prompt puts the failures on the clipboard; Restore brings the old files back', async () => {
    const workspace = await oldWorkspace('upgrade-broken', { broken: true });
    const lock = await withLock(workspace);
    const { app, picker } = await pickerApp({ native: { messageChoice: { 'Upgrade this workspace?': 'Upgrade' } } });
    try {
      await chooseInPicker(app, picker, workspace);
      await waitFor(() => windowAt(app, 'result.html'), { timeout: 240_000, what: 'the result screen' });
      const result = windowAt(app, 'result.html');
      await expect(result.locator('#failures')).toContainText('broken');
      await expect(result.locator('#failures')).toContainText('broken on purpose');
      await expect(result.locator('#failures')).not.toContainText('welcome');
      await expect(result.locator('#backup')).toContainText(join(app.dataFolder, 'backups', 'upgrade-broken-'));
      await expect(result.getByRole('button', { name: 'Copy prompt for your agent' })).toBeVisible();
      await expect(result.getByRole('button', { name: 'Restore backup' })).toBeVisible();
      await result.getByRole('button', { name: 'Copy prompt for your agent' }).click();
      await expect(result.locator('#message')).toContainText('Copied');
      const prompt = await app.evaluate(({ clipboard }) => clipboard.readText());
      expect(prompt).toContain('broken');
      expect(prompt).toContain('opendoc review');
      expect(prompt).toContain('0.6.1');
      expect(await pinOf(workspace)).toBe(pin('0.6.1')); // the upgrade went through; the documents are what failed
      expect(await exists(join(workspace, 'documents', 'welcome', '.history'))).toBe(true); // review wrote it

      await result.getByRole('button', { name: 'Restore backup' }).click().catch(() => {}); // the click closes the window it is in
      // Restore counts as read-only, which this service cannot do yet: refused, with the files restored.
      await expect(picker.locator('#message')).toContainText('restored from a backup', { timeout: 120_000 });
      expect(await pinOf(workspace)).toBe(pin('0.5.0'));
      expect(await exists(join(workspace, 'documents', 'welcome', '.history'))).toBe(false);
      expect(await exists(join(workspace, 'documents', 'broken', 'index.tsx'))).toBe(true);
      const kinds = await Promise.all((await readdir(join(app.dataFolder, 'backups'))).map(async name => (await readJson(join(app.dataFolder, 'backups', name, 'backup.json'))).kind));
      expect(kinds.sort()).toEqual(['before-restore', 'upgrade']);
      expect(await exists(join(workspace, '.opendoc', 'update.lock'))).toBe(false);
      await lock.unchanged();
    } finally { await app.close(); }
  });

  test('closing the result screen leaves the upgraded workspace and the backup, and does not open it', async () => {
    const workspace = await oldWorkspace('upgrade-closed', { broken: true });
    const { app, picker } = await pickerApp({ native: { messageChoice: { 'Upgrade this workspace?': 'Upgrade' } } });
    try {
      await chooseInPicker(app, picker, workspace);
      await waitFor(() => windowAt(app, 'result.html'), { timeout: 240_000, what: 'the result screen' });
      await windowAt(app, 'result.html').getByRole('button', { name: 'Close' }).click().catch(() => {}); // the click closes the window it is in
      await waitFor(() => !windowAt(app, 'result.html'), { what: 'the result screen to close' });
      expect(workspaceWindow(app)).toBeUndefined();
      expect(await readdir(join(app.dataFolder, 'backups'))).toHaveLength(1);
      await waitFor(() => exists(join(workspace, '.opendoc', 'update.lock')).then(found => !found), { what: 'the lock to be released' });
      expect(await exists(join(workspace, '.opendoc', 'desktop.json'))).toBe(false);
      expect(await pinOf(workspace)).toBe(pin('0.6.1'));
    } finally { await app.close(); }
  });
});

test.describe('an AppImage', () => {
  test('an AppImage works from a copy of the runtime in the data folder; workspace links name its current link, and old copies are pruned', async () => {
    const home = newHome('appimage-home');
    const runtimes = join(home, '.local', 'share', 'opendoc-desktop', 'runtime');
    await mkdir(join(runtimes, '0.5.0-3'), { recursive: true });
    await writeFile(join(runtimes, '0.5.0-3', 'old'), 'old');
    // APPIMAGE names a file that is not there: the agent command is left alone, the runtime copy is still made.
    const { app, picker } = await pickerApp({ env: { HOME: home, APPIMAGE: join(home, 'no-such.AppImage') } });
    try {
      const workspace = await newWorkspace('appimage-ws');
      await chooseInPicker(app, picker, workspace);
      await opened(app, workspace);
      expect(await readdir(runtimes)).toEqual(['0.6.1-7', 'current']);
      expect(await readlink(join(runtimes, 'current'))).toBe('0.6.1-7');
      expect(await readlink(modulesOf(workspace))).toBe(join(runtimes, 'current', 'node_modules'));
      expect((await lstat(join(runtimes, '0.6.1-7', 'node_modules', 'opendoc', 'package.json'))).isFile()).toBe(true);
      expect(await readFile(join(runtimes, '0.6.1-7', 'build-info.json'), 'utf8')).toBe(await readFile(join(runtimeDir, 'build-info.json'), 'utf8'));
      // The service and the theme import both run from the copy.
      const entry = commandLine(hostPid(app)).find(argument => argument.endsWith('/src/server/service.ts'));
      expect(entry).toContain(join(runtimes, '0.6.1-7'));
      const resolved = await realpath(createRequire(join(workspace, 'themes', 'neutral', 'index.ts')).resolve('opendoc/themes'));
      expect(resolved).toBe(await realpath(join(runtimes, '0.6.1-7', 'node_modules', 'opendoc', 'src', 'themes', 'index.ts')));
    } finally { await app.close(); }
    // A second launch finds the copy and makes no new one.
    const before = (await lstat(join(runtimes, '0.6.1-7'))).ino;
    const second = await pickerApp({ env: { HOME: home, APPIMAGE: join(home, 'no-such.AppImage') } });
    try {
      expect((await lstat(join(runtimes, '0.6.1-7'))).ino).toBe(before);
      expect(await readdir(runtimes)).toEqual(['0.6.1-7', 'current']);
    } finally { await second.app.close(); }
  });

  test('an AppImage whose runtime copy fails says so when a workspace is opened, and opens nothing', async () => {
    // The data folder cannot be created: its parent is a file.
    const home = newHome('appimage-full');
    await rm(join(home, '.local', 'share'), { recursive: true });
    await writeFile(join(home, '.local', 'share'), 'not a folder');
    const { app, picker } = await pickerApp({ env: { HOME: home, XDG_DATA_HOME: join(home, '.local', 'share'), APPIMAGE: join(home, 'no-such.AppImage') } });
    try {
      const workspace = await newWorkspace('appimage-failed');
      const before = await listing(workspace);
      await chooseInPicker(app, picker, workspace);
      await expect(picker.locator('#message')).toContainText('could not be copied', { timeout: 60_000 });
      expect(await listing(workspace)).toEqual(before);
      expect(workspaceWindow(app)).toBeUndefined();
    } finally { await app.close(); }
  });
});
