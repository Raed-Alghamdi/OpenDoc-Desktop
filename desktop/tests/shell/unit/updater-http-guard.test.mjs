// Redirects the updater may follow: https always (a release host may send a download to another https host), plain http only to the
// loopback address and only when the feed itself is on it. Both the rule and the wrapper that applies it to electron-updater's executor.
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { createRequire } from 'node:module';
import { test } from 'node:test';
import { guardRedirects, guardSession, redirectVerdict } from '../../../src/main/updater/http-guard.mjs';

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

// ---------- createRequest: the differential download makes its requests directly ----------

/** A base class shaped like the executor's createRequest: it returns a request that records what it was asked and whether it was followed. */
class RequestBase {
  createRequest(options, callback) {
    const request = Object.assign(new EventEmitter(), { options, callback, aborted: 0, followed: 0, abort() { this.aborted++; }, followRedirect() { this.followed++; } });
    (RequestBase.made ??= []).push(request);
    return request;
  }
}

const redirectOf = (request, target) => request.emit('redirect', 302, 'GET', target, {});

test('createRequest: every request is made with redirect "manual", whatever the caller asked for', () => {
  const Guarded = guardRedirects(RequestBase);
  const request = new Guarded().createRequest({ headers: { range: 'bytes=0-9' } }, () => {});
  assert.equal(request.options.redirect, 'manual');
  assert.deepEqual(request.options.headers, { range: 'bytes=0-9' });
  assert.equal(new Guarded().createRequest({ redirect: 'follow' }, () => {}).options.redirect, 'manual');
});

test('createRequest, the single-range path (a caller that follows redirects itself): an allowed redirect is followed, a refused one is aborted, errors, and its listener never runs', () => {
  const lines = [];
  const Guarded = guardRedirects(RequestBase, { log: line => lines.push(line) });
  // What DifferentialDownloader does: request.on('redirect', ...) then request.followRedirect().
  const make = () => {
    const request = new Guarded().createRequest({}, () => {});
    const called = [];
    const errors = [];
    request.on('error', error => errors.push(error));
    request.on('redirect', (code, method, url) => { called.push(url); request.followRedirect(); });
    return { request, called, errors };
  };
  const good = make();
  redirectOf(good.request, 'https://objects.githubusercontent.com/f');
  assert.deepEqual(good.called, ['https://objects.githubusercontent.com/f']);
  assert.equal(good.request.followed, 1);
  assert.equal(good.request.aborted, 0);

  const bad = make();
  redirectOf(bad.request, 'http://example.org/payload');
  assert.deepEqual(bad.called, [], 'the caller\'s listener is not called');
  assert.equal(bad.request.followed, 0, 'followRedirect was never reached');
  assert.equal(bad.request.aborted, 1);
  assert.equal(bad.errors.length, 1);
  assert.match(bad.errors[0].message, /not https/);
  assert.match(lines.at(-1), /refused a redirect/);
});

test('createRequest, a caller that adds no redirect listener (multi-range and block map requests): an allowed redirect is followed here, a refused one fails', () => {
  const Guarded = guardRedirects(RequestBase);
  const good = new Guarded().createRequest({}, () => {});
  good.on('error', () => assert.fail('no error'));
  redirectOf(good, 'https://cdn.example.org/f');
  assert.equal(good.followed, 1);
  const bad = new Guarded().createRequest({}, () => {});
  const errors = [];
  bad.on('error', error => errors.push(error));
  redirectOf(bad, 'http://example.org/f');
  assert.equal(bad.followed, 0);
  assert.equal(bad.aborted, 1);
  assert.equal(errors.length, 1);
});

test('createRequest: a listener that follows after the fact is stopped too (followRedirect itself checks), and once() is wrapped', () => {
  const Guarded = guardRedirects(RequestBase);
  const request = new Guarded().createRequest({}, () => {});
  request.on('error', () => {});
  let later = null;
  request.once('redirect', () => { later = () => request.followRedirect(); });
  redirectOf(request, 'file:///etc/passwd');
  assert.equal(later, null, 'the listener did not run');
  request.followRedirect();
  assert.equal(request.followed, 0);
});

test('createRequest: loopback http is followed for a loopback feed only', () => {
  let loopback = true;
  const Guarded = guardRedirects(RequestBase, { loopbackFeed: () => loopback });
  const a = new Guarded().createRequest({}, () => {});
  redirectOf(a, 'http://127.0.0.1:9/f');
  assert.equal(a.followed, 1);
  loopback = false;
  const b = new Guarded().createRequest({}, () => {});
  b.on('error', () => {});
  redirectOf(b, 'http://127.0.0.1:9/f');
  assert.equal(b.followed, 0);
  assert.equal(b.aborted, 1);
});

test('createRequest on electron-updater\'s real executor class passes the options through with redirect "manual"', () => {
  const { ElectronHttpExecutor } = require('electron-updater/out/electronHttpExecutor');
  let seen = null;
  const Real = class extends ElectronHttpExecutor { createRequest(options, callback) { seen = options; return super.createRequest(options, callback); } };
  // super.createRequest needs Electron's net, which plain Node does not have: the options are what matters here.
  const Guarded = guardRedirects(Real);
  assert.throws(() => new Guarded().createRequest({ protocol: 'https:', hostname: 'a.example', path: '/x', headers: {} }, () => {}));
  assert.equal(seen.redirect, 'manual');
});

// ---------- the catch-all on the session ----------

test('the session catch-all cancels what the rule refuses and lets the rest through; a second call replaces the first', () => {
  const handlers = [];
  const session = { webRequest: { onBeforeRequest: (filter, handler) => handlers.push({ filter, handler }) } };
  const lines = [];
  let loopback = false;
  guardSession(session, { loopbackFeed: () => loopback, log: line => lines.push(line) });
  assert.deepEqual(handlers[0].filter, { urls: ['<all_urls>'] });
  const ask = url => { let answer; handlers[0].handler({ url }, value => { answer = value; }); return answer; };
  assert.deepEqual(ask('https://github.com/a/b/releases/download/t/f'), { cancel: false });
  assert.deepEqual(ask('http://example.org/f'), { cancel: true });
  assert.deepEqual(ask('http://127.0.0.1:9/f'), { cancel: true }, 'loopback http only for a loopback feed');
  assert.deepEqual(ask('file:///etc/passwd'), { cancel: true });
  assert.deepEqual(ask('ftp://example.org/f'), { cancel: true });
  loopback = true;
  assert.deepEqual(ask('http://127.0.0.1:9/f'), { cancel: false });
  assert.deepEqual(ask('http://example.org/f'), { cancel: true });
  assert.equal(lines.filter(line => /blocked a request/.test(line)).length, 5);
});
