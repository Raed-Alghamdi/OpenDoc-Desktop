import type { PackExportInput, PackInspection } from './api';
import { desktopBridge, type DesktopBridge } from './desktopBridge';

/*
 * The logic behind the pack screens (PackDialogs.tsx), kept free of React and styles so tests can run it.
 * Three parts: which designs are chosen for Export, what an inspected pack allows, and the one entry point
 * that opens Import from outside (the desktop shell's double-click, File > Import and drop).
 */

export type PackKind = 'theme' | 'template';

/* Choosing designs. The choice is shared by both galleries, so one pack can hold themes and templates. */

export interface PackChoice { selecting: boolean; themes: readonly string[]; templates: readonly string[] }
const kinds = { theme: 'themes', template: 'templates' } as const;

export function createPackChoice() {
  let value: PackChoice = { selecting: false, themes: [], templates: [] };
  const listeners = new Set<() => void>();
  const set = (next: PackChoice) => { value = next; listeners.forEach(listener => listener()); };
  return {
    get: () => value,
    subscribe(listener: () => void) { listeners.add(listener); return () => { listeners.delete(listener); }; },
    start() { if (!value.selecting) set({ ...value, selecting: true }); },
    /** Leaves choosing mode and forgets the choice. */
    stop() { if (value.selecting || value.themes.length || value.templates.length) set({ selecting: false, themes: [], templates: [] }); },
    toggle(kind: PackKind, id: string) {
      const key = kinds[kind], current = value[key];
      set({ ...value, selecting: true, [key]: current.includes(id) ? current.filter(item => item !== id) : [...current, id] });
    },
    /** Drops choices the catalog no longer lists, such as a design deleted in another window. */
    prune(kind: PackKind, existing: readonly string[]) {
      const key = kinds[kind], current = value[key], kept = current.filter(id => existing.includes(id));
      if (kept.length !== current.length) set({ ...value, [key]: kept });
    },
  };
}
export const packChoice = createPackChoice();
export const chosenCount = (choice: Pick<PackChoice, 'themes' | 'templates'>) => choice.themes.length + choice.templates.length;
const plural = (count: number, one: string, many = `${one}s`) => `${count} ${count === 1 ? one : many}`;
/** "2 themes and 1 template", or "Nothing" while nothing is chosen. */
export function chosenText(choice: Pick<PackChoice, 'themes' | 'templates'>) {
  const parts = [choice.themes.length && plural(choice.themes.length, 'theme'), choice.templates.length && plural(choice.templates.length, 'template')].filter(Boolean);
  return parts.length ? parts.join(' and ') : 'Nothing';
}

/* The export form. C5 takes a name, an ID, a version, an author and a license; there is no description. */

export interface ExportForm { name: string; version: string; author: string; license: string }
export const emptyExportForm: ExportForm = { name: '', version: '1.0.0', author: '', license: '' };
export const nameLimit = 200, licenseLimit = 1000, versionLimit = 40, idLimit = 80;
const stableVersion = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/;

/** The pack ID the server will accept (lowercase words joined by single hyphens), or '' when the name has no Latin letters or digits. */
export function packId(name: string) {
  return name.normalize('NFKD').replace(/[̀-ͯ]/g, '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, idLimit).replace(/-+$/, '');
}
/** The file Export will write under `output/packs/`, before the server answers. `fallbackId` is the first chosen design. */
export function packFileName(form: ExportForm, fallbackId: string) {
  return `${packId(form.name) || fallbackId}-${form.version.trim() || '1.0.0'}.opendoc.zip`;
}
export function exportProblems(form: ExportForm): Partial<Record<keyof ExportForm, string>> {
  const problems: Partial<Record<keyof ExportForm, string>> = {};
  if (form.name.length > nameLimit) problems.name = `Use at most ${nameLimit} characters.`;
  if (form.version.trim() && !stableVersion.test(form.version.trim())) problems.version = 'Use three numbers, such as 1.0.0.';
  if (form.version.trim().length > versionLimit) problems.version = `Use at most ${versionLimit} characters.`;
  if (form.author.length > nameLimit) problems.author = `Use at most ${nameLimit} characters.`;
  if (form.license.length > licenseLimit) problems.license = `Use at most ${licenseLimit} characters.`;
  return problems;
}
/** The request body: empty fields are left out so the server's defaults apply. */
export function exportRequest(choice: Pick<PackChoice, 'themes' | 'templates'>, form: ExportForm): PackExportInput {
  const text = (value: string) => value.trim() || undefined;
  const name = text(form.name), id = name && packId(name) || undefined;
  return {
    themes: [...choice.themes], templates: [...choice.templates],
    ...(id ? { id } : {}), ...(name ? { name } : {}),
    ...(text(form.version) ? { version: text(form.version) } : {}),
    ...(text(form.author) ? { author: text(form.author) } : {}),
    ...(text(form.license) ? { license: text(form.license) } : {}),
  };
}
/** The server answers an existing output file with 409; say what to change instead of quoting its path. */
export function exportFailure(error: { status?: number; message: string }) {
  return error.status === 409 && /EEXIST|already exists/i.test(error.message)
    ? 'A pack with this name and version already exists in this workspace. Change the version (for example 1.0.1) or the name, then try again.'
    : error.message;
}

/* Reading an inspected pack. */

export type PackBlocker = { kind: 'incompatible' | 'conflicts' | 'nothing-new' | 'read-only' | 'offline'; message: string };
/** Why Install cannot go ahead whatever the user ticks. Conflicts are never something to overwrite. */
export function packBlockers(inspection: Pick<PackInspection, 'compatibility' | 'conflicts' | 'added'>, context: { readOnly?: string; connected?: boolean } = {}): PackBlocker[] {
  const blockers: PackBlocker[] = [];
  const { compatibility, conflicts, added } = inspection;
  if (!compatibility.compatible) blockers.push({ kind: 'incompatible', message: `This pack needs OpenDoc ${compatibility.requiredVersion} or a later patch of the same minor version. This workspace runs ${compatibility.currentVersion}. Ask the sender to export it again with this version.` });
  if (conflicts.length) blockers.push({ kind: 'conflicts', message: 'These files already exist in this workspace with different contents, so nothing was installed. OpenDoc never overwrites an existing design. Ask the sender to export with different design IDs, or import the pack into another workspace.' });
  if (!conflicts.length && compatibility.compatible && !added.length) blockers.push({ kind: 'nothing-new', message: 'Everything in this pack is already installed, unchanged.' });
  if (context.readOnly) blockers.push({ kind: 'read-only', message: context.readOnly });
  if (context.connected === false) blockers.push({ kind: 'offline', message: 'Reconnect to OpenDoc to install.' });
  return blockers;
}
/** Install needs no blocker, an explicit tick of the trust box, and no request in flight. */
export function canInstall(blockers: readonly PackBlocker[], trusted: boolean, busy: boolean) {
  return !blockers.length && trusted && !busy;
}
/** What Install adds, grouped as the design folders the user will see. */
export function installedLinks(installed: readonly { kind: PackKind; id: string }[]) {
  return installed.map(item => ({ ...item, href: `#${kinds[item.kind]}/${item.id}` }));
}
export function fileSize(bytes: number) {
  if (bytes < 1024) return `${bytes} B`;
  const unit = bytes >= 1048576 ? 'MB' : 'KB';
  return `${new Intl.NumberFormat(undefined, { maximumFractionDigits: 1 }).format(bytes / (unit === 'MB' ? 1048576 : 1024))} ${unit}`;
}
/** A pack is a ZIP; `.opendoc.zip` is the usual name, but a browser or Finder may rename it. */
export const isPackFileName = (name: string) => /\.zip$/i.test(name);
export const packSizeLimit = 64 * 1024 * 1024;

/* Opening Import from outside. */

/** What the shell hands the page: the pack's file name and bytes. The page cannot read a path itself. */
export type PackFileInput = File | { name: string; bytes: ArrayBuffer | Uint8Array };
/** A desktop bridge that can also deliver a pack the user opened outside the page. Optional, so older shells still work. */
export interface PackBridge extends DesktopBridge {
  /** Called with the pack the user double-clicked, dropped on the window, or chose in File > Import. Returns the unsubscribe function. */
  onImportPack?(listener: (file: { name: string; bytes: ArrayBuffer | Uint8Array }) => void): () => void;
  /** Shows a file in the system file manager. The shell must allow only files inside the open workspace's `output/packs/`. */
  showInFolder?(path: string): Promise<void> | void;
}
export const packBridge = (scope: object = window) => desktopBridge(scope) as PackBridge | undefined;

/** A File from what the shell sent, or from a chosen file as it is. */
export function packFile(input: PackFileInput): File {
  if (typeof File !== 'undefined' && input instanceof File) return input;
  const { name, bytes } = input as { name: string; bytes: ArrayBuffer | Uint8Array };
  return new File([bytes as BlobPart], name, { type: 'application/zip' });
}

export interface ImportRequest { id: number; file?: File }
export function createImportEntry() {
  let request: ImportRequest | null = null, counter = 0;
  const listeners = new Set<() => void>();
  return {
    /** The pending request, or null once the dialog took it or the user closed it. */
    get: () => request,
    subscribe(listener: () => void) { listeners.add(listener); return () => { listeners.delete(listener); }; },
    /** Opens Import, with `file` already chosen when given. */
    open(file?: PackFileInput) { request = { id: ++counter, file: file ? packFile(file) : undefined }; listeners.forEach(listener => listener()); },
    close() { if (request) { request = null; listeners.forEach(listener => listener()); } },
  };
}
export const importEntry = createImportEntry();

/**
 * Several screens can mount the Import dialog (each gallery does, and the app shell can once for every view). Only the
 * first one mounted is active, so a file dropped on the window opens one dialog, not two.
 */
export function createHostRegistry() {
  const hosts: symbol[] = [];
  const listeners = new Set<() => void>();
  let first: symbol | undefined;
  const emit = () => { const next = hosts[0]; if (next !== first) { first = next; listeners.forEach(listener => listener()); } };
  return {
    register(host: symbol) { hosts.push(host); emit(); return () => { hosts.splice(hosts.indexOf(host), 1); emit(); }; },
    active: () => first,
    subscribe(listener: () => void) { listeners.add(listener); return () => { listeners.delete(listener); }; },
  };
}
export const importHosts = createHostRegistry();

/**
 * The entry point for the desktop shell (E9) and anything else outside the dialog: open Import, optionally with a pack file
 * already chosen. It inspects at once when a file is given; nothing is installed until the user ticks trust and presses Install.
 */
export function openPackImport(file?: PackFileInput) { importEntry.open(file); }
