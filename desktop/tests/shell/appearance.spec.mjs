// The workspace page's own boot script (inline in index.html) applies the saved appearance before the first paint. The desktop
// content security policy names that script by its hash, so it runs, and nothing is reported as a violation.
import { expect, test } from '@playwright/test';
import { launchApp, newProfile, newWorkspace, stubNative } from './support/app.mjs';
import { isWorkspaceUrl, libraryReady, waitFor, waitForOpen } from './support/helpers.mjs';

const workspacePage = app => app.windows().find(page => isWorkspaceUrl(page.url()));
const violations = app => app.consoleProblems.filter(line => /Content Security Policy|Refused to|violat/i.test(line));

test.describe.serial('the saved appearance is applied by the page\'s boot script', () => {
  let app; let page;

  test.beforeAll(async () => {
    const workspace = await newWorkspace('appearance');
    const profile = await newProfile('appearance-profile', { defaultWorkspace: workspace });
    app = await launchApp({ profile });
    await stubNative(app, {});
    await waitFor(() => workspacePage(app), { timeout: 120_000, what: 'the workspace page' });
    page = workspacePage(app);
    await waitForOpen(workspace);
    await libraryReady(page);
  });

  test.afterAll(async () => { await app?.close().catch(() => {}); });

  test('a page load runs without any policy violation', async () => {
    expect(violations(app)).toEqual([]);
  });

  test('a saved dark appearance is set before the app starts, and without a violation', async () => {
    // Record the first time data-appearance is written, and whether the app (React) had drawn anything yet. Only the inline
    // script in <head> can write it while #root is still empty.
    await page.addInitScript(() => {
      const seen = [];
      window.__appearance = seen;
      new MutationObserver(() => {
        const root = document.getElementById('root');
        seen.push({ value: document.documentElement.dataset.appearance, colorScheme: document.documentElement.style.colorScheme, themeColor: document.querySelector('meta[name="theme-color"]')?.content, drawn: Boolean(root?.childElementCount) });
      }).observe(document, { subtree: true, attributes: true, attributeFilter: ['data-appearance'] }); // The root element does not exist yet when this runs.
    });
    await page.evaluate(() => localStorage.setItem('opendoc-appearance', 'dark'));
    app.consoleProblems.length = 0;
    await page.reload();
    await libraryReady(page);
    const seen = await page.evaluate(() => window.__appearance);
    expect(seen.length).toBeGreaterThan(0);
    expect(seen[0]).toEqual({ value: 'dark', colorScheme: 'dark', themeColor: '#181818', drawn: false });
    expect(await page.evaluate(() => document.documentElement.dataset.appearance)).toBe('dark');
    expect(violations(app)).toEqual([]);
  });

  test('a saved light appearance is applied the same way', async () => {
    await page.evaluate(() => localStorage.setItem('opendoc-appearance', 'light'));
    app.consoleProblems.length = 0;
    await page.reload();
    await libraryReady(page);
    const seen = await page.evaluate(() => window.__appearance);
    expect(seen[0]).toEqual({ value: 'light', colorScheme: 'light', themeColor: '#f8f8f8', drawn: false });
    expect(violations(app)).toEqual([]);
    await page.evaluate(() => localStorage.removeItem('opendoc-appearance'));
  });

  test('the page still cannot run any other inline script', async () => {
    const ran = await page.evaluate(async () => {
      const script = document.createElement('script');
      script.textContent = 'window.__other = 1';
      document.head.append(script);
      await new Promise(accept => setTimeout(accept, 300));
      return window.__other ?? null;
    });
    expect(ran).toBeNull();
  });
});
