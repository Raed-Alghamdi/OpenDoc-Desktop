import assert from 'node:assert/strict';
import { test } from 'node:test';
import { fitToWorkArea } from '../../../src/main/window-fit.mjs';

test('a window that fits keeps its size', () => {
  assert.deepEqual(fitToWorkArea({ width: 800, height: 760 }, { width: 1920, height: 1040 }), { width: 800, height: 760 });
});

test('a window taller or wider than the work area is cut to it, leaving the margin on every side', () => {
  assert.deepEqual(fitToWorkArea({ width: 800, height: 760 }, { width: 1280, height: 770 }), { width: 800, height: 746 });
  assert.deepEqual(fitToWorkArea({ width: 800, height: 760 }, { width: 700, height: 600 }, { margin: 10 }), { width: 680, height: 580 });
});

test('never below the minimum, unless the work area itself is smaller', () => {
  assert.deepEqual(fitToWorkArea({ width: 800, height: 760 }, { width: 1024, height: 420 }), { width: 800, height: 396 });
  assert.deepEqual(fitToWorkArea({ width: 800, height: 760 }, { width: 1024, height: 300 }, { min: { width: 480, height: 380 } }), { width: 800, height: 276 });
  assert.deepEqual(fitToWorkArea({ width: 800, height: 760 }, { width: 300, height: 200 }), { width: 276, height: 176 });
  assert.deepEqual(fitToWorkArea({ width: 800, height: 760 }, { width: 1024, height: 500 }, { min: { width: 480, height: 480 } }), { width: 800, height: 476 });
  assert.deepEqual(fitToWorkArea({ width: 500, height: 300 }, { width: 1024, height: 900 }), { width: 500, height: 380 }, 'a wanted size below the minimum is raised to it');
});
