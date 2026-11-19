import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn, execFileSync } from 'node:child_process';
import { mkdir, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { fixture, projectRoot, until } from './helpers';

const tsx = import.meta.resolve('tsx');
const alive = (pid: number) => { try { process.kill(pid, 0); return true; } catch { return false; } };
const children = (pid: number) => { try { return execFileSync('pgrep', ['-P', String(pid)], { encoding: 'utf8' }).split('\n').filter(Boolean).map(Number); } catch { return []; } };

// A parent that dies without cleaning up leaves its worker reparented to PID 1. A worker stuck in a synchronous
// loop cannot notice by itself (its 'disconnect' event never runs), so it must be ended from outside its event loop.
async function orphanCheck(script: (root: string) => string, root: string) {
  const parent = spawn(process.execPath, ['--import', tsx, '--input-type=module', '-e', script(root)], { cwd: root, stdio: ['ignore', 'pipe', 'inherit'] });
  let worker = 0;
  try {
    await until(() => { worker = children(parent.pid!)[0] ?? 0; return worker > 0; }, 30_000);
    // Give the worker time to load, start its watchdog and enter the loop.
    await new Promise(accept => setTimeout(accept, 4_000));
    assert.ok(alive(worker));
    process.kill(parent.pid!, 'SIGKILL');
    const killed = Date.now();
    await until(() => !alive(worker), 10_000);
    return Date.now() - killed;
  } finally { for (const pid of [parent.pid!, worker]) if (pid && alive(pid)) process.kill(pid, 'SIGKILL'); }
}

test('a render worker stuck in a synchronous loop exits soon after its parent is killed', { skip: process.platform === 'win32', timeout: 90_000 }, async () => {
  const f = await fixture();
  try {
    await mkdir(resolve(f.root, 'documents/spin'), { recursive: true });
    await writeFile(resolve(f.root, 'documents/spin/index.tsx'), `import { Document, Pages, Paragraph } from '../../src/document';\nexport const meta = { title: 'Spin', description: 'Never ends', kind: 'report', theme: 'neutral' };\nwhile (true) { /* a theme or document that never returns */ }\nexport default function Spin() { return <Document title="Spin"><Pages title="Spin"><Paragraph>Never</Paragraph></Pages></Document>; }\n`);
    const took = await orphanCheck(root => `const { renderOnce } = await import(${JSON.stringify(resolve(projectRoot, 'src/server/render.ts'))}); await renderOnce(${JSON.stringify(root)}, 'spin', 600000).catch(() => {}); `, f.root);
    assert.ok(took < 8_000, `took ${took} ms`);
  } finally { await f.cleanup(); }
});

test('an import worker stuck in a synchronous loop exits soon after its parent is killed', { skip: process.platform === 'win32', timeout: 90_000 }, async () => {
  const f = await fixture();
  try {
    // The import worker is replaced by a spinning stand-in that starts the same watchdog the real one does.
    const stand = resolve(f.root, 'spin-worker.ts');
    await writeFile(stand, `import { exitWithParent } from ${JSON.stringify(resolve(projectRoot, 'src/server/parent-watch.ts'))};\nexitWithParent();\nwhile (true) {}\n`);
    const took = await orphanCheck(root => `import { fork } from 'node:child_process'; fork(${JSON.stringify(stand)}, [], { cwd: ${JSON.stringify(root)}, execArgv: ['--import', ${JSON.stringify(tsx)}], stdio: ['ignore', 'ignore', 'inherit', 'ipc'] }); setInterval(() => {}, 1000);`, f.root);
    assert.ok(took < 8_000, `took ${took} ms`);
  } finally { await f.cleanup(); }
});
