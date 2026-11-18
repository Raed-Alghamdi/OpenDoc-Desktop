import test from 'node:test';
import assert from 'node:assert/strict';
import { writeFile, readFile, symlink, mkdir, utimes } from 'node:fs/promises';
import { resolve } from 'node:path';
import { addComment, changeComment, editComment, deleteComment, restoreComment, readComments, Conflict } from '../src/server/comments';
import { documentEntry } from '../src/server/render';
import { Workspace } from '../src/server/workspace';
import { getBlock } from '../src/shared/types';
import { fixture, settled, source } from './helpers';

test('concurrent feedback is retained and stale updates are rejected', async () => {
  const f = await fixture();
  try {
    await Promise.all(Array.from({ length: 8 }, (_, i) => addComment(f.root, 'proof', { blockId: 'target', text: `Comment ${i}`, quote: 'Paragraph' })));
    const rows = await readComments(f.root, 'proof');
    assert.equal(rows.length, 8); assert.equal(new Set(rows.map(c => c.id)).size, 8);
    await changeComment(f.root, 'proof', rows[0].id, 'resolved', 1);
    await assert.rejects(changeComment(f.root, 'proof', rows[0].id, 'open', 1), Conflict);
  } finally { await f.cleanup(); }
});

test('invalid feedback and traversal do not overwrite or expose files', async () => {
  const f = await fixture();
  try {
    const path = resolve(f.root, 'documents/proof/comments.json');
    await writeFile(path, '{ invalid');
    await assert.rejects(addComment(f.root, 'proof', { blockId: 'target', text: 'Hello', quote: '' }));
    assert.equal(await readFile(path, 'utf8'), '{ invalid');
    await assert.rejects(documentEntry(f.root, '../outside'), /Invalid document ID/);
    await symlink(resolve(f.root, 'src'), resolve(f.root, 'documents/escaped'));
    await assert.rejects(documentEntry(f.root, 'escaped'));
  } finally { await f.cleanup(); }
});

test('phrase anchors retain exact text and history beside legacy block comments', async () => {
  const f = await fixture();
  try {
    const quote = 'An exact phrase '.repeat(40);
    const anchor = { targetId: 'target:text', start: 3, end: 3 + quote.length, quote, prefix: 'An ', suffix: ' follows.' };
    await addComment(f.root, 'proof', { blockId: 'target', text: 'Review the selected wording.', quote, anchor });
    await addComment(f.root, 'proof', { blockId: 'target', text: 'Legacy whole-block feedback.', quote: 'Paragraph' });
    let rows = await readComments(f.root, 'proof');
    assert.deepEqual(rows[0].anchor, anchor);
    assert.equal(rows[0].quote, quote, 'Precise anchors must not truncate a selected passage.');
    assert.equal(rows[1].anchor, undefined);
    rows = await changeComment(f.root, 'proof', rows[0].id, 'resolved', 1);
    rows = await changeComment(f.root, 'proof', rows[0].id, 'open', 2);
    assert.deepEqual(rows[0].anchor, anchor);
    assert.deepEqual(rows[0].history.map(item => item.action), ['created', 'resolved', 'reopened']);
    await assert.rejects(addComment(f.root, 'proof', { blockId: 'target', text: 'Bad anchor', quote, anchor: { ...anchor, end: 4 } }), /phrase again/);
  } finally { await f.cleanup(); }
});

test('a constructor block is a valid comment target only while it is actually present', async () => {
  const f = await fixture();
  const workspace = new Workspace(f.root);
  try {
    await writeFile(f.entry, source('<Paragraph id="constructor">A real paragraph with a valid ID.</Paragraph>'));
    await workspace.refresh(); await settled(workspace);
    const artifact = workspace.states.get('proof')!.artifact!;
    const block = getBlock(artifact, 'constructor');
    assert.equal(block?.id, 'constructor');
    assert.equal(getBlock(artifact, 'toString'), undefined);
    await addComment(f.root, 'proof', { blockId: 'constructor', text: 'Keep this feedback when the passage is removed.', quote: block!.text });
    await workspace.setContext({ documentId: 'proof', blockId: 'constructor', page: 1 });
    const before = JSON.parse(await readFile(resolve(f.root, '.opendoc/current.json'), 'utf8'));
    assert.equal(before.selectedBlock.id, 'constructor');
    assert.equal(before.pendingComments[0].targetAvailable, true);

    await writeFile(f.entry, source());
    await workspace.refresh(); await settled(workspace); await workspace.writeContext();
    assert.equal(getBlock(workspace.states.get('proof')!.artifact, 'constructor'), undefined);
    const after = JSON.parse(await readFile(resolve(f.root, '.opendoc/current.json'), 'utf8'));
    assert.equal(after.selectedBlock, null);
    assert.equal(after.source, null);
    assert.equal(after.pendingComments[0].blockId, 'constructor');
    assert.equal(after.pendingComments[0].targetAvailable, false);
    assert.equal((await readComments(f.root, 'proof')).length, 1);
  } finally { await workspace.close(); await f.cleanup(); }
});

test('editing and deleting feedback checks versions and retains its history', async () => {
  const f = await fixture();
  try {
    const [original] = await addComment(f.root, 'proof', { blockId: 'target', text: 'First comment.', quote: 'stable' });
    const [edited] = await editComment(f.root, 'proof', original.id, 'Updated comment.', original.version);
    assert.equal(edited.text, 'Updated comment.');
    assert.equal(edited.quote, original.quote);
    assert.equal(edited.history.at(-1)?.previousText, 'First comment.');
    await assert.rejects(() => deleteComment(f.root, 'proof', original.id, original.version), Conflict);
    await assert.rejects(() => editComment(f.root, 'proof', original.id, 'Stale change.', original.version), Conflict);
    await assert.rejects(() => editComment(f.root, 'proof', original.id, ' ', edited.version));
    const [deleted] = await deleteComment(f.root, 'proof', original.id, edited.version);
    assert.equal(deleted.status, 'deleted');
    assert.equal(deleted.text, 'Updated comment.');
    assert.deepEqual(deleted.history.map(event => event.action), ['created', 'edited', 'deleted']);
    assert.equal((await readComments(f.root, 'proof'))[0].status, 'deleted');
    await assert.rejects(() => changeComment(f.root, 'proof', original.id, 'open', deleted.version), Conflict);
    await assert.rejects(() => restoreComment(f.root, 'proof', original.id, edited.version), Conflict);
    const [restored] = await restoreComment(f.root, 'proof', original.id, deleted.version);
    assert.deepEqual({ ...restored, status: deleted.status, version: deleted.version, updatedAt: deleted.updatedAt, history: deleted.history }, deleted);
    assert.equal(restored.status, 'open');
    assert.deepEqual(restored.history.map(event => event.action), ['created', 'edited', 'deleted', 'restored']);
    await assert.rejects(() => restoreComment(f.root, 'proof', original.id, deleted.version), Conflict);
    const [resolved] = await changeComment(f.root, 'proof', original.id, 'resolved', restored.version);
    const [deletedAgain] = await deleteComment(f.root, 'proof', original.id, resolved.version);
    assert.equal((await restoreComment(f.root, 'proof', original.id, deletedAgain.version))[0].status, 'resolved');
  } finally { await f.cleanup(); }
});

test('malformed saved records and duplicate comment IDs never get silently rewritten', async () => {
  const f = await fixture();
  try {
    const [comment] = await addComment(f.root, 'proof', { blockId: 'target', text: 'Keep this feedback.', quote: 'stable' });
    const file = resolve(f.root, 'documents/proof/comments.json');
    for (const invalid of [
      [comment, comment], [{ ...comment, quote: undefined }], [{ ...comment, version: 0 }],
      [{ ...comment, history: [null] }], [{ ...comment, history: [{ at: comment.createdAt, action: 'unknown' }] }],
      [{ ...comment, updatedAt: 'invalid' }],
    ]) {
      const original = JSON.stringify(invalid);
      await writeFile(file, original);
      await assert.rejects(changeComment(f.root, 'proof', comment.id, 'resolved', 1), /Invalid comments file/);
      assert.equal(await readFile(file, 'utf8'), original);
    }
  } finally { await f.cleanup(); }
});

test('feedback recovers abandoned locks from interrupted and dead sessions', async () => {
  const f = await fixture();
  try {
    const lock = resolve(f.root, '.opendoc/locks/proof.lock');
    for (const owner of [undefined, '{ interrupted', JSON.stringify({ pid: 2_147_483_647 })]) {
      await mkdir(lock, { recursive: true });
      if (owner !== undefined) await writeFile(resolve(lock, 'owner.json'), owner);
      const old = new Date(Date.now() - 60_000);
      await utimes(lock, old, old);
      await addComment(f.root, 'proof', { blockId: 'target', text: 'Recovered feedback.', quote: 'stable' });
    }
    assert.equal((await readComments(f.root, 'proof')).length, 3);
    await mkdir(lock);
    await writeFile(resolve(lock, 'owner.json'), JSON.stringify({ pid: process.pid }));
    const old = new Date(Date.now() - 60_000);
    await utimes(lock, old, old);
    await assert.rejects(addComment(f.root, 'proof', { blockId: 'target', text: 'Must wait for the live owner.', quote: 'stable' }), Conflict);
    assert.equal((await readComments(f.root, 'proof')).length, 3);
  } finally { await f.cleanup(); }
});

const phrase = (targetId: string, quote: string) => ({ targetId, start: 3, end: 3 + quote.length, quote, prefix: 'An ', suffix: ' follows.' });

test('a comment on one place is stored exactly as before, with no targets field', async () => {
  const f = await fixture();
  try {
    const [single] = await addComment(f.root, 'proof', { blockId: 'target', text: 'One place.', quote: 'Paragraph' });
    const rows = await addComment(f.root, 'proof', { text: 'A list of one place.', targets: [{ blockId: 'title', quote: 'Heading' }] });
    assert.equal('targets' in single, false);
    assert.deepEqual(Object.keys(single), ['id', 'blockId', 'text', 'quote', 'status', 'createdAt', 'updatedAt', 'version', 'history']);
    assert.equal(rows.length, 2);
    assert.equal('targets' in rows[1], false, 'A list of one place is the single-place shape.');
    const file = resolve(f.root, 'documents/proof/comments.json');
    const before = await readFile(file, 'utf8');
    await changeComment(f.root, 'proof', single.id, 'resolved', 1);
    await changeComment(f.root, 'proof', single.id, 'open', 2);
    assert.deepEqual(JSON.parse(await readFile(file, 'utf8')).map((row: { targets?: unknown }) => row.targets), [undefined, undefined]);
    assert.equal(before.includes('targets'), false);
  } finally { await f.cleanup(); }
});

test('a comment on three places round-trips and keeps them through every whole-comment change', async () => {
  const f = await fixture();
  try {
    const quote = 'exact phrase';
    const anchor = phrase('title:text', quote);
    const places = [{ blockId: 'title', quote, anchor }, { blockId: 'target', quote: 'A stable paragraph' }, { blockId: 'last', quote: 'Closing line' }];
    const rows = await addComment(f.root, 'proof', { text: 'Make these three agree.', targets: places });
    const [made] = rows;
    assert.deepEqual(made.targets, places);
    assert.equal(made.blockId, 'title'); assert.equal(made.quote, quote); assert.deepEqual(made.anchor, anchor);
    assert.deepEqual(await readComments(f.root, 'proof'), rows);
    const file = resolve(f.root, 'documents/proof/comments.json');
    assert.deepEqual(JSON.parse(await readFile(file, 'utf8'))[0].targets, places);

    let [row] = await changeComment(f.root, 'proof', made.id, 'resolved', 1);
    assert.equal(row.status, 'resolved'); assert.deepEqual(row.targets, places);
    [row] = await changeComment(f.root, 'proof', made.id, 'open', 2);
    [row] = await editComment(f.root, 'proof', made.id, 'Make them agree.', 3);
    [row] = await deleteComment(f.root, 'proof', made.id, 4);
    assert.equal(row.status, 'deleted'); assert.deepEqual(row.targets, places);
    [row] = await restoreComment(f.root, 'proof', made.id, 5);
    assert.equal(row.status, 'open'); assert.deepEqual(row.targets, places);
    assert.deepEqual(row.history.map(event => event.action), ['created', 'resolved', 'reopened', 'edited', 'deleted', 'restored']);
    assert.equal(row.version, 6);
  } finally { await f.cleanup(); }
});

test('places are validated one by one and a block can be named only once', async () => {
  const f = await fixture();
  try {
    const place = { blockId: 'target', quote: 'Paragraph' };
    await assert.rejects(addComment(f.root, 'proof', { text: 'x', targets: [place, { ...place }] }), /once/);
    await assert.rejects(addComment(f.root, 'proof', { text: 'x', targets: [place, { blockId: '', quote: 'q' }] }), /Select a document element/);
    await assert.rejects(addComment(f.root, 'proof', { text: 'x', targets: [place, { blockId: 'title', quote: 7 as unknown as string }] }), /again before commenting/);
    await assert.rejects(addComment(f.root, 'proof', { text: 'x', targets: [place, { blockId: 'title', quote: 'q', anchor: { ...phrase('title:text', 'q'), end: 99 } }] }), /phrase again/);
    await assert.rejects(addComment(f.root, 'proof', { text: 'x', targets: [] }), /Select a document element/);
    // A place's own fields beside a list are a type error and a runtime error, never silently ignored.
    const second = { blockId: 'title', quote: 'q' };
    // @ts-expect-error blockId and quote belong to a single place
    await assert.rejects(addComment(f.root, 'proof', { text: 'x', blockId: 'target', quote: 'q', targets: [place, second] }), /either one place/);
    // @ts-expect-error exactQuote belongs to a single place
    await assert.rejects(addComment(f.root, 'proof', { text: 'x', exactQuote: true, targets: [place, second] }), /either one place/);
    // @ts-expect-error anchor belongs to a single place
    await assert.rejects(addComment(f.root, 'proof', { text: 'x', anchor: phrase('title:text', 'q'), targets: [place, second] }), /either one place/);
    await assert.rejects(addComment(f.root, 'proof', { text: 'x', targets: Array.from({ length: 201 }, (_, i) => ({ blockId: `b${i}`, quote: 'q' })) }), /at most 200/);
    await assert.rejects(addComment(f.root, 'proof', { text: ' ', targets: [place, { blockId: 'title', quote: 'q' }] }), /between 1 and 8,000/);
    assert.deepEqual(await readComments(f.root, 'proof'), [], 'A refused comment writes nothing.');
    const long = 'w'.repeat(900);
    const [row] = await addComment(f.root, 'proof', { text: 'Lengths.', targets: [{ blockId: 'target', quote: long }, { blockId: 'title', quote: long, exactQuote: true }] });
    assert.equal(row.quote.length, 500);
    assert.equal(row.targets![1].quote.length, 900, 'Each place keeps its own exact-quote choice.');
  } finally { await f.cleanup(); }
});

test('saved targets that do not match the top-level fields are never silently rewritten', async () => {
  const f = await fixture();
  try {
    const [comment] = await addComment(f.root, 'proof', { text: 'Keep this feedback.', targets: [{ blockId: 'target', quote: 'a' }, { blockId: 'title', quote: 'b' }] });
    const file = resolve(f.root, 'documents/proof/comments.json');
    for (const invalid of [
      { ...comment, targets: [] }, { ...comment, targets: 'target' }, { ...comment, targets: [null, comment.targets![1]] },
      { ...comment, targets: [{ ...comment.targets![0], blockId: 'other' }, comment.targets![1]] },
      { ...comment, targets: [{ ...comment.targets![0], quote: 'changed' }, comment.targets![1]] },
      { ...comment, targets: [comment.targets![0], { blockId: '', quote: 'b' }] },
      { ...comment, targets: [comment.targets![0], { blockId: 'title', quote: 'b', anchor: { targetId: 'x' } }] },
    ]) {
      const original = JSON.stringify([invalid]);
      await writeFile(file, original);
      await assert.rejects(changeComment(f.root, 'proof', comment.id, 'resolved', 1), /Invalid comments file/);
      assert.equal(await readFile(file, 'utf8'), original);
    }
  } finally { await f.cleanup(); }
});

test('the place cap and a one-entry targets list apply when a comment is made, never when the file is read', async () => {
  const f = await fixture();
  try {
    const file = resolve(f.root, 'documents/proof/comments.json');
    const [made] = await addComment(f.root, 'proof', { text: 'Two places.', targets: [{ blockId: 'target', quote: 'a' }, { blockId: 'title', quote: 'b' }] });
    const write = (row: object) => writeFile(file, JSON.stringify([row], null, 2) + '\n');

    const many = Array.from({ length: 201 }, (_, i) => ({ blockId: i ? `b${i}` : 'target', quote: i ? 'q' : 'a' }));
    await write({ ...made, targets: many });
    assert.equal((await readComments(f.root, 'proof'))[0].targets!.length, 201, 'A file with 201 places stays readable.');
    const [resolved] = await changeComment(f.root, 'proof', made.id, 'resolved', 1);
    assert.equal(resolved.targets!.length, 201, 'and writable, keeping every place.');

    const one = { ...made, targets: [made.targets![0]] };
    await write(one);
    const bytes = await readFile(file, 'utf8');
    assert.deepEqual((await readComments(f.root, 'proof'))[0].targets, [made.targets![0]], 'A one-place targets list is tolerated on read.');
    await changeComment(f.root, 'proof', made.id, 'open', 1);
    assert.equal(await readFile(file, 'utf8'), bytes, 'and rewritten byte for byte.');
    await changeComment(f.root, 'proof', made.id, 'resolved', 1);
    assert.deepEqual(JSON.parse(await readFile(file, 'utf8'))[0].targets, one.targets);
    const single = (await addComment(f.root, 'proof', { text: 'Never written.', targets: [{ blockId: 'target', quote: 'a' }] })).at(-1)!;
    assert.equal(single.targets, undefined, 'This version never writes a one-place list.');
  } finally { await f.cleanup(); }
});
