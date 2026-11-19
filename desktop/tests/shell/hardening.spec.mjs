// Window hardening (plan E1 step 2): isolation, sandbox, no Node in the renderer, content security policy,
// navigation locked to the app's origin, new windows denied, permissions denied, links through the system browser,
// no file:// pages and no cookies.
import { expect, test } from '@playwright/test';
import { launchApp, nativeCalls, newProfile, newWorkspace, stubNative } from './support/app.mjs';
import { libraryReady, waitFor } from './support/helpers.mjs';

test.describe.serial('hardening', () => {
  let app; let page; let origin;

  test.beforeAll(async () => {
    const workspace = await newWorkspace('hardening');
    app = await launchApp({ profile: await newProfile('hardening-profile', { defaultWorkspace: workspace }) });
    await stubNative(app);
    page = await app.firstWindow();
    await libraryReady(page);
    origin = 'app://opendoc';
  });

  test.afterAll(async () => { await app?.close().catch(() => {}); });

  test('every window is isolated, sandboxed and has no Node', async () => {
    const preferences = await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().map(window => window.webContents.getLastWebPreferences()));
    expect(preferences.length).toBeGreaterThan(0);
    for (const item of preferences) {
      expect(item).toMatchObject({ contextIsolation: true, sandbox: true, nodeIntegration: false, webSecurity: true, webviewTag: false, nodeIntegrationInWorker: false, nodeIntegrationInSubFrames: false, allowRunningInsecureContent: false });
    }
    const exposed = await page.evaluate(() => ({ require: typeof require, process: typeof process, module: typeof module, buffer: typeof Buffer, shell: typeof window.opendocShell }));
    expect(exposed).toEqual({ require: 'undefined', process: 'undefined', module: 'undefined', buffer: 'undefined', shell: 'undefined' });
  });

  test('the workspace page gets the two bridge functions, and nothing else of the shell', async () => {
    const bridge = await page.evaluate(() => ({ keys: Object.keys(window.opendocDesktop ?? {}).sort(), types: Object.values(window.opendocDesktop ?? {}).map(item => typeof item) }));
    expect(bridge).toEqual({ keys: ['onChange', 'onHostState'], types: ['function', 'function'] });
    // Each subscription returns the function that stops it.
    expect(await page.evaluate(() => [window.opendocDesktop.onChange(() => {}), window.opendocDesktop.onHostState(() => {})].map(item => typeof item))).toEqual(['function', 'function']);
    // A page that is not the workspace (a window the page opens, an iframe, the app's own pages) has no bridge.
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
  });

  test('the content security policy is set and blocks inline script, eval and other origins', async () => {
    const policy = await page.evaluate(async () => (await fetch('/')).headers.get('content-security-policy'));
    expect(policy).toContain("default-src 'none'");
    expect(policy).toContain("connect-src 'self'; ");
    expect(policy).not.toMatch(/wss?:/);
    expect(policy).not.toContain("'unsafe-eval'");
    const result = await page.evaluate(async () => {
      const script = document.createElement('script');
      script.textContent = 'window.__inline = 1';
      document.head.append(script);
      const external = document.createElement('script');
      external.src = 'data:text/javascript,window.__data = 1';
      document.head.append(external);
      await new Promise(accept => setTimeout(accept, 300));
      const attempt = async url => fetch(url).then(() => 'reached', () => 'blocked');
      return { inline: window.__inline ?? null, dataScript: window.__data ?? null, remote: await attempt('https://example.com/'), file: await attempt('file:///etc/hostname'), otherHost: await attempt('app://elsewhere/api/session'), otherPort: await attempt('http://127.0.0.1:9/'), socket: await new Promise(accept => { try { const socket = new WebSocket('ws://127.0.0.1:9/api/events'); socket.onerror = () => accept('blocked'); socket.onopen = () => accept('reached'); } catch { accept('blocked'); } }) };
    });
    expect(result).toEqual({ inline: null, dataScript: null, remote: 'blocked', file: 'blocked', otherHost: 'blocked', otherPort: 'blocked', socket: 'blocked' });
  });

  test('the app itself runs without a single policy violation', async () => {
    app.consoleProblems.length = 0; // The previous test provoked violations on purpose.
    await page.getByText('Welcome to OpenDoc').first().click();
    await page.waitForSelector('canvas', { state: 'attached' });
    await expect.poll(() => page.evaluate(() => [...document.querySelectorAll('canvas')].filter(canvas => canvas.width > 0).length), { timeout: 120_000 }).toBeGreaterThan(0);
    expect(app.consoleProblems.filter(line => /Content Security Policy|Refused to|violat/i.test(line))).toEqual([]);
    await page.evaluate(() => { location.hash = '#library'; });
  });

  test('navigation cannot leave the app: web links go to the system browser, everything else is dropped', async () => {
    const before = page.url();
    await page.evaluate(() => { location.href = 'https://example.com/landing'; });
    await waitFor(async () => (await nativeCalls(app)).external.includes('https://example.com/landing'), { what: 'the external link' });
    await page.evaluate(() => { location.href = 'file:///etc/hostname'; });
    await page.evaluate(() => { location.href = 'data:text/html,<p>x</p>'; });
    await page.evaluate(() => { location.href = 'javascript:void(0)'; });
    await new Promise(accept => setTimeout(accept, 800));
    expect(page.url()).toBe(before);
    expect((await nativeCalls(app)).external).toEqual(['https://example.com/landing']);
  });

  test('new windows are denied; web links open in the system browser; the app opens no file:// page', async () => {
    const windows = app.windows().length;
    const results = await page.evaluate(() => ({ web: window.open('https://example.org/x') === null, local: window.open('/') === null, file: window.open('file:///etc/hostname') === null }));
    expect(results).toEqual({ web: true, local: true, file: true });
    await waitFor(async () => (await nativeCalls(app)).external.includes('https://example.org/x'), { what: 'the external link' });
    expect(app.windows().length).toBe(windows);
    const urls = await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().map(window => window.webContents.getURL()));
    expect(urls.filter(url => url.startsWith('file:'))).toEqual([]);
  });

  test('permission requests are denied, except copying text after a click', async () => {
    const outcomes = await page.evaluate(async () => {
      const position = await new Promise(accept => navigator.geolocation.getCurrentPosition(() => accept('granted'), error => accept(`denied:${error.code}`), { timeout: 5000 }));
      return { notifications: await Notification.requestPermission(), position };
    });
    expect(outcomes.notifications).not.toBe('granted');
    expect(outcomes.position).toBe('denied:1');
    const states = await page.evaluate(async () => Object.fromEntries(await Promise.all(['geolocation', 'notifications', 'midi', 'camera', 'microphone', 'clipboard-read'].map(async name => [name, await navigator.permissions.query({ name }).then(result => result.state, () => 'unsupported')]))));
    for (const [name, state] of Object.entries(states)) expect([name, state]).not.toEqual([name, 'granted']);
    // Copying a prompt to the clipboard (a button the user clicks) keeps working.
    await page.mouse.click(400, 400);
    const copied = await page.evaluate(() => navigator.clipboard.writeText('opendoc-desktop clipboard check').then(() => 'copied', error => error.name));
    expect(copied).toBe('copied');
    expect(await app.evaluate(({ clipboard }) => clipboard.readText())).toBe('opendoc-desktop clipboard check');
  });

  test('no cookies are stored, and the session has its own per-workspace partition', async () => {
    expect(await page.evaluate(() => document.cookie)).toBe('');
    const state = await app.evaluate(async ({ BrowserWindow }) => {
      const contents = BrowserWindow.getAllWindows()[0].webContents;
      return { cookies: (await contents.session.cookies.get({})).length, path: contents.session.storagePath };
    });
    expect(state.cookies).toBe(0);
    expect(state.path).toMatch(/Partitions\/ws-[0-9a-f]{16}$/);
  });

  test('the service answers only the app: changes the page did not make, and other hosts, are refused', async () => {
    // Requests made from the main process carry no page origin, like any other program on the machine.
    const answers = await app.evaluate(async ({ BrowserWindow }, base) => {
      const session = BrowserWindow.getAllWindows()[0].webContents.session;
      const status = async (url, init) => { try { return (await session.fetch(url, init)).status; } catch (error) { return `blocked: ${error.message}`; } };
      return {
        read: await status(`${base}/api/session`),
        change: await status(`${base}/api/documents`, { method: 'POST', body: '{}' }),
        otherHost: await status('http://127.0.0.1:9/api/session'),
        otherAppHost: await status('app://elsewhere/api/session'),
      };
    }, origin);
    expect(answers.read).toBe(200);
    expect(answers.change).toMatch(/^blocked/);
    expect(answers.otherHost).toMatch(/^blocked/);
    expect(answers.otherAppHost).toMatch(/^blocked/);
    // The page itself can still change things (saving a comment is covered by the workspace flow).
    expect(await page.evaluate(async () => (await fetch('/api/context', { method: 'POST', headers: { 'content-type': 'application/json', 'x-opendoc-token': (await (await fetch('/api/session')).json()).token }, body: JSON.stringify({ documentId: 'welcome', blockId: null, page: 1, selection: null, editing: false, pendingEdits: 0, draftPreview: false }) })).status)).toBeLessThan(500);
  });
});
