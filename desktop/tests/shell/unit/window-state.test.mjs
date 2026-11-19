import assert from 'node:assert/strict';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { defaultSize, loadWindowState, restoreBounds, saveWindowState } from '../../../src/main/window-state.mjs';

const screen = [{ x: 0, y: 0, width: 1920, height: 1080 }];

test('nothing saved gives the default size, not maximised', () => {
  assert.deepEqual(restoreBounds(null, screen), { ...defaultSize, maximized: false });
  assert.deepEqual(restoreBounds('junk', screen), { ...defaultSize, maximized: false });
});

test('a saved position on a connected display is kept', () => {
  assert.deepEqual(restoreBounds({ x: 100, y: 80, width: 1000, height: 700, maximized: true }, screen), { x: 100, y: 80, width: 1000, height: 700, maximized: true });
});

test('a position on a display that is gone is dropped, the size is kept', () => {
  assert.deepEqual(restoreBounds({ x: 5000, y: 80, width: 1000, height: 700 }, screen), { width: 1000, height: 700, maximized: false });
  assert.deepEqual(restoreBounds({ x: 1900, y: 1070, width: 1000, height: 700 }, screen), { width: 1000, height: 700, maximized: false });
});

test('a tiny or invalid size is raised to a usable one', () => {
  const bounds = restoreBounds({ x: 0, y: 0, width: 10, height: Number.NaN }, screen);
  assert.ok(bounds.width >= 640 && bounds.height >= 480);
});

test('the state round-trips through its file', async () => {
  const file = join(await mkdtemp(join(tmpdir(), 'opendoc-window-')), 'window-state.json');
  assert.equal(await loadWindowState(file), null);
  await saveWindowState(file, { x: 1, y: 2, width: 800, height: 600, maximized: false });
  assert.deepEqual(await loadWindowState(file), { x: 1, y: 2, width: 800, height: 600, maximized: false });
});
