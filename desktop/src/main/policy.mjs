// What a window may load, open and ask for. Pure functions, so the rules are tested without Electron.
import { shellHost, shellScheme } from './identity.mjs';

const webSchemes = new Set(['http:', 'https:', 'mailto:']);

export function parseUrl(value) {
  try { return new URL(value); } catch { return null; }
}

/** `app://opendoc`, `https://example.com`: the origin as the browser writes it. (URL.origin is "null" for app: addresses.) */
export function originOf(value) {
  const url = parseUrl(value);
  if (!url) return '';
  return url.protocol === `${shellScheme}:` ? `${url.protocol}//${url.host}` : url.origin;
}

/** The Content-Security-Policy for the workspace pages: the service's own address and nothing else. */
export function contentSecurityPolicy() {
  return [
    "default-src 'none'",
    // pdf.js compiles WebAssembly for some image formats.
    "script-src 'self' 'wasm-unsafe-eval'",
    "style-src 'self' 'unsafe-inline'",
    "img-src 'self' data: blob:",
    "font-src 'self' data:",
    "connect-src 'self'",
    "media-src 'self' blob:",
    "worker-src 'self' blob:",
    "object-src 'none'",
    "base-uri 'none'",
    "form-action 'self'",
    "frame-ancestors 'none'",
  ].join('; ');
}

/** The policy for the app's own pages (workspace picker, crash screen). */
export const shellContentSecurityPolicy = "default-src 'none'; script-src 'self'; style-src 'self'; img-src 'self' data:; connect-src 'none'; worker-src 'none'; frame-src 'none'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'";

export function isShellUrl(value) {
  const url = parseUrl(value);
  return Boolean(url && url.protocol === `${shellScheme}:` && url.host === shellHost);
}

export function isWebLink(value) {
  const url = parseUrl(value);
  return Boolean(url && webSchemes.has(url.protocol));
}

/**
 * A navigation a page starts inside a window (the main process's own loadURL never comes here): `allow` for the
 * workspace's own address, and for the app's own pages only when the page is itself one of them (so a link in the
 * workspace page cannot turn the window into the picker, which has calls to the main process); `external` for a web
 * link (the system browser opens it); `deny` for everything else (file:, data:, javascript:, other app hosts).
 * `from` is the address of the page the navigation starts from.
 */
export function classifyNavigation(value, origins, from = '') {
  const url = parseUrl(value);
  if (!url) return 'deny';
  if (isShellUrl(value)) return isShellUrl(from) ? 'allow' : 'deny';
  if (origins.includes(originOf(value))) return 'allow';
  return webSchemes.has(url.protocol) ? 'external' : 'deny';
}

/**
 * window.open and target=_blank. A file the service itself serves (an exported PDF, a font specimen) may open in a
 * small app window; any other address on the origin is refused; web links go to the system browser.
 */
export function classifyWindowOpen(value, origin) {
  const url = parseUrl(value);
  if (!url) return 'deny';
  if (originOf(value) === origin) return url.pathname.startsWith('/api/') ? 'file-window' : 'deny';
  return webSchemes.has(url.protocol) ? 'external' : 'deny';
}

/**
 * The service answers `GET /api/session` with the token to any caller, and does not look at Origin itself. Electron
 * does not pass the Origin header to a protocol handler, but it tells the web request hook which origin started
 * the request (`initiatorOrigin`; none when the main process made it). So a request that changes something (any
 * method but GET and HEAD under /api/) is let through only when the app's own page, at the service's address, made it.
 */
export function crossOriginMutation({ url, method, initiatorOrigin }, origins) {
  const parsed = parseUrl(url);
  if (!parsed || !parsed.pathname.startsWith('/api/')) return false;
  if (method === 'GET' || method === 'HEAD') return false;
  return !origins.includes(initiatorOrigin ?? '');
}

/** Requests a page may make: the open workspace's address, the app's own pages, and inline data. Everything else is refused. */
export function requestAllowed(value, origins) {
  const url = parseUrl(value);
  if (!url) return false;
  if (['data:', 'blob:', 'devtools:', 'chrome-extension:'].includes(url.protocol)) return true;
  if (url.protocol === `${shellScheme}:`) return url.host === shellHost || origins.includes(originOf(value));
  return false;
}

/** Permissions the app grants: copying text to the clipboard from a button the user clicked. Nothing else. */
export function permissionAllowed(permission) {
  return permission === 'clipboard-sanitized-write';
}
