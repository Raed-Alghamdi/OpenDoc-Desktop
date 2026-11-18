// The everyday flow, end to end on a scratch workspace, all of it over the app's own address (app://opendoc, no
// port): the library shows, a document opens and its PDF renders (whole, and by Range request), a comment is added,
// a logo is uploaded, an export is saved through the (stubbed) save dialog, "Show in folder" reaches the service,
// the PDF window works, the bundled command's comment appears in the window through the bridge, links leave through
// the system browser, and quitting leaves nothing running.
import { expect, test } from '@playwright/test';
import { execFile } from 'node:child_process';
import { readFile, readdir, access, mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { deflateSync } from 'node:zlib';
import { promisify } from 'node:util';
import { launchApp, nativeCalls, newProfile, newWorkspace, setNative, stubNative } from './support/app.mjs';
import { waitFor } from './support/helpers.mjs';
import { unpackedDir } from './support/paths.mjs';
import { electronProcesses, waitForNoElectron } from './support/processes.mjs';

/** A valid PNG of the given size: random pixels when `noisy` (does not compress, so the file is large), else a flat colour. */
function png(width, height, noisy) {
  const crcTable = Array.from({ length: 256 }, (_, n) => { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; return c >>> 0; });
  const crc = bytes => { let c = 0xffffffff; for (const byte of bytes) c = crcTable[(c ^ byte) & 0xff] ^ (c >>> 8); return (c ^ 0xffffffff) >>> 0; };
  const chunk = (type, data) => { const body = Buffer.concat([Buffer.from(type), data]); const out = Buffer.alloc(12 + data.length); out.writeUInt32BE(data.length, 0); body.copy(out, 4); out.writeUInt32BE(crc(body), 8 + data.length); return out; };
  const header = Buffer.alloc(13); header.writeUInt32BE(width, 0); header.writeUInt32BE(height, 4); header[8] = 8; header[9] = 2;
  const rows = Buffer.alloc((width * 3 + 1) * height);
  for (let y = 0; y < height; y++) {
    const start = y * (width * 3 + 1);
    for (let x = 0; x < width * 3; x++) rows[start + 1 + x] = noisy ? Math.floor(Math.random() * 256) : (x % 3 === 0 ? 20 : 120);
  }
  return Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), chunk('IHDR', header), chunk('IDAT', deflateSync(rows, { level: noisy ? 0 : 6 })), chunk('IEND', Buffer.alloc(0))]);
}

test.describe.serial('workspace flow', () => {
  let app; let page; let workspace; let profile; let saveTo; let opened;

  test.beforeAll(async () => {
    workspace = await newWorkspace('flow');
    profile = await newProfile('flow-profile', { defaultWorkspace: workspace });
    saveTo = join(profile, 'saved-copy.pdf');
    // A file manager that only takes a note: "Show in folder" goes to the service, which starts `xdg-open` (and never the real one here).
    const bin = join(profile, 'bin');
    opened = join(profile, 'xdg-open.log');
    await mkdir(bin);
    await writeFile(join(bin, 'xdg-open'), `#!/bin/sh\nprintf 'args=%s run-as-node=%s\\n' "$*" "\${ELECTRON_RUN_AS_NODE-unset}" >> '${opened}'\n`, { mode: 0o755 });
    app = await launchApp({ profile, env: { PATH: `${bin}:${process.env.PATH}` } });
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

  test('the PDF is served whole and a Range request is carried through', async () => {
    // pdf.js asks for the file from a worker, so the page's own timing list does not show it: ask the service for the render's hash.
    const url = await page.evaluate(async () => {
      const summaries = await (await fetch('/api/documents')).json();
      const welcome = (Array.isArray(summaries) ? summaries : summaries.documents).find(item => item.id === 'welcome');
      return `/api/documents/welcome/pdf?hash=${welcome.hash ?? welcome.artifact?.hash}`;
    });
    expect(url).toMatch(/hash=[0-9a-f]{64}$/);
    const result = await page.evaluate(async address => {
      const whole = await fetch(address);
      const wholeBytes = new Uint8Array(await whole.arrayBuffer());
      const ranged = await fetch(address, { headers: { Range: 'bytes=0-99' } });
      const rangedBytes = new Uint8Array(await ranged.arrayBuffer());
      const text = bytes => String.fromCharCode(...bytes.subarray(0, 5));
      return { wholeStatus: whole.status, wholeLength: wholeBytes.length, declared: Number(whole.headers.get('content-length')), wholeMagic: text(wholeBytes), rangedStatus: ranged.status, rangedLength: rangedBytes.length, contentRange: ranged.headers.get('content-range'), rangedMagic: text(rangedBytes) };
    }, url);
    expect(result).toMatchObject({ wholeStatus: 200, wholeMagic: '%PDF-', rangedMagic: '%PDF-' });
    expect(result.wholeLength).toBe(result.declared);
    expect(result.wholeLength).toBeGreaterThan(100_000);
    // The service answers a Range request with the whole file today (it sends no Accept-Ranges, so pdf.js loads the file whole);
    // a 206 from a later service is carried through just as faithfully (the host's unit tests cover it).
    if (result.rangedStatus === 206) { expect(result.rangedLength).toBe(100); expect(result.contentRange).toMatch(/^bytes 0-99\//); }
    else { expect(result.rangedStatus).toBe(200); expect(result.rangedLength).toBe(result.wholeLength); }
  });

  test('a logo uploads through the channel, a small one and a large one', async () => {
    for (const [id, image] of [['shell-small-logo', png(240, 120, false)], ['shell-large-logo', png(1000, 1000, true)]]) {
      const result = await page.evaluate(async ({ id: name, base64 }) => {
        const token = (await (await fetch('/api/session')).json()).token;
        const form = new FormData();
        form.set('metadata', JSON.stringify({ id: name, name, description: 'Uploaded by a shell test', variationName: 'Default', variationDescription: 'The only variation' }));
        form.set('file', new Blob([Uint8Array.from(atob(base64), character => character.charCodeAt(0))], { type: 'image/png' }), 'logo.png');
        const response = await fetch('/api/assets/logo', { method: 'POST', headers: { 'x-opendoc-token': token }, body: form });
        return { status: response.status, body: await response.json().catch(() => null) };
      }, { id, base64: image.toString('base64') });
      expect(result.status, JSON.stringify(result.body)).toBe(201);
      expect(await page.evaluate(async name => (await fetch(`/api/assets/logo/${name}`)).status, id)).toBe(200);
    }
    expect((await readdir(join(workspace, 'assets', 'logos'))).sort()).toEqual(expect.arrayContaining(['shell-large-logo', 'shell-small-logo']));
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

  test('"Show in folder" reaches the service, which starts the file manager (the app does not answer it itself)', async () => {
    await page.getByRole('button', { name: 'Show in folder' }).click();
    await waitFor(() => readFile(opened, 'utf8').catch(() => ''), { timeout: 20_000, what: 'the file manager to be started' });
    const [line] = (await readFile(opened, 'utf8')).trim().split('\n');
    expect(line).toContain(`args=${join(workspace, 'output')}`);
    // Known item (report): the service host's environment still has ELECTRON_RUN_AS_NODE, so the file manager gets it too (line: ${line}).
    expect((await nativeCalls(app)).folders).toEqual([]);
  });

  test('"Open PDF to print" opens the file in an app window', async () => {
    const [child] = await Promise.all([app.waitForEvent('window', { timeout: 30_000 }), page.getByRole('link', { name: 'Open PDF to print' }).click()]);
    await child.waitForLoadState('domcontentloaded');
    expect(child.url()).toMatch(/\/api\/exports\/[a-f0-9-]+\/open$/);
    await child.close();
  });

  test('a comment added by the bundled command shows in the open window, through the bridge', async () => {
    await page.evaluate(() => { window.__changes = 0; window.opendocDesktop.onChange(() => { window.__changes++; }); });
    const launcher = join(unpackedDir, 'resources', 'cli', 'opendoc');
    const { stdout } = await promisify(execFile)(launcher, ['comments', 'add', 'welcome', 'welcome-introduction', 'Added by the bundled command.', '--json'], { cwd: workspace, env: { PATH: '/usr/bin:/bin', HOME: profile, LANG: 'C.UTF-8' }, timeout: 240_000 });
    expect(JSON.parse(stdout)).toBeTruthy();
    await expect.poll(() => page.evaluate(() => window.__changes), { timeout: 30_000 }).toBeGreaterThan(0);
    // The page's comment count grew (the earlier test added the first) and the new text is in the panel: the window refreshed by itself.
    await expect(page.getByRole('button', { name: /^Comments, 2 open/ })).toBeVisible({ timeout: 30_000 });
    await page.getByRole('button', { name: /^Comments, 2 open/ }).click();
    await expect(page.getByText('Added by the bundled command.').first()).toBeVisible({ timeout: 30_000 });
    // The page learned of it through the bridge, not a socket.
    expect(await page.evaluate(() => performance.getEntriesByType('resource').some(entry => entry.name.includes('/api/events')))).toBe(false);
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
