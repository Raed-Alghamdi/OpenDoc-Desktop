// The app's own pages (workspace picker, crash screen, upgrade progress and result, backups) are files in desktop/src/renderer, served from
// app://shell/ by the main process. The app loads no file:// pages (the file protocol keeps no fetch or storage
// when its extra privileges are off), and these pages share no origin with the OpenDoc workspace pages.
import { protocol } from 'electron';
import { readFile } from 'node:fs/promises';
import { extname, join } from 'node:path';
import { shellHost, shellScheme } from './identity.mjs';
import { shellContentSecurityPolicy } from './policy.mjs';

const pages = new Set(['picker.html', 'picker.js', 'crash.html', 'crash.js', 'status.html', 'status.js', 'result.html', 'result.js', 'backups.html', 'backups.js', 'shell.css']);
const types = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8' };
const rendererFolder = new URL('../renderer/', import.meta.url);

/** Must run before the app is ready. The same scheme carries the shell's pages (app://shell) and the service (app://opendoc). */
export function registerSchemes() {
  protocol.registerSchemesAsPrivileged([{ scheme: shellScheme, privileges: { standard: true, secure: true, supportFetchAPI: true, stream: true, corsEnabled: true } }]);
}

export async function serveShell(request) {
  const url = new URL(request.url);
  if (url.host !== shellHost) return new Response('Not found.', { status: 403 });
  const name = url.pathname.replace(/^\//, '');
  if (request.method !== 'GET' || !pages.has(name)) return new Response('Not found.', { status: 404 });
  const body = await readFile(new URL(name, rendererFolder));
  return new Response(body, { headers: { 'Content-Type': types[extname(name)], 'Content-Security-Policy': shellContentSecurityPolicy, 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' } });
}

export const shellPageUrl = (page, query = {}) => {
  const url = new URL(`${shellScheme}://${shellHost}/${page}`);
  for (const [key, value] of Object.entries(query)) url.searchParams.set(key, value);
  return url.href;
};
