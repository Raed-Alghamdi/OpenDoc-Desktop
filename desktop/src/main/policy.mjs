// What a window may load, open and ask for. Pure functions, so the rules are tested without Electron.
import { shellHost, shellScheme } from './identity.mjs';

const webSchemes = new Set(['http:', 'https:', 'mailto:']);

export function parseUrl(value) {
  try { return new URL(value); } catch { return null; }
}

/** The Content-Security-Policy for the workspace pages: the service's own origin and nothing else. */
export function contentSecurityPolicy(origin) {
  const socket = origin.replace(/^http/, 'ws');
  return [
    "default-src 'none'",
    // pdf.js compiles WebAssembly for some image formats.
    "script-src 'self' 'wasm-unsafe-eval'",
    "style-src 'self' 'unsafe-inline'",
    "img-src 'self' data: blob:",
    "font-src 'self' data:",
    `connect-src 'self' ${socket}`,
    "media-src 'self' blob:",
    "worker-src 'self' blob:",
    "object-src 'none'",
    "base-uri 'none'",
    "form-action 'self'",
    "frame-ancestors 'none'",
  ].join('; ');
}

/** The policy for the app's own pages (workspace picker, crash screen). */
export const shellContentSecurityPolicy = "default-src 'none'; script-src 'self'; style-src 'self'; img-src 'self' data:; connect-src 'none'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'";

export function isShellUrl(value) {
  const url = parseUrl(value);
  return Boolean(url && url.protocol === `${shellScheme}:` && url.host === shellHost);
}

export function isWebLink(value) {
  const url = parseUrl(value);
  return Boolean(url && webSchemes.has(url.protocol));
}

/**
 * A navigation inside a window: `allow` for the app's own origin and its own pages, `external` for a web link
 * (the system browser opens it), `deny` for everything else (file:, data:, javascript:, other app hosts).
 */
export function classifyNavigation(value, origins) {
  const url = parseUrl(value);
  if (!url) return 'deny';
  if (origins.includes(url.origin) || isShellUrl(value)) return 'allow';
  return webSchemes.has(url.protocol) ? 'external' : 'deny';
}

/**
 * window.open and target=_blank. A file the service itself serves (an exported PDF, a font specimen) may open in a
 * small app window; any other address on the origin is refused; web links go to the system browser.
 */
export function classifyWindowOpen(value, origin) {
  const url = parseUrl(value);
  if (!url) return 'deny';
  if (url.origin === origin) return url.pathname.startsWith('/api/') ? 'file-window' : 'deny';
  return webSchemes.has(url.protocol) ? 'external' : 'deny';
}

/** `/api/exports/<id>/reveal`: the request the main process answers with showItemInFolder. */
export function revealRequest(request, origin) {
  const url = parseUrl(request.url);
  if (!url || url.origin !== origin || request.method !== 'POST') return null;
  const match = url.pathname.match(/^\/api\/exports\/([a-f0-9-]+)\/reveal$/);
  return match ? match[1] : null;
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

/** Requests a page may make: its own origin, the app's own pages, and inline data. Everything else is refused. */
export function requestAllowed(value, origins) {
  const url = parseUrl(value);
  if (!url) return false;
  if (['data:', 'blob:', 'devtools:', 'chrome-extension:'].includes(url.protocol)) return true;
  if (url.protocol === `${shellScheme}:`) return url.host === shellHost;
  if (['http:', 'https:', 'ws:', 'wss:'].includes(url.protocol)) {
    const origin = url.origin.replace(/^ws/, 'http');
    return origins.includes(origin);
  }
  return false;
}

/** Permissions the app grants: copying text to the clipboard from a button the user clicked. Nothing else. */
export function permissionAllowed(permission) {
  return permission === 'clipboard-sanitized-write';
}
