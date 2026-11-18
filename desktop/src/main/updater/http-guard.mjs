// Redirects the updater may follow. electron-updater's HTTP executor follows any redirect, https to http included, so a feed (or a
// release host) could send a download to a plain http address. Here a redirect is followed only when it stays on https, with one
// exception: a feed that is itself on the loopback address (tests) may redirect to another loopback http address.
// No Electron import: the class that is guarded comes in as an argument.
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
 * A subclass of an electron-updater HTTP executor that refuses unsafe redirects. Both the metadata requests and the downloads go through
 * addRedirectHandlers(request, options, reject, redirectCount, handler), and the base class uses only request.on(...) and request.abort(),
 * so the "redirect" listener it registers is wrapped with the check.
 * @param options.loopbackFeed () => true when the feed address is on the loopback address (read at each redirect)
 * @param options.log (line) => void
 */
export function guardRedirects(Base, { loopbackFeed = () => false, log = () => {} } = {}) {
  return class extends Base {
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
