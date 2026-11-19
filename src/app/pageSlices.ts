import type { RenderArtifact } from '../shared/types';
import type { DocumentSelection } from '../shared/selection';

/** The part of the reader's selection and open comments that one page displays. */
export interface PageSlice {
  /** The selection when its component or text appears on this page. */
  selection: DocumentSelection | null;
  /** Components on this page with open comments. */
  commented: ReadonlySet<string>;
  /** Open phrase comments whose text appears on this page. */
  commentPhrases: DocumentSelection[];
  /** Components on this page chosen in addition to the main selection. */
  multi: ReadonlySet<string>;
}

type PageMembers = { blocks: Set<string>; targets: Set<string> };
const members = new WeakMap<RenderArtifact, PageMembers[]>();

/** The components and text targets laid out on each page, computed once per render. */
function pageMembers(artifact: RenderArtifact): PageMembers[] {
  let result = members.get(artifact);
  if (result) return result;
  result = artifact.pages.map(page => ({ blocks: new Set(page.fragments.map(fragment => fragment.id)), targets: new Set<string>() }));
  for (const target of artifact.textTargets ?? []) {
    for (const line of target.lines) result[line.page - 1]?.targets.add(target.id);
  }
  members.set(artifact, result);
  return result;
}

const sameRange = (a: DocumentSelection, b: DocumentSelection) =>
  a.blockId === b.blockId && a.targetId === b.targetId && a.start === b.start && a.end === b.end && a.renderHash === b.renderHash;

/**
 * Split document-wide reader state into per-page props. A page whose slice is
 * unchanged keeps the previous objects, so a memoized page skips the render.
 */
export function pageSlices(
  artifact: RenderArtifact | undefined,
  selection: DocumentSelection | null,
  commented: ReadonlySet<string>,
  commentPhrases: DocumentSelection[],
  previous: readonly PageSlice[] = [],
  additional: readonly DocumentSelection[] = [],
): PageSlice[] {
  if (!artifact) return [];
  return pageMembers(artifact).map(({ blocks, targets }, index) => {
    const before = previous[index];
    const shown = selection && (blocks.has(selection.blockId) || (!!selection.targetId && targets.has(selection.targetId))) ? selection : null;
    const markers = [...blocks].filter(id => commented.has(id));
    const phrases = commentPhrases.filter(phrase => !!phrase.targetId && targets.has(phrase.targetId));
    const chosen = additional.filter(item => blocks.has(item.blockId)).map(item => item.blockId);
    const next: PageSlice = {
      selection: shown,
      multi: before && before.multi.size === chosen.length && chosen.every(id => before.multi.has(id)) ? before.multi : new Set(chosen),
      commented: before && before.commented.size === markers.length && markers.every(id => before.commented.has(id)) ? before.commented : new Set(markers),
      commentPhrases: before && before.commentPhrases.length === phrases.length && phrases.every((phrase, at) => sameRange(phrase, before.commentPhrases[at])) ? before.commentPhrases : phrases,
    };
    return before && before.selection === next.selection && before.commented === next.commented && before.commentPhrases === next.commentPhrases && before.multi === next.multi ? before : next;
  });
}
