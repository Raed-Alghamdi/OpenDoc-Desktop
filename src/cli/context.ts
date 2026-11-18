import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { parseArgs } from 'node:util';
import { workspaceSession } from './owner';

const usage = `Usage: npx opendoc context [--json]
Prints what the OpenDoc app last recorded in .opendoc/current.json: the open document, the selection,
unsaved text edits, and pending comments. stale is true when that record may no longer match the app:
nothing has the workspace open, or the document has a newer revision than the record.`;

/** Whether the recorded document revision is still the live one. Unknown counts as stale. */
async function current(root: string, context: { documentId?: unknown; revision?: unknown }): Promise<boolean> {
  let owned;
  // An owner that cannot be confirmed is not one to trust: the record may be a leftover.
  try { owned = await workspaceSession(root); } catch { return false; }
  const { owner } = owned;
  // Nothing has the workspace open, so nothing keeps the record up to date.
  if (owner.mode === null) return false;
  // The desktop app answers over its own channel, not an address; its host rewrites the record on every change.
  if (owner.mode === 'desktop') return true;
  if (typeof context.documentId !== 'string' || !context.documentId) return true;
  try {
    const response = await fetch(`${owner.origin}/api/documents/${encodeURIComponent(context.documentId)}`, { signal: AbortSignal.timeout(3000), redirect: 'error' });
    if (!response.ok) return false;
    const state = await response.json() as { revision?: unknown };
    return state.revision === context.revision;
  } catch { return false; }
}

export async function runContext(args: string[], root: string) {
  const { values, positionals } = parseArgs({ args, allowPositionals: true, options: { json: { type: 'boolean' }, help: { type: 'boolean', short: 'h' } } });
  if (values.help) { console.log(values.json ? JSON.stringify({ usage }) : usage); return; }
  if (positionals.length) throw new Error(usage);
  let text: string;
  try { text = await readFile(resolve(root, '.opendoc/current.json'), 'utf8'); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') throw new Error('There is no current context yet. Open this workspace in OpenDoc and open a document, then try again.');
    throw error;
  }
  let context: Record<string, unknown> | null;
  try { context = JSON.parse(text); } catch { context = null; }
  if (!context || typeof context !== 'object' || Array.isArray(context)) throw new Error('.opendoc/current.json is not a valid context record. Open this workspace in OpenDoc to write it again.');
  // Everything the app wrote passes through as it is; only stale is added.
  const result = { ...context, stale: !(await current(root, context)) };
  if (values.json) { console.log(JSON.stringify(result, null, 2)); return; }
  const document = typeof context.name === 'string' && context.name ? context.name : typeof context.documentId === 'string' ? context.documentId : 'none';
  const selection = context.selection as { quote?: unknown } | null | undefined;
  console.log([
    `Document: ${document}${typeof context.revision === 'number' ? ` (revision ${context.revision})` : ''}`,
    `Selection: ${typeof context.blockId === 'string' && context.blockId ? context.blockId : 'none'}${typeof selection?.quote === 'string' ? ` "${selection.quote}"` : ''}`,
    ...(result.stale ? ['Stale: the app may have moved on since this was written. Run npx opendoc context again with OpenDoc open, or ask the user.'] : []),
  ].join('\n'));
}
