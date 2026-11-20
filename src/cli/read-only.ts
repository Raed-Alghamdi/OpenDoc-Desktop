import { codedError } from './errors';
import { workspaceOwner } from './owner';
import { comparePin, isManagedHere, packageMetadata, readWorkspaceMarker, workspaceIdentity } from './workspace';
import { readOnlyCode, type ReadOnlyState } from '../shared/read-only';

/**
 * Which `opendoc` commands may run while a workspace is read-only (plan 3.4): reading, rendering into `.opendoc/`,
 * exporting into `output/`, and the export history. A command that is on neither list is refused, so a command
 * added later is safe until someone decides. tests/read-only.test.ts keeps both lists in step with the registry.
 * Each entry is the command path as typed; `create` and `update` also depend on a flag (see `isWriteCommand`).
 */
export const readOnlyCommands = [
  'help', 'check', 'review', 'export', 'context', 'status', 'stop', 'start', 'init', 'update',
  'projects list', 'documents trash', 'documents list', 'documents show', 'templates list', 'templates inspect', 'templates check', 'templates preview',
  'themes list', 'themes inspect', 'themes check', 'themes preview', 'themes folders list',
  'tags list', 'tags show', 'tags find', 'assets list', 'assets inspect', 'media list', 'media check',
  'comments list', 'history list', 'history show', 'history block', 'packs export', 'packs inspect',
  'export history list', 'export history delete', 'export history restore', 'export history reveal',
];
export const writeCommands = [
  'create',
  'projects create', 'projects update', 'projects assign', 'projects delete',
  'documents rename', 'documents duplicate', 'documents delete', 'documents restore',
  'themes folders create', 'themes folders rename', 'themes folders delete', 'themes assign', 'themes tags',
  'tags add', 'tags remove', 'tags set', 'tags status', 'tags create', 'tags delete',
  'assets import logo', 'assets import font', 'assets revise', 'assets add-variation', 'assets add-faces', 'assets archive', 'assets restore', 'assets defaults', 'assets bind', 'assets unbind',
  'media import', 'media record', 'media edit',
  'comments resolve', 'comments reopen', 'comments delete', 'comments restore', 'comments add', 'comments edit',
  'history restore', 'packs install',
];

const known = new Map<string, 'read' | 'write'>([...readOnlyCommands.map(path => [path, 'read'] as const), ...writeCommands.map(path => [path, 'write'] as const)]);

/** Whether this command line would write to the workspace's own files. Unknown commands count as writes. */
export function isWriteCommand(command: string, args: string[]): boolean {
  if (command === '--version' || command === '-v' || command === '--help' || command === '-h') return false;
  const words = [command, ...args.filter(arg => !arg.startsWith('-'))];
  let kind: 'read' | 'write' | undefined;
  for (let length = Math.min(words.length, 3); length > 0 && !kind; length--) kind = known.get(words.slice(0, length).join(' '));
  if (command === 'create') return !args.includes('--list');
  if (command === 'update') return !args.includes('--check');
  return kind !== 'read';
}

/**
 * In a workspace the desktop app manages, a pin newer than this runtime is read-only (plan 3.4): the same minor with a newer
 * patch, or a newer minor. The app's own opening says the same in its own words; this covers the CLI run on its own.
 */
async function pinReadOnly(root: string): Promise<ReadOnlyState | null> {
  let pin: string, running: string, status: ReturnType<typeof comparePin>;
  try {
    if (!await isManagedHere(root)) return null;
    pin = workspaceIdentity(await packageMetadata(root), await readWorkspaceMarker(root)).version;
    running = (await packageMetadata()).version;
    status = comparePin(pin, running);
  } catch { return null; } // A workspace that cannot be read gets its real error from the command itself.
  if (status === 'newer-patch') return { reason: 'newer-patch', message: `This workspace is on OpenDoc ${pin}, newer than the ${running} in this app. Update the app to edit it.` };
  if (status === 'newer-minor') return { reason: 'newer-minor', message: `This workspace was upgraded by OpenDoc ${pin.split('.').slice(0, 2).join('.')}. Update the app to edit it.` };
  return null;
}

/** The read-only state of a workspace: what the desktop app recorded for the workspace it has open, else the version table. */
export async function workspaceReadOnly(root: string): Promise<ReadOnlyState | null> {
  return (await workspaceOwner(root, { pidOnly: true })).readOnly ?? await pinReadOnly(root);
}

/** Throws the refusal for a write command in a read-only workspace. */
export async function refuseReadOnlyWrite(root: string, command: string, args: string[]) {
  if (!isWriteCommand(command, args)) return;
  const state = await workspaceReadOnly(root);
  if (state) throw codedError(state.message, readOnlyCode);
}
