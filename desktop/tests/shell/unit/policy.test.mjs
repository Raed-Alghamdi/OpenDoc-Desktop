import assert from 'node:assert/strict';
import { test } from 'node:test';
import { classifyNavigation, classifyWindowOpen, contentSecurityPolicy, crossOriginMutation, permissionAllowed, requestAllowed, revealRequest } from '../../../src/main/policy.mjs';

const origin = 'http://127.0.0.1:4310';

test('navigation stays on the app origin; web links go out; everything else is refused', () => {
  assert.equal(classifyNavigation(`${origin}/#library`, [origin]), 'allow');
  assert.equal(classifyNavigation('app://shell/picker.html', [origin]), 'allow');
  assert.equal(classifyNavigation('https://example.com/', [origin]), 'external');
  assert.equal(classifyNavigation('mailto:someone@example.com', [origin]), 'external');
  assert.equal(classifyNavigation('http://127.0.0.1:9999/', [origin]), 'external');
  for (const url of ['file:///etc/passwd', 'javascript:alert(1)', 'data:text/html,hi', 'app://other/x', 'not a url', 'ftp://example.com/']) assert.equal(classifyNavigation(url, [origin]), 'deny', url);
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
  assert.equal(requestAllowed('ws://127.0.0.1:4310/api/events', [origin]), true);
  assert.equal(requestAllowed('ws://127.0.0.1:4311/api/events', [origin]), false);
  assert.equal(requestAllowed('app://shell/picker.js', [origin]), true);
  assert.equal(requestAllowed('app://elsewhere/x', [origin]), false);
  assert.equal(requestAllowed('https://example.com/x.png', [origin]), false);
  assert.equal(requestAllowed('file:///etc/hostname', [origin]), false);
  assert.equal(requestAllowed('data:image/png;base64,AAAA', [origin]), true);
  assert.equal(requestAllowed(`${origin}/api/session`, []), false);
});

test('the content security policy names only the origin', () => {
  const policy = contentSecurityPolicy(origin);
  assert.match(policy, /default-src 'none'/);
  assert.match(policy, /connect-src 'self' ws:\/\/127\.0\.0\.1:4310/);
  assert.match(policy, /object-src 'none'/);
  assert.match(policy, /frame-ancestors 'none'/);
  assert.doesNotMatch(policy, /'unsafe-eval'/);
  assert.doesNotMatch(policy, /https?:\/\/(?!127)/);
});

test('only a click-to-copy write is a permission the app grants', () => {
  assert.equal(permissionAllowed('clipboard-sanitized-write'), true);
  for (const name of ['geolocation', 'notifications', 'media', 'clipboard-read', 'midi', 'openExternal', 'fullscreen']) assert.equal(permissionAllowed(name), false, name);
});

test('the reveal request is a POST to /api/exports/<id>/reveal on the origin', () => {
  const make = (method, url) => ({ method, url });
  assert.equal(revealRequest(make('POST', `${origin}/api/exports/abc-123/reveal`), origin), 'abc-123');
  assert.equal(revealRequest(make('GET', `${origin}/api/exports/abc-123/reveal`), origin), null);
  assert.equal(revealRequest(make('POST', `${origin}/api/exports/abc-123/copy`), origin), null);
  assert.equal(revealRequest(make('POST', 'http://127.0.0.1:1/api/exports/abc-123/reveal'), origin), null);
  assert.equal(revealRequest(make('POST', `${origin}/api/exports/../../x/reveal`), origin), null);
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
