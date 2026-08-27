import type { MutableRefObject } from "react";
import type { ThreadScrollPosition } from "@/components/chat/scrollPositionMemory";

/** The scroll operation required to restore a thread's saved reading position. */
export type ScrollRestorePlan =
  | { readonly kind: "tail" }
  | {
      readonly kind: "reading";
      readonly scrollTop: number;
      readonly anchorMessageId?: string;
      readonly anchorTop?: number;
    };

/** Chooses between tail following and restoring a saved reading anchor. */
export function getScrollRestorePlan(
  element: HTMLElement,
  target: ThreadScrollPosition,
  autoScrollThreshold: number,
): ScrollRestorePlan {
  const maxScroll = Math.max(0, element.scrollHeight - element.clientHeight);
  const withinTail = target.scrollTop <= maxScroll && maxScroll - target.scrollTop <= autoScrollThreshold;
  const hasHistoryAnchor = !target.atTail && !!target.anchorMessageId && target.anchorTop != null;
  if (target.atTail || (!hasHistoryAnchor && (withinTail || target.scrollTop > maxScroll))) {
    return { kind: "tail" };
  }
  return {
    kind: "reading",
    scrollTop: target.scrollTop,
    anchorMessageId: target.anchorMessageId,
    anchorTop: target.anchorTop,
  };
}

function findMessageElement(element: HTMLElement, messageId: string): HTMLElement | undefined {
  return [...element.querySelectorAll<HTMLElement>("[data-message-id]")]
    .find((node) => node.getAttribute("data-message-id") === messageId);
}

/** Keeps a restored reading anchor fixed while virtual rows finish measuring. */
export function settleRestoredReadingAnchor({
  element,
  anchorMessageId,
  anchorTop,
  generationRef,
  scheduleEnd,
}: {
  readonly element: HTMLElement;
  readonly anchorMessageId: string;
  readonly anchorTop: number;
  readonly generationRef: MutableRefObject<number>;
  readonly scheduleEnd: () => void;
}) {
  const generation = generationRef.current + 1;
  generationRef.current = generation;
  let stableFrames = 0;
  let attempts = 0;
  const settle = () => {
    if (generationRef.current !== generation) return;
    attempts += 1;
    const anchor = findMessageElement(element, anchorMessageId);
    if (anchor) {
      const delta = anchor.getBoundingClientRect().top - anchorTop;
      if (Math.abs(delta) > 0.5) {
        element.scrollTop += delta;
        stableFrames = 0;
      } else {
        stableFrames += 1;
      }
    }
    if (stableFrames >= 3 || attempts >= 20) {
      scheduleEnd();
      return;
    }
    requestAnimationFrame(settle);
  };
  requestAnimationFrame(settle);
}
