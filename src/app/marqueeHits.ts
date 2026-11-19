/** A box in any one coordinate space; candidates and the marquee must share it. */
export interface MarqueeBox { left: number; top: number; right: number; bottom: number }
export interface MarqueeCandidate extends MarqueeBox { id: string; page: number }

const touches = (a: MarqueeBox, b: MarqueeBox) => a.left < b.right && a.right > b.left && a.top < b.bottom && a.bottom > b.top;
const area = (box: MarqueeBox) => (box.right - box.left) * (box.bottom - box.top);
// PDF geometry carries fractional rounding, so a point of slack separates equal edges.
const SLACK = 1;
const encloses = (outer: MarqueeBox, inner: MarqueeBox) => outer.left <= inner.left + SLACK && outer.top <= inner.top + SLACK
  && outer.right >= inner.right - SLACK && outer.bottom >= inner.bottom - SLACK;
const nested = (outer: MarqueeBox, inner: MarqueeBox) => encloses(outer, inner) && area(outer) > area(inner);

/**
 * The components a box chooses. A component the box fully encloses counts as
 * one, with whatever it holds; otherwise only the innermost component the box
 * touches counts, so a box through one list item never selects the whole list.
 */
export function marqueeComponents(box: MarqueeBox, candidates: readonly MarqueeCandidate[]): MarqueeCandidate[] {
  const hits = candidates.filter(item => touches(box, item));
  const enclosed = hits.filter(item => encloses(box, item));
  return hits.filter(item => enclosed.includes(item)
    ? !enclosed.some(other => other !== item && nested(other, item))
    : !enclosed.some(other => nested(other, item)) && !hits.some(other => other !== item && nested(item, other)));
}
