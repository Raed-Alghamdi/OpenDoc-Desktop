import { selectionListError, type DocumentSelection } from '../shared/selection';

/** The most places one comment or context selection can name; it keeps observed context small. */
export const maxSelections = 200;

/** Keep observed UI context small and typed; it is not an instruction to the agent. */
export function readSelection(input: unknown, blockId: string | null): DocumentSelection | null {
  if (input == null) return null;
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw new Error('Invalid selection.');
  if (!blockId || (input as DocumentSelection).blockId !== blockId) throw new Error('The selection does not match the active block.');
  return readSelectionEntry(input);
}

/**
 * A list of selections (C1): the first may be a phrase, the others are whole components, each block
 * once. `activeBlockId` is the block the reader has focused; it must be one of them, and the
 * first entry is kept first. Returns [] for no selection.
 */
export function readSelections(input: unknown, activeBlockId: string | null): DocumentSelection[] {
  if (input == null) return [];
  if (!Array.isArray(input)) throw new Error('Invalid selections.');
  if (input.length > maxSelections) throw new Error(`Select at most ${maxSelections} components in one comment.`);
  const entries = input.map(item => {
    if (!item || typeof item !== 'object' || Array.isArray(item)) throw new Error('Invalid selection.');
    return readSelectionEntry(item);
  });
  if (!entries.length) return [];
  const problem = selectionListError(entries);
  if (problem) throw new Error(problem);
  if (!activeBlockId || !entries.some(entry => entry.blockId === activeBlockId)) throw new Error('The selection does not match the active block.');
  return entries;
}

/** The context fields for a list: `selection` stays the first entry, as older readers expect. */
export function selectionContext(selections: DocumentSelection[]) {
  return { selection: selections[0] ?? null, selections };
}

function readSelectionEntry(input: object): DocumentSelection {
  const value = input as DocumentSelection;
  const blockId = value.blockId;
  if (typeof blockId !== 'string' || !blockId || blockId.length > 1000) throw new Error('Invalid selection block.');
  // The user can scroll elsewhere while keeping a phrase selected.
  if (!Number.isInteger(value.page) || value.page < 1) throw new Error('Invalid selection page.');
  if (value.targetId !== undefined && (typeof value.targetId !== 'string' || !value.targetId || value.targetId.length > 1000)) throw new Error('Invalid selected field.');
  if ((value.start !== undefined || value.end !== undefined) && (!value.targetId || !Number.isInteger(value.start) || !Number.isInteger(value.end) || value.start! < 0 || value.end! <= value.start!)) throw new Error('Invalid selected text range.');
  if (value.quote !== undefined && (typeof value.quote !== 'string' || value.quote.length > 8000)) throw new Error('Selected text is too long. Select a shorter passage.');
  if (value.renderHash !== undefined && (typeof value.renderHash !== 'string' || value.renderHash.length > 128)) throw new Error('Invalid selection version.');
  if (value.revision !== undefined && (!Number.isInteger(value.revision) || value.revision < 0)) throw new Error('Invalid selection revision.');
  return { blockId, page: value.page,
    ...(value.targetId === undefined ? {} : { targetId: value.targetId }),
    ...(value.start === undefined ? {} : { start: value.start, end: value.end }),
    ...(value.quote === undefined ? {} : { quote: value.quote }),
    ...(value.renderHash === undefined ? {} : { renderHash: value.renderHash }),
    ...(value.revision === undefined ? {} : { revision: value.revision }),
  };
}
