import test from 'node:test';
import assert from 'node:assert/strict';
import { commentBlockIds, commentPlaces, selectionsByPlace } from '../src/app/commentPlaces';
import { commentTargets } from '../src/shared/anchors';
import type { Comment, RenderArtifact } from '../src/shared/types';

const box = (id: string, x: number, y: number) => ({ id, x, y, width: 100, height: 20 });
const block = (id: string, kind: string, text: string) => [id, { id, kind, text }] as const;
const artifact = {
  hash: 'render',
  blocks: Object.fromEntries([block('title', 'heading', 'Report'), block('summary', 'paragraph', 'Revenue grew.'), block('chart', 'figure', ''),
    block('left', 'paragraph', 'Left column'), block('right', 'paragraph', 'Right column')]),
  pages: [
    // Fragments come in artifact order, not reading order.
    { width: 595, height: 842, fragments: [box('right', 320, 300), box('summary', 40, 120), box('left', 40, 300), box('title', 40, 40)] },
    { width: 595, height: 842, fragments: [box('chart', 40, 60)] },
  ],
  textTargets: [],
} as unknown as RenderArtifact;

const comment = (targets?: { blockId: string; quote: string }[]): Comment => ({
  id: 'c1', blockId: 'chart', quote: '', text: 'Make these consistent.', status: 'open', createdAt: '', updatedAt: '', version: 1, history: [],
  ...(targets ? { targets } : {}),
});

test('a comment without targets is one place; with targets it is every one, the first being its own block', () => {
  assert.deepEqual(commentTargets(comment()), [{ blockId: 'chart', quote: '' }]);
  assert.deepEqual(commentBlockIds(comment()), ['chart']);
  const several = comment([{ blockId: 'chart', quote: '' }, { blockId: 'title', quote: 'Report' }, { blockId: 'summary', quote: 'Revenue grew.' }]);
  assert.deepEqual(commentBlockIds(several), ['chart', 'title', 'summary']);
});

test('places sort by page, then y, then x, not in the order they were chosen', () => {
  const places = commentPlaces(artifact, comment([{ blockId: 'chart', quote: '' }, { blockId: 'right', quote: 'Right column' },
    { blockId: 'summary', quote: 'Revenue grew.' }, { blockId: 'left', quote: 'Left column' }, { blockId: 'title', quote: 'Report' }]));
  assert.deepEqual(places.map(place => place.target.blockId), ['title', 'summary', 'left', 'right', 'chart']);
  assert.deepEqual(places.map(place => place.selection?.page), [1, 1, 1, 1, 2]);
  assert.deepEqual(places.map(place => place.kind), ['heading', 'paragraph', 'paragraph', 'paragraph', 'figure']);
});

test('a place whose component left the document is missing, listed last, and the others still resolve', () => {
  const places = commentPlaces(artifact, comment([{ blockId: 'gone', quote: 'Removed' }, { blockId: 'chart', quote: '' }, { blockId: 'title', quote: 'Report' }]));
  assert.deepEqual(places.map(place => [place.target.blockId, place.status]), [['title', 'attached'], ['chart', 'attached'], ['gone', 'missing']]);
  assert.equal(places[2].selection, undefined);
});

test('the composer lists chosen components in page order', () => {
  const ordered = selectionsByPlace(artifact, [{ blockId: 'chart', page: 2 }, { blockId: 'right', page: 1 }, { blockId: 'title', page: 1 }]);
  assert.deepEqual(ordered.map(item => item.blockId), ['title', 'right', 'chart']);
});

test('a place whose phrase can no longer be found is the only one marked changed', () => {
  const lost = { targetId: 'summary:children', start: 0, end: 7, quote: 'Revenue', prefix: '', suffix: ' grew.' };
  const places = commentPlaces(artifact, { ...comment(), targets: [{ blockId: 'title', quote: 'Report' }, { blockId: 'summary', quote: 'Revenue', anchor: lost }, { blockId: 'chart', quote: '' }] });
  assert.deepEqual(places.map(place => [place.target.blockId, place.status]), [['title', 'attached'], ['summary', 'changed'], ['chart', 'attached']]);
});
