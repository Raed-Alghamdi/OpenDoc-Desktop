import { getBlock, type Comment, type RenderArtifact } from '../shared/types';
import type { DocumentSelection, TextAnchor } from '../shared/selection';
import { getTextTarget, resolveCommentAnchor } from '../shared/anchors';

/** One place a comment is about (contract C1). */
export interface CommentTarget { blockId: string; quote: string; anchor?: TextAnchor }
/** A comment as the reader sees it: `targets` is present only when it covers two or more places. */
export type CommentWithTargets = Comment & { targets?: CommentTarget[] };

/** Every place a comment covers, the first being the comment's own block, quote, and anchor. */
export function commentTargets(comment: CommentWithTargets): CommentTarget[] {
  return comment.targets && comment.targets.length > 1 ? comment.targets
    : [{ blockId: comment.blockId, quote: comment.quote, ...(comment.anchor ? { anchor: comment.anchor } : {}) }];
}

export const commentBlockIds = (comment: CommentWithTargets) => commentTargets(comment).map(target => target.blockId);

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

/** A comment's places in page order, each resolved against the current render. */
export function commentPlaces(artifact: RenderArtifact | null | undefined, comment: CommentWithTargets): CommentPlace[] {
  const places = commentTargets(comment).map((target): CommentPlace => {
    const { status, selection } = resolveCommentAnchor(artifact, target);
    return { target, status, selection, kind: getBlock(artifact, target.blockId)?.kind ?? 'component' };
  });
  return sortByPlace(places, place => place.selection && positionOf(artifact, place.selection));
}
