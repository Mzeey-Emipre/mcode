import type { Terminal } from "@xterm/xterm";

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

/** Per-PTY scroll anchors, in lines-from-bottom, surviving view unmount. */
const anchorByPty = new Map<string, number>();

/**
 * At or within this many lines of the bottom, the view is treated as
 * "following the tail" — no anchor is stored, so the remount follows.
 */
export const FOLLOW_TAIL_THRESHOLD = 1;

/** Lines the given terminal's viewport currently sits above the bottom. */
function linesFromBottom(term: Terminal): number {
  const buf = term.buffer.active;
  return buf.length - term.rows - buf.viewportY;
}

/**
 * Capture the scroll position as a lines-from-bottom anchor when a view
 * unmounts. Clears any prior anchor when the user was following the tail so the
 * next remount follows rather than restoring a stale offset.
 *
 * @param ptyId - The PTY whose view is unmounting.
 * @param term - The live xterm instance (still readable before dispose).
 */
export function captureRemountAnchor(ptyId: string, term: Terminal): void {
  const fromBottom = linesFromBottom(term);
  if (fromBottom > FOLLOW_TAIL_THRESHOLD) {
    anchorByPty.set(ptyId, fromBottom);
  } else {
    anchorByPty.delete(ptyId);
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
  const fromBottom = anchorByPty.get(ptyId);
  if (fromBottom === undefined) {
    term.scrollToBottom();
    return false;
  }
  const target = Math.max(0, term.buffer.active.length - term.rows - fromBottom);
  term.scrollToLine(target);
  return true;
}

/** Drop a persisted anchor, e.g. when the PTY exits and cannot remount. */
export function dropRemountAnchor(ptyId: string): void {
  anchorByPty.delete(ptyId);
}

/** Test-only: whether an anchor is currently held for a PTY. */
export function hasRemountAnchor(ptyId: string): boolean {
  return anchorByPty.has(ptyId);
}
