import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { projectRoot } from './helpers';

/**
 * Run a script that keeps writing for a while after its output is closed, as a long `opendoc review` does when
 * `head -c 100` has what it wants. The output is closed before the first write.
 */
async function closedEarly(imports: string[]) {
  const script = `${imports.map(file => `await import(${JSON.stringify(file)});`).join('\n')}
    await new Promise(accept => setTimeout(accept, 300));
    for (let index = 0; index < 20; index++) { console.log('x'.repeat(10_000)); await new Promise(accept => setTimeout(accept, 10)); }
    console.error('done');`;
  const child = spawn(process.execPath, ['--input-type=module', '-e', script], { stdio: ['ignore', 'pipe', 'pipe'] });
  let stderr = '';
  child.stderr.on('data', chunk => { stderr += chunk; });
  child.stdout.destroy();
  const code = await new Promise<number | null>(accept => child.on('close', accept));
  return { code, stderr };
}

test('without the handler a closed output ends the process with an EPIPE stack trace (the problem)', { timeout: 60_000 }, async () => {
  const result = await closedEarly([]);
  assert.match(result.stderr, /EPIPE/);
  assert.notEqual(result.code, 0);
});

test('the CLI entry drops output a reader no longer takes: no stack trace, the command finishes and keeps its exit status', { timeout: 60_000 }, async () => {
  const result = await closedEarly([resolve(projectRoot, 'bin/closed-output.mjs')]);
  assert.equal(result.stderr.replace(/done\n$/, ''), '');
  assert.equal(result.code, 0);
  assert.match(await readFile(resolve(projectRoot, 'bin/opendoc.mjs'), 'utf8'), /^import '\.\/closed-output\.mjs';$/m, 'bin/opendoc.mjs loads it first');
});

test('the handler rethrows every output error but EPIPE', async () => {
  const source = await readFile(resolve(projectRoot, 'bin/closed-output.mjs'), 'utf8');
  assert.match(source, /error\.code !== 'EPIPE'\) throw error/);
});
