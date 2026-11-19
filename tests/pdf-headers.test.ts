import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { fixture, until } from './helpers';
import { createOpenDocService } from '../src/server/service';

const client = (_req: IncomingMessage, res: ServerResponse) => { res.end('client'); };

test('PDF routes tell the browser not to sniff the type', { timeout: 60_000 }, async () => {
  const f = await fixture();
  const service = await createOpenDocService({ root: f.root, production: false, client });
  const server = createServer((req, res) => { service.handle(req, res).catch(() => {}); });
  await new Promise<void>(accept => server.listen(0, '127.0.0.1', accept));
  const origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  try {
    await until(async () => (await fetch(`${origin}/api/documents?view=summary`).then(r => r.json()) as { status: string }[]).every(d => d.status === 'ready'));
    const hash = (await fetch(`${origin}/api/documents/proof`).then(r => r.json())).artifact.hash;
    const document = await fetch(`${origin}/api/documents/proof/pdf?hash=${hash}`);
    assert.equal(document.headers.get('content-type'), 'application/pdf');
    assert.equal(document.headers.get('x-content-type-options'), 'nosniff');
    const preview = await fetch(`${origin}/api/themes/neutral/preview`).then(r => r.json());
    const theme = await fetch(`${origin}/api/themes/neutral/pdf?hash=${preview.hash ?? preview.artifact?.hash}`);
    assert.equal(theme.status, 200);
    assert.equal(theme.headers.get('x-content-type-options'), 'nosniff');
  } finally {
    server.closeAllConnections(); await new Promise(accept => server.close(accept));
    await service.close(); await f.cleanup();
  }
});
