import { parseArgs } from 'node:util';
import { ExportError, ExportStore } from './exports';
import { documentEntry, validId } from './render';
import { exportInfo, type ExportHistoryEntry } from '../shared/export';

const usage = `Usage: npx opendoc export history list <doc> [--json]
       npx opendoc export history delete <export-id> [--json]
       npx opendoc export history restore <export-id> [--json]
       npx opendoc export history reveal <export-id> [--open] [--json]
Previous exports of a document, newest first, as the app's Previous exports dialog shows them. An
entry is unavailable when its file was moved, removed, or changed outside OpenDoc. delete removes
the receipt and the output file when it is untouched; restore undoes it. reveal prints the file's
path; with --open it also shows the file in the system file manager.`;

/** What reveal does when asked to open the folder; replaced in tests so nothing launches. */
export interface ExportHistoryOptions { reveal?: (store: ExportStore, id: string) => Promise<void> }

const size = (bytes: number) => `${new Intl.NumberFormat('en-US', { maximumFractionDigits: 1 }).format(bytes / (bytes >= 1048576 ? 1048576 : 1024))} ${bytes >= 1048576 ? 'MB' : 'KB'}`;

function row(entry: ExportHistoryEntry) {
  const notes = [!entry.hash ? 'Saved from the command line' : '', !entry.available ? 'File moved, removed, or changed' : ''].filter(Boolean);
  return [`  ${entry.id}  ${entry.filename}  ${exportInfo(entry.format).label}  ${entry.createdAt}  ${size(entry.bytes)}`, ...(notes.length ? [`    ${notes.join('. ')}`] : [])].join('\n');
}

export async function runExportHistoryCli(args: string[], root = process.cwd(), options: ExportHistoryOptions = {}): Promise<void> {
  const { values, positionals } = parseArgs({ args: args[0] === '--' ? args.slice(1) : args, allowPositionals: true, options: {
    json: { type: 'boolean' }, help: { type: 'boolean', short: 'h' }, open: { type: 'boolean' },
  } });
  if (values.help) { console.log(values.json ? JSON.stringify({ usage }, null, 2) : usage); return; }
  const [group, action, target] = positionals;
  if (group !== 'history' || !['list', 'delete', 'restore', 'reveal'].includes(action) || !target || positionals.length !== 3) throw new Error(usage);
  if (values.open && action !== 'reveal') throw new Error(`--open belongs to export history reveal.\n${usage}`);
  const store = new ExportStore(root);
  const print = (value: unknown, text: string) => console.log(values.json ? JSON.stringify(value, null, 2) : text);
  if (action === 'list') {
    if (!validId(target)) throw new Error('Invalid document ID.');
    try { await documentEntry(root, target); }
    catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') throw new ExportError('Document not found.', 404); throw error; }
    const exports = await store.list(target);
    print({ documentId: target, exports }, exports.length ? [`${exports.length} ${exports.length === 1 ? 'export' : 'exports'} of ${target}, newest first:`, ...exports.map(row)].join('\n') : `No exports yet for ${target}.`);
  } else if (action === 'delete') {
    // The name is for the message only; an entry that is no longer available is removed by its ID.
    const filename = await store.get(target).then(value => value?.filename, () => undefined);
    await store.remove(target);
    print({ id: target, ...(filename ? { filename } : {}), removed: true }, `Removed ${filename ?? target}\nRestore with: npx opendoc export history restore ${target}`);
  } else if (action === 'restore') {
    const result = await store.restore(target);
    print(result, `Restored ${result.filename}`);
  } else {
    const saved = await store.get(target);
    if (!saved) throw new ExportError('This exported file is no longer available.', 404);
    // Nothing is launched unless asked: the path is the answer.
    if (values.open) await (options.reveal ?? ((exports, id) => exports.reveal(id)))(store, target);
    print({ id: saved.id, filename: saved.filename, path: saved.path, opened: !!values.open }, saved.path);
  }
}
