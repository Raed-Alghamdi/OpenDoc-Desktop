import { mkdir, rm } from 'node:fs/promises';
import { lstatSync, readFileSync, rmSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { randomUUID } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';
import { atomicWrite, readJSON, containedFile } from './files';
import { documentEntry } from './render';
import { maxSelections } from './selection';
import type { Comment, CommentTarget } from '../shared/types';
import type { TextAnchor } from '../shared/selection';

export class Conflict extends Error {}
const validDate = (value: unknown): value is string => typeof value === 'string' && Number.isFinite(Date.parse(value));
const nonempty = (value: unknown): value is string => typeof value === 'string' && value.length > 0;

function validAnchor(anchor: unknown): anchor is TextAnchor {
  if (!anchor || typeof anchor !== 'object') return false;
  const value = anchor as TextAnchor;
  return typeof value.targetId === 'string' && value.targetId.length > 0 && value.targetId.length <= 1000
    && Number.isInteger(value.start) && Number.isInteger(value.end) && value.start >= 0 && value.end > value.start
    && typeof value.quote === 'string' && value.quote.length > 0 && value.quote.length <= 8000
    && value.end - value.start === value.quote.length
    && typeof value.prefix === 'string' && value.prefix.length <= 40
    && typeof value.suffix === 'string' && value.suffix.length <= 40;
}
function validTarget(target: unknown): target is CommentTarget {
  if (!target || typeof target !== 'object') return false;
  const value = target as CommentTarget;
  return nonempty(value.blockId) && typeof value.quote === 'string' && (value.anchor === undefined || validAnchor(value.anchor));
}
/**
 * `targets` only adds places: the first one must be the top-level block, quote and anchor older
 * readers see. One place or many is accepted on read, and the number of places is capped only
 * when a comment is made, so a file written elsewhere never locks the document's feedback.
 */
function validTargets(row: Comment) {
  if (row.targets === undefined) return true;
  return Array.isArray(row.targets) && row.targets.length > 0 && row.targets.every(validTarget)
    && row.targets[0].blockId === row.blockId && row.targets[0].quote === row.quote && isDeepStrictEqual(row.targets[0].anchor, row.anchor);
}
export async function readComments(root: string, id: string): Promise<Comment[]> {
  const entry = await documentEntry(root, id);
  const file = resolve(dirname(entry), 'comments.json');
  try { await containedFile(dirname(entry), file); } catch (e) { if ((e as NodeJS.ErrnoException).code !== 'ENOENT') throw e; }
  const rows = await readJSON<unknown>(file, []);
  if (!Array.isArray(rows) || new Set(rows.map(row => row?.id)).size !== rows.length || rows.some(row => !row
    || !nonempty(row.id) || !nonempty(row.blockId) || !nonempty(row.text) || typeof row.quote !== 'string'
    || !['open', 'resolved', 'deleted'].includes(row.status) || !Number.isInteger(row.version) || row.version < 1
    || !validDate(row.createdAt) || !validDate(row.updatedAt) || !Array.isArray(row.history) || !row.history.length
    || row.history.some((event: Comment['history'][number]) => !event || !validDate(event.at)
      || !['created', 'resolved', 'reopened', 'edited', 'deleted', 'restored'].includes(event.action)
      || (event.previousText !== undefined && typeof event.previousText !== 'string'))
    || (row.anchor !== undefined && !validAnchor(row.anchor)) || !validTargets(row))) throw new Error(`Invalid comments file for ${id}. Restore valid JSON; existing feedback has not been overwritten.`);
  return rows as Comment[];
}

/** A crash before owner publication must not permanently strand a document. */
function removeAbandonedLock(lock: string) {
  try {
    const before = lstatSync(lock);
    let pid: number | undefined;
    try { pid = JSON.parse(readFileSync(resolve(lock, 'owner.json'), 'utf8')).pid; } catch { /* An interrupted acquisition may have no owner yet. */ }
    if (Number.isSafeInteger(pid) && pid! > 0) {
      try { process.kill(pid!, 0); return; } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ESRCH') return;
      }
    } else if (Date.now() - before.mtimeMs < 30_000) return;
    const current = lstatSync(lock);
    if (current.dev === before.dev && current.ino === before.ino && current.mtimeMs === before.mtimeMs) rmSync(lock, { recursive: true, force: true });
  } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
}

export async function withCommentLock<T>(root: string, id: string, operation: () => Promise<T>) {
  const lock = resolve(root, '.opendoc/locks', `${id}.lock`);
  await mkdir(dirname(lock), { recursive: true });
  let acquired = false;
  for (let attempt = 0; attempt < 80; attempt++) {
    try {
      await mkdir(lock); acquired = true;
      await atomicWrite(resolve(lock, 'owner.json'), JSON.stringify({ pid: process.pid }));
      break;
    } catch (e) {
      if (acquired) { await rm(lock, { recursive: true, force: true }); throw e; }
      if ((e as NodeJS.ErrnoException).code !== 'EEXIST') throw e;
      removeAbandonedLock(lock);
      await new Promise(r => setTimeout(r, 25));
    }
  }
  if (!acquired) throw new Conflict('Feedback is being updated. Retry in a moment.');
  try {
    return await operation();
  } finally { await rm(lock, { recursive: true, force: true }); }
}

async function mutate(root: string, id: string, fn: (rows: Comment[]) => Comment[], unchanged?: () => boolean) {
  await documentEntry(root, id);
  return withCommentLock(root, id, async () => {
    const entry = await documentEntry(root, id);
    const updated = fn(await readComments(root, id));
    if (unchanged && !unchanged()) throw new Conflict('The document changed while verifying the comment target. Retry against the current source.');
    await atomicWrite(resolve(dirname(entry), 'comments.json'), JSON.stringify(updated, null, 2) + '\n');
    return updated;
  });
}

/** One place of a new comment; `exactQuote` keeps a selected passage whole instead of the 500-character block preview. */
export interface CommentPlace { blockId: string; quote: string; anchor?: TextAnchor; exactQuote?: boolean }

/**
 * A comment on one place (`blockId`, `quote`, `anchor`) or on several (`targets`, at least 2, each
 * block once). Several places are saved as `targets` and the first is also written to the top-level
 * fields, so a comment on one place is stored exactly as before.
 */
type SinglePlaceComment = CommentPlace & { text: string; targets?: undefined };
type MultiPlaceComment = { text: string; targets: CommentPlace[]; blockId?: undefined; quote?: undefined; anchor?: undefined; exactQuote?: undefined };
export async function addComment(root: string, id: string, input: SinglePlaceComment | MultiPlaceComment, unchanged?: () => boolean) {
  if (typeof input.text !== 'string' || !input.text.trim() || input.text.length > 8000) throw new Error('Write a comment between 1 and 8,000 characters.');
  if (input.targets !== undefined && (input.blockId !== undefined || input.quote !== undefined || input.anchor !== undefined || input.exactQuote !== undefined)) throw new Error('Give either one place or a list of places, not both.');
  if (input.targets !== undefined && (!Array.isArray(input.targets) || !input.targets.length)) throw new Error('Select a document element first.');
  const places = input.targets ?? [input];
  if (places.length > maxSelections) throw new Error(`Comment on at most ${maxSelections} places at once.`);
  for (const place of places) {
    if (!place || typeof place.blockId !== 'string' || !place.blockId) throw new Error('Select a document element first.');
    if (typeof place.quote !== 'string') throw new Error('Select the document element again before commenting.');
    if (place.anchor !== undefined && !validAnchor(place.anchor)) throw new Error('Select the phrase again before commenting.');
  }
  if (new Set(places.map(place => place.blockId)).size !== places.length) throw new Error('A comment names each component once. Remove the repeated component.');
  const targets: CommentTarget[] = places.map(place => ({ blockId: place.blockId, quote: place.anchor?.quote ?? place.quote.slice(0, place.exactQuote ? 8000 : 500), ...(place.anchor ? { anchor: place.anchor } : {}) }));
  const [first] = targets;
  const at = new Date().toISOString();
  return mutate(root, id, rows => [...rows, { id: randomUUID(), blockId: first.blockId, text: input.text.trim(), quote: first.quote, ...(first.anchor ? { anchor: first.anchor } : {}), ...(targets.length > 1 ? { targets } : {}), status: 'open', createdAt: at, updatedAt: at, version: 1, history: [{ at, action: 'created' }] }], unchanged);
}

/** Every mutation checks the same current record before appending its history. */
async function updateComment(root: string, documentId: string, commentId: string, version: number, update: (comment: Comment, at: string) => Partial<Comment> | undefined, restoring = false) {
  return mutate(root, documentId, rows => {
    const comment = rows.find(row => row.id === commentId);
    if (!comment) throw new Error('Comment not found.');
    if ((comment.status === 'deleted') !== restoring || comment.version !== version) throw new Conflict('This comment changed elsewhere. Refresh and try again.');
    const at = new Date().toISOString();
    const changes = update(comment, at);
    if (!changes) return rows;
    return rows.map(row => row === comment ? { ...row, ...changes, version: row.version + 1, updatedAt: at } : row);
  });
}

export async function changeComment(root: string, documentId: string, commentId: string, status: 'open' | 'resolved', version: number) {
  if (!['open', 'resolved'].includes(status)) throw new Error('Invalid comment status.');
  return updateComment(root, documentId, commentId, version, (comment, at) => {
    if (comment.status === status) return undefined;
    return { status, history: [...comment.history, { at, action: status === 'resolved' ? 'resolved' : 'reopened' }] };
  });
}

export async function editComment(root: string, documentId: string, commentId: string, text: string, version: number) {
  if (typeof text !== 'string' || !text.trim() || text.length > 8000) throw new Error('Write a comment between 1 and 8,000 characters.');
  return updateComment(root, documentId, commentId, version, (comment, at) => {
    if (comment.text === text.trim()) return undefined;
    return { text: text.trim(), history: [...comment.history, { at, action: 'edited', previousText: comment.text }] };
  });
}

/** Keep the local audit history while removing deleted feedback from the app. */
export async function deleteComment(root: string, documentId: string, commentId: string, version: number) {
  return updateComment(root, documentId, commentId, version, (comment, at) => ({ status: 'deleted', history: [...comment.history, { at, action: 'deleted' }] }));
}

/** Undo a deletion with the same record, identity, anchor, and its earlier open or resolved status. */
export async function restoreComment(root: string, documentId: string, commentId: string, version: number) {
  return updateComment(root, documentId, commentId, version, (comment, at) => {
    const status = comment.history.reduce<'open' | 'resolved'>((current, event) => event.action === 'resolved' ? 'resolved' : event.action === 'reopened' ? 'open' : current, 'open');
    return { status, history: [...comment.history, { at, action: 'restored' }] };
  }, true);
}

/** Deleted feedback that is still offered for restoring, newest deletion first. Records themselves are never pruned. */
export function recentlyDeletedComments(rows: Comment[], now = Date.now(), days = 90) {
  return rows.filter(row => row.status === 'deleted')
    .map(row => ({ row, at: Date.parse([...row.history].reverse().find(event => event.action === 'deleted')?.at ?? row.updatedAt) }))
    .filter(({ at }) => now - at <= days * 86_400_000)
    .sort((a, b) => b.at - a.at).map(({ row }) => row);
}
