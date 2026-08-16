import type { Terminal } from "@xterm/xterm";

/**
 * Scroll anchor for a PTY terminal. Stores both the absolute viewport line and
 * the distance from the bottom so restore stays correct when the buffer grows
 * after a paused thread resumes.
 */
export interface TerminalScrollAnchor {
  readonly viewportY: number;
  readonly linesFromBottom: number;
  /** Buffer length at capture time; used to pick viewportY vs linesFromBottom restore. */
  readonly bufferLength: number;
}

/** Maximum distance from the bottom that still represents tail-follow intent. */
export const FOLLOW_TAIL_THRESHOLD = 1;

/** Per-PTY scroll anchors preserved across workspace thread switches. */
const anchorByPtyId = new Map<string, TerminalScrollAnchor>();

/**
 * Anchors pinned until the user scrolls manually. Survives PTY resume bursts
 * after thread switch (time-based locks alone expire too early).
 */
const pinnedAnchorByPtyId = new Map<string, TerminalScrollAnchor>();

/** Monotonic restore lock deadline per PTY (`performance.now()` ms). */
const restoreLockUntilByPtyId = new Map<string, number>();

/** Default duration to block fit/refresh after restore. */
export const SCROLL_RESTORE_LOCK_MS = 1200;

/** Dev-only snapshot of saved and pinned scroll anchors per PTY. */
export type TerminalScrollDebugSnapshot = {
  readonly anchors: Readonly<Record<string, TerminalScrollAnchor>>;
  readonly pinned: Readonly<Record<string, TerminalScrollAnchor>>;
};

/** Dev-only snapshot of saved and pinned scroll anchors per PTY. */
export function exportScrollDebugSnapshot(): TerminalScrollDebugSnapshot {
  return {
    anchors: Object.fromEntries(anchorByPtyId),
    pinned: Object.fromEntries(pinnedAnchorByPtyId),
  };
}

/**
 * Captures the current viewport scroll anchor from a live xterm instance.
 */
export function captureScrollAnchor(term: Terminal): TerminalScrollAnchor {
  const buf = term.buffer.active;
  const viewportY = buf.viewportY;
  const linesFromBottom = Math.max(0, buf.length - viewportY - term.rows);
  return { viewportY, linesFromBottom, bufferLength: buf.length };
}

/** Returns whether a captured anchor represents following the terminal tail. */
export function isFollowingTail(anchor: TerminalScrollAnchor): boolean {
  return anchor.linesFromBottom <= FOLLOW_TAIL_THRESHOLD;
}

/**
 * Restores scroll position from an anchor. Prefers the lines-from-bottom metric
 * when the buffer length changed while the thread was dormant.
 */
export function restoreScrollAnchor(term: Terminal, anchor: TerminalScrollAnchor): void {
  const buf = term.buffer.active;
  const maxViewportY = Math.max(0, buf.length - term.rows);
  const fromViewportY = Math.min(maxViewportY, anchor.viewportY);
  const fromBottomY = Math.max(
    0,
    Math.min(maxViewportY, buf.length - anchor.linesFromBottom - term.rows),
  );
  // Same scrollback size (tab close/reopen): absolute line is exact. Buffer grew: use linesFromBottom.
  const bufferGrew = buf.length > anchor.bufferLength;
  const target = buf.length > 0 && bufferGrew ? fromBottomY : fromViewportY;
  term.scrollToLine(target);
}

/** Restores an anchor from the bottom edge after a replayed buffer rebuild. */
export function restoreScrollAnchorFromBottom(
  term: Terminal,
  anchor: TerminalScrollAnchor,
): void {
  const buf = term.buffer.active;
  const maxViewportY = Math.max(0, buf.length - term.rows);
  const target = Math.max(
    0,
    Math.min(maxViewportY, buf.length - anchor.linesFromBottom - term.rows),
  );
  term.scrollToLine(target);
}

/** Restores tail-follow or reading intent after a complete-cell reflow. */
export function restoreScrollIntent(term: Terminal, anchor: TerminalScrollAnchor): void {
  if (isFollowingTail(anchor)) {
    term.scrollToBottom();
    return;
  }
  restoreScrollAnchorFromBottom(term, anchor);
}

/**
 * Writes a known-good anchor to the saved and pinned maps (e.g. last read while shown).
 */
export function persistScrollAnchor(ptyId: string, anchor: TerminalScrollAnchor): void {
  saveScrollAnchor(ptyId, anchor);
  pinScrollAnchor(ptyId, anchor);
}

/**
 * Persists an anchor for the given PTY (hide transition or live scroll).
 */
export function touchScrollAnchor(ptyId: string, term: Terminal): void {
  anchorByPtyId.set(ptyId, captureScrollAnchor(term));
}

/**
 * Saves scroll on hide without letting a hidden xterm read (often viewportY 0)
 * overwrite a previously captured anchor.
 */
export function saveScrollAnchorOnHide(ptyId: string, term: Terminal): void {
  const prior = anchorByPtyId.get(ptyId) ?? pinnedAnchorByPtyId.get(ptyId);
  touchScrollAnchor(ptyId, term);
  const captured = anchorByPtyId.get(ptyId);
  if (prior && captured && prior.viewportY > 0 && captured.viewportY === 0) {
    saveScrollAnchor(ptyId, prior);
  }
}

/**
 * @deprecated Use {@link touchScrollAnchor}. Kept for call-site clarity on hide.
 */
export function saveScrollAnchor(ptyId: string, anchor: TerminalScrollAnchor): void {
  anchorByPtyId.set(ptyId, anchor);
}

/**
 * Returns a saved anchor for the PTY, if any.
 */
export function getScrollAnchor(ptyId: string): TerminalScrollAnchor | undefined {
  return anchorByPtyId.get(ptyId);
}

/**
 * Clears a saved anchor (e.g. on unmount).
 */
export function clearScrollAnchor(ptyId: string): void {
  anchorByPtyId.delete(ptyId);
  pinnedAnchorByPtyId.delete(ptyId);
}

/**
 * Pins an anchor so every PTY write re-applies it until the user scrolls.
 */
export function pinScrollAnchor(ptyId: string, anchor: TerminalScrollAnchor): void {
  pinnedAnchorByPtyId.set(ptyId, anchor);
}

/**
 * Clears a pinned anchor after the user scrolls manually.
 */
export function unpinScrollAnchor(ptyId: string): void {
  pinnedAnchorByPtyId.delete(ptyId);
}

/**
 * Returns the pinned anchor for a PTY, if any.
 */
export function getPinnedScrollAnchor(ptyId: string): TerminalScrollAnchor | undefined {
  return pinnedAnchorByPtyId.get(ptyId);
}

/**
 * Returns true while scroll position is pinned (suppresses auto-scroll on writes).
 */
export function isScrollPinned(ptyId: string): boolean {
  return pinnedAnchorByPtyId.has(ptyId);
}

/**
 * Marks the PTY as in scroll-restore mode so fit/refresh are suppressed.
 */
export function beginScrollRestoreLock(
  ptyId: string,
  durationMs = SCROLL_RESTORE_LOCK_MS,
): void {
  restoreLockUntilByPtyId.set(ptyId, performance.now() + durationMs);
}

/**
 * Returns true while fit/refresh should be skipped for this PTY.
 */
export function isScrollRestoreLocked(ptyId: string): boolean {
  const until = restoreLockUntilByPtyId.get(ptyId);
  if (until === undefined) return false;
  if (performance.now() >= until) {
    restoreLockUntilByPtyId.delete(ptyId);
    return false;
  }
  return true;
}

/**
 * Clears restore lock state for a PTY (e.g. on unmount).
 */
export function clearScrollRestoreLock(ptyId: string): void {
  restoreLockUntilByPtyId.delete(ptyId);
}
