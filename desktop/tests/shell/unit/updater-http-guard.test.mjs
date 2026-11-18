// Redirects the updater may follow: https always (a release host may send a download to another https host), plain http only to the
// loopback address and only when the feed itself is on it. Both the rule and the wrapper that applies it to electron-updater's executor.
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { createRequire } from 'node:module';
import { test } from 'node:test';
import { guardRedirects, redirectVerdict } from '../../../src/main/updater/http-guard.mjs';

const require = createRequire(import.meta.url);

test('the rule: https always, loopback http only for a loopback feed, nothing else', () => {
  for (const target of ['https://objects.githubusercontent.com/x/y?token=1', 'https://github.com/a/b/releases/download/t/f', 'https://example.org:8443/f']) assert.equal(redirectVerdict(target).ok, true, target);
  for (const target of ['http://127.0.0.1:8099/f', 'http://localhost:8099/f', 'http://[::1]:8099/f']) {
    assert.equal(redirectVerdict(target, { loopbackFeed: true }).ok, true, `${target} from a loopback feed`);
    assert.equal(redirectVerdict(target, { loopbackFeed: false }).ok, false, `${target} from an https feed`);
  }
  for (const target of ['http://example.org/f', 'http://192.168.1.5/f', 'http://127.0.0.1.example.org/f', 'file:///etc/passwd', 'ftp://example.org/f', 'javascript:alert(1)', 'https://user:pass@example.org/f', 'not an address', '']) {
    const verdict = redirectVerdict(target, { loopbackFeed: true });
    assert.equal(verdict.ok, false, target);
    assert.ok(verdict.message.length > 10);
  }
  assert.match(redirectVerdict('http://example.org/f').message, /not https/);
});

/** A base class shaped like electron-updater's HTTP executor: it registers one "redirect" listener and calls `handler` for a followed redirect. */
class Base {
  addRedirectHandlers(request, options, reject, redirectCount, handler) {
    request.on('redirect', (statusCode, method, redirectUrl) => {
      request.abort();
      handler({ redirectedTo: redirectUrl, redirectCount });
    });
  }
}

function attempt(Guarded, target) {
  const request = Object.assign(new EventEmitter(), { aborted: 0, abort() { this.aborted++; } });
  const followed = [];
  const rejected = [];
  new Guarded().addRedirectHandlers(request, {}, error => rejected.push(error), 0, options => followed.push(options));
  request.emit('redirect', 302, 'GET', target);
  return { followed, rejected, request };
}

test('a redirect to https is followed, a redirect to http is refused with an error, and the request is aborted either way', () => {
  const lines = [];
  const Guarded = guardRedirects(Base, { log: line => lines.push(line) });
  const good = attempt(Guarded, 'https://objects.githubusercontent.com/f');
  assert.deepEqual(good.followed, [{ redirectedTo: 'https://objects.githubusercontent.com/f', redirectCount: 0 }]);
  assert.deepEqual(good.rejected, []);
  const bad = attempt(Guarded, 'http://example.org/f');
  assert.deepEqual(bad.followed, [], 'the handler that makes the next request never runs');
  assert.equal(bad.rejected.length, 1);
  assert.match(bad.rejected[0].message, /http:\/\/example\.org.*not https/);
  assert.equal(bad.request.aborted, 1);
  assert.match(lines[0], /refused a redirect/);
});

test('a loopback feed may be redirected to loopback http, an https feed may not', () => {
  let loopback = true;
  const Guarded = guardRedirects(Base, { loopbackFeed: () => loopback });
  assert.equal(attempt(Guarded, 'http://127.0.0.1:9/f').followed.length, 1);
  assert.equal(attempt(Guarded, 'http://example.org/f').followed.length, 0, 'not to a remote http address, even from a loopback feed');
  loopback = false;
  assert.equal(attempt(Guarded, 'http://127.0.0.1:9/f').followed.length, 0);
});

test('the wrapper works on electron-updater\'s real executor (its listener is the one that is guarded)', () => {
  const { ElectronHttpExecutor } = require('electron-updater/out/electronHttpExecutor');
  const Guarded = guardRedirects(ElectronHttpExecutor);
  const bad = attempt(Guarded, 'http://example.org/payload');
  assert.equal(bad.rejected.length, 1);
  assert.equal(bad.request.aborted, 1);
  const good = new Guarded();
  const request = Object.assign(new EventEmitter(), { aborted: 0, abort() { this.aborted++; } });
  const followed = [];
  good.addRedirectHandlers(request, { headers: {}, protocol: 'https:', hostname: 'a.example', path: '/x' }, () => assert.fail('no rejection'), 0, options => followed.push(options));
  request.emit('redirect', 302, 'GET', 'https://b.example/y');
  assert.equal(followed.length, 1);
  assert.equal(followed[0].hostname, 'b.example');
});
