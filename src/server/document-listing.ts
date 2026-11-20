import { lstat, readdir, readFile, realpath } from 'node:fs/promises';
import { relative, resolve, sep } from 'node:path';
import ts from 'typescript';
import { codedError } from '../cli/errors';
import { mediaId, parseMediaMeta } from '../media/files';
import { discoverDocumentIds } from './export-batch';
import { sourceLanguage } from './language';
import { documentEntry, validId } from './render';
import { readProjects } from './projects';
import { itemFiles, sourceFiles, sourceUpdatedAt } from './source-files';
import { detailsOf, readTags } from './tags';
import type { DocumentFormat } from '../shared/types';
import type { Language } from '../shared/language';

/**
 * `opendoc documents list` and `documents show`: the command-line side of `GET /api/documents` and
 * `GET /api/documents/<id>`. The routes answer with each document's live render state; the command
 * line never renders (that would run authored code, as `media list` and `tags find` also avoid),
 * so it answers with what the saved files say: the route's own fields that need no render (`id`,
 * `name`, `format`, `projectId`, `language`, `updatedAt`) plus the authored title, path and tags.
 */

export interface DocumentMetaText { title?: string; description?: string; kind?: string }

/** The `meta` export's plain string properties, read from the source text without running it. */
export function staticMeta(file: string, text: string): DocumentMetaText {
  const tree = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
  const found: DocumentMetaText = {};
  const unwrap = (node: ts.Expression): ts.Expression =>
    ts.isParenthesizedExpression(node) || ts.isAsExpression(node) || ts.isSatisfiesExpression(node) || ts.isTypeAssertionExpression(node) ? unwrap(node.expression) : node;
  for (const statement of tree.statements) {
    if (!ts.isVariableStatement(statement) || !statement.modifiers?.some(modifier => modifier.kind === ts.SyntaxKind.ExportKeyword)) continue;
    for (const declaration of statement.declarationList.declarations) {
      if (!ts.isIdentifier(declaration.name) || declaration.name.text !== 'meta' || !declaration.initializer) continue;
      const object = unwrap(declaration.initializer);
      if (!ts.isObjectLiteralExpression(object)) continue;
      for (const property of object.properties) {
        if (!ts.isPropertyAssignment(property) || !(ts.isIdentifier(property.name) || ts.isStringLiteral(property.name))) continue;
        const key = property.name.text;
        const value = unwrap(property.initializer);
        if ((key === 'title' || key === 'description' || key === 'kind') && (ts.isStringLiteral(value) || ts.isNoSubstitutionTemplateLiteral(value))) found[key] = value.text;
      }
    }
  }
  return found;
}

export interface DocumentListing {
  id: string;
  /** What the app shows: the name given in OpenDoc, else the authored title, else the ID. */
  title: string;
  /** The name given in OpenDoc (documents rename), or null. */
  name: string | null;
  /** The title the source states, or null when it is computed and only a render can tell. */
  authoredTitle: string | null;
  path: string;
  format: DocumentFormat;
  projectId: string | null;
  project: string | null;
  type: string | null;
  tags: string[];
  documentStatus: string | null;
  language?: Language;
  updatedAt?: string;
}

export interface DocumentSourceFile { path: string; size: number; updatedAt: string }
export interface DocumentMediaItem { id: string; folder: string; title?: string; file?: string; kind?: string; error?: string }
export interface DocumentDetails extends DocumentListing {
  meta: DocumentMetaText;
  files: DocumentSourceFile[];
  media: DocumentMediaItem[];
}

const entryPath = (id: string) => `documents/${id}/index.tsx`;

/** A regular file's text, or nothing for a link, a folder or a file over the limit. */
async function smallText(file: string, limit: number) {
  const info = await lstat(file).catch(() => undefined);
  return info?.isFile() && info.size <= limit ? readFile(file, 'utf8').catch(() => '') : '';
}

/** The documents the app would list: a folder with an `index.tsx` that stays inside the workspace. */
async function presentDocuments(root: string, only?: string) {
  const ids = only === undefined ? await discoverDocumentIds(root) : [only];
  const present: string[] = [];
  for (const id of ids) {
    try { await documentEntry(root, id); present.push(id); } catch { /* not a document the app would show */ }
  }
  return present;
}

async function describe(root: string, id: string, shared: { projects: Awaited<ReturnType<typeof readProjects>>; tags: Awaited<ReturnType<typeof readTags>> }): Promise<{ listing: DocumentListing; meta: DocumentMetaText }> {
  const { projects, tags } = shared;
  const files = await sourceFiles(root, 'documents', id).catch(() => []);
  const text = await smallText(resolve(root, entryPath(id)), 512_000);
  const meta = staticMeta(entryPath(id), text);
  const name = projects.names && Object.hasOwn(projects.names, id) ? projects.names[id] : null;
  const projectId = Object.hasOwn(projects.assignments, id) ? projects.assignments[id] : null;
  const details = detailsOf(tags, 'documents', id);
  const language = await sourceLanguage(root, 'documents', id, files).catch(() => undefined);
  const updatedAt = sourceUpdatedAt(files);
  return {
    meta,
    listing: {
      id, title: name ?? meta.title ?? id, name, authoredTitle: meta.title ?? null, path: entryPath(id),
      format: projects.formats && Object.hasOwn(projects.formats, id) ? projects.formats[id] : 'document',
      projectId, project: projectId ? projects.projects.find(project => project.id === projectId)?.name ?? null : null,
      type: details.type ?? null, tags: details.tags, documentStatus: details.status ?? null,
      ...(language ? { language } : {}), ...(updatedAt ? { updatedAt } : {}),
    },
  };
}

/** Every document, sorted by the name the app shows, as `GET /api/documents` sorts them. */
export async function listDocuments(root: string): Promise<DocumentListing[]> {
  const shared = { projects: await readProjects(root), tags: await readTags(root) };
  const listings = await Promise.all((await presentDocuments(root)).map(async id => (await describe(root, id, shared)).listing));
  return listings.sort((a, b) => a.title.localeCompare(b.title));
}

/** One document's metadata, the source files it is built from, and its media. */
export async function showDocument(root: string, id: string): Promise<DocumentDetails> {
  if (!validId(id)) throw codedError('Invalid document ID.', 'invalid-input');
  if (!(await presentDocuments(root, id)).length) throw codedError(`Document not found: ${id}. List documents with npx opendoc documents list.`, 'not-found');
  const { listing, meta } = await describe(root, id, { projects: await readProjects(root), tags: await readTags(root) });
  const workspace = await realpath(root);
  const folder = resolve(workspace, 'documents', id);
  const files = (await itemFiles(folder)).map(file => ({ path: relative(workspace, file.path).split(sep).join('/'), size: file.size, updatedAt: new Date(file.mtimeMs).toISOString() }));
  return { ...listing, meta, files, media: await mediaItems(folder, id) };
}

/** The document's media folders; a folder whose record cannot be read is listed with the reason. */
async function mediaItems(folder: string, id: string): Promise<DocumentMediaItem[]> {
  const entries = await readdir(resolve(folder, 'media'), { withFileTypes: true }).catch(() => []);
  const items: DocumentMediaItem[] = [];
  for (const entry of entries.filter(entry => entry.isDirectory() && mediaId.test(entry.name)).sort((a, b) => a.name.localeCompare(b.name))) {
    const base = { id: entry.name, folder: `documents/${id}/media/${entry.name}` };
    try {
      const meta = parseMediaMeta(JSON.parse(await smallText(resolve(folder, 'media', entry.name, 'meta.json'), 32_000)));
      items.push({ ...base, title: meta.title, file: meta.file, kind: meta.kind });
    } catch (error) { items.push({ ...base, error: error instanceof Error ? error.message : String(error) }); }
  }
  return items;
}
