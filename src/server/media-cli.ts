import { parseArgs } from 'node:util';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { lstat, readFile, realpath, stat } from 'node:fs/promises';
import { relative, sep } from 'node:path';
import { documentEntry, validId } from './render';
import { atomicWrite } from './files';
import { codedError } from '../cli/errors';
import { readMedia, mediaFreshness, imageInfo, hashBytes, mediaId, parseMediaMeta } from '../media/files';
import type { GenerationRecord, } from '../media/files';
import type { MediaKind, MediaMeta } from '../shared/media';
import { importMedia as importMediaUpload, editMedia } from './media-mutations';
import { discoverDocumentIds } from './export-batch';
import { scanMaterials } from './materials';

/** Record only after generation and review; it is a provenance snapshot, not a generator. */
export async function recordMedia(root: string, documentId: string, id: string) {
  const entry = await documentEntry(root, documentId);
  const document = resolve(entry, '..');
  const asset = readMedia(document, id);
  const record: GenerationRecord = { version: 1, imageHash: asset.hash, inputs: asset.inputs, recordedAt: new Date().toISOString() };
  // Re-read immediately before publishing so an input change cannot be recorded as reviewed.
  const latest = readMedia(document, id);
  if (latest.hash !== asset.hash || JSON.stringify(latest.inputs) !== JSON.stringify(asset.inputs)) throw new Error('Media inputs changed while recording. Generate and review the current version first.');
  await atomicWrite(resolve(asset.directory, 'generation.json'), JSON.stringify(record, null, 2) + '\n');
  return record;
}
export async function importMedia(root: string, documentId: string, id: string, file: string, title: string, description: string, kind = 'image') {
  const input = resolve(file);
  const inputInfo = await stat(input);
  if (!inputInfo.isFile()) throw new Error('Choose a regular image file.');
  if (inputInfo.size > 50_000_000) throw new Error('Keep an embedding image below 50 MB.');
  const bytes = await readFile(input);
  const info = imageInfo(bytes);
  if (bytes.length > 50_000_000) throw new Error('Keep an embedding image below 50 MB.');
  const name = info.mime === 'image/png' ? 'image.png' : 'image.jpg';
  // Preserve the CLI's content-based input detection while sharing staged publication
  // and full image decoding with the browser upload path.
  const imported = await importMediaUpload(root, documentId, { id, title, description, kind: kind as MediaKind }, { filename: name, bytes });
  return { ...imported, file: `documents/${documentId}/media/${id}/${name}`, hash: hashBytes(bytes) };
}
/** The fields `PATCH /api/materials/<document>/meta` lets the app change; every other field of meta.json is left alone. */
const editableFields = ['title', 'description', 'kind', 'alt', 'attribution', 'sources'] as const;
/** The other fields meta.json may hold; the app's editor keeps them as they are. */
const otherFields = ['file', 'data', 'recipe'];
const editFlags = ['alt', 'attribution', 'source', 'clear-alt', 'clear-attribution', 'clear-sources', 'expected-revision'];

/** Where media edit finds the item: a document and a media ID, or the path of the item's image, meta.json or folder. */
async function locateMedia(root: string, args: string[]) {
  if (args.length === 2) {
    if (!validId(args[0]) || !mediaId.test(args[1])) throw codedError('Use a document ID and a lowercase media ID.', 'invalid-input');
    return { document: args[0], id: args[1] };
  }
  let target: string, workspace: string;
  try { [target, workspace] = await Promise.all([realpath(resolve(args[0])), realpath(root)]); }
  catch { throw codedError(`Media item not found: ${args[0]}. Give a document and media ID, or the path of the media item.`, 'not-found'); }
  const parts = relative(workspace, target).split(sep);
  if (parts.length < 4 || parts[0] !== 'documents' || parts[2] !== 'media' || !validId(parts[1]) || !mediaId.test(parts[3])) throw codedError('That path is not inside a document\'s media folder (documents/<document>/media/<media-id>).', 'invalid-input');
  return { document: parts[1], id: parts[3] };
}

/** meta.json as the route's `GET /api/materials` reads it, with the revision a `PATCH` must name. */
async function readMeta(root: string, document: string, id: string) {
  const entry = await documentEntry(root, document).catch(() => { throw codedError(`Document not found: ${document}. List documents with npx opendoc documents list.`, 'not-found'); });
  const folder = resolve(entry, '..', 'media', id);
  const [folderInfo, fileInfo] = await Promise.all([lstat(folder), lstat(resolve(folder, 'meta.json'))]).catch(() => { throw codedError(`Media item not found: ${id} in ${document}. List media with npx opendoc media list ${document}.`, 'not-found'); });
  if (!folderInfo.isDirectory() || !fileInfo.isFile() || fileInfo.size > 32_000) throw codedError('Keep media metadata in a regular local file below 32 KB.', 'invalid-input');
  const meta = JSON.parse(await readFile(resolve(folder, 'meta.json'), 'utf8')) as Record<string, unknown>;
  return { meta, folder, revision: hashBytes(Buffer.from(JSON.stringify(meta))) };
}

/**
 * Edit a media item's title, description, kind, alt text, attribution or sources through `editMedia`, the code the route runs. A field
 * the flags don't name keeps its value. The revision is the one just read unless --expected-revision names the one the caller saw.
 */
export async function editMediaFromCli(root: string, args: string[], values: { title?: string; description?: string; kind?: string; alt?: string; attribution?: string; source?: string[]; 'clear-alt'?: boolean; 'clear-attribution'?: boolean; 'clear-sources'?: boolean; 'expected-revision'?: string }) {
  if ((values.alt !== undefined && values['clear-alt']) || (values.attribution !== undefined && values['clear-attribution']) || (values.source && values['clear-sources'])) throw new Error(`Give a field a new value or clear it, not both.\n${editUsage}`);
  const changes = [
    ...(['title', 'description', 'kind', 'alt', 'attribution'] as const).filter(field => values[field] !== undefined),
    ...(values.source ? ['sources'] : []), ...(['alt', 'attribution', 'sources'] as const).filter(field => values[`clear-${field}`]),
  ];
  if (!changes.length) throw new Error(`Name at least one field to change.\n${editUsage}`);
  const { document, id } = await locateMedia(root, args);
  const current = await readMeta(root, document, id);
  const next: Record<string, unknown> = Object.fromEntries(editableFields.filter(field => current.meta[field] !== undefined).map(field => [field, current.meta[field]]));
  for (const field of ['title', 'description', 'kind', 'alt', 'attribution'] as const) if (values[field] !== undefined) next[field] = values[field];
  if (values.source) next.sources = values.source;
  for (const field of ['alt', 'attribution', 'sources'] as const) if (values[`clear-${field}`]) delete next[field];
  // Say what is wrong with the new values here, as a refused input, before anything is written.
  try { parseMediaMeta({ ...Object.fromEntries(otherFields.filter(field => current.meta[field] !== undefined).map(field => [field, current.meta[field]])), ...next }); }
  catch (error) { throw codedError(error instanceof Error ? error.message : String(error), 'invalid-input'); }
  const result = await editMedia(root, document, id, { expectedRevision: values['expected-revision'] ?? current.revision, meta: next as unknown as MediaMeta });
  return { ...result, changed: changes, file: `documents/${document}/media/${id}/meta.json`, meta: (await readMeta(root, document, id)).meta };
}

const editUsage = 'Usage: npx opendoc media edit <document> <media-id> [--title "Title"] [--description "Text"] [--kind photo|illustration|chart|diagram|image] [--alt "Alt text"|--clear-alt]\n       [--attribution "Credit"|--clear-attribution] [--source "Note or URL"]... [--clear-sources] [--expected-revision <revision>]\n       npx opendoc media edit <path-of-the-media-item> ...   (its image, meta.json or folder)\n--source replaces the whole list of sources; repeat it for each one. A field you do not name keeps its value.';
const usage = 'Usage: npx opendoc media list [<document>] [--json]\n       npx opendoc media import <document> <media-id> --file <image> --title "Title" --description "Description" [--kind photo|illustration|chart|diagram|image]\n       npx opendoc media record <document> <media-id>\n       npx opendoc media check <document> <media-id>\n       npx opendoc media edit <document> <media-id> [--title "Title"] [--description "Text"] [--kind <kind>] [--alt "Text"] [--attribution "Credit"] [--source "Note"]... (or --clear-alt, --clear-attribution, --clear-sources)\n       npx opendoc media edit --help shows every option of edit.';
export async function runMediaCli(args: string[], root = process.cwd()): Promise<void> {
  const { values, positionals } = parseArgs({ args: args[0] === '--' ? args.slice(1) : args, allowPositionals: true, options: {
    file: { type: 'string' }, title: { type: 'string' }, description: { type: 'string' }, kind: { type: 'string' },
    alt: { type: 'string' }, attribution: { type: 'string' }, source: { type: 'string', multiple: true }, 'expected-revision': { type: 'string' },
    'clear-alt': { type: 'boolean' }, 'clear-attribution': { type: 'boolean' }, 'clear-sources': { type: 'boolean' },
    json: { type: 'boolean' }, help: { type: 'boolean', short: 'h' },
  } });
  const [action = 'list', doc, id] = positionals;
  if (values.help) { const text = action === 'edit' ? editUsage : usage; console.log(values.json ? JSON.stringify({ usage: text }, null, 2) : text); return; }
  const importFlags = ['file', 'title', 'description', 'kind'];
  const editing = action === 'edit';
  if (Object.keys(values).some(key => (!editing && editFlags.includes(key)) || (action !== 'import' && !(editing && key !== 'file') && importFlags.includes(key)))) throw new Error(editing ? editUsage : usage);
  if (editing) {
    if (positionals.length < 2 || positionals.length > 3) throw new Error(editUsage);
    const result = await editMediaFromCli(root, positionals.slice(1), values);
    console.log(values.json ? JSON.stringify(result, null, 2) : `Updated ${result.id} in ${result.documentId}: ${result.changed.join(', ')}\nRevision: ${result.metadataRevision}`);
    return;
  }
  if (action === 'list' && positionals.length <= 2) {
    if (doc !== undefined && !validId(doc)) throw new Error(usage);
    const ids = doc === undefined ? await discoverDocumentIds(root) : [doc];
    for (const documentId of ids) await documentEntry(root, documentId);
    // Listing should not execute authored TSX. Without a render, usage remains explicitly unknown.
    console.log(JSON.stringify(await scanMaterials(root, ids.map(id => ({ id, status: 'rendering' as const, revision: 0 }))), null, 2));
    return;
  }
  if (!validId(doc ?? '')) throw new Error(usage);
  if (action === 'import' && positionals.length === 3 && values.file && values.title && values.description) {
    console.log(JSON.stringify(await importMedia(root, doc, id, values.file, values.title, values.description, values.kind), null, 2));
  } else if (action === 'record' && positionals.length === 3) {
    console.log(JSON.stringify(await recordMedia(root, doc, id), null, 2));
  } else if (action === 'check' && positionals.length === 3) {
    const entry = await documentEntry(root, doc);
    const media = readMedia(resolve(entry, '..'), id);
    const status = mediaFreshness(media);
    console.log(JSON.stringify({ meta: media.meta, ...status }, null, 2));
    if (status.freshness === 'stale' || status.freshness === 'unrecorded') process.exitCode = 1;
  } else throw new Error(usage);
}
if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  runMediaCli(process.argv.slice(2)).catch(error => { console.error(error instanceof Error ? error.message : String(error)); process.exitCode = 1; });
}
