// The read-only handshake with the service (contract "E3 and U4"): the app passes `readOnly: { reason, message }` to
// prepareOpenDocService, and a service that does not set `readOnlySupported: true` is never started, so a workspace that
// must be read-only is never served writable.
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { after, before, test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { createService } from '../../../src/host/service-host.mjs';
import { startTransport, TransportError } from '../../../src/main/transport.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const tsx = join(here, '..', '..', '..', '..', 'node_modules', 'tsx', 'dist', 'esm', 'index.mjs');

// `mode` in the workspace's file `mode` chooses what the stand-in service offers.
const fakeService = `
import { readFileSync, writeFileSync } from 'node:fs';
const mode = readFileSync('mode', 'utf8').trim();
const make = options => ({ token: 't', onChange: () => () => {}, async close() {}, async handle(req, res) { res.writeHead(200, { 'content-type': 'application/json' }); res.end(JSON.stringify({ readOnly: options.readOnly ?? null })); } });
export async function prepareOpenDocService(options) {
  writeFileSync('prepared', JSON.stringify(options));
  return { ...(mode === 'supported' ? { readOnlySupported: true } : mode === 'false' ? { readOnlySupported: false } : {}), service: make(options), start: async () => { writeFileSync('started', 'yes'); } };
}
export async function createOpenDocService(options) { const prepared = await prepareOpenDocService(options); await prepared.start(); return prepared.service; }
`;
const onlyCreate = `
export async function createOpenDocService() { throw new Error('not reached'); }
`;

let folder; let location; let legacy;
const readOnly = { reason: 'newer-minor', message: 'This workspace was upgraded by OpenDoc 0.7. Update the app to edit it.' };
async function workspace(mode) {
  const root = await mkdtemp(join(folder, 'ws-'));
  await writeFile(join(root, 'mode'), mode);
  return root;
}

before(async () => {
  folder = await mkdtemp(join(tmpdir(), 'opendoc-readonly-'));
  for (const [name, text] of [['full', fakeService], ['legacy', onlyCreate]]) {
    const base = join(folder, name, 'node_modules', 'opendoc');
    await mkdir(join(base, 'src', 'server'), { recursive: true });
    await writeFile(join(base, 'src', 'server', 'service.ts'), text);
    await writeFile(join(base, 'package.json'), JSON.stringify({ name: 'opendoc', type: 'module' }));
  }
  location = { entry: join(folder, 'full', 'node_modules', 'opendoc', 'src', 'server', 'service.ts'), tsx };
  legacy = { entry: join(folder, 'legacy', 'node_modules', 'opendoc', 'src', 'server', 'service.ts'), tsx };
});
after(() => rm(folder, { recursive: true, force: true }));

test('createService without readOnly uses createOpenDocService as before', async () => {
  const calls = [];
  const service = await createService({ createOpenDocService: async options => { calls.push(options); return 'service'; } });
  assert.equal(service, 'service');
  assert.deepEqual(calls, [{ root: process.cwd(), production: true }]);
});

test('createService with readOnly passes it on, checks readOnlySupported, and starts only a service that supports it', async () => {
  const events = [];
  const supported = { prepareOpenDocService: async options => { events.push(['prepare', options.readOnly]); return { readOnlySupported: true, service: 'ro-service', start: async () => { events.push(['start']); } }; } };
  assert.equal(await createService(supported, readOnly), 'ro-service');
  assert.deepEqual(events, [['prepare', readOnly], ['start']]);
  for (const prepared of [{ service: 'x', start: async () => events.push(['start-bad']) }, { readOnlySupported: 'yes', service: 'x', start: async () => events.push(['start-bad']) }, { readOnlySupported: false, service: 'x', start: async () => events.push(['start-bad']) }]) {
    await assert.rejects(createService({ prepareOpenDocService: async () => prepared }, readOnly), error => error.code === 'read-only-unsupported');
  }
  await assert.rejects(createService({ createOpenDocService: async () => 'writable' }, readOnly), error => error.code === 'read-only-unsupported');
  assert.ok(!events.some(event => event[0] === 'start-bad'), 'an unsupported service is never started');
});

test('a read-only start reaches the service: prepareOpenDocService gets readOnly, and the host serves', async () => {
  const root = await workspace('supported');
  const transport = await startTransport({ root, location, readOnly });
  try {
    assert.deepEqual(JSON.parse(await readFile(join(root, 'prepared'), 'utf8')).readOnly, readOnly);
    assert.equal(await readFile(join(root, 'started'), 'utf8'), 'yes');
    assert.deepEqual(await (await transport.handle(new Request('app://opendoc/x'))).json(), { readOnly });
  } finally { await transport.stop(); }
});

test('a normal start passes no readOnly', async () => {
  const root = await workspace('supported');
  const transport = await startTransport({ root, location });
  try { assert.deepEqual(await (await transport.handle(new Request('app://opendoc/x'))).json(), { readOnly: null }); }
  finally { await transport.stop(); }
});

test('a service that does not say readOnlySupported is never started, and the start fails with read-only-unsupported', async () => {
  for (const mode of ['none', 'false']) {
    const root = await workspace(mode);
    await assert.rejects(startTransport({ root, location, readOnly }), error => error instanceof TransportError && error.code === 'read-only-unsupported');
    assert.equal(existsSync(join(root, 'started')), false, 'start() was not called');
  }
});

test('a service from before read-only (no prepareOpenDocService export) fails the same way', async () => {
  const root = await workspace('none');
  await assert.rejects(startTransport({ root, location: legacy, readOnly }), error => error instanceof TransportError && error.code === 'read-only-unsupported');
});
