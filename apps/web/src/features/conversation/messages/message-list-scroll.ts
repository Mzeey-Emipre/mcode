/** A visible message and its viewport position at the time a scroll snapshot is captured. */
export interface MessageViewportAnchor {
  readonly messageId: string;
  readonly top: number;
}

/** Mutable tail-following state held by the transcript viewport. */
export interface TranscriptTailState {
  readonly isPinned: boolean;
  readonly baselineMaxScroll: number;
  readonly hasScrollToTailIntent: boolean;
  readonly previousScrollTop: number;
  readonly wasScrolledUp: boolean;
}

/** Tail-following state after one native scroll event. */
export interface ReconciledTranscriptTail {
  readonly maxScroll: number;
  readonly awayFromTail: boolean;
  readonly state: Omit<TranscriptTailState, "previousScrollTop" | "wasScrolledUp"> & {
    readonly isScrolledUp: boolean;
  };
}

/** Captures the first message that remains visible in the viewport. */
export function findViewportMessageAnchor(element: HTMLElement): MessageViewportAnchor | undefined {
  const viewportTop = element.getBoundingClientRect().top;
  const message = [...element.querySelectorAll<HTMLElement>("[data-message-id]")]
    .find((node) => node.getBoundingClientRect().bottom > viewportTop + 2);
  if (!message) return undefined;
  return {
    messageId: message.getAttribute("data-message-id") ?? "",
    top: message.getBoundingClientRect().top,
  };
}

/** Returns the space beneath the final rendered message. */
export function trailingMessageSpace(element: HTMLElement): number | undefined {
  const messages = [...element.querySelectorAll<HTMLElement>("[data-message-id]")];
  const lastMessage = messages.at(-1);
  if (!lastMessage) return undefined;
  return element.getBoundingClientRect().bottom - lastMessage.getBoundingClientRect().bottom;
}

/** Returns whether the viewport may request older resident history. */
export function canLoadOlderHistory({
  isRequested,
  element,
  threadId,
  isVisible,
  hasMore,
  isLoading,
  threshold,
}: {
  readonly isRequested: boolean;
  readonly element: HTMLElement | null;
  readonly threadId: string | undefined;
  readonly isVisible: boolean;
  readonly hasMore: boolean;
  readonly isLoading: boolean;
  readonly threshold: number;
}): boolean {
  return Boolean(
    isRequested
    && element
    && element.scrollTop < threshold
    && threadId
    && isVisible
    && hasMore
    && !isLoading,
  );
}

/** Returns whether the viewport may request newer resident history. */
export function canLoadNewerHistory({
  isRequested,
  element,
  threadId,
  isVisible,
  hasNewer,
  isLoading,
  threshold,
}: {
  readonly isRequested: boolean;
  readonly element: HTMLElement | null;
  readonly threadId: string | undefined;
  readonly isVisible: boolean;
  readonly hasNewer: boolean;
  readonly isLoading: boolean;
  readonly threshold: number;
}): boolean {
  return Boolean(
    isRequested
    && element
    && element.scrollHeight - element.scrollTop - element.clientHeight < threshold
    && threadId
    && isVisible
    && hasNewer
    && !isLoading,
  );
}

function cancelInterruptedTailIntent(element: HTMLElement, state: TranscriptTailState) {
  return state.hasScrollToTailIntent && element.scrollTop < state.previousScrollTop
    ? false
    : state.hasScrollToTailIntent;
}

function reconcilePinnedTail(
  element: HTMLElement,
  isPinned: boolean,
  baselineMaxScroll: number,
  threshold: number,
) {
  const maxScroll = Math.max(0, element.scrollHeight - element.clientHeight);
  if (!isPinned) return { isPinned, baselineMaxScroll, maxScroll };
  const gap = element.scrollHeight - element.scrollTop - element.clientHeight;
  if (gap <= threshold) return { isPinned, baselineMaxScroll: maxScroll, maxScroll };
  if (element.scrollTop < baselineMaxScroll - 1) {
    return { isPinned: false, baselineMaxScroll, maxScroll };
  }
  element.scrollTop = element.scrollHeight;
  return { isPinned: true, baselineMaxScroll: maxScroll, maxScroll };
}

function reconcileFollowState({
  isPinned,
  baselineMaxScroll,
  hasScrollToTailIntent,
  wasScrolledUp,
  maxScroll,
  awayFromTail,
}: {
  readonly isPinned: boolean;
  readonly baselineMaxScroll: number;
  readonly hasScrollToTailIntent: boolean;
  readonly wasScrolledUp: boolean;
  readonly maxScroll: number;
  readonly awayFromTail: boolean;
}) {
  const completedTailScroll = hasScrollToTailIntent && !awayFromTail;
  const tailIntent = completedTailScroll ? false : hasScrollToTailIntent;
  const isScrolledUp = awayFromTail && !tailIntent;
  if (awayFromTail) {
    return { isPinned: false, baselineMaxScroll, hasScrollToTailIntent: tailIntent, isScrolledUp };
  }
  if (!isPinned && !wasScrolledUp && !completedTailScroll) {
    return { isPinned, baselineMaxScroll, hasScrollToTailIntent: tailIntent, isScrolledUp };
  }
  return { isPinned: true, baselineMaxScroll: maxScroll, hasScrollToTailIntent: tailIntent, isScrolledUp };
}

/** Reconciles the tail-following state for one native scroll event. */
export function reconcileTranscriptTail(
  element: HTMLElement,
  state: TranscriptTailState,
  threshold: number,
): ReconciledTranscriptTail {
  const hasScrollToTailIntent = cancelInterruptedTailIntent(element, state);
  const pinnedTail = reconcilePinnedTail(
    element,
    state.isPinned,
    state.baselineMaxScroll,
    threshold,
  );
  const distanceFromBottom = element.scrollHeight - element.scrollTop - element.clientHeight;
  const awayFromTail = distanceFromBottom > threshold;
  return {
    maxScroll: pinnedTail.maxScroll,
    awayFromTail,
    state: reconcileFollowState({
      isPinned: pinnedTail.isPinned,
      baselineMaxScroll: pinnedTail.baselineMaxScroll,
      hasScrollToTailIntent,
      wasScrolledUp: state.wasScrolledUp,
      maxScroll: pinnedTail.maxScroll,
      awayFromTail,
    }),
  };
}

/** Identifies an intentional scroll that may release transient history trailing space. */
export function shouldReleaseHistoryTrailingSpace({
  trailingSpace,
  hasPendingAnchor,
  currentScrollTop,
  previousScrollTop,
}: {
  readonly trailingSpace: number;
  readonly hasPendingAnchor: boolean;
  readonly currentScrollTop: number;
  readonly previousScrollTop: number;
}): boolean {
  return trailingSpace > 0 && !hasPendingAnchor && currentScrollTop > previousScrollTop + 0.5;
}
