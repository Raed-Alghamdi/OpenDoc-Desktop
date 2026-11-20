import test from 'node:test';
import assert from 'node:assert/strict';
import { watch } from 'chokidar';
import { link, mkdir, mkdtemp, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { readyWatcher } from '../src/server/watch';
import { until } from './helpers';

// Import publishes a design by linking files into a folder the watcher may already be attaching to. On macOS a watcher
// that attached while that was going on was seen to miss later edits (CI, Intel runner), so the service starts a fresh
// one on the finished folders (`refreshWatcher` in service.ts). This test stands in for the lost watch with a watcher
// that was told to stop watching the folder, which any platform can do, and shows what the replacement must do.
test('a watcher started on the finished folder sees edits that the one that attached earlier no longer sees', async t => {
  const root = await realpath(await mkdtemp(resolve(tmpdir(), 'opendoc-watcher-')));
  t.after(() => rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 }));
  const staged = resolve(root, 'stage'), theme = resolve(root, 'themes/acme');
  await mkdir(staged); await mkdir(resolve(root, 'themes'));
  await writeFile(resolve(staged, 'design.md'), '# Acme\n');
  const open = (seen: string[]) => () => watch([root], { ignoreInitial: true, ignored: path => /stage/.test(path) }).on('all', (_event, path) => seen.push(path));
  const before: string[] = [], after: string[] = [];
  const old = await readyWatcher(open(before));
  t.after(() => old.close());
  // The publication: a new folder, a file hard-linked into it from the stage, and the stage removed.
  await mkdir(theme); await link(resolve(staged, 'design.md'), resolve(theme, 'design.md'));
  await rm(staged, { recursive: true });
  await until(() => before.some(path => path.endsWith('design.md') || path.endsWith('acme')), 10_000);
  // The earlier watcher loses the folder (the failure seen on macOS).
  await old.unwatch(theme);
  const next = await readyWatcher(open(after));
  t.after(() => next.close());
  await writeFile(resolve(theme, 'design.md'), '# Acme\nChanged after install.\n');
  await until(() => after.some(path => path === resolve(theme, 'design.md')), 10_000);
  await writeFile(resolve(theme, 'extra.md'), 'new\n');
  await until(() => after.some(path => path === resolve(theme, 'extra.md')), 10_000);
  assert.deepEqual(before.filter(path => path.startsWith(theme + '/') && path.endsWith('extra.md')), [], 'the earlier watcher stayed blind, so the replacement is what saw it');
});

test('a watcher that cannot start is closed and the error reaches the caller', async () => {
  let closed = false;
  const failing = { once(event: string, listener: (value?: unknown) => void) { if (event === 'error') queueMicrotask(() => listener(new Error('no watch'))); return this; }, close: async () => { closed = true; } };
  await assert.rejects(readyWatcher(() => failing as never), /no watch/);
  assert.equal(closed, true);
});
