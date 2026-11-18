import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { pathToFileURL } from 'node:url';
import { addComment, changeComment, readComments } from '../src/server/comments';
import { selectionContext } from '../src/server/selection';
import { Workspace } from '../src/server/workspace';
import { commentTargetsForSelections, resolveCommentTargets } from '../src/shared/anchors';
import { fixture, projectRoot, settled, source } from './helpers';

const extra = '<Paragraph id="second">The second place to review.</Paragraph><Paragraph id="third">The third place to review.</Paragraph>';
const current = async (root: string) => JSON.parse(await readFile(resolve(root, '.opendoc/current.json'), 'utf8'));

test('removing one block of a three-place comment marks only that place missing, and the file keeps all three', async () => {
  const f = await fixture();
  const workspace = new Workspace(f.root);
  try {
    await writeFile(f.entry, source(extra));
    await workspace.refresh(); await settled(workspace);
    const artifact = workspace.states.get('proof')!.artifact!;
    const places = commentTargetsForSelections(artifact, [{ blockId: 'target', page: 1 }, { blockId: 'second', page: 1 }, { blockId: 'third', page: 1 }]);
    await addComment(f.root, 'proof', { text: 'Make the three agree.', targets: places });
    const [comment] = await readComments(f.root, 'proof');
    assert.deepEqual(comment.targets!.map(place => place.blockId), ['target', 'second', 'third']);
    assert.deepEqual(resolveCommentTargets(artifact, comment).map(place => place.anchorStatus), ['attached', 'attached', 'attached']);

    await workspace.setContext({ documentId: 'proof', blockId: 'target', page: 1 }); await workspace.writeContext();
    assert.equal((await current(f.root)).pendingComments[0].anchorStatus, 'attached');

    await writeFile(f.entry, source('<Paragraph id="third">The third place to review.</Paragraph>'));
    await workspace.refresh(); await settled(workspace); await workspace.writeContext();
    const after = workspace.states.get('proof')!.artifact!;
    assert.deepEqual(resolveCommentTargets(after, comment).map(place => [place.blockId, place.anchorStatus]), [['target', 'attached'], ['second', 'missing'], ['third', 'attached']]);
    const pending = (await current(f.root)).pendingComments[0];
    assert.equal(pending.anchorStatus, 'missing', 'The comment reports its worst place.');
    assert.equal(pending.targetAvailable, false);
    assert.deepEqual(pending.targets.map((place: { blockId: string; anchorStatus: string; targetAvailable: boolean }) => [place.blockId, place.anchorStatus, place.targetAvailable]),
      [['target', 'attached', true], ['second', 'missing', false], ['third', 'attached', true]], 'Each place reports its own status.');
    assert.deepEqual(pending.targets.map((place: { blockId: string; quote: string }) => [place.blockId, place.quote]), comment.targets!.map(place => [place.blockId, place.quote]));
    assert.deepEqual(await readComments(f.root, 'proof'), [comment], 'Nothing is rewritten or dropped.');
  } finally { await workspace.close(); await f.cleanup(); }
});

test('current.json carries selections and selection stays the first of them', async () => {
  const f = await fixture();
  const workspace = new Workspace(f.root);
  try {
    await writeFile(f.entry, source(extra));
    await workspace.refresh(); await settled(workspace);
    const list = [{ blockId: 'second', page: 1 }, { blockId: 'third', page: 1 }, { blockId: 'target', page: 1 }];
    await workspace.setContext({ documentId: 'proof', blockId: 'second', page: 1, ...selectionContext(list) });
    const written = await current(f.root);
    assert.deepEqual(written.selections, list);
    assert.equal(list.length, 3);
    assert.deepEqual(written.selection, written.selections[0]);
    assert.equal(written.selectedBlock.id, 'second');
    await workspace.setContext({ documentId: 'proof', blockId: 'second', page: 1, ...selectionContext([]) });
    assert.deepEqual(await current(f.root).then(value => [value.selection, value.selections]), [null, []]);
  } finally { await workspace.close(); await f.cleanup(); }
});

/**
 * npm 0.6.1's own comment code reads and rewrites a file that has `targets`. The two files in
 * tests/fixtures/opendoc-0.6.1 are `src/server/comments.ts` and `files.ts` of the published
 * @ryanyahya/opendoc@0.6.1, verified as described in that folder's README; only the document
 * lookup is replaced by a stub, as the real one needs the whole render stack.
 */
test('npm 0.6.1 reads, rewrites and edits a comment with targets without losing them', async () => {
  const f = await fixture();
  const scratch = await mkdtemp(resolve(tmpdir(), 'opendoc-0.6.1-'));
  try {
    const server = resolve(scratch, 'server');
    await mkdir(server, { recursive: true });
    for (const name of ['comments', 'files']) await writeFile(resolve(server, `${name}.ts`), await readFile(resolve(projectRoot, `tests/fixtures/opendoc-0.6.1/${name}.ts.txt`)));
    await writeFile(resolve(server, 'render.ts'), "import { resolve } from 'node:path';\nexport async function documentEntry(root: string, id: string) { return resolve(root, 'documents', id, 'index.tsx'); }\n");
    const old = await import(pathToFileURL(resolve(server, 'comments.ts')).href) as typeof import('../src/server/comments');

    const anchor = { targetId: 'title:text', start: 3, end: 15, quote: 'exact phrase', prefix: 'An ', suffix: ' follows.' };
    const places = [{ blockId: 'title', quote: 'exact phrase', anchor }, { blockId: 'target', quote: 'A stable paragraph' }, { blockId: 'last', quote: 'Closing line' }];
    const [made] = await addComment(f.root, 'proof', { text: 'Three places.', targets: places });
    assert.deepEqual((await old.readComments(f.root, 'proof'))[0].targets, places, '0.6.1 reads the file.');

    let [row] = await old.changeComment(f.root, 'proof', made.id, 'resolved', 1);
    [row] = await old.editComment(f.root, 'proof', made.id, 'Edited by 0.6.1.', 2);
    const [legacy] = (await old.addComment(f.root, 'proof', { blockId: 'target', text: 'Added by 0.6.1.', quote: 'x' })).slice(-1);
    [row] = await old.deleteComment(f.root, 'proof', made.id, 3);
    [row] = await old.restoreComment(f.root, 'proof', made.id, 4);
    assert.equal(row.version, 5);
    const saved = JSON.parse(await readFile(resolve(f.root, 'documents/proof/comments.json'), 'utf8'));
    assert.deepEqual(saved[0].targets, places, '0.6.1 rewrites the file without dropping targets.');
    assert.equal('targets' in saved[1], false);

    const rows = await readComments(f.root, 'proof');
    assert.deepEqual(rows[0].targets, places);
    assert.equal(rows[0].text, 'Edited by 0.6.1.');
    assert.equal(rows[1].id, legacy.id);
    const [reopened] = await changeComment(f.root, 'proof', made.id, 'resolved', 5);
    assert.equal(reopened.status, 'resolved');
  } finally { await rm(scratch, { recursive: true, force: true }); await f.cleanup(); }
});

test('a rewrite of a single-place file by either version is byte-stable and adds no targets', async () => {
  const f = await fixture();
  const scratch = await mkdtemp(resolve(tmpdir(), 'opendoc-0.6.1-'));
  try {
    const server = resolve(scratch, 'server');
    await mkdir(server, { recursive: true });
    for (const name of ['comments', 'files']) await writeFile(resolve(server, `${name}.ts`), await readFile(resolve(projectRoot, `tests/fixtures/opendoc-0.6.1/${name}.ts.txt`)));
    await writeFile(resolve(server, 'render.ts'), "import { resolve } from 'node:path';\nexport async function documentEntry(root: string, id: string) { return resolve(root, 'documents', id, 'index.tsx'); }\n");
    const old = await import(pathToFileURL(resolve(server, 'comments.ts')).href) as typeof import('../src/server/comments');
    const file = resolve(f.root, 'documents/proof/comments.json');
    const anchor = { targetId: 'title:text', start: 3, end: 15, quote: 'exact phrase', prefix: 'An ', suffix: ' follows.' };
    const [first] = await old.addComment(f.root, 'proof', { blockId: 'title', text: 'Phrase comment.', quote: 'exact phrase', anchor });
    await old.addComment(f.root, 'proof', { blockId: 'target', text: 'Block comment.', quote: 'Paragraph' });
    const written = await readFile(file, 'utf8');
    await changeComment(f.root, 'proof', first.id, 'open', 1);
    assert.equal(await readFile(file, 'utf8'), written, 'A no-op rewrite by this version reproduces a 0.6.1 file byte for byte.');
    await changeComment(f.root, 'proof', first.id, 'resolved', 1); await old.changeComment(f.root, 'proof', first.id, 'open', 2);
    assert.equal((await readFile(file, 'utf8')).includes('targets'), false);
    // Reading and writing the same rows is stable: this version serialises what 0.6.1 serialised.
    const rows = await readComments(f.root, 'proof');
    assert.equal(JSON.stringify(rows, null, 2) + '\n', await readFile(file, 'utf8'));
  } finally { await rm(scratch, { recursive: true, force: true }); await f.cleanup(); }
});

test('current.json lists selections even when the context names only one, and a single-place comment keeps its keys', async () => {
  const f = await fixture();
  const workspace = new Workspace(f.root);
  try {
    await writeFile(f.entry, source(extra));
    await workspace.refresh(); await settled(workspace);
    const [single] = await addComment(f.root, 'proof', { blockId: 'target', text: 'One place.', quote: 'A stable paragraph' });
    await workspace.setContext({ documentId: 'proof', blockId: 'target', page: 1, selection: { blockId: 'target', page: 1 } });
    const written = await current(f.root);
    assert.deepEqual(written.selections, [{ blockId: 'target', page: 1 }]);
    assert.deepEqual(written.selection, written.selections[0]);
    assert.deepEqual(Object.keys(written.pendingComments[0]).sort(), [...Object.keys(single), 'targetAvailable', 'anchorStatus', 'selection'].sort());
    assert.equal('targets' in written.pendingComments[0], false);
    await workspace.setContext({ documentId: 'proof', blockId: null, page: 1 });
    assert.deepEqual(await current(f.root).then(value => [value.selection, value.selections]), [null, []]);
  } finally { await workspace.close(); await f.cleanup(); }
});
