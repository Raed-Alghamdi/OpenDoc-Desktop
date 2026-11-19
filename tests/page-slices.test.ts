import test from 'node:test';
import assert from 'node:assert/strict';
import { pageSlices } from '../src/app/pageSlices';
import type { DocumentSelection, TextTarget } from '../src/shared/selection';
import type { RenderArtifact } from '../src/shared/types';

function target(id: string, blockId: string, pages: number[]): TextTarget {
  return { id, blockId, slot: 'content', text: 'Quarterly revenue grew.', runs: [],
    lines: pages.map(page => ({ page, x: 40, y: 80, width: 300, height: 20, text: 'Quarterly revenue grew.', start: 0, end: 23 })) };
}
const fragment = (id: string) => ({ id, x: 40, y: 80, width: 300, height: 20 });
const artifact = {
  hash: 'render', pages: [
    { width: 595, height: 842, fragments: [fragment('intro'), fragment('table')] },
    { width: 595, height: 842, fragments: [fragment('table'), fragment('body')] },
    { width: 595, height: 842, fragments: [fragment('closing')] },
  ],
  textTargets: [target('intro:content', 'intro', [1]), target('body:content', 'body', [2, 3])],
} as unknown as RenderArtifact;

test('each page receives only the selection and comments it shows', () => {
  const table: DocumentSelection = { blockId: 'table', page: 1 };
  const phrase: DocumentSelection = { blockId: 'body', targetId: 'body:content', start: 0, end: 9, page: 2 };
  const slices = pageSlices(artifact, table, new Set(['intro', 'body']), [phrase]);
  assert.deepEqual(slices.map(slice => slice.selection), [table, table, null], 'A component split across pages is selected on both.');
  assert.deepEqual(slices.map(slice => [...slice.commented]), [['intro'], ['body'], []]);
  assert.deepEqual(slices.map(slice => slice.commentPhrases), [[], [phrase], [phrase]], 'A phrase comment follows its text onto later lines.');
  const continued = pageSlices(artifact, { ...phrase, page: 3 }, new Set(), []);
  assert.ok(continued[2].selection, 'Text that continues on a page without its component still selects there.');
  assert.equal(continued[0].selection, null);
});

test('unchanged pages keep their previous slice so memoized pages skip rendering', () => {
  const first = pageSlices(artifact, { blockId: 'intro', page: 1 }, new Set(['body']), [{ blockId: 'body', targetId: 'body:content', start: 0, end: 9, page: 2 }]);
  // A new selection elsewhere, and freshly fetched comments with the same content.
  const next = pageSlices(artifact, { blockId: 'closing', page: 3 }, new Set(['body']), [{ blockId: 'body', targetId: 'body:content', start: 0, end: 9, page: 2 }], first);
  assert.notEqual(next[0], first[0], 'The page that lost the selection changes.');
  assert.equal(next[1], first[1], 'An unrelated page keeps the same props.');
  assert.notEqual(next[2], first[2], 'The newly selected page changes.');
  assert.equal(next[2].commentPhrases, first[2].commentPhrases, 'Equal comment ranges keep their identity.');
  const commented = pageSlices(artifact, { blockId: 'closing', page: 3 }, new Set(['body', 'closing']), [], next);
  assert.equal(commented[0], next[0]);
  assert.notEqual(commented[2].commented, next[2].commented, 'A new comment marker changes only its page.');
  assert.deepEqual(pageSlices(undefined, null, new Set(), []), []);
});

test('components chosen after the main selection reach only the pages they are on, and keep their identity when unchanged', () => {
  const main: DocumentSelection = { blockId: 'intro', page: 1 };
  const more: DocumentSelection[] = [{ blockId: 'body', page: 2 }, { blockId: 'closing', page: 3 }];
  const slices = pageSlices(artifact, main, new Set(), [], [], more);
  assert.deepEqual(slices.map(slice => [...slice.multi]), [[], ['body'], ['closing']]);
  const same = pageSlices(artifact, main, new Set(), [], slices, [...more]);
  assert.deepEqual(same, slices);
  same.forEach((slice, index) => assert.equal(slice, slices[index], 'Equal choices keep the page props.'));
  const fewer = pageSlices(artifact, main, new Set(), [], slices, more.slice(0, 1));
  assert.equal(fewer[1], slices[1]);
  assert.notEqual(fewer[2], slices[2], 'The page that lost a component changes.');
});
