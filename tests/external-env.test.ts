import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { fork } from 'node:child_process';
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { resolve, delimiter } from 'node:path';
import { fixture } from './helpers';
import { ExportStore } from '../src/server/exports';
import { externalEnv } from '../src/server/external-env';

test('externalEnv drops ELECTRON_RUN_AS_NODE, keeps everything else and leaves process.env alone', () => {
  const env = { ELECTRON_RUN_AS_NODE: '1', PATH: '/bin', HOME: '/home/x' };
  assert.deepEqual(externalEnv(env), { PATH: '/bin', HOME: '/home/x' });
  assert.equal(env.ELECTRON_RUN_AS_NODE, '1');
  const saved = process.env.ELECTRON_RUN_AS_NODE;
  process.env.ELECTRON_RUN_AS_NODE = '1';
  try { assert.ok(!('ELECTRON_RUN_AS_NODE' in externalEnv())); assert.equal(process.env.ELECTRON_RUN_AS_NODE, '1'); }
  finally { if (saved === undefined) delete process.env.ELECTRON_RUN_AS_NODE; else process.env.ELECTRON_RUN_AS_NODE = saved; }
});

test('the file manager started by an export reveal lacks ELECTRON_RUN_AS_NODE, while forked Node children keep it', { skip: process.platform !== 'linux' }, async () => {
  const f = await fixture();
  const bin = await mkdtemp(resolve(tmpdir(), 'opendoc-bin-'));
  const report = resolve(bin, 'env.txt');
  const saved = { PATH: process.env.PATH, run: process.env.ELECTRON_RUN_AS_NODE, out: process.env.OPENDOC_TEST_ENV_FILE };
  try {
    await writeFile(resolve(bin, 'xdg-open'), '#!/bin/sh\nenv > "$OPENDOC_TEST_ENV_FILE"\n');
    await chmod(resolve(bin, 'xdg-open'), 0o755);
    process.env.PATH = `${bin}${delimiter}${saved.PATH}`; process.env.ELECTRON_RUN_AS_NODE = '1'; process.env.OPENDOC_TEST_ENV_FILE = report;
    await mkdir(resolve(f.root, 'output'));
    const store = new ExportStore(f.root);
    const saveInput = { id: randomUUID(), documentId: 'proof', hash: 'h', filename: 'Reviewed.pdf' };
    const result = await store.save(saveInput, async () => ({ bytes: Buffer.from('%PDF-1.7'), isCurrent: () => true }));
    await store.reveal(result.id);
    const seen = await readFile(report, 'utf8');
    assert.match(seen, /^PATH=/m, 'The program did run with the rest of the environment.');
    assert.doesNotMatch(seen, /ELECTRON_RUN_AS_NODE/);
    // Render and import workers are forked without an env option, so they inherit it.
    const child = fork('-e', ['process.send(process.env.ELECTRON_RUN_AS_NODE ?? "")'], { execArgv: [], stdio: ['ignore', 'ignore', 'ignore', 'ipc'] });
    assert.equal(await new Promise(accept => child.once('message', accept)), '1');
  } finally {
    for (const [key, value] of Object.entries({ PATH: saved.PATH, ELECTRON_RUN_AS_NODE: saved.run, OPENDOC_TEST_ENV_FILE: saved.out })) { if (value === undefined) delete process.env[key]; else process.env[key] = value; }
    await rm(bin, { recursive: true, force: true }); await f.cleanup();
  }
});
