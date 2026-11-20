// Opening a design pack from outside the page (shell side) under Electron on the virtual display: a path in the launch
// arguments and in a second launch, macOS's open-file (also before any workspace is open), File > Import Design Pack…, the 64 MiB
// limit, and the refusals of Show in folder. The page here is the workspace page as the service serves it, with a listener the test
// adds from the first moment of the page; what the Import dialog does with the pack is the page's own (src/app/PackDialogs.tsx).
import { expect, test } from '@playwright/test';
import { createHash, randomBytes } from 'node:crypto';
import { mkdir, symlink, truncate, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { launchApp, nativeCalls, newProfile, newWorkspace, spawnApp, stubNative } from './support/app.mjs';
import { isWorkspaceUrl, waitFor, waitForExit, waitForOpen } from './support/helpers.mjs';
import { workDir } from './support/paths.mjs';

const sha = bytes => createHash('sha256').update(bytes).digest('hex');
const menuItem = (app, path) => app.evaluate(({ Menu }, names) => {
  let items = Menu.getApplicationMenu().items;
  let item;
  for (const name of names) { item = items.find(entry => entry.label === name); items = item.submenu?.items ?? []; }
  return { enabled: item.enabled };
}, path);
const clickItem = (app, path) => app.evaluate(({ Menu }, names) => {
  let items = Menu.getApplicationMenu().items;
  let item;
  for (const name of names) { item = items.find(entry => entry.label === name); items = item.submenu?.items ?? []; }
  item.click();
}, path);
const openFile = (app, path) => app.evaluate(({ app: electron }, file) => { electron.emit('open-file', { preventDefault() {} }, file); }, path);

let counter = 0;
async function makePack(name, size = 300_000) {
  const folder = join(workDir, `packs-${++counter}`);
  await mkdir(folder, { recursive: true });
  const path = join(folder, name);
  const bytes = randomBytes(size);
  await writeFile(path, bytes);
  return { path, bytes, hash: sha(bytes) };
}

/** The page-side listener: it keeps what arrives in window.__packs (name, size, hash, whether the bytes are a Uint8Array). */
function startListening() {
  if (window.__packs) return;
  window.__packs = [];
  window.__stop = window.opendocDesktop.onImportPack(async file => {
    const digest = await crypto.subtle.digest('SHA-256', file.bytes);
    window.__packs.push({ name: file.name, size: file.bytes.length, bytes: file.bytes instanceof Uint8Array, hash: [...new Uint8Array(digest)].map(byte => byte.toString(16).padStart(2, '0')).join('') });
  });
}
/**
 * Listen the way the Import dialog does, from the first moment of every workspace page (right after the preload, before any of the
 * page's own scripts). A workspace page that has the real Import dialog (src/app/main.tsx mounts it) subscribes too, and the first
 * subscriber takes a pack that arrived before any, so a test that subscribed "in time" would race with it. The late-subscriber case
 * is pack-import-e2e.spec.mjs: there the real dialog is the late subscriber of a pack from the command line.
 */
const listenFromStart = app => app.context().addInitScript(`if (location.protocol === 'app:' && location.host === 'opendoc') (${startListening})();`);
const listen = page => page.evaluate(startListening);
const received = page => page.evaluate(() => window.__packs);
const workspacePage = app => app.windows().find(page => isWorkspaceUrl(page.url()));

test.describe.serial('a pack named on the command line, in a second launch, by open-file and from the File menu', () => {
  let app; let page; let workspace; let profile; let first;

  test.beforeAll(async () => {
    workspace = await newWorkspace('pack-open');
    profile = await newProfile('pack-open-profile', { defaultWorkspace: workspace });
    first = await makePack('civic-1.0.0.opendoc.zip');
    app = await launchApp({ profile, appArgs: [first.path] });
    await listenFromStart(app);
    await stubNative(app, {});
    await waitFor(() => workspacePage(app), { timeout: 120_000, what: 'the workspace page' });
    page = workspacePage(app);
    await waitForOpen(workspace);
  });

  test.afterAll(async () => { await app?.close().catch(() => {}); });

  test('a .opendoc.zip in the launch arguments reaches the page, whole and with its name', async () => {
    await listen(page);
    await waitFor(async () => (await received(page)).length === 1, { what: 'the pack' });
    expect(await received(page)).toEqual([{ name: 'civic-1.0.0.opendoc.zip', size: first.bytes.length, bytes: true, hash: first.hash }]);
  });

  test('it is delivered once: a new subscriber does not get it again', async () => {
    const again = await page.evaluate(() => new Promise(accept => {
      const seen = [];
      const stop = window.opendocDesktop.onImportPack(file => seen.push(file.name));
      setTimeout(() => { stop(); accept(seen); }, 700);
    }));
    expect(again).toEqual([]);
  });

  test('a second launch with a pack passes it to the running app and exits', async () => {
    const second = await makePack('second.opendoc.zip', 120_000);
    const child = spawnApp({ profile, appArgs: [second.path] });
    expect(await waitForExit(child, 60_000)).toBe(true);
    await waitFor(async () => (await received(page)).length === 2, { what: 'the second pack' });
    expect((await received(page))[1]).toEqual({ name: 'second.opendoc.zip', size: 120_000, bytes: true, hash: second.hash });
    expect(app.windows().filter(item => isWorkspaceUrl(item.url()))).toHaveLength(1);
  });

  test('a file:// address with a space in the name works as an argument of a second launch, and so does the plain path', async () => {
    const spaced = await makePack('My pack.opendoc.zip', 60_000);
    for (const argument of [pathToFileURL(spaced.path).href, spaced.path]) {
      const before = (await received(page)).length;
      const child = spawnApp({ profile, appArgs: [argument] });
      expect(await waitForExit(child, 60_000)).toBe(true);
      await waitFor(async () => (await received(page)).length === before + 1, { what: `the pack from ${argument}` });
      expect((await received(page)).at(-1)).toEqual({ name: 'My pack.opendoc.zip', size: 60_000, bytes: true, hash: spaced.hash });
    }
    // The tests after this one count what arrived: take those two off.
    await page.evaluate(() => { window.__packs.splice(2, 2); });
  });

  test('macOS open-file is handled the same way', async () => {
    const pack = await makePack('from-finder.opendoc.zip', 90_000);
    await openFile(app, pack.path);
    await waitFor(async () => (await received(page)).length === 3, { what: 'the pack from open-file' });
    expect((await received(page))[2]).toMatchObject({ name: 'from-finder.opendoc.zip', hash: pack.hash });
  });

  test('open-file takes only a .zip: any other file a program names to the app is not read and nothing reaches the page', async () => {
    const folder = join(workDir, `packs-${++counter}`);
    await mkdir(folder, { recursive: true });
    const other = [join(folder, 'notes.txt'), join(folder, 'photo.png'), join(folder, 'archive.zip.txt'), join(folder, 'no-extension')];
    for (const path of other) await writeFile(path, 'not a pack');
    const before = (await received(page)).length;
    const readsBefore = (await nativeCalls(app)).messages.length;
    for (const path of [...other, folder, join(folder, 'missing.pdf'), '/etc/hostname']) await openFile(app, path);
    await new Promise(accept => setTimeout(accept, 700));
    expect(await received(page)).toHaveLength(before);
    expect((await nativeCalls(app)).messages).toHaveLength(readsBefore); // and no error box either: the event is dropped where it arrives
    // A .zip still goes through the same event (the next test counts on the packs that came before).
    const zip = await makePack('after-others.opendoc.zip', 40_000);
    await openFile(app, zip.path);
    await waitFor(async () => (await received(page)).length === before + 1, { what: 'the zip after the others' });
    expect((await received(page)).at(-1)).toMatchObject({ name: 'after-others.opendoc.zip', hash: zip.hash });
  });

  test('File > Import Design Pack… asks for a .opendoc.zip and sends the chosen file', async () => {
    expect(await menuItem(app, ['File', 'Import Design Pack…'])).toEqual({ enabled: true });
    const pack = await makePack('chosen.opendoc.zip', 70_000);
    await stubNative(app, { openDialog: { canceled: false, filePaths: [pack.path] } });
    await clickItem(app, ['File', 'Import Design Pack…']);
    await waitFor(async () => (await received(page)).length === 5, { what: 'the chosen pack' });
    expect((await received(page))[4]).toMatchObject({ name: 'chosen.opendoc.zip', hash: pack.hash });
    const [dialogOptions] = (await nativeCalls(app)).opens;
    expect(dialogOptions.title).toBe('Import a design pack');
    expect(dialogOptions.properties).toEqual(['openFile']);
    expect(dialogOptions.filters[0].extensions).toEqual(['opendoc.zip']);
    // Cancel sends nothing.
    await stubNative(app, { openDialog: { canceled: true, filePaths: [] } });
    await clickItem(app, ['File', 'Import Design Pack…']);
    await new Promise(accept => setTimeout(accept, 500));
    expect(await received(page)).toHaveLength(5);
  });

  test('a pack over 64 MiB is refused with the app\'s own message and nothing reaches the page; a file that is gone says so', async () => {
    const big = await makePack('too-big.opendoc.zip', 10);
    await truncate(big.path, 64 * 1024 * 1024 + 1);
    await stubNative(app, {});
    await openFile(app, big.path);
    await waitFor(async () => (await nativeCalls(app)).messages.length === 1, { what: 'the message' });
    const [message] = (await nativeCalls(app)).messages;
    expect(message.type).toBe('error');
    expect(message.title).toBe('Could not open the design pack');
    expect(message.message).toBe('too-big.opendoc.zip is 64 MiB. A design pack can be at most 64 MiB, so it was not opened.');
    await openFile(app, join(workDir, 'no-such-folder', 'gone.opendoc.zip'));
    await waitFor(async () => (await nativeCalls(app)).messages.length === 2, { what: 'the second message' });
    expect((await nativeCalls(app)).messages[1].message).toContain('gone.opendoc.zip could not be opened. It was not found.');
    await new Promise(accept => setTimeout(accept, 500));
    expect(await received(page)).toHaveLength(5);
  });
});

test('a pack opened while no workspace is open waits, the picker says so, and the first workspace that opens gets it', async () => {
  const workspace = await newWorkspace('pack-wait');
  const profile = await newProfile('pack-wait-profile');
  const pack = await makePack('waiting.opendoc.zip', 150_000);
  const app = await launchApp({ profile, appArgs: [pack.path] });
  await listenFromStart(app);
  try {
    await stubNative(app, { openDialog: { canceled: false, filePaths: [workspace] } });
    const picker = await app.firstWindow();
    expect(picker.url()).toBe('app://shell/picker.html');
    await expect(picker.locator('#message')).toContainText('Choose a workspace to review waiting.opendoc.zip');
    expect(await menuItem(app, ['File', 'Import Design Pack…'])).toEqual({ enabled: false });
    await picker.getByRole('button', { name: /Open existing workspace/ }).click();
    await waitFor(() => workspacePage(app), { timeout: 120_000, what: 'the workspace page' });
    const page = workspacePage(app);
    await waitForOpen(workspace);
    await listen(page);
    await waitFor(async () => (await received(page)).length === 1, { what: 'the waiting pack' });
    expect((await received(page))[0]).toMatchObject({ name: 'waiting.opendoc.zip', hash: pack.hash });
  } finally { await app.close(); }
});

test('open-file that arrives before the workspace window exists is held until the page has loaded', async () => {
  const workspace = await newWorkspace('pack-early');
  const profile = await newProfile('pack-early-profile', { defaultWorkspace: workspace });
  const pack = await makePack('early.opendoc.zip', 80_000);
  const app = await launchApp({ profile });
  await listenFromStart(app);
  try {
    // The workspace is still opening (its service host is starting) when the event comes.
    await openFile(app, pack.path);
    await waitFor(() => workspacePage(app), { timeout: 120_000, what: 'the workspace page' });
    const page = workspacePage(app);
    await waitForOpen(workspace);
    await listen(page);
    await waitFor(async () => (await received(page)).length === 1, { what: 'the early pack' });
    expect((await received(page))[0]).toMatchObject({ name: 'early.opendoc.zip', hash: pack.hash });
  } finally { await app.close(); }
});

test.describe.serial('Show in folder', () => {
  let app; let page; let workspace; let packs; let outside;

  test.beforeAll(async () => {
    workspace = await newWorkspace('pack-reveal');
    packs = join(workspace, 'output', 'packs');
    await mkdir(packs, { recursive: true });
    outside = join(workDir, `reveal-outside-${++counter}`);
    await mkdir(outside, { recursive: true });
    await writeFile(join(packs, 'saved-1.0.0.opendoc.zip'), 'zip');
    await writeFile(join(workspace, 'secret.txt'), 'x');
    await writeFile(join(outside, 'other.opendoc.zip'), 'zip');
    await symlink(join(outside, 'other.opendoc.zip'), join(packs, 'link.opendoc.zip'));
    await symlink(outside, join(packs, 'dir-link'));
    const profile = await newProfile('pack-reveal-profile', { defaultWorkspace: workspace });
    app = await launchApp({ profile });
    await stubNative(app, {});
    await waitFor(() => workspacePage(app), { timeout: 120_000, what: 'the workspace page' });
    page = workspacePage(app);
    await waitForOpen(workspace);
  });

  test.afterAll(async () => { await app?.close().catch(() => {}); });

  const reveal = path => page.evaluate(value => window.opendocDesktop.showInFolder(value), path);
  const revealed = async () => (await nativeCalls(app)).folders;

  test('a pack the app saved is shown in the file manager', async () => {
    expect(await reveal(join(packs, 'saved-1.0.0.opendoc.zip'))).toBeUndefined();
    await waitFor(async () => (await revealed()).length === 1, { what: 'the reveal' });
    expect((await revealed())[0].endsWith(join('output', 'packs', 'saved-1.0.0.opendoc.zip'))).toBe(true);
  });

  test('every other path is refused: .., links, other folders of the workspace, other places, relative paths, the folder itself, other types', async () => {
    const refused = [
      `${packs}/../../secret.txt`,
      join(packs, '..', '..', '..', 'etc', 'passwd'),
      join(packs, 'link.opendoc.zip'),
      join(packs, 'dir-link', 'other.opendoc.zip'),
      join(outside, 'other.opendoc.zip'),
      join(workspace, 'secret.txt'),
      join(workspace, 'package.json'),
      join(workspace, 'output'),
      packs,
      join(packs, 'missing.opendoc.zip'),
      '/etc/passwd',
      '/',
      'output/packs/saved-1.0.0.opendoc.zip',
      '',
    ];
    for (const path of refused) expect(await reveal(path), path).toBeUndefined();
    for (const value of [null, undefined, 42, {}]) expect(await page.evaluate(item => window.opendocDesktop.showInFolder(item), value)).toBeUndefined();
    await new Promise(accept => setTimeout(accept, 500));
    expect(await revealed()).toHaveLength(1);
    expect(app.output.join('').match(/\[show-in-folder\] refused/g)?.length).toBeGreaterThanOrEqual(refused.length - 1);
  });

  test('only the workspace page may ask: a frame inside it has no bridge, and the app\'s own pages have no such call', async () => {
    const frame = await page.evaluate(async () => {
      const element = document.createElement('iframe');
      element.src = 'about:blank';
      document.body.append(element);
      await new Promise(accept => setTimeout(accept, 300));
      const seen = typeof element.contentWindow.opendocDesktop;
      element.remove();
      return seen;
    });
    expect(frame).toBe('undefined');
    expect(await page.evaluate(() => typeof window.opendocShell)).toBe('undefined');
  });
});
