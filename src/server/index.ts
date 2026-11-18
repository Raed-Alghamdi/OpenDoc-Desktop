import { createServer } from 'node:http';
import { WebSocket, WebSocketServer } from 'ws';
import { readFile, rm } from 'node:fs/promises';
import { resolve } from 'node:path';
import type { ViteDevServer } from 'vite';
import { atomicWrite } from './files';
import { applicationRoot } from '../runtime/paths';
import { prepareOpenDocService, json, type OpenDocService } from './service';

const root = process.cwd();
const events = new WebSocketServer({ noServer: true, maxPayload: 1024 });
const production = process.argv.includes('--production') || process.env.NODE_ENV === 'production';
let vite: ViteDevServer | undefined;
let service: OpenDocService;
let port = Number(process.env.OPENDOC_PORT ?? 4310);
if (!Number.isInteger(port) || port < 0 || port > 65535) throw new Error('OPENDOC_PORT must be an integer from 0 to 65535.');
let origin = '';

const server = createServer(async (req, res) => {
  if (req.headers.host !== `127.0.0.1:${port}` && req.headers.host !== `localhost:${port}`) { json(res, { error: 'Invalid host.' }, 403); return; }
  let api = false;
  try { api = new URL(req.url ?? '/', origin).pathname.startsWith('/api/'); } catch { /* the service reports a bad URL */ }
  if (api && !['GET', 'HEAD'].includes(req.method ?? 'GET') && req.headers.origin && req.headers.origin !== `http://${req.headers.host}`) { json(res, { error: 'This write must come from the local OpenDoc session.' }, 403); return; }
  await service.handle(req, res);
});

// Upgraded sockets do not occupy the browser's six HTTP/1 request slots.
server.on('upgrade', (req, socket, head) => {
  if (req.url?.split('?')[0] !== '/api/events') {
    if (production) socket.destroy(); // Vite owns other upgrades in development.
    return;
  }
  const host = req.headers.host;
  if ((host !== `127.0.0.1:${port}` && host !== `localhost:${port}`) || req.headers.origin !== `http://${host}`) {
    socket.end('HTTP/1.1 403 Forbidden\r\nConnection: close\r\n\r\n'); return;
  }
  events.handleUpgrade(req, socket, head, client => {
    client.on('error', () => client.terminate());
    client.send('connected');
  });
});

let client: Parameters<typeof prepareOpenDocService>[0]['client'];
if (!production) {
  const { createServer: createViteServer } = await import('vite');
  vite = await createViteServer({ root: applicationRoot, server: { middlewareMode: true, ws: { server } }, appType: 'spa' });
  client = (req, res) => vite!.middlewares(req, res);
}
const prepared = await prepareOpenDocService({ root, production, client });
service = prepared.service;
let closing = false;
async function close() {
  if (closing) return; closing = true;
  const stopped = new Promise<void>((accept, reject) => server.close(error => error ? reject(error) : accept()));
  for (const client of events.clients) client.terminate();
  events.close();
  for (const client of vite?.ws.clients ?? []) client.socket.terminate();
  // Complete accepted saves while their preview files and source watcher are still available.
  await stopped;
  await service.close(); await vite?.close();
  const sessionFile = resolve(root, '.opendoc/server.json');
  const session = await readFile(sessionFile, 'utf8').then(JSON.parse, error => { if (error.code === 'ENOENT') return null; throw error; });
  // Another process may now own the workspace session. Do not disconnect its CLI.
  if (session?.pid === process.pid && session?.token === service.token) await rm(sessionFile, { force: true });
}
// As in 0.6.1: claim the port first, then publish server.json, and only then start the watcher, history and the first refresh.
// A second instance that loses the port therefore never touches the workspace.
try {
  while (true) {
    try {
      await new Promise<void>((accept, reject) => { server.once('error', reject); server.listen(port, '127.0.0.1', () => { server.off('error', reject); accept(); }); }); break;
    } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'EADDRINUSE' || process.env.OPENDOC_PORT || port >= 4320) throw error; port++; }
  }
} catch (error) {
  await Promise.allSettled([service.close(), vite?.close()]);
  throw error;
}
const address = server.address();
if (address && typeof address === 'object') port = address.port;
origin = `http://127.0.0.1:${port}`;
await atomicWrite(resolve(root, '.opendoc/server.json'), JSON.stringify({ origin, token: service.token, pid: process.pid }, null, 2));
service.onChange(() => { for (const client of events.clients) if (client.readyState === WebSocket.OPEN) client.send('changed'); });
try { await prepared.start(); }
catch (error) { await close().catch(() => {}); throw error; }
console.log(`\nOpenDoc is running at ${origin}\nDocuments: ${resolve(root, 'documents')}\n`);
function shutdown() { if (closing) return; void close().then(() => process.exit(0), error => { console.error('OpenDoc could not finish closing:', error); process.exit(1); }); }
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
