import type { MutableRefObject } from "react";
import { recallScrollPosition, type ThreadScrollPosition } from "@/components/chat/scrollPositionMemory";
import type { MessageViewportAnchor } from "./message-list-scroll";

/** The message identities that describe one resident history window. */
export interface HistoryWindowSnapshot {
  readonly count: number;
  readonly firstMessageId: string | null;
  readonly lastMessageId: string | null;
}

/** Minimal virtualizer contract needed to restore a resident message anchor. */
export interface HistoryAnchorVirtualizer {
  scrollToIndex(index: number, options: { readonly align: "start" }): void;
}

/** The viewport operation required after a resident history window changes. */
export type HistoryWindowAction =
  | { readonly kind: "initial" | "unchanged" | "settled"; readonly scrollHeight: number }
  | { readonly kind: "anchor"; readonly scrollHeight: number; readonly anchor: MessageViewportAnchor }
  | { readonly kind: "prepend"; readonly scrollHeight: number; readonly addedHeight: number };

function hasWindowChanged(previous: HistoryWindowSnapshot, next: HistoryWindowSnapshot): boolean {
  return previous.count !== next.count
    || previous.firstMessageId !== next.firstMessageId
    || previous.lastMessageId !== next.lastMessageId;
}

function scrollMemoryAnchor(position: ThreadScrollPosition | undefined): MessageViewportAnchor | null {
  if (!position?.anchorMessageId || position.anchorTop == null) return null;
  return { messageId: position.anchorMessageId, top: position.anchorTop };
}

function resolveHistoryAnchor(
  pendingAnchor: MessageViewportAnchor | null,
  rememberedPosition: ThreadScrollPosition | undefined,
) {
  return pendingAnchor ?? scrollMemoryAnchor(rememberedPosition);
}

/** Captures the durable identity of a resident history window. */
export function snapshotHistoryWindow(messages: readonly { readonly id: string }[]): HistoryWindowSnapshot {
  return {
    count: messages.length,
    firstMessageId: messages[0]?.id ?? null,
    lastMessageId: messages.at(-1)?.id ?? null,
  };
}

/** Looks up a saved scroll position only when resident history was evicted. */
export function recallEvictedHistoryPosition(
  threadId: string | null | undefined,
  nextCount: number,
  previousCount: number,
): ThreadScrollPosition | undefined {
  if (!threadId || nextCount >= previousCount) return undefined;
  return recallScrollPosition(threadId);
}

/** Classifies one resident-history update so the viewport can preserve its reading position. */
export function getHistoryWindowAction({
  element,
  previous,
  next,
  previousScrollHeight,
  pendingAnchor,
  rememberedPosition,
}: {
  readonly element: HTMLElement | null;
  readonly previous: HistoryWindowSnapshot;
  readonly next: HistoryWindowSnapshot;
  readonly previousScrollHeight: number;
  readonly pendingAnchor: MessageViewportAnchor | null;
  readonly rememberedPosition: ThreadScrollPosition | undefined;
}): HistoryWindowAction {
  const scrollHeight = element?.scrollHeight ?? 0;
  if (!element || previous.count === 0) return { kind: "initial", scrollHeight };
  if (!hasWindowChanged(previous, next)) return { kind: "unchanged", scrollHeight };
  const anchor = resolveHistoryAnchor(pendingAnchor, rememberedPosition);
  if (anchor) return { kind: "anchor", scrollHeight, anchor };
  if (next.count > previous.count && next.firstMessageId !== previous.firstMessageId) {
    return { kind: "prepend", scrollHeight, addedHeight: scrollHeight - previousScrollHeight };
  }
  return { kind: "settled", scrollHeight };
}

/** Applies a classified history-window operation through its viewport callbacks. */
export function applyHistoryWindowAction({
  action,
  isLoading,
  resetPrepend,
  clearAnchor,
  updateScrollHeight,
  settleAnchor,
  adjustPrepend,
}: {
  readonly action: HistoryWindowAction;
  readonly isLoading: boolean;
  readonly resetPrepend: () => void;
  readonly clearAnchor: () => void;
  readonly updateScrollHeight: (scrollHeight: number) => void;
  readonly settleAnchor: (anchor: MessageViewportAnchor) => void;
  readonly adjustPrepend: (addedHeight: number) => void;
}) {
  switch (action.kind) {
    case "initial":
      resetPrepend();
      if (!isLoading) clearAnchor();
      updateScrollHeight(action.scrollHeight);
      return;
    case "unchanged":
      if (!isLoading) clearAnchor();
      updateScrollHeight(action.scrollHeight);
      return;
    case "anchor":
      settleAnchor(action.anchor);
      break;
    case "prepend":
      adjustPrepend(action.addedHeight);
      clearAnchor();
      break;
    case "settled":
      clearAnchor();
      break;
  }
  updateScrollHeight(action.scrollHeight);
  resetPrepend();
}

function findMessageElement(element: HTMLElement, messageId: string): HTMLElement | undefined {
  return [...element.querySelectorAll<HTMLElement>("[data-message-id]")]
    .find((node) => node.getAttribute("data-message-id") === messageId);
}

function startAnchorMeasurement({
  element,
  anchor,
  generation,
  generationRef,
  clearAnchor,
}: {
  readonly element: HTMLElement;
  readonly anchor: MessageViewportAnchor;
  readonly generation: number;
  readonly generationRef: MutableRefObject<number>;
  readonly clearAnchor: () => void;
}) {
  let stableFrames = 0;
  let attempts = 0;
  const measure = () => {
    if (generationRef.current !== generation) return;
    attempts += 1;
    const node = findMessageElement(element, anchor.messageId);
    const drift = node ? node.getBoundingClientRect().top - anchor.top : null;
    stableFrames = drift !== null && Math.abs(drift) <= 0.5 ? stableFrames + 1 : 0;
    if (stableFrames >= 3) {
      clearAnchor();
      return;
    }
    if (drift !== null && Math.abs(drift) > 0.5) {
      requestAnimationFrame(() => {
        if (generationRef.current !== generation) return;
        element.scrollTop += drift;
        if (attempts >= 12) clearAnchor();
        else requestAnimationFrame(measure);
      });
      return;
    }
    if (attempts >= 12) {
      clearAnchor();
      return;
    }
    requestAnimationFrame(measure);
  };
  requestAnimationFrame(measure);
}

/** Keeps a visible message fixed while older or newer resident history settles. */
export function settleHistoryAnchor({
  element,
  anchor,
  anchorIndex,
  virtualizer,
  generationRef,
  clearAnchor,
}: {
  readonly element: HTMLElement;
  readonly anchor: MessageViewportAnchor;
  readonly anchorIndex: number;
  readonly virtualizer: HistoryAnchorVirtualizer;
  readonly generationRef: MutableRefObject<number>;
  readonly clearAnchor: () => void;
}) {
  if (!findMessageElement(element, anchor.messageId) && anchorIndex >= 0) {
    virtualizer.scrollToIndex(anchorIndex, { align: "start" });
  }
  const generation = generationRef.current + 1;
  generationRef.current = generation;
  startAnchorMeasurement({ element, anchor, generation, generationRef, clearAnchor });
}
