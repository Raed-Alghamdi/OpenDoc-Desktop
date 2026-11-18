import { useRef, type PointerEvent, type RefObject } from 'react';
import type { RenderArtifact } from '../shared/types';
import { marqueeComponents, type MarqueeCandidate } from './marqueeHits';

export interface MarqueeHit { id: string; page: number }

/**
 * Shift-drag box selection over the reader's pages, written against the
 * component bounds each page already carries in the render artifact. No DOM
 * query per component: a page contributes its fragments scaled by its own
 * on-screen width, so pages that are not rendered yet can still be chosen.
 */
export function useMarquee({ sheets, box, artifact, enabled, onStart, onChange }: {
  /** The positioned element that holds every page and the box. */
  sheets: RefObject<HTMLElement | null>;
  box: RefObject<HTMLElement | null>;
  artifact: RenderArtifact | undefined;
  enabled: boolean;
  onStart: () => void;
  /** The components the box chooses now; null when Escape cancels the drag. */
  onChange: (hits: MarqueeHit[] | null) => void;
}) {
  const latest = useRef({ artifact, enabled, onStart, onChange });
  latest.current = { artifact, enabled, onStart, onChange };

  return function onPointerDown(event: PointerEvent<HTMLElement>) {
    const { artifact, enabled } = latest.current;
    const area = sheets.current, outline = box.current, host = event.currentTarget;
    // Touch scrolls the reader, and the keyboard has Shift+Enter, so a box is for mouse and pen.
    if (!enabled || !artifact || !area || !outline || event.button !== 0 || !event.shiftKey || event.pointerType === 'touch') return;
    if ((event.target as Element).closest('a, input, textarea, select, [role="dialog"], .comment-marker')) return;
    const frame: HTMLElement = outline;
    const startArea = area.getBoundingClientRect();
    const origin = { x: event.clientX - startArea.left, y: event.clientY - startArea.top };
    let point = { x: event.clientX, y: event.clientY }, raf = 0, dragging = false, cancelled = false, key = '';

    const tick = () => {
      raf = requestAnimationFrame(tick);
      const hostRect = host.getBoundingClientRect();
      // Near the top or bottom edge the reader scrolls on its own.
      const edge = 48, push = point.y < hostRect.top + edge ? point.y - hostRect.top - edge : point.y > hostRect.bottom - edge ? point.y - hostRect.bottom + edge : 0;
      if (push) host.scrollTop += Math.max(-16, Math.min(16, push / 3));
      const areaRect = area.getBoundingClientRect();
      const clamp = (value: number, low: number, high: number) => Math.max(low, Math.min(high, value));
      const x = clamp(point.x, areaRect.left, areaRect.right), y = clamp(point.y, areaRect.top, areaRect.bottom);
      const rect = { left: Math.min(x, areaRect.left + origin.x), right: Math.max(x, areaRect.left + origin.x),
        top: Math.min(y, areaRect.top + origin.y), bottom: Math.max(y, areaRect.top + origin.y) };
      Object.assign(frame.style, { left: `${rect.left - areaRect.left}px`, top: `${rect.top - areaRect.top}px`,
        width: `${rect.right - rect.left}px`, height: `${rect.bottom - rect.top}px` });
      const candidates: MarqueeCandidate[] = [];
      for (const element of area.querySelectorAll<HTMLElement>('.pdf-page[data-page]')) {
        const bounds = element.getBoundingClientRect();
        if (bounds.bottom <= rect.top || bounds.top >= rect.bottom || bounds.right <= rect.left || bounds.left >= rect.right) continue;
        const number = Number(element.dataset.page), page = artifact.pages[number - 1];
        if (!page) continue;
        const scale = bounds.width / page.width;
        for (const f of page.fragments) candidates.push({ id: f.id, page: number, left: bounds.left + f.x * scale, top: bounds.top + f.y * scale,
          right: bounds.left + (f.x + f.width) * scale, bottom: bounds.top + (f.y + f.height) * scale });
      }
      const hits = marqueeComponents(rect, candidates);
      const next = hits.map(hit => hit.id).sort().join('\n');
      if (next === key) return;
      key = next;
      latest.current.onChange(hits.map(({ id, page }) => ({ id, page })));
    };
    const move = (next: globalThis.PointerEvent) => {
      if (next.pointerId !== event.pointerId) return;
      point = { x: next.clientX, y: next.clientY };
      // Matches the page's click threshold: a shorter move is a Shift-click, which toggles.
      if (cancelled || dragging || Math.hypot(next.clientX - event.clientX, next.clientY - event.clientY) <= 4) return;
      dragging = true;
      window.getSelection()?.removeAllRanges();
      host.classList.add('marquee-active');
      frame.hidden = false;
      latest.current.onStart();
      raf = requestAnimationFrame(tick);
    };
    const stop = () => {
      cancelAnimationFrame(raf);
      window.removeEventListener('pointermove', move);
      window.removeEventListener('pointerup', finish);
      window.removeEventListener('pointercancel', finish);
      window.removeEventListener('keydown', escape, true);
      host.classList.remove('marquee-active');
      frame.hidden = true;
    };
    // The click that follows a drag is not a toggle.
    const swallowClick = () => {
      const swallow = (click: MouseEvent) => { click.stopPropagation(); click.preventDefault(); };
      window.addEventListener('click', swallow, { capture: true, once: true });
      setTimeout(() => window.removeEventListener('click', swallow, true), 0);
    };
    function finish(next: globalThis.PointerEvent) {
      if (next.pointerId !== event.pointerId) return;
      if (dragging) swallowClick();
      stop();
    }
    function escape(press: KeyboardEvent) {
      if (press.key !== 'Escape') return;
      press.stopImmediatePropagation();
      press.preventDefault();
      // The drag ends here, but the button is still down: its release and click stay swallowed.
      cancelled = true;
      cancelAnimationFrame(raf);
      host.classList.remove('marquee-active');
      frame.hidden = true;
      if (dragging) latest.current.onChange(null);
    }
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', finish);
    window.addEventListener('pointercancel', finish);
    window.addEventListener('keydown', escape, true);
  };
}
