import { getBlock, type Comment, type CommentTarget, type RenderArtifact } from '../shared/types';
import type { DocumentSelection } from '../shared/selection';
import { commentTargets, getTextTarget, resolveCommentTargets } from '../shared/anchors';

export const commentBlockIds = (comment: Comment) => commentTargets(comment).map(target => target.blockId);

export interface CommentPlace {
  target: CommentTarget;
  status: 'attached' | 'changed' | 'missing';
  selection?: DocumentSelection;
  /** The component's kind, such as "paragraph". */
  kind: string;
}

interface Position { page: number; y: number; x: number }

/** Where a selection sits on its page: a phrase by its first line, a component by its box. */
function positionOf(artifact: RenderArtifact | null | undefined, selection: DocumentSelection): Position | undefined {
  const target = getTextTarget(artifact, selection.targetId);
  const line = target && selection.start !== undefined ? target.lines.find(item => item.page === selection.page && item.end > selection.start! && item.start <= selection.start!) : undefined;
  if (line) return { page: line.page, y: line.y, x: line.x };
  const fragment = artifact?.pages[selection.page - 1]?.fragments.find(item => item.id === selection.blockId);
  return fragment ? { page: selection.page, y: fragment.y, x: fragment.x } : undefined;
}

/** Order places by page, then y, then x; places without a position keep their order, last. */
export function sortByPlace<T>(items: readonly T[], position: (item: T) => Position | undefined): T[] {
  const keyed = items.map((item, index) => ({ item, index, at: position(item) }));
  return keyed.sort((a, b) => !a.at || !b.at ? Number(!a.at) - Number(!b.at) || a.index - b.index
    : a.at.page - b.at.page || a.at.y - b.at.y || a.at.x - b.at.x || a.index - b.index).map(entry => entry.item);
}

/** The selections in page order, for the composer's summary. */
export function selectionsByPlace(artifact: RenderArtifact | null | undefined, selections: readonly DocumentSelection[]) {
  return sortByPlace(selections, selection => positionOf(artifact, selection));
}

/** A comment's places in page order, each resolved on its own against the current render. */
export function commentPlaces(artifact: RenderArtifact | null | undefined, comment: Comment): CommentPlace[] {
  const places = resolveCommentTargets(artifact, comment).map(({ anchorStatus, targetAvailable, selection, ...target }): CommentPlace =>
    ({ target, status: anchorStatus, selection, kind: getBlock(artifact, target.blockId)?.kind ?? 'component' }));
  return sortByPlace(places, place => place.selection && positionOf(artifact, place.selection));
}
