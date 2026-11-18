// Requests and redirects the updater may follow. electron-updater's HTTP executor follows any redirect, https to http included, so a feed (or a
// release host) could send a download to a plain http address. Here a redirect is followed only when it stays on https, with one
// exception: a feed that is itself on the loopback address (tests) may redirect to another loopback http address.
// Three layers, all using the same rule: addRedirectHandlers (metadata, block maps, full downloads), createRequest (every request, for the
// differential download calls it directly and Electron would follow its redirects silently), and a catch-all on the session's
// webRequest that cancels any request or redirect hop that is not allowed. No Electron import: the class and the session come in as arguments.
import { isLoopbackHost } from './feed.mjs';

/** `{ ok: true }` for a redirect target the updater may follow, else `{ ok: false, message }` (the message is the error and the log line). */
export function redirectVerdict(target, { loopbackFeed = false } = {}) {
  let url;
  try { url = new URL(target); } catch { return { ok: false, message: 'The update server sent a redirect to an address that is not a web address, so it was not followed.' }; }
  if (url.username || url.password) return { ok: false, message: `The update server redirected to an address with a user name or password (${url.protocol}//${url.host}), so it was not followed.` };
  if (url.protocol === 'https:') return { ok: true };
  if (url.protocol === 'http:' && loopbackFeed && isLoopbackHost(url.hostname)) return { ok: true };
  return { ok: false, message: `The update server redirected to ${url.protocol}//${url.host}, which is not https, so it was not followed.` };
}

/**
 * A subclass of an electron-updater HTTP executor that refuses unsafe redirects.
 * - addRedirectHandlers(request, options, reject, redirectCount, handler): the metadata requests and full downloads. The base class
 *   uses only request.on(...) and request.abort(), so the "redirect" listener it registers is wrapped with the check.
 * - createRequest(options, callback): every request, including the differential download's ranged requests, which the base class
 *   makes directly. Each is made with redirect "manual", so no redirect is ever followed by Electron itself. A redirect is checked
 *   first; when it is not allowed the request is aborted and fails with an error, and a listener the caller adds for "redirect" is not
 *   called. When the caller adds none (the multi-range and block map requests), an allowed redirect is followed here.
 * @param options.loopbackFeed () => true when the feed address is on the loopback address (read at each redirect)
 * @param options.log (line) => void
 */
export function guardRedirects(Base, { loopbackFeed = () => false, log = () => {} } = {}) {
  return class extends Base {
    createRequest(options, callback) {
      const request = super.createRequest({ ...options, redirect: 'manual' }, callback);
      let last = null;
      const on = request.on.bind(request);
      const once = request.once?.bind(request);
      const follow = request.followRedirect?.bind(request);
      const wrap = register => (event, listener) => {
        if (event !== 'redirect') return register(event, listener);
        return register('redirect', (...args) => { if (last?.ok) listener(...args); });
      };
      request.on = wrap(on);
      if (once) request.once = wrap(once);
      if (follow) request.followRedirect = () => { if (last?.ok) follow(); };
      // Registered first, so it runs before any listener the caller adds.
      on('redirect', (statusCode, method, redirectUrl) => {
        last = redirectVerdict(redirectUrl, { loopbackFeed: loopbackFeed() });
        if (!last.ok) {
          request.abort();
          log(`refused a redirect: ${last.message}`);
          if (request.listenerCount('error') > 0) request.emit('error', new Error(last.message));
          return;
        }
        if (request.listenerCount('redirect') === 1) follow?.(); // nobody else is handling it
      });
      return request;
    }

    addRedirectHandlers(request, options, reject, redirectCount, handler) {
      const guarded = {
        abort: (...args) => request.abort(...args),
        on: (event, listener) => {
          if (event !== 'redirect') return request.on(event, listener);
          return request.on('redirect', (statusCode, method, redirectUrl, ...rest) => {
            const verdict = redirectVerdict(redirectUrl, { loopbackFeed: loopbackFeed() });
            if (verdict.ok) return listener(statusCode, method, redirectUrl, ...rest);
            request.abort();
            log(`refused a redirect: ${verdict.message}`);
            return reject(new Error(verdict.message));
          });
        },
      };
      return super.addRedirectHandlers(guarded, options, reject, redirectCount, handler);
    }
  };
}

/**
 * The catch-all: every request of the updater's session, and every redirect hop, is checked by the same rule before it is sent, and
 * cancelled when it is not allowed. Setting it again replaces the earlier one (Electron keeps one handler per session).
 * @param session an Electron session (anything with webRequest.onBeforeRequest)
 */
export function guardSession(session, { loopbackFeed = () => false, log = () => {} } = {}) {
  session.webRequest.onBeforeRequest({ urls: ['<all_urls>'] }, (details, callback) => {
    const verdict = redirectVerdict(details.url, { loopbackFeed: loopbackFeed() });
    if (!verdict.ok) log(`blocked a request: ${verdict.message}`);
    callback({ cancel: !verdict.ok });
  });
}
