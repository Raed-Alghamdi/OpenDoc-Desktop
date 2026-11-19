import test, { type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { fixture } from './helpers';
import { runCommentsCli } from '../src/server/comments-cli';
import { addComment, deleteComment, editComment, readComments } from '../src/server/comments';

function output(t: TestContext) {
  const lines: string[] = [];
  t.mock.method(console, 'log', (line: string) => { lines.push(line); });
  t.mock.method(console, 'error', () => {});
  return () => lines.splice(0);
}

test('comments edit replaces the text, keeps the earlier text in history, and prints the comment', async t => {
  const f = await fixture();
  const lines = output(t);
  try {
    const [original] = await addComment(f.root, 'proof', { blockId: 'target', text: 'First comment.', quote: 'stable' });
    await runCommentsCli(['edit', 'proof', original.id, 'A', 'sharper', 'comment.', '--json'], f.root, { mode: 'direct' });
    const edited = JSON.parse(lines().at(-1)!);
    assert.equal(edited.id, original.id);
    assert.equal(edited.text, 'A sharper comment.');
    assert.equal(edited.version, original.version + 1);
    assert.deepEqual(edited.history.at(-1), { at: edited.history.at(-1).at, action: 'edited', previousText: 'First comment.' });
    assert.equal((await readComments(f.root, 'proof'))[0].text, 'A sharper comment.');
    await runCommentsCli(['edit', 'proof', original.id, 'Plain output.'], f.root, { mode: 'direct' });
    assert.deepEqual(lines(), [`Edited ${original.id}`]);
    // The version the caller last saw is accepted while it is still current.
    const current = (await readComments(f.root, 'proof'))[0];
    await runCommentsCli(['edit', 'proof', original.id, 'Checked edit.', '--expected-version', String(current.version), '--json'], f.root, { mode: 'direct' });
    assert.equal(JSON.parse(lines().at(-1)!).text, 'Checked edit.');
  } finally { await f.cleanup(); }
});

test('comments edit refuses a version conflict and leaves the comment unchanged', async t => {
  const f = await fixture();
  output(t);
  try {
    const [original] = await addComment(f.root, 'proof', { blockId: 'target', text: 'First comment.', quote: 'stable' });
    await editComment(f.root, 'proof', original.id, 'Changed elsewhere.', original.version);
    const before = JSON.stringify(await readComments(f.root, 'proof'));
    await assert.rejects(runCommentsCli(['edit', 'proof', original.id, 'Stale change.', '--expected-version', String(original.version), '--json'], f.root, { mode: 'direct' }), /changed elsewhere/);
    assert.equal(JSON.stringify(await readComments(f.root, 'proof')), before);
    await assert.rejects(runCommentsCli(['edit', 'proof', original.id, 'Text.', '--expected-version', 'two'], f.root, { mode: 'direct' }), /whole comment version/);
    await assert.rejects(runCommentsCli(['edit', 'proof', original.id, 'Text.', '--expected-version', '0'], f.root, { mode: 'direct' }), /whole comment version/);
    assert.equal(JSON.stringify(await readComments(f.root, 'proof')), before);
  } finally { await f.cleanup(); }
});

test('comments edit does not touch a deleted or missing comment, and --expected-version belongs to edit', async t => {
  const f = await fixture();
  output(t);
  try {
    const [original] = await addComment(f.root, 'proof', { blockId: 'target', text: 'First comment.', quote: 'stable' });
    await deleteComment(f.root, 'proof', original.id, original.version);
    const before = JSON.stringify(await readComments(f.root, 'proof'));
    await assert.rejects(runCommentsCli(['edit', 'proof', original.id, 'Too late.', '--json'], f.root, { mode: 'direct' }), /Comment not found/);
    await assert.rejects(runCommentsCli(['edit', 'proof', 'no-such-comment', 'Nowhere.'], f.root, { mode: 'direct' }), /Comment not found/);
    await assert.rejects(runCommentsCli(['edit', 'proof', original.id], f.root, { mode: 'direct' }), /Unknown comments command or missing arguments/);
    await assert.rejects(runCommentsCli(['resolve', 'proof', original.id, '--expected-version', '1'], f.root, { mode: 'direct' }), /belongs to comments edit/);
    assert.equal(JSON.stringify(await readComments(f.root, 'proof')), before);
  } finally { await f.cleanup(); }
});
