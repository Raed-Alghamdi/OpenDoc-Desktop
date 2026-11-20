import type { IncomingMessage, ServerResponse } from 'node:http';
import { randomUUID } from 'node:crypto';
import { lstat, mkdir, readFile, readdir, realpath, rename, rm, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { withWorkspaceLock } from '../cli/lock';
import { limits } from '../packs/archive';
import { validPackId } from '../packs/manifest';
import { exportPack, installPack, planInstall, readPack } from '../packs/packs';

type Send = (res: ServerResponse, value: unknown, status?: number) => void;
type Body = (req: IncomingMessage, limit?: number) => Promise<any>;

/** The service pauses its catalog watcher around an install, so half-published source is never discovered. */
export type PackHooks = { pauseWatching: () => void | Promise<void>; resumeWatching: () => void | Promise<void> };

export class PackHttpError extends Error {
  constructor(message: string, readonly status = 400) { super(message); this.name = 'PackHttpError'; }
}

/** Staged uploads live under `.opendoc/`, which the watcher ignores, and are removed after install or after an hour. */
export const stagedLifetime = 60 * 60 * 1000;
const stagedLimit = 8;
const stagedFolder = '.opendoc/pack-uploads';
const stagedName = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/;
const previewName = /^(?:theme|template)-[a-z0-9]+(?:-[a-z0-9]+)*\.pdf$/;
const installing = new Map<string, string>(); // workspace root -> the staged ID being installed

function exact(value: unknown, fields: string[]): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value) || Object.keys(value).some(key => !fields.includes(key))) throw new PackHttpError('Invalid pack request. Reload and try again.');
  return value as Record<string, unknown>;
}
function idList(value: unknown, label: string): string[] {
  if (value === undefined) return [];
  if (!Array.isArray(value) || value.length > 100 || value.some(id => !validPackId(id))) throw new PackHttpError(`Choose ${label} by ID.`);
  return value as string[];
}
function optionalText(value: unknown, label: string, limit = 200): string | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== 'string' || !value.trim() || value.length > limit) throw new PackHttpError(`Enter a ${label} of at most ${limit} characters, or leave it empty.`);
  return value;
}

async function uploads(root: string, create = false): Promise<string> {
  const control = resolve(root, '.opendoc'), folder = resolve(root, stagedFolder);
  const info = await lstat(control).catch(() => undefined);
  if (info && (!info.isDirectory() || info.isSymbolicLink())) throw new PackHttpError('OpenDoc needs an ordinary .opendoc directory for pack uploads.');
  if (create) await mkdir(folder, { recursive: true });
  const staged = await lstat(folder).catch(() => undefined);
  if (staged && (!staged.isDirectory() || staged.isSymbolicLink())) throw new PackHttpError('OpenDoc needs an ordinary pack upload directory.');
  return folder;
}

/** Remove staged uploads (and unfinished ones) older than an hour. The service can also call this at startup. */
export async function expireStagedPacks(root: string, now = Date.now()) {
  root = await realpath(root);
  const folder = await uploads(root);
  const entries = await readdir(folder, { withFileTypes: true }).catch(() => []);
  const kept: { path: string; time: number }[] = [];
  for (const entry of entries) {
    const path = resolve(folder, entry.name), time = (await lstat(path).catch(() => undefined))?.mtimeMs;
    if (time === undefined) continue;
    if (now - time >= stagedLifetime) await rm(path, { recursive: true, force: true });
    else kept.push({ path, time });
  }
  return kept.sort((a, b) => a.time - b.time);
}

/** At service start no inspection is running, so any `.pending-*` folder is a crash's leftover. Creates nothing. */
export async function clearPendingPackUploads(root: string) {
  const folder = await uploads(await realpath(root)).catch(() => undefined); // An odd .opendoc is reported when a pack is used, not at start.
  if (!folder) return;
  for (const entry of await readdir(folder).catch(() => [])) if (entry.startsWith('.pending-')) await rm(resolve(folder, entry), { recursive: true, force: true });
}

/** The staged folder for an ID, or a 404 once it is gone or past its hour. */
async function staged(root: string, id: unknown): Promise<string> {
  if (typeof id !== 'string' || !stagedName.test(id)) throw new PackHttpError('Choose the pack file again.', 404);
  const folder = resolve(await uploads(root), id), info = await lstat(folder).catch(() => undefined);
  if (!info?.isDirectory() || Date.now() - info.mtimeMs >= stagedLifetime) {
    if (info) await rm(folder, { recursive: true, force: true });
    throw new PackHttpError('This pack was removed after an hour or after it was installed. Choose the file again.', 404);
  }
  return folder;
}

/** One ZIP in a multipart upload, bounded before parsing and before anything is written. */
async function packUpload(req: IncomingMessage): Promise<Uint8Array> {
  const type = req.headers['content-type'];
  if (!type?.startsWith('multipart/form-data;')) throw new PackHttpError('Choose a pack file using a multipart upload.');
  const cap = limits.archive + 1024 * 1024; // The ZIP itself is bounded again by readPack.
  if (Number(req.headers['content-length']) > cap) throw new PackHttpError('Choose a pack of at most 64 MiB.', 413);
  const chunks: Buffer[] = []; let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > cap) throw new PackHttpError('Choose a pack of at most 64 MiB.', 413);
    chunks.push(Buffer.from(chunk));
  }
  let form: FormData;
  try { form = await new Response(new Uint8Array(Buffer.concat(chunks)), { headers: { 'Content-Type': type } }).formData(); }
  catch { throw new PackHttpError('The upload was interrupted or malformed. Choose the pack file and try again.'); }
  const entries = form.getAll('file');
  if ([...form.keys()].some(key => key !== 'file') || entries.length !== 1 || typeof entries[0] === 'string') throw new PackHttpError('Choose one OpenDoc pack file.');
  const file = entries[0] as File;
  if (file.size > limits.archive) throw new PackHttpError('Choose a pack of at most 64 MiB.', 413);
  return new Uint8Array(await file.arrayBuffer());
}

const compatibility = (plan: { compatible: boolean; requiredVersion: string; currentVersion: string }) => ({ compatible: plan.compatible, requiredVersion: plan.requiredVersion, currentVersion: plan.currentVersion });
const listing = (paths: string[]) => paths.length > 10 ? `${paths.slice(0, 10).join('\n')}\nand ${paths.length - 10} more` : paths.join('\n');

/**
 * Pack export, inspection and install, called after the server's local-session write guard.
 * - `POST /api/packs/export` makes a pack from workspace themes and templates (this renders their own code).
 * - `POST /api/packs/inspect` stages one uploaded ZIP and reports it. Pack code never runs here.
 * - `GET /api/packs/staged/<stagedId>/previews/<file>` serves a staged pack's own preview PDFs.
 * - `DELETE /api/packs/staged/<stagedId>` discards one staged upload (Cancel and Close in the Import dialog) -> `{ removed }`.
 * - `POST /api/packs/install` `{ stagedId, trust: true }` plans first, refuses conflicts, pauses the
 *   watcher, installs (the only step that runs pack code), rescans and resumes.
 */
export async function handlePacksRequest(root: string, req: IncomingMessage, res: ServerResponse, url: URL, json: Send, body: Body, changed: () => void, hooks: PackHooks): Promise<boolean> {
  const route = url.pathname.match(/^\/api\/packs\/(export|inspect|install|staged\/([^/]+)(?:\/previews\/([^/]+))?)$/);
  if (!route) return false;
  root = await realpath(root);
  const [, action, id, preview] = route;
  if (id !== undefined && preview === undefined) {
    // Discard: the app's own staging only, one folder named by a checked UUID. Unknown, expired or installing gives removed: false.
    if (req.method !== 'DELETE') throw new PackHttpError('Pack action not found.', 404);
    if (!stagedName.test(id)) throw new PackHttpError('This is not a staged pack.', 400);
    const folder = resolve(await uploads(root), id), info = await lstat(folder).catch(() => undefined);
    if (!info?.isDirectory() || installing.get(root) === id) { json(res, { removed: false }); return true; }
    await rm(folder, { recursive: true, force: true });
    json(res, { removed: Date.now() - info.mtimeMs < stagedLifetime }); return true;
  }
  if (id !== undefined) {
    if (req.method !== 'GET') throw new PackHttpError('Pack action not found.', 404);
    if (!previewName.test(preview!)) throw new PackHttpError('This preview is not part of the pack.', 404);
    const bytes = await readFile(resolve(await staged(root, id), 'previews', preview!)).catch(() => { throw new PackHttpError('This preview is not part of the pack.', 404); });
    // The sender's own PDF: show it, never let it run as page content.
    res.writeHead(200, { 'Content-Type': 'application/pdf', 'Content-Length': bytes.length, 'Content-Disposition': `inline; filename="${preview}"`, 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff', 'Content-Security-Policy': "default-src 'none'; sandbox" });
    res.end(bytes); return true;
  }
  if (req.method !== 'POST') throw new PackHttpError('Pack action not found.', 404);
  await expireStagedPacks(root);

  if (action === 'export') {
    const input = exact(await body(req), ['themes', 'templates', 'id', 'name', 'version', 'author', 'license']);
    const themes = idList(input.themes, 'themes'), templates = idList(input.templates, 'templates');
    if (!themes.length && !templates.length) throw new PackHttpError('Choose at least one theme or template to share.');
    const result = await withWorkspaceLock(root, () => exportPack(root, {
      themes, templates, id: optionalText(input.id, 'pack ID', 80), name: optionalText(input.name, 'pack name'),
      version: optionalText(input.version, 'pack version', 40), author: optionalText(input.author, 'author name'), license: optionalText(input.license, 'license', 1000),
    })).catch(error => { throw /\(EEXIST\)/.test(error?.message) ? new PackHttpError(error.message, 409) : error; });
    json(res, { file: result.output, relativeFile: result.output.startsWith(root + '/') ? result.output.slice(root.length + 1) : undefined, sha256: result.sha256, items: result.manifest.items, previews: result.previews }, 201);
    return true;
  }

  if (action === 'inspect') {
    const bytes = await packUpload(req);
    const folder = await uploads(root, true);
    if ((await expireStagedPacks(root)).length >= stagedLimit) throw new PackHttpError('Install or wait for the packs already waiting, then try again.', 429);
    const stagedId = randomUUID(), pending = resolve(folder, `.pending-${randomUUID()}`);
    await mkdir(pending);
    try {
      const file = resolve(pending, 'pack.zip');
      await writeFile(file, bytes, { flag: 'wx' });
      const pack = await readPack(file); // Reads and verifies the ZIP. It never imports or renders a design.
      const plan = await planInstall(root, pack);
      await mkdir(resolve(pending, 'previews'));
      const previews: string[] = [];
      for (const [path, contents] of pack.files) if (path.startsWith('previews/')) {
        const name = path.slice('previews/'.length);
        await writeFile(resolve(pending, 'previews', name), contents, { flag: 'wx' });
        previews.push(`/api/packs/staged/${stagedId}/previews/${name}`);
      }
      await rename(pending, resolve(folder, stagedId));
      // The sweep also covers a process that never calls again; the timer must not keep the service alive.
      setTimeout(() => { void rm(resolve(folder, stagedId), { recursive: true, force: true }); }, stagedLifetime).unref();
      json(res, {
        stagedId, manifest: pack.manifest, items: pack.manifest.items, files: pack.manifest.files, sha256: pack.sha256,
        compatibility: compatibility(plan), conflicts: plan.conflicts, added: plan.added, reused: plan.reused, previews,
        trust: 'Contains executable TypeScript. Hashes verify file integrity, not author identity or safety. Inspection did not run it.',
      }, 201);
      return true;
    } catch (error) { await rm(pending, { recursive: true, force: true }); throw error; }
  }

  // install
  const input = exact(await body(req), ['stagedId', 'trust']);
  if (input.trust !== true) throw new PackHttpError('Themes and templates run TypeScript when OpenDoc renders them. Confirm that you trust this pack to install it.');
  const folder = await staged(root, input.stagedId), file = resolve(folder, 'pack.zip');
  if (installing.has(root)) throw new PackHttpError('Another pack is installing. Wait for it to finish, then retry.', 409);
  installing.set(root, input.stagedId as string);
  try {
    // Dry run first: conflicts and version mismatches never reach the step that runs code.
    const dry = await installPack(root, file, { dryRun: true });
    if (!dry.plan.compatible) throw new PackHttpError(`This pack requires OpenDoc ${dry.plan.requiredVersion} or a newer patch in the same major.minor line; installed: ${dry.plan.currentVersion}.`, 409);
    if (dry.plan.conflicts.length) throw new PackHttpError(`Pack conflicts with existing files; nothing was installed:\n${listing(dry.plan.conflicts)}\nExisting designs are never overwritten.`, 409);
    if (!dry.plan.added.length) {
      await rm(folder, { recursive: true, force: true });
      json(res, { installed: [], alreadyInstalled: true, verification: 'Every file of this pack is already installed unchanged.' }); return true;
    }
    await hooks.pauseWatching();
    let result: Awaited<ReturnType<typeof installPack>>;
    try { result = await installPack(root, file, { trust: true, calledByOwner: true }); }
    finally { await hooks.resumeWatching(); }
    changed(); // Rescan, so the catalog shows the new designs without a restart.
    await rm(folder, { recursive: true, force: true });
    const added = new Set(result.plan.added);
    json(res, {
      installed: result.manifest.items.filter(item => [...added].some(path => path.startsWith(`${item.kind === 'theme' ? 'themes' : 'templates'}/${item.id}/`))),
      files: result.plan.added,
      verification: 'verified' in result ? result.verified : undefined, visualReview: 'visualReview' in result ? result.visualReview : undefined,
    });
    return true;
  } finally { installing.delete(root); }
}
