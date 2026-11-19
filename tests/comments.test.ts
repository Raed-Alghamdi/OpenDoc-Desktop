import test, { type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { writeFile, readFile, symlink, mkdir, utimes } from 'node:fs/promises';
import { resolve } from 'node:path';
import { addComment, changeComment, editComment, deleteComment, restoreComment, readComments, Conflict } from '../src/server/comments';
import { documentEntry } from '../src/server/render';
import { Workspace } from '../src/server/workspace';
import { getBlock, type Comment } from '../src/shared/types';
import { fixture, settled, source, until } from './helpers';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { runCommentsCli } from '../src/server/comments-cli';
import { createOpenDocService } from '../src/server/service';

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

// --- The CLI and the service: several places in one comment ---------------------------------------

const second = '<Paragraph id="second">The second place to review.</Paragraph><Paragraph id="third">The third place to review.</Paragraph>';
function lines(t: TestContext) {
  const out: string[] = [];
  t.mock.method(console, 'log', (line: string) => { out.push(line); });
  t.mock.method(console, 'error', () => {});
  return () => out.splice(0);
}
const savedComments = async (root: string) => JSON.parse(await readFile(resolve(root, 'documents/proof/comments.json'), 'utf8')) as Comment[];

test('comments add --also puts one comment on several places, and a plain add is stored as before', { timeout: 60_000 }, async t => {
  const f = await fixture();
  const out = lines(t);
  try {
    await writeFile(f.entry, source(second));
    await runCommentsCli(['add', 'proof', 'target', 'Plain', 'comment.'], f.root, { mode: 'direct' });
    assert.equal(out().at(-1), 'Added comment on target');
    assert.equal('targets' in (await savedComments(f.root))[0], false, 'Without --also the comment has no targets.');

    await runCommentsCli(['add', 'proof', 'title', 'Make', 'these', 'agree.', '--phrase', 'first draft', '--also', 'second', '--also-phrase', 'second place', '--also', 'third', '--json'], f.root, { mode: 'direct' });
    const printed = JSON.parse(out().at(-1)!) as Comment[];
    const [made] = (await savedComments(f.root)).slice(-1);
    assert.deepEqual(printed.at(-1), made);
    assert.deepEqual(made.targets!.map(place => place.blockId), ['title', 'second', 'third']);
    assert.equal(made.blockId, 'title'); assert.equal(made.quote, 'first draft'); assert.deepEqual(made.anchor, made.targets![0].anchor);
    assert.equal(made.targets![0].anchor?.quote, 'first draft');
    assert.equal(made.targets![1].anchor?.quote, 'second place', 'A later place can carry its own phrase.');
    assert.equal(made.targets![1].quote, 'second place');
    assert.equal(made.targets![2].anchor, undefined);
    assert.equal(made.targets![2].quote, 'The third place to review.');
    await runCommentsCli(['add', 'proof', 'target', 'Two.', '--also', 'third'], f.root, { mode: 'direct' });
    assert.equal(out().at(-1), 'Added comment on target, third');
    await runCommentsCli(['add', 'proof', 'target', 'Phrases.', '--phrase', 'stable paragraph', '--also', 'second', '--also-phrase', 'second place'], f.root, { mode: 'direct' });
    assert.equal(out().at(-1), 'Added comment on target at “stable paragraph”, second at “second place”');
  } finally { await f.cleanup(); }
});

test('comments add --also refuses what it cannot place, and writes nothing', { timeout: 60_000 }, async t => {
  const f = await fixture();
  lines(t);
  try {
    await writeFile(f.entry, source(second));
    const add = (...args: string[]) => runCommentsCli(['add', 'proof', 'target', 'Text.', ...args], f.root, { mode: 'direct' });
    await assert.rejects(add('--also', 'target'), /once/);
    await assert.rejects(add('--also', 'second', '--also', 'second'), /once/);
    await assert.rejects(add('--also', 'no-such-block'), /no-such-block does not exist/);
    await assert.rejects(add('--also-phrase', 'words'), /after the --also it belongs to/);
    await assert.rejects(add('--also-target', 'second:children'), /after the --also it belongs to/);
    await assert.rejects(add('--also', 'second', '--also-target', 'second:children'), /with --also-phrase/);
    await assert.rejects(add('--also', 'second', '--also-phrase', 'a', '--also-phrase', 'b'), /one --also-phrase/);
    await assert.rejects(add('--also', 'second', '--also-phrase', 'absent words'), /does not appear/);
    await assert.rejects(runCommentsCli(['list', 'proof', '--also', 'second'], f.root, { mode: 'direct' }), /belongs to comments add/);
    await assert.rejects(runCommentsCli(['resolve', 'proof', 'x', '--also-phrase', 'a'], f.root, { mode: 'direct' }), /belongs to comments add/);
    await assert.rejects(readFile(resolve(f.root, 'documents/proof/comments.json'), 'utf8'), { code: 'ENOENT' });
  } finally { await f.cleanup(); }
});

test('comments list --anchors gives each place its status and the comment the worst, single places unchanged', { timeout: 60_000 }, async t => {
  const f = await fixture();
  const out = lines(t);
  try {
    await writeFile(f.entry, source(second));
    await runCommentsCli(['add', 'proof', 'target', 'Single.'], f.root, { mode: 'direct' });
    await runCommentsCli(['add', 'proof', 'target', 'Three.', '--also', 'second', '--also', 'third'], f.root, { mode: 'direct' });
    out();
    const anchors = async () => { await runCommentsCli(['list', 'proof', '--anchors'], f.root, { mode: 'direct' }); return JSON.parse(out().at(-1)!) as (Comment & { anchorStatus: string; targetAvailable: boolean })[]; };
    let [single, three] = await anchors();
    assert.deepEqual(Object.keys(single).sort(), ['anchorStatus', 'blockId', 'createdAt', 'history', 'id', 'quote', 'status', 'targetAvailable', 'text', 'updatedAt', 'version'], 'A single place keeps today\'s keys.');
    assert.equal(three.anchorStatus, 'attached');
    assert.deepEqual(three.targets!.map(place => Object.keys(place).sort()), Array(3).fill(['anchorStatus', 'blockId', 'quote', 'targetAvailable']));

    await writeFile(f.entry, source('<Paragraph id="third">The third place to review.</Paragraph>'));
    [single, three] = await anchors();
    assert.equal(single.anchorStatus, 'attached');
    assert.deepEqual(three.targets!.map(place => [place.blockId, (place as { anchorStatus?: string }).anchorStatus, (place as { targetAvailable?: boolean }).targetAvailable]), [['target', 'attached', true], ['second', 'missing', false], ['third', 'attached', true]]);
    assert.equal(three.anchorStatus, 'missing'); assert.equal(three.targetAvailable, false);
    await runCommentsCli(['list', 'proof'], f.root, { mode: 'direct' });
    assert.equal((JSON.parse(out().at(-1)!) as Comment[])[1].targets!.length, 3, 'The plain list keeps all three places.');
  } finally { await f.cleanup(); }
});

async function listen(service: Awaited<ReturnType<typeof createOpenDocService>>) {
  const server = createServer((req: IncomingMessage, res: ServerResponse) => { service.handle(req, res).catch(() => {}); });
  await new Promise<void>(accept => server.listen(0, '127.0.0.1', accept));
  return { origin: `http://127.0.0.1:${(server.address() as AddressInfo).port}`, close: () => new Promise<void>(accept => { server.close(() => accept()); server.closeAllConnections(); }) };
}
const client = (_req: IncomingMessage, res: ServerResponse) => { res.writeHead(200); res.end(); };

test('the service takes selections for a comment and for the context, and the CLI reaches it', { timeout: 120_000 }, async t => {
  const f = await fixture();
  const out = lines(t);
  await writeFile(f.entry, source(second));
  const service = await createOpenDocService({ root: f.root, production: false, client });
  const listener = await listen(service);
  try {
    const { origin } = listener;
    const headers = { 'Content-Type': 'application/json', 'X-OpenDoc-Token': service.token };
    const documents = () => fetch(`${origin}/api/documents`).then(r => r.json()) as Promise<{ id: string; status: string; revision: number; artifact?: { hash: string } }[]>;
    await until(async () => (await documents()).every(d => d.status === 'ready'));
    const { revision, artifact } = (await documents())[0];
    const hash = artifact!.hash;
    const post = (path: string, body: object) => fetch(`${origin}${path}`, { method: 'POST', headers, body: JSON.stringify(body) });
    const comment = (body: object) => post('/api/documents/proof/comments', { hash, ...body });
    const place = (blockId: string, extra: object = {}) => ({ blockId, page: 1, renderHash: hash, revision, ...extra });
    const phrase = place('title', { targetId: 'title:children', start: 2, end: 7, quote: 'first' });

    // Three places: the first may be a phrase, the others are whole components.
    const made = await comment({ text: 'Make these agree.', selections: [place('target'), place('second'), place('third')] });
    assert.equal(made.status, 200);
    const [row] = await made.json() as Comment[];
    assert.deepEqual(row.targets!.map(item => item.blockId), ['target', 'second', 'third']);
    assert.equal(row.blockId, 'target');
    assert.deepEqual(await fetch(`${origin}/api/documents/proof/comments`).then(r => r.json()), await readComments(f.root, 'proof'), 'The route lists what the file holds.');
    assert.deepEqual((await savedComments(f.root))[0].targets, row.targets, 'It round-trips through the file.');
    const withPhrase = await comment({ text: 'Phrase first.', blockId: 'title', selections: [phrase, place('second')] });
    assert.equal(withPhrase.status, 200);
    const phraseRow = (await withPhrase.json() as Comment[]).at(-1)!;
    assert.equal(phraseRow.anchor?.quote, 'first'); assert.deepEqual(phraseRow.targets![0].anchor, phraseRow.anchor);
    // One selection in a list is a single-place comment, stored as before.
    const one = (await (await comment({ text: 'One.', selections: [place('second')] })).json() as Comment[]).at(-1)!;
    assert.equal('targets' in one, false);
    // The single-selection body still works.
    assert.equal((await comment({ text: 'Old shape.', blockId: 'target' })).status, 200);

    const refused = async (body: object, status: number, pattern: RegExp) => {
      const response = await comment({ text: 'Refused.', ...body });
      assert.equal(response.status, status, JSON.stringify(body));
      assert.match((await response.json()).error, pattern);
    };
    const total = (await readComments(f.root, 'proof')).length;
    await refused({ selections: [place('target'), place('target')] }, 400, /only once/);
    await refused({ selections: [place('target'), phrase] }, 400, /Only the first selection can be a phrase/);
    await refused({ selections: [place('target'), place('gone')] }, 400, /no longer available/);
    await refused({ selections: [place('target'), place('second', { renderHash: 'old' })] }, 409, /Select the components again/);
    await refused({ selections: [place('target'), place('second', { revision: revision + 1 })] }, 409, /Select the components again/);
    await refused({ selections: [place('target')], selection: place('target'), blockId: 'target' }, 400, /not both/);
    await refused({ selections: [place('target'), place('second')], blockId: 'second' }, 400, /first selection must be/);
    await refused({ selections: [] }, 400, /at least one/);
    await refused({ selections: 'target' }, 400, /Invalid selections/);
    assert.equal((await readComments(f.root, 'proof')).length, total, 'A refused comment writes nothing.');

    // The context route: selection stays the first of selections.
    const list = [place('second'), place('third'), place('target')];
    assert.equal((await post('/api/context', { documentId: 'proof', blockId: 'third', page: 1, selections: list })).status, 200);
    const current = async () => JSON.parse(await readFile(resolve(f.root, '.opendoc/current.json'), 'utf8'));
    let written = await current();
    assert.deepEqual(written.selections, list); assert.deepEqual(written.selection, list[0]);
    assert.equal((await post('/api/context', { documentId: 'proof', blockId: 'third', page: 1, selections: list, selection: list[0] })).status, 400);
    assert.equal((await post('/api/context', { documentId: 'proof', blockId: 'gone', page: 1, selections: list })).status, 400, 'The active block must be in the list.');
    assert.equal((await post('/api/context', { documentId: 'proof', blockId: 'second', page: 1, selections: [list[0], phrase] })).status, 400);
    assert.equal((await post('/api/context', { documentId: 'proof', blockId: 'target', page: 1, selection: place('target') })).status, 200);
    written = await current();
    assert.deepEqual(written.selections, [place('target')]); assert.deepEqual(written.selection, written.selections[0]);
    assert.equal((await post('/api/context', { documentId: 'proof', blockId: null, page: 1 })).status, 200);
    written = await current();
    assert.deepEqual([written.selection, written.selections], [null, []]);

    // The CLI reaches the same route when the service runs: whole components only.
    await mkdir(resolve(f.root, '.opendoc'), { recursive: true });
    await writeFile(resolve(f.root, '.opendoc/server.json'), JSON.stringify({ origin, token: service.token, pid: process.pid }));
    out();
    await runCommentsCli(['add', 'proof', 'target', 'Through', 'the', 'service.', '--also', 'second', '--also', 'third', '--json'], f.root);
    const viaService = (JSON.parse(out().at(-1)!) as Comment[]).at(-1)!;
    assert.deepEqual(viaService.targets!.map(item => item.blockId), ['target', 'second', 'third']);
    assert.deepEqual((await savedComments(f.root)).at(-1)!.targets, viaService.targets);
    await assert.rejects(runCommentsCli(['add', 'proof', 'target', 'No.', '--also', 'second', '--also-phrase', 'second place'], f.root), /needs OpenDoc stopped/);
    await runCommentsCli(['add', 'proof', 'target', 'Phrase through the service.', '--phrase', 'stable paragraph', '--json'], f.root);
    assert.equal((JSON.parse(out().at(-1)!) as Comment[]).at(-1)!.anchor?.quote, 'stable paragraph', 'The single-place CLI request is unchanged.');

    // A block that is only a later place of a comment is still a known context block once removed.
    await writeFile(f.entry, source('<Paragraph id="third">The third place to review.</Paragraph>'));
    await until(async () => { const [d] = await documents(); return d.status === 'ready' && d.artifact?.hash !== hash; });
    const after = (await documents())[0];
    assert.equal((await post('/api/context', { documentId: 'proof', blockId: 'second', page: 1, selection: { blockId: 'second', page: 1, renderHash: after.artifact!.hash, revision: after.revision } })).status, 200);
    assert.equal((await post('/api/context', { documentId: 'proof', blockId: 'nowhere', page: 1 })).status, 400);
  } finally { await listener.close(); await service.close(); await f.cleanup(); }
});
