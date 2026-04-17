import { useEffect, useState, type RefObject } from "react";

/**
 * Tracks the rendered width (in CSS pixels) of the element referenced by
 * `ref` via `ResizeObserver`. Returns `0` until the first measurement lands.
 *
 * Use this when responsiveness must depend on the *container* a component
 * actually occupies, not on the viewport. Example: the chat composer's
 * available width changes whenever the right panel opens or the sidebar
 * resizes — viewport media queries can't see that.
 *
 * Updates are throttled with `requestAnimationFrame` so a flurry of resize
 * notifications collapses into one state update per frame.
 */
export function useElementWidth<T extends HTMLElement>(ref: RefObject<T | null>): number {
  const [width, setWidth] = useState(0);

  useEffect(() => {
    const el = ref.current;
    if (!el) return;

    // Seed with the current size so consumers don't get a 0 → real flash
    // when the element is already laid out at mount time. Done unconditionally
    // so environments without ResizeObserver (older test runners, SSR
    // hydration) still get a valid initial measurement.
    setWidth(el.getBoundingClientRect().width);

    if (typeof ResizeObserver === "undefined") return;

    let rafId: number | null = null;
    let pending = 0;

    const observer = new ResizeObserver((entries) => {
      const entry = entries[0];
      if (!entry) return;
      // Modern browsers expose contentBoxSize as a readonly array; older ones
      // returned a single object. Fall back to contentRect for the rest.
      let next: number;
      if (entry.contentBoxSize) {
        const box = Array.isArray(entry.contentBoxSize)
          ? entry.contentBoxSize[0]
          : (entry.contentBoxSize as unknown as ResizeObserverSize);
        next = box.inlineSize;
      } else {
        next = entry.contentRect.width;
      }

      pending = next;
      if (rafId !== null) return;
      rafId = requestAnimationFrame(() => {
        rafId = null;
        setWidth(pending);
      });
    });

    observer.observe(el);
    return () => {
      observer.disconnect();
      if (rafId !== null) cancelAnimationFrame(rafId);
    };
  }, [ref]);

  return width;
}
