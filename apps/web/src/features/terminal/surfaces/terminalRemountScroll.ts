import type { Terminal } from "@xterm/xterm";
import {
  captureScrollAnchor,
  clearScrollAnchor,
  getScrollAnchor,
  isFollowingTail,
  restoreScrollAnchorFromBottom,
  saveScrollAnchor,
} from "./terminalScrollState";

/**
 * Smart scroll restore across terminal view remounts (ADR-0010 / #751).
 *
 * The mount-on-demand view is disposed on every thread / shell-tab switch, so
 * scroll position cannot live in the xterm instance. This module persists a
 * lightweight per-PTY anchor — distance from the bottom in lines — captured when
 * a view unmounts and re-applied after the next view's reattach replay.
 *
 * Policy: if the user was following the tail when they left, the remount follows
 * the tail (current #748 v1 behaviour); if they had scrolled up to read history,
 * the remount lands back at roughly the same region instead of jumping to the
 * tail.
 */

/**
 * Capture the scroll position as a lines-from-bottom anchor when a view
 * unmounts. Clears any prior anchor when the user was following the tail so the
 * next remount follows rather than restoring a stale offset.
 *
 * @param ptyId - The PTY whose view is unmounting.
 * @param term - The live xterm instance (still readable before dispose).
 */
export function captureRemountAnchor(ptyId: string, term: Terminal): void {
  const anchor = captureScrollAnchor(term);
  if (!isFollowingTail(anchor)) {
    saveScrollAnchor(ptyId, anchor);
  } else {
    clearScrollAnchor(ptyId);
  }
}

/**
 * Apply the persisted anchor after a remount's replay completes, or follow the
 * tail when there is no anchor. The anchor is clamped to the (possibly shorter)
 * replayed buffer.
 *
 * @param ptyId - The PTY whose view just remounted.
 * @param term - The fresh xterm instance, post-replay.
 * @returns `true` if a stored anchor was restored, `false` if it followed tail.
 */
export function applyRemountAnchor(ptyId: string, term: Terminal): boolean {
  const anchor = getScrollAnchor(ptyId);
  if (anchor === undefined) {
    term.scrollToBottom();
    return false;
  }
  restoreScrollAnchorFromBottom(term, anchor);
  return true;
}

/** Drop a persisted anchor, e.g. when the PTY exits and cannot remount. */
export function dropRemountAnchor(ptyId: string): void {
  clearScrollAnchor(ptyId);
}

/** Test-only: whether an anchor is currently held for a PTY. */
export function hasRemountAnchor(ptyId: string): boolean {
  return getScrollAnchor(ptyId) !== undefined;
}
