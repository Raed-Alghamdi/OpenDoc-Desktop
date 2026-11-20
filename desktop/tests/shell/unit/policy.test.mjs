import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { classifyNavigation, classifyWindowOpen, contentSecurityPolicy, crossOriginMutation, inlineScriptHashes, isIndexPage, originOf, permissionAllowed, requestAllowed } from '../../../src/main/policy.mjs';
import { repo, runtimeDir } from '../support/paths.mjs';

const origin = 'app://opendoc';

test('the origin of an app address is app://host (URL.origin says null for it)', () => {
  assert.equal(originOf('app://opendoc/api/session?x=1'), 'app://opendoc');
  assert.equal(originOf('app://shell/picker.html'), 'app://shell');
  assert.equal(originOf('https://example.com:8443/a'), 'https://example.com:8443');
  assert.equal(originOf('not a url'), '');
});

test('navigation stays on the app origin; web links go out; everything else is refused', () => {
  assert.equal(classifyNavigation(`${origin}/#library`, [origin]), 'allow');
  assert.equal(classifyNavigation('app://shell/picker.html', [origin], 'app://shell/picker.html'), 'allow'); // shell pages link to each other
  assert.equal(classifyNavigation('https://example.com/', [origin]), 'external');
  assert.equal(classifyNavigation('mailto:someone@example.com', [origin]), 'external');
  assert.equal(classifyNavigation('http://127.0.0.1:9999/', [origin]), 'external');
  assert.equal(classifyNavigation('app://opendoc/', []), 'deny'); // no workspace is open
  for (const url of ['file:///etc/passwd', 'javascript:alert(1)', 'data:text/html,hi', 'app://other/x', 'not a url', 'ftp://example.com/']) assert.equal(classifyNavigation(url, [origin]), 'deny', url);
});

test('the shell\'s own pages cannot be navigated to from the OpenDoc page, a file window or a blank page', () => {
  for (const from of [`${origin}/`, `${origin}/#library`, `${origin}/api/exports/x/open`, 'about:blank', '', 'https://example.com/', 'app://other/x']) {
    assert.equal(classifyNavigation('app://shell/picker.html', [origin], from), 'deny', `from ${from || '(none)'}`);
    assert.equal(classifyNavigation('app://shell/crash.html', [origin], from), 'deny');
    assert.equal(classifyNavigation('APP://SHELL/picker.html', [origin], from), 'deny');
  }
  assert.equal(classifyNavigation('app://shell/picker.html', [origin]), 'deny'); // no page given: refused
  assert.equal(classifyNavigation(`${origin}/#library`, [origin], `${origin}/`), 'allow'); // the page's own navigation is unchanged
});

test('window.open: only files the service serves open in an app window', () => {
  assert.equal(classifyWindowOpen(`${origin}/api/exports/abc-123/open`, origin), 'file-window');
  assert.equal(classifyWindowOpen(`${origin}/api/documents/welcome/pdf?hash=x`, origin), 'file-window');
  assert.equal(classifyWindowOpen(`${origin}/`, origin), 'deny');
  assert.equal(classifyWindowOpen(`${origin}/#document/x`, origin), 'deny');
  assert.equal(classifyWindowOpen('https://github.com/RyanYahya/OpenDoc', origin), 'external');
  assert.equal(classifyWindowOpen('file:///etc/passwd', origin), 'deny');
  assert.equal(classifyWindowOpen('javascript:1', origin), 'deny');
});

test('requests: the origin, the app pages and inline data only', () => {
  assert.equal(requestAllowed(`${origin}/api/session`, [origin]), true);
  assert.equal(requestAllowed('ws://127.0.0.1:4310/api/events', [origin]), false); // nothing listens, nothing is reachable
  assert.equal(requestAllowed('http://127.0.0.1:4310/api/session', [origin]), false);
  assert.equal(requestAllowed('app://shell/picker.js', [origin]), true);
  assert.equal(requestAllowed('app://elsewhere/x', [origin]), false);
  assert.equal(requestAllowed('https://example.com/x.png', [origin]), false);
  assert.equal(requestAllowed('file:///etc/hostname', [origin]), false);
  assert.equal(requestAllowed('data:image/png;base64,AAAA', [origin]), true);
  assert.equal(requestAllowed(`${origin}/api/session`, []), false);
});

test('the content security policy names only the page\'s own address', () => {
  const policy = contentSecurityPolicy();
  assert.match(policy, /default-src 'none'/);
  assert.match(policy, /connect-src 'self'(;|$)/);
  assert.doesNotMatch(policy, /wss?:/);
  assert.match(policy, /object-src 'none'/);
  assert.match(policy, /frame-ancestors 'none'/);
  assert.doesNotMatch(policy, /'unsafe-eval'/);
  assert.doesNotMatch(policy, /https?:/);
});

/** Every inline <script>...</script> of a page, found without the code under test (the pages here use the bare tag). */
const inlineScripts = html => html.split('<script>').slice(1).map(part => part.slice(0, part.indexOf('</script>')));
const sourceOf = text => `'sha256-${createHash('sha256').update(text, 'utf8').digest('base64')}'`;
const scriptSrc = policy => policy.split('; ').find(part => part.startsWith('script-src ')).split(' ');

test('the policy carries the hash of every inline script in the index.html the service serves, and never unsafe-inline', () => {
  // The source page, and the built page of the package the tests run against when there is one (the one a workspace serves).
  const pages = [join(repo, 'index.html'), join(runtimeDir, 'node_modules', 'opendoc', 'dist', 'index.html'), join(repo, 'dist', 'index.html')].filter(existsSync);
  assert.ok(pages.length >= 1);
  for (const file of pages) {
    const html = readFileSync(file, 'utf8');
    const scripts = inlineScripts(html);
    assert.ok(scripts.length >= 1, `${file} has an inline script`);
    const hashes = inlineScriptHashes(html);
    assert.deepEqual(hashes.sort(), [...new Set(scripts.map(sourceOf))].sort(), file);
    const sources = scriptSrc(contentSecurityPolicy({ scriptHashes: hashes }));
    for (const text of scripts) assert.ok(sources.includes(sourceOf(text)), `${file}: ${sourceOf(text)}`);
    assert.ok(sources.includes("'self'"));
    assert.ok(!sources.includes("'unsafe-inline'"));
  }
});

test('the hashes follow the page: another script gives another hash, scripts with a src and empty ones give none', () => {
  const one = '<head><script>window.a = 1;</script></head>';
  const other = '<head><script>window.a = 2;</script></head>';
  assert.equal(inlineScriptHashes(one).length, 1);
  assert.notDeepEqual(inlineScriptHashes(one), inlineScriptHashes(other));
  assert.deepEqual(inlineScriptHashes('<script type="module" crossorigin src="/assets/index.js"></script><script src=/x.js></script><script></script>'), []);
  assert.deepEqual(inlineScriptHashes(`${one}${one}`), inlineScriptHashes(one));
  assert.equal(inlineScriptHashes('<SCRIPT type="module">import "/x";</SCRIPT>').length, 1);
  // Without the page's scripts the policy is as strict as before.
  assert.deepEqual(scriptSrc(contentSecurityPolicy()), ['script-src', "'self'", "'wasm-unsafe-eval'"]);
  assert.deepEqual(scriptSrc(contentSecurityPolicy({ scriptHashes: inlineScriptHashes(one) })).slice(0, 3), ['script-src', "'self'", "'wasm-unsafe-eval'"]);
});

test('only the start page is looked at for inline scripts', () => {
  assert.equal(isIndexPage('app://opendoc/'), true);
  assert.equal(isIndexPage('app://opendoc'), true);
  assert.equal(isIndexPage('app://opendoc/index.html'), true);
  assert.equal(isIndexPage('app://opendoc/index.html?x=1#y'), true);
  for (const path of ['/assets/index.js', '/api/documents', '/other.html', '/assets/index.html', '/api/files/index.html']) assert.equal(isIndexPage(`app://opendoc${path}`), false, path);
});

test('only a click-to-copy write is a permission the app grants', () => {
  assert.equal(permissionAllowed('clipboard-sanitized-write'), true);
  for (const name of ['geolocation', 'notifications', 'media', 'clipboard-read', 'midi', 'openExternal', 'fullscreen']) assert.equal(permissionAllowed(name), false, name);
});

test('a request that changes something is refused unless the app\'s own page made it', () => {
  const origins = [origin];
  const request = (method, path, initiatorOrigin) => ({ method, url: `${origin}${path}`, initiatorOrigin });
  assert.equal(crossOriginMutation(request('GET', '/api/session'), origins), false);
  assert.equal(crossOriginMutation(request('POST', '/api/documents', origin), origins), false);
  assert.equal(crossOriginMutation(request('POST', '/api/documents'), origins), true); // made by the main process or a worker
  assert.equal(crossOriginMutation(request('POST', '/api/documents', 'https://example.com'), origins), true);
  assert.equal(crossOriginMutation(request('DELETE', '/api/comments/1', 'app://shell'), origins), true);
  assert.equal(crossOriginMutation(request('PUT', '/api/comments/1', 'null'), origins), true);
  assert.equal(crossOriginMutation(request('POST', '/index.html'), origins), false);
});
