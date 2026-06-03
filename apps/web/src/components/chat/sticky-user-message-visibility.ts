/** Minimal virtualizer surface used to decide sticky visibility. */
export interface StickyVisibilityVirtualizer {
  getVirtualItems: () => ReadonlyArray<{ index: number; start: number; size: number }>;
}

/**
 * Message bottom must be at least this far above the viewport top before the sticky
 * bar turns on (avoids toggling while the bubble is only partially clipped).
 */
export const STICKY_SHOW_ABOVE_VIEWPORT_PX = 8;

/**
 * Message bottom must be at least this far below the viewport top before the sticky
 * bar turns off (avoids toggling when reserved top padding nudges the bubble back in).
 */
export const STICKY_HIDE_IN_VIEW_PX = 4;

/**
 * Returns true when the last user message has scrolled fully above the list viewport
 * and the sticky preview should pin at the top.
 *
 * @param currentlySticky - When true, keeps the bar visible through partial clip until
 *   the message is clearly back in the viewport (hysteresis).
 */
export function shouldShowStickyUserMessage(
  container: HTMLElement,
  messageId: string,
  itemIndex: number,
  virtualizer: StickyVisibilityVirtualizer,
  currentlySticky = false,
): boolean {
  const viewportHeight = container.clientHeight;
  const scrollTop = container.scrollTop;
  const domEl = container.querySelector(`[data-message-id="${messageId}"]`);

  if (domEl) {
    const containerRect = container.getBoundingClientRect();
    const msgRect = domEl.getBoundingClientRect();
    const relativeTop = msgRect.top - containerRect.top;
    const relativeBottom = msgRect.bottom - containerRect.top;
    if (relativeBottom > STICKY_HIDE_IN_VIEW_PX && relativeTop < viewportHeight) {
      return false;
    }
    if (currentlySticky) {
      return relativeBottom <= STICKY_HIDE_IN_VIEW_PX;
    }
    return relativeBottom <= -STICKY_SHOW_ABOVE_VIEWPORT_PX;
  }

  const visible = virtualizer.getVirtualItems();
  if (visible.length === 0) return false;

  const firstVisible = visible[0]!;
  if (itemIndex < firstVisible.index) {
    return true;
  }

  const match = visible.find((item) => item.index === itemIndex);
  if (!match) return false;

  const messageBottom = match.start + match.size - scrollTop;
  if (currentlySticky) {
    return messageBottom <= STICKY_HIDE_IN_VIEW_PX;
  }
  return messageBottom <= -STICKY_SHOW_ABOVE_VIEWPORT_PX;
}
