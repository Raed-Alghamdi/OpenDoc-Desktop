import test from 'node:test';
import assert from 'node:assert/strict';
import { maxSelections, readSelection, readSelections, selectionContext } from '../src/server/selection';

test('a selected phrase retains its page when the reader scrolls to another page', () => {
  const selected = { blockId: 'opening', page: 1, targetId: 'opening:children', start: 4, end: 10, quote: 'phrase', revision: 7, renderHash: 'current' };
  assert.deepEqual(readSelection(selected, 'opening'), selected);
  assert.equal(readSelection(null, null), null);
});

test('observed context excludes draft text and rejects malformed range identity', () => {
  const selected = { blockId: 'opening', page: 1, targetId: 'opening:children', start: 4, end: 10, quote: 'phrase' };
  assert.deepEqual(readSelection({ ...selected, draft: 'private unsaved text', instruction: 'not UI context' }, 'opening'), selected);
  assert.throws(() => readSelection(selected, 'different'), /active block/);
  assert.throws(() => readSelection({ ...selected, page: -1 }, 'opening'), /selection page/);
  assert.throws(() => readSelection({ ...selected, end: 3 }, 'opening'), /text range/);
  assert.throws(() => readSelection({ ...selected, quote: 'x'.repeat(8001) }, 'opening'), /shorter passage/);
});

test('a list of selections keeps the first as the phrase and every other place as a whole component', () => {
  const phrase = { blockId: 'opening', page: 1, targetId: 'opening:children', start: 4, end: 10, quote: 'phrase', revision: 7 };
  const second = { blockId: 'middle', page: 2 }, third = { blockId: 'closing', page: 3, quote: 'Closing text' };
  assert.deepEqual(readSelections([phrase, second, third], 'opening'), [phrase, second, third]);
  assert.deepEqual(readSelections([second, third], 'closing'), [second, third], 'The active block may be any listed place.');
  assert.deepEqual(readSelections([{ ...second, draft: 'private' }], 'middle'), [second]);
  assert.deepEqual(readSelections(null, null), []);
  assert.deepEqual(readSelections([], null), []);
  assert.deepEqual(selectionContext([phrase, second]), { selection: phrase, selections: [phrase, second] });
  assert.deepEqual(selectionContext([]), { selection: null, selections: [] });
});

test('selection lists refuse duplicate blocks, later phrases and a missing active block', () => {
  const phrase = { blockId: 'opening', page: 1, targetId: 'opening:children', start: 4, end: 10, quote: 'phrase' };
  assert.throws(() => readSelections([phrase, { blockId: 'opening', page: 1 }], 'opening'), /only once/);
  assert.throws(() => readSelections([{ blockId: 'middle', page: 1 }, phrase], 'middle'), /Only the first selection can be a phrase/);
  assert.throws(() => readSelections([{ blockId: 'middle', page: 1 }, { blockId: 'closing', page: 1, targetId: 'closing:text' }], 'middle'), /Only the first selection can be a phrase/);
  assert.throws(() => readSelections([phrase], 'elsewhere'), /active block/);
  assert.throws(() => readSelections([phrase], null), /active block/);
  assert.throws(() => readSelections(phrase, 'opening'), /Invalid selections/);
  assert.throws(() => readSelections([null], 'opening'), /Invalid selection/);
  assert.throws(() => readSelections([{ page: 1 }], 'opening'), /Invalid selection block/);
  assert.throws(() => readSelections([{ blockId: 'a', page: 0 }], 'a'), /selection page/);
  assert.throws(() => readSelections(Array.from({ length: maxSelections + 1 }, (_, i) => ({ blockId: `b${i}`, page: 1 })), 'b0'), /at most/);
});
