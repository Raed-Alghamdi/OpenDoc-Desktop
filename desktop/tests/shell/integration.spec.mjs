// Integration of the shell and the service host after review (plan E1): what the service's own headers keep, who may
// change things through app://opendoc, where the shell's pages can be reached from, what happens to a download or an
// upload when the host dies or the page gives up, and that quitting or killing the app at any moment leaves nothing.
import { expect, test } from '@playwright/test';
import { access, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { launchApp, newProfile, newWorkspace, spawnApp, stubNative } from './support/app.mjs';
import { desktopRecord, hostPid, isWorkspaceUrl, libraryReady, nextHostPid, waitFor, waitForExit } from './support/helpers.mjs';
import { electronProcesses, killElectronProcesses, processAlive, serviceHostOf, waitForNoElectron } from './support/processes.mjs';

/** The route of a stored file of a logo, from what the service answered when it was created. */
const fileRoute = ({ asset }, which) => `/api/assets/logo/${asset.id}/file?revision=${asset.revision}&file=${encodeURIComponent(asset.variations[0][which].file)}`;
const exists = file => access(file).then(() => true, () => false);

// Helpers that run inside the workspace page: a token, a noise PNG (big, and it does not compress), an upload.
const installPageHelpers = page => page.evaluate(() => {
  const table = new Uint32Array(256).map((_, n) => { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; return c >>> 0; });
  const crc = (...parts) => { let c = 0xffffffff; for (const part of parts) for (let i = 0; i < part.length; i++) c = table[(c ^ part[i]) & 255] ^ (c >>> 8); return (c ^ 0xffffffff) >>> 0; };
  const chunk = (type, data) => {
    const name = new TextEncoder().encode(type);
    const out = new Uint8Array(12 + data.length);
    const view = new DataView(out.buffer);
    view.setUint32(0, data.length); out.set(name, 4); out.set(data, 8); view.setUint32(8 + data.length, crc(name, data));
    return out;
  };
  const token = async () => (await (await fetch('/api/session')).json()).token;
  window.__t = {
    token,
    async png(size) {
      const stride = size * 3 + 1;
      const raw = new Uint8Array(stride * size);
      for (let at = 0; at < raw.length; at += 65536) crypto.getRandomValues(raw.subarray(at, Math.min(at + 65536, raw.length)));
      for (let row = 0; row < size; row++) raw[row * stride] = 0;
      const packed = new Uint8Array(await new Response(new Blob([raw]).stream().pipeThrough(new CompressionStream('deflate'))).arrayBuffer());
      const header = new Uint8Array(13); const view = new DataView(header.buffer);
      view.setUint32(0, size); view.setUint32(4, size); header[8] = 8; header[9] = 2;
      return new Blob([new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10]), chunk('IHDR', header), chunk('IDAT', packed), chunk('IEND', new Uint8Array(0))], { type: 'image/png' });
    },
    /** POST a logo; resolves { status, body } (the parsed answer) or { error } when the request failed or was cut. */
    async upload(name, blob, filename, signal) {
      const form = new FormData();
      form.set('metadata', JSON.stringify({ name }));
      form.set('file', blob, filename);
      try {
        const response = await fetch('/api/assets/logo', { method: 'POST', headers: { 'x-opendoc-token': window.__token ?? await token() }, body: form, signal });
        return { status: response.status, body: await response.json().catch(() => null) };
      } catch (error) { return { error: `${error.name}: ${error.message}` }; }
    },
  };
});

test.describe.serial('the shell and the service host, as the page sees them', () => {
  test.describe.configure({ timeout: 600_000 });
  let app; let page; let workspace; let svg; let big; let bigBytes;
  const run = (code, ...args) => page.evaluate(code, ...args);
  const states = () => page.evaluate(() => window.__states);

  test.beforeAll(async () => {
    workspace = await newWorkspace('integration');
    app = await launchApp({ profile: await newProfile('integration-profile', { defaultWorkspace: workspace }), env: { OPENDOC_DESKTOP_HEALTH_MS: '700' } });
    await stubNative(app);
    page = await app.firstWindow();
    await libraryReady(page);
    await installPageHelpers(page);
    await page.evaluate(() => { window.__states = []; window.__marker = 'same page'; window.opendocDesktop.onHostState(({ state }) => window.__states.push(state)); });
  });

  test.afterAll(async () => { await app?.close().catch(() => {}); });

  test('the page\'s own changes and uploads work: a JSON post, a small upload and one larger than the upload window', async () => {
    const context = await run(async () => (await fetch('/api/context', { method: 'POST', headers: { 'content-type': 'application/json', 'x-opendoc-token': await window.__t.token() }, body: JSON.stringify({ documentId: 'welcome', blockId: null, page: 1, selection: null, editing: false, pendingEdits: 0, draftPreview: false }) })).status);
    expect(context).toBeLessThan(500);
    const logo = '<svg xmlns="http://www.w3.org/2000/svg" width="64" height="64"><rect width="64" height="64" fill="#036"/></svg>';
    svg = await run(async text => window.__t.upload('Integration SVG', new Blob([text], { type: 'image/svg+xml' }), 'logo.svg'), logo);
    expect(svg.error).toBeUndefined();
    expect(svg.status).toBe(201);
    // About 12 MB of noise: three times the window the main process sends before the service has read some of it.
    const made = await run(async () => { const blob = await window.__t.png(2000); const result = await window.__t.upload('Integration big PNG', blob, 'big.png'); return { size: blob.size, ...result }; });
    expect(made.size).toBeGreaterThan(11 * 1024 * 1024);
    expect(made.error).toBeUndefined();
    expect(made.status).toBe(201);
    big = made.body;
    bigBytes = made.size;
  });

  test('the service\'s own security headers survive the forward, next to the app\'s policy', async () => {
    const url = fileRoute(svg.body, 'original');
    const answer = await run(async address => {
      const response = await fetch(address);
      return { status: response.status, headers: Object.fromEntries(response.headers.entries()) };
    }, url);
    expect(answer.status).toBe(200);
    // The service's policy for SVG assets is still there (it is stricter than the app's), and the app's policy is added.
    expect(answer.headers['content-security-policy']).toContain("default-src 'none'; sandbox");
    expect(answer.headers['content-security-policy']).toContain("connect-src 'self'");
    expect(answer.headers['content-disposition']).toMatch(/^attachment; filename="[^"]+\.svg"$/);
    expect(answer.headers['x-content-type-options']).toBe('nosniff');
    expect(answer.headers['cache-control']).toBe('no-store');
    expect(answer.headers['content-type']).toBe('image/svg+xml');
    expect(Number(answer.headers['content-length'])).toBeGreaterThan(0);
    // A route that sets no policy of its own still gets exactly the app's (one policy, no stray separator).
    const plain = await run(async () => (await fetch('/api/session')).headers.get('content-security-policy'));
    expect(plain.startsWith("default-src 'none'; script-src 'self'")).toBe(true);
    expect(plain).not.toContain(', ');
    expect(plain).not.toContain('sandbox');
    // The service's other answers keep their own headers too (a PDF and a PNG are served inline, with nosniff).
    const inline = await run(async address => { const response = await fetch(address); return { status: response.status, type: response.headers.get('content-type'), disposition: response.headers.get('content-disposition'), nosniff: response.headers.get('x-content-type-options') }; }, fileRoute(big, 'original'));
    expect(inline).toMatchObject({ status: 200, type: 'image/png', nosniff: 'nosniff' });
    expect(inline.disposition).toMatch(/^inline;/);
  });

  test('a change from anywhere but the app\'s own page is cancelled: a shell page (and its frames); the app\'s own page, upload and worker still work; workers are policed by policy, not by the request hook', async () => {
    // A window of the app's own pages in the workspace's session, with the page's own policy switched off (Page.setBypassCSP), so that
    // only the app's request guard stands between this page and the service. What the guard saw is read from the network events.
    const within = (promise, label, milliseconds = 20_000) => Promise.race([promise, new Promise((_, reject) => setTimeout(reject, milliseconds, new Error(`timed out: ${label}`)))]);
    await within(app.evaluate(async ({ BrowserWindow }) => {
      const session = BrowserWindow.getAllWindows()[0].webContents.session;
      const win = globalThis.__shellWindow = new BrowserWindow({ show: false, webPreferences: { session, sandbox: true, contextIsolation: true } });
      globalThis.__shellFailures = [];
      await win.loadURL('app://shell/crash.html'); // a renderer first: the debugger needs one
    }), 'loading app://shell/crash.html');
    // With the shell page's own policy, it cannot start a worker at all (worker-src 'none'), so the gap noted below is closed one level up.
    const workerWithPolicy = await within(app.evaluate(({}) => globalThis.__shellWindow.webContents.executeJavaScript(`new Promise(accept => {
      try { const worker = new Worker(URL.createObjectURL(new Blob(['postMessage(1)']))); worker.onmessage = () => accept('started'); worker.onerror = () => accept('refused'); }
      catch (error) { accept('refused: ' + error.name); }
      setTimeout(() => accept('no answer'), 3000);
    })`)), 'a worker under the shell policy');
    expect(workerWithPolicy).toMatch(/^refused/);
    await within(app.evaluate(async ({}) => {
      const win = globalThis.__shellWindow;
      const attached = win.webContents.debugger;
      attached.attach('1.3');
      attached.on('message', (_event, method, params) => { if (method === 'Network.loadingFailed') globalThis.__shellFailures.push({ error: params.errorText, blocked: params.blockedReason ?? null }); });
      await attached.sendCommand('Network.enable');
      await attached.sendCommand('Page.setBypassCSP', { enabled: true });
      await win.loadURL('app://shell/crash.html?again=1'); // loaded again, now without the page's policy
    }), 'switching the shell page\'s policy off');
    const result = await within(app.evaluate(({}) => globalThis.__shellWindow.webContents.executeJavaScript(`(async () => {
      const attempt = async (url, init) => { try { return (await fetch(url, init)).status; } catch (error) { return 'blocked'; } };
      const out = { origin: location.origin };
      out.get = await attempt('app://opendoc/api/session');
      out.post = await attempt('app://opendoc/api/context', { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' });
      out.put = await attempt('app://opendoc/api/context', { method: 'PUT', body: '{}' });
      out.del = await attempt('app://opendoc/api/assets/logo/none', { method: 'DELETE' });
      out.upload = await attempt('app://opendoc/api/assets/logo', { method: 'POST', body: new FormData() });
      out.worker = await new Promise(accept => {
        const code = 'fetch("app://opendoc/api/context", { method: "POST", body: "{}" }).then(r => postMessage(r.status), () => postMessage("blocked"))';
        const worker = new Worker(URL.createObjectURL(new Blob([code])));
        worker.onmessage = event => accept(event.data);
        worker.onerror = () => accept('worker error');
        setTimeout(() => accept('timeout'), 8000);
      });
      return out;
    })()`)), 'the requests of the shell page');
    const failures = await app.evaluate(({}) => { const found = globalThis.__shellFailures; globalThis.__shellWindow.destroy(); return found; });
    const outcome = { result, failures };
    expect(outcome.result.origin).toBe('app://shell');
    expect(outcome.result.post).toBe('blocked');
    expect(outcome.result.put).toBe('blocked');
    expect(outcome.result.del).toBe('blocked');
    expect(outcome.result.upload).toBe('blocked');
    // A finding, not a wish: Electron does not run the web request hook for requests that dedicated or shared workers make (the
    // protocol handler still sees them, with no origin), so the guard cannot police them. Here the service's own token rule answers
    // (403); what keeps a worker of another origin out is that no page of another origin may start one (checked above).
    expect([403, 'blocked']).toContain(outcome.result.worker);
    // The cancellation is the app's request guard (ERR_BLOCKED_BY_CLIENT), not the page's policy (switched off here).
    // That webRequest.onBeforeRequest fires for requests the protocol handler answers, and carries the initiator's origin, is what this shows.
    const guard = outcome.failures.filter(item => item.error === 'net::ERR_BLOCKED_BY_CLIENT');
    expect(guard.length).toBeGreaterThanOrEqual(4);
    expect(outcome.failures.some(item => item.blocked === 'csp')).toBe(false);
    // The service did not see any of it: a read from the shell page is not a change (it may or may not pass the browser's cross-origin rule).
    expect(['blocked', 200]).toContain(outcome.result.get);

    // The app's own page: a change, an upload and a change made by its own (blob) worker all go through; the worker's requests carry the page's origin.
    const own = await run(async () => {
      const token = await window.__t.token();
      const post = await fetch('/api/context', { method: 'POST', headers: { 'content-type': 'application/json', 'x-opendoc-token': token }, body: JSON.stringify({ documentId: 'welcome', blockId: null, page: 1, selection: null, editing: false, pendingEdits: 0, draftPreview: false }) });
      const upload = await window.__t.upload('Own page upload', new Blob(['<svg xmlns="http://www.w3.org/2000/svg" width="8" height="8"><circle cx="4" cy="4" r="3"/></svg>'], { type: 'image/svg+xml' }), 'dot.svg');
      const worker = await new Promise(accept => {
        const code = `fetch("/api/context", { method: "POST", headers: { "content-type": "application/json", "x-opendoc-token": ${JSON.stringify(token)} }, body: JSON.stringify({ documentId: "welcome", blockId: null, page: 1, selection: null, editing: false, pendingEdits: 0, draftPreview: false }) }).then(r => postMessage(r.status), e => postMessage("failed: " + e.message))`;
        // A blob worker has no base address of its own: the full address is given.
        const worker = new Worker(URL.createObjectURL(new Blob([code.replace('"/api/context"', `"${location.origin}/api/context"`)])));
        worker.onmessage = event => accept(event.data);
        worker.onerror = () => accept('worker error');
        setTimeout(() => accept('timeout'), 8000);
      });
      return { post: post.status, upload: upload.status, worker };
    });
    expect(own.post).toBeLessThan(500);
    expect(own.upload).toBe(201);
    expect(typeof own.worker === 'number' ? own.worker : 999).toBeLessThan(500); // a worker the app's page made is the app's own code
  });

  test('the shell\'s pages cannot be reached from the workspace page: not by address, link, window.open or a form', async () => {
    const windows = app.windows().length;
    const before = page.url();
    await run(() => { location.href = 'app://shell/picker.html'; });
    await new Promise(accept => setTimeout(accept, 600));
    expect(page.url()).toBe(before);
    await run(() => { const link = document.createElement('a'); link.href = 'app://shell/picker.html'; link.id = '__shell-link'; link.textContent = 'x'; document.body.append(link); link.click(); link.remove(); });
    await run(() => { location.href = 'APP://SHELL/crash.html'; });
    await run(() => { const form = document.createElement('form'); form.action = 'app://shell/picker.html'; form.method = 'get'; document.body.append(form); try { form.submit(); } catch { /* blocked by the policy */ } form.remove(); });
    expect(await run(() => window.open('app://shell/picker.html')) ).toBeNull();
    await new Promise(accept => setTimeout(accept, 600));
    expect(page.url()).toBe(before);
    expect(app.windows().length).toBe(windows);
    expect(isWorkspaceUrl(page.url())).toBe(true);
    // The page still has the bridge of the workspace and none of the picker's.
    expect(await run(() => [typeof window.opendocDesktop, typeof window.opendocShell])).toEqual(['object', 'undefined']);
  });

  test('app://shell answers only its own pages: other hosts, odd hosts, encoded and dotted paths get 403 or 404 and never a file', async () => {
    const answers = await app.evaluate(async ({ BrowserWindow }) => {
      const session = BrowserWindow.getAllWindows()[0].webContents.session;
      const ask = async url => {
        try { const response = await session.fetch(url); return { status: response.status, type: response.headers.get('content-type'), text: (await response.text()).slice(0, 120) }; }
        catch (error) { return { status: 'blocked', error: error.message }; }
      };
      const urls = ['app://shell/picker.html', 'app://SHELL/picker.html', 'app://shell/nothing.html', 'app://shell/', 'app://shell/%2e%2e/package.json', 'app://shell/..%2fpackage.json', 'app://shell/%2e%2e%2fmain%2findex.mjs', 'app://shell/picker.html%2f..%2fpicker.js', 'app://shell/../main/index.mjs', 'app://shell/picker.html/../../main/index.mjs', 'app://shell/%2Fetc%2Fpasswd', 'app://shell/picker.js%00.html', 'app://shell.evil/picker.html', 'app://opendoc.evil/api/session', 'app://shell:80/picker.html', 'app://user@shell/picker.html', 'app://shell@opendoc/api/session', 'app://other/picker.html'];
      const found = {};
      for (const url of urls) found[url] = await ask(url);
      return found;
    });
    // The same host spelled differently (case, a port) is the same host and the same page, nothing more; credentials in the address are refused.
    const samePage = ['app://shell/picker.html', 'app://SHELL/picker.html', 'app://shell:80/picker.html'];
    for (const url of samePage) expect(answers[url], url).toMatchObject({ status: 200, type: 'text/html; charset=utf-8', text: answers['app://shell/picker.html'].text });
    for (const [url, answer] of Object.entries(answers)) {
      if (samePage.includes(url) || url === 'app://shell@opendoc/api/session') continue;
      expect([403, 404, 'blocked'], `${url} -> ${JSON.stringify(answer)}`).toContain(answer.status);
      expect(answer.text ?? '', url).not.toMatch(/export |import |require\(|root:/);
    }
    expect(answers['app://shell.evil/picker.html'].status).not.toBe(200);
    expect(answers['app://opendoc.evil/api/session'].status).not.toBe(200);
    expect(answers['app://shell@opendoc/api/session'].status).not.toBe(500); // credentials in the address do not make a different host
  });

  test('a download in flight when the host is killed never ends as a short file that looks whole, the host comes back and the same file downloads whole', async () => {
    // Chromium takes a response from the main process far ahead of a slow page (a fast host has often sent all of 12 MB by the time the page
    // has read a chunk), so the kill may land before or after the last byte. Either is fine; a clean end of a short file is not.
    const url = fileRoute(big, 'original');
    const whole = await run(async address => { const response = await fetch(address); return (await response.arrayBuffer()).byteLength; }, url);
    expect(whole).toBeGreaterThan(11 * 1024 * 1024);
    await run(address => {
      window.__dlBytes = 0;
      window.__dl = (async () => {
        const reader = (await fetch(address)).body.getReader();
        try { for (;;) { const { done, value } = await reader.read(); if (done) return { done: true, bytes: window.__dlBytes }; window.__dlBytes += value.length; await new Promise(accept => setTimeout(accept, 150)); } }
        catch (error) { return { error: String(error), bytes: window.__dlBytes }; }
      })();
    }, url);
    await waitFor(() => run(() => window.__dlBytes > 0), { timeout: 60_000, what: 'the download to be under way' });
    const before = hostPid(app);
    process.kill(before, 'SIGKILL');
    const ended = await run(() => Promise.race([window.__dl, new Promise(accept => setTimeout(accept, 60_000, { hung: true }))]));
    expect(ended.hung).toBeUndefined();
    if (ended.done) expect(ended.bytes, JSON.stringify(ended)).toBe(whole);
    else expect(ended.error, JSON.stringify(ended)).toBeDefined();
    const after = await nextHostPid(app, before);
    expect(after).not.toBe(before);
    await waitFor(async () => (await states()).includes('running'), { timeout: 120_000, what: 'the running state' });
    expect(await run(() => window.__marker)).toBe('same page');
    const again = await run(async address => { const response = await fetch(address); return { status: response.status, bytes: (await response.arrayBuffer()).byteLength }; }, url);
    expect(again).toEqual({ status: 200, bytes: whole });
  });

  test('an upload in flight when the host is killed fails cleanly, and the next upload works against the new host', async () => {
    await waitFor(async () => (await states()).at(-1) === 'running', { timeout: 120_000, what: 'a running host' });
    const before = hostPid(app);
    await run(async () => { window.__token = await window.__t.token(); window.__blob = await window.__t.png(1500); }); // the token and the file first: the upload itself is what is in flight
    process.kill(before, 'SIGSTOP'); // the service reads nothing, so the upload stops at the window
    const started = run(() => window.__t.upload('Killed upload', window.__blob, 'killed.png'));
    await new Promise(accept => setTimeout(accept, 1500));
    process.kill(before, 'SIGKILL');
    const result = await Promise.race([started, new Promise(accept => setTimeout(accept, 60_000, { hung: true }))]);
    expect(result.hung).toBeUndefined();
    expect(result.error !== undefined || result.status >= 500, JSON.stringify(result)).toBe(true);
    const after = await nextHostPid(app, before);
    await waitFor(async () => (await states()).at(-1) === 'running', { timeout: 120_000, what: 'the running state' });
    await run(() => { window.__token = undefined; }); // the new host has a new token
    const next = await run(async () => window.__t.upload('Upload after the kill', new Blob(['<svg xmlns="http://www.w3.org/2000/svg" width="8" height="8"><rect width="8" height="8"/></svg>'], { type: 'image/svg+xml' }), 'after.svg'));
    expect(next.status).toBe(201);
    const list = await run(async () => (await (await fetch('/api/assets?kind=logo')).json()).items.map(item => item.name));
    expect(list).not.toContain('Killed upload');
    expect(processAlive(after)).toBe(true);
  });

  test('an upload the page cancels midway ends for the page at once, and the host keeps serving', async () => {
    // Electron 45 does not tell a protocol handler that the page cancelled a request (request.signal never fires), and by then it
    // has handed over the whole body, so a cancelled upload is finished by the service like any other whole request (a browser's
    // server does the same). What the page and the host must show is no hang, no leftover and no restart.
    await waitFor(async () => (await states()).at(-1) === 'running', { timeout: 120_000, what: 'a running host' });
    const host = hostPid(app);
    const restarts = (await states()).length;
    await run(async () => { window.__token = await window.__t.token(); window.__blob = await window.__t.png(1500); }); // made before the host is stopped: the health check (700 ms here) would replace a host that stays stopped for about two seconds
    process.kill(host, 'SIGSTOP');
    try {
      const outcome = await run(async () => {
        const controller = new AbortController();
        const pending = window.__t.upload('Cancelled upload', window.__blob, 'cancelled.png', controller.signal);
        await new Promise(accept => setTimeout(accept, 500));
        controller.abort();
        return Promise.race([pending, new Promise(accept => setTimeout(accept, 5000, { hung: true }))]);
      });
      expect(outcome.hung).toBeUndefined();
      expect(outcome.error, app.output.join('').slice(-800)).toMatch(/AbortError/);
    } finally { try { process.kill(host, 'SIGCONT'); } catch { /* replaced meanwhile */ } }
    await new Promise(accept => setTimeout(accept, 2500));
    expect(hostPid(app)).toBe(host);
    expect((await states()).length).toBe(restarts);
    expect(await run(() => fetch('/api/session').then(response => response.ok))).toBe(true);
    // The whole request had reached the host, which finished it; the library lists it or not, but it never half-exists.
    const items = await run(async () => (await (await fetch('/api/assets?kind=logo')).json()));
    expect(items.issues ?? []).toEqual([]);
    const next = await run(async () => window.__t.upload('After the cancel', new Blob(['<svg xmlns="http://www.w3.org/2000/svg" width="8" height="8"><rect width="8" height="8"/></svg>'], { type: 'image/svg+xml' }), 'again.svg'));
    expect(next.status).toBe(201);
  });
});

test.describe('quitting or killing the app at any moment leaves nothing', () => {
  test.describe.configure({ timeout: 300_000 });
  test.afterEach(() => { killElectronProcesses(); });

  const lockFile = workspace => join(workspace, '.opendoc', 'update.lock');
  const launchRaw = async name => {
    const workspace = await newWorkspace(name);
    const profile = await newProfile(`${name}-profile`, { defaultWorkspace: workspace });
    const child = spawnApp({ profile });
    child.stdout.resume(); child.stderr.resume();
    return { workspace, profile, child };
  };

  test('kill -9 of the main process while the service host is still starting leaves no process', async () => {
    const { child } = await launchRaw('kill9-start');
    const host = await waitFor(() => serviceHostOf(child.pid), { timeout: 120_000, interval: 10, what: 'the service host to be spawned' });
    child.kill('SIGKILL');
    expect(await waitForNoElectron(5000)).toEqual([]);
    await waitFor(() => !processAlive(host), { timeout: 5000, what: 'the starting host to be gone' });
  });

  test('kill -9 of the main process while the workspace is opening leaves no process, and the lock it held is the one stale lock the next launch reports', async () => {
    const { workspace, child } = await launchRaw('kill9-open');
    await waitFor(() => exists(lockFile(workspace)), { timeout: 120_000, interval: 10, what: 'the open workspace lock' });
    child.kill('SIGKILL');
    expect(await waitForNoElectron(5000)).toEqual([]);
    // By design (C3) a stale lock is never cleared on its own; the app offers "Clear stale lock" after confirming the owner is gone.
    expect(await exists(lockFile(workspace))).toBe(true);
    expect(JSON.parse(await readFile(lockFile(workspace), 'utf8')).pid).toBe(child.pid);
    expect(processAlive(child.pid)).toBe(false);
  });

  test('quitting (SIGTERM) while the workspace is opening stops the start, releases the lock and leaves nothing', async () => {
    const { workspace, child } = await launchRaw('quit-open');
    await waitFor(() => exists(lockFile(workspace)), { timeout: 120_000, interval: 10, what: 'the open workspace lock' });
    child.kill('SIGTERM');
    expect(await waitForExit(child, 30_000)).toBe(true);
    expect(await waitForNoElectron(5000)).toEqual([]);
    expect(await exists(lockFile(workspace))).toBe(false); // released, not left stale
    expect(await exists(join(workspace, '.opendoc', 'desktop.json'))).toBe(false);
  });

  test('kill -9 of the main process while the service host is stopped (SIGSTOP) leaves no process', async () => {
    const { workspace, child } = await launchRaw('kill9-stopped');
    const host = await waitFor(() => serviceHostOf(child.pid), { timeout: 120_000, what: 'the service host' });
    await waitFor(async () => (await exists(join(workspace, '.opendoc', 'desktop.json'))) && !(await exists(lockFile(workspace))), { timeout: 120_000, what: 'the workspace to be open' });
    expect((await desktopRecord(workspace)).pid).toBe(child.pid);
    process.kill(host, 'SIGSTOP');
    child.kill('SIGKILL');
    const left = await waitForNoElectron(6000);
    expect(left, JSON.stringify(left)).toEqual([]);
    expect(processAlive(host)).toBe(false);
    expect(electronProcesses()).toEqual([]);
  });
});
