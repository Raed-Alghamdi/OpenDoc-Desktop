import test from 'node:test';
import assert from 'node:assert/strict';
import { commentDraftKey, componentCommentDraftKey, createCommentDraftStore, multiCommentDraftKey } from '../src/app/commentDrafts';
import { addsToSelection } from '../src/app/phraseSelection';
import type { DocumentSelection } from '../src/shared/selection';

const selection: DocumentSelection = { blockId: 'opening', targetId: 'opening:text', start: 3, end: 8, quote: 'words', page: 2, revision: 7, renderHash: 'selected-preview' };

test('component comments survive edited wording and reflow without leaking to another text slot', () => {
  const key = componentCommentDraftKey(selection);
  assert.equal(componentCommentDraftKey({ ...selection, quote: 'A longer edited draft', end: 24, page: 3, revision: 8 }), key);
  assert.notEqual(componentCommentDraftKey({ ...selection, targetId: 'opening:subtitle' }), key);
  assert.notEqual(componentCommentDraftKey({ blockId: 'opening', page: 2 }), key);
  assert.equal(componentCommentDraftKey(null), '');
});

test('phrase drafts remain separate from other phrases and legacy whole-block drafts', () => {
  const store = createCommentDraftStore(() => undefined);
  const originalKey = commentDraftKey(selection);
  const secondKey = commentDraftKey({ ...selection, start: 14, end: 19 });
  const blockKey = commentDraftKey({ blockId: 'opening', page: 1 });
  assert.equal(blockKey, 'opening');
  assert.notEqual(originalKey, secondKey);
  store.set('report', originalKey, 'Explain this phrase.');
  store.set('report', secondKey, 'Different note.');
  store.set('report', blockKey, 'Older paragraph note.');
  store.clearSubmitted('report', originalKey, 'Explain this phrase.');
  assert.equal(store.read('report')[secondKey], 'Different note.');
  assert.equal(store.read('report')[blockKey], 'Older paragraph note.');
  assert.equal(commentDraftKey(null), '');
});

test('Shift, Ctrl and Cmd add to the selection, so Cmd-click works on macOS where Ctrl-click is the context menu', () => {
  const none = { shiftKey: false, ctrlKey: false, metaKey: false };
  assert.equal(addsToSelection(none), false);
  assert.equal(addsToSelection({ ...none, shiftKey: true }), true);
  assert.equal(addsToSelection({ ...none, ctrlKey: true }), true);
  assert.equal(addsToSelection({ ...none, metaKey: true }), true);
});

test('a comment on several components keeps its own draft, whichever order they were chosen in', () => {
  const first = componentCommentDraftKey(selection);
  const others: DocumentSelection[] = [{ blockId: 'closing', page: 3 }, { blockId: 'chart', page: 2 }];
  const key = multiCommentDraftKey(first, others);
  assert.notEqual(key, first, 'The first component alone has its own draft.');
  assert.equal(multiCommentDraftKey(first, [...others].reverse()), key);
  assert.notEqual(multiCommentDraftKey(first, others.slice(0, 1)), key);
  assert.notEqual(multiCommentDraftKey(commentDraftKey(selection), others), key, 'A phrase first is a different comment.');
  assert.equal(multiCommentDraftKey(first, []), '');
  assert.equal(multiCommentDraftKey('', others), '');
});
