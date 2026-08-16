import type { Terminal } from "@xterm/xterm";
import {
  beginScrollRestoreLock,
  captureScrollAnchor,
  clearScrollAnchor,
  clearScrollRestoreLock,
  exportScrollDebugSnapshot,
  getPinnedScrollAnchor,
  getScrollAnchor,
  isScrollPinned,
  isScrollRestoreLocked,
  persistScrollAnchor,
  pinScrollAnchor,
  restoreScrollAnchor,
  restoreScrollIntent,
  saveScrollAnchorOnHide,
  touchScrollAnchor,
  unpinScrollAnchor,
  type TerminalScrollAnchor,
  type TerminalScrollDebugSnapshot,
} from "./terminalScrollState";

export type { TerminalScrollAnchor, TerminalScrollDebugSnapshot };

/** Per-PTY session anchor used during show/restore. */
const sessionAnchorByPtyId = new Map<string, TerminalScrollAnchor>();

/** Last anchor captured while the terminal was visible (avoids bad reads on hide). */
const lastGoodAnchorByPtyId = new Map<string, TerminalScrollAnchor>();

/** PTY ids inside a programmatic scrollToLine (onScroll is ignored). */
const programmaticPtyIds = new Set<string>();

type TerminalScrollDebugWindow = Window & {
  __mcodeTerminalScrollDebug?: () => TerminalScrollDebugSnapshot;
};

if (import.meta.env.DEV) {
  const w = window as TerminalScrollDebugWindow;
  w.__mcodeTerminalScrollDebug = () => terminalScroll.debugSnapshot();
}

/**
 * Central scroll policy for pooled terminals: record while shown, pin on hide/show,
 * restore after writes until the user scrolls manually.
 */
export const terminalScroll = {
  /**
   * Records a user-driven scroll and clears an active pin.
   */
  onUserScroll(ptyId: string, term: Terminal): void {
    if (programmaticPtyIds.has(ptyId)) return;
    if (isScrollPinned(ptyId)) {
      unpinScrollAnchor(ptyId);
      clearScrollRestoreLock(ptyId);
      sessionAnchorByPtyId.delete(ptyId);
    }
    const anchor = captureScrollAnchor(term);
    lastGoodAnchorByPtyId.set(ptyId, anchor);
    touchScrollAnchor(ptyId, term);
  },

  /**
   * Persists scroll when a terminal hides (tab/thread/panel). Prefers last good anchor.
   */
  onHide(ptyId: string, term: Terminal): void {
    const lastGood = lastGoodAnchorByPtyId.get(ptyId);
    if (lastGood) {
      persistScrollAnchor(ptyId, lastGood);
    } else {
      saveScrollAnchorOnHide(ptyId, term);
      const saved = getScrollAnchor(ptyId);
      if (saved) {
        pinScrollAnchor(ptyId, saved);
      }
    }
    sessionAnchorByPtyId.delete(ptyId);
  },

  /**
   * Arms restore for show: pins anchor and starts a short fit/refresh lock.
   */
  onShow(ptyId: string): TerminalScrollAnchor | null {
    const anchor = getScrollAnchor(ptyId) ?? getPinnedScrollAnchor(ptyId);
    if (!anchor) return null;
    lastGoodAnchorByPtyId.set(ptyId, anchor);
    pinScrollAnchor(ptyId, anchor);
    beginScrollRestoreLock(ptyId);
    sessionAnchorByPtyId.set(ptyId, anchor);
    return anchor;
  },

  /** Anchor to re-apply after PTY writes or layout restore. */
  restoreAnchor(ptyId: string): TerminalScrollAnchor | undefined {
    return (
      sessionAnchorByPtyId.get(ptyId) ??
      getPinnedScrollAnchor(ptyId) ??
      getScrollAnchor(ptyId)
    );
  },

  /** Applies the active anchor to the live xterm instance. */
  restore(ptyId: string, term: Terminal): void {
    const anchor = terminalScroll.restoreAnchor(ptyId);
    if (!anchor) return;
    terminalScroll.runProgrammatic(ptyId, () => {
      restoreScrollAnchor(term, anchor);
    });
  },

  /** Restores tail-follow or reading intent after a terminal reflow. */
  restoreAfterResize(
    ptyId: string,
    term: Terminal,
    anchor: TerminalScrollAnchor,
  ): void {
    terminalScroll.runProgrammatic(ptyId, () => {
      restoreScrollIntent(term, anchor);
    });
  },

  /** Runs a callback without treating resulting onScroll as user input. */
  runProgrammatic(ptyId: string, fn: () => void): void {
    programmaticPtyIds.add(ptyId);
    try {
      fn();
    } finally {
      requestAnimationFrame(() => {
        programmaticPtyIds.delete(ptyId);
      });
    }
  },

  isProgrammatic(ptyId: string): boolean {
    return programmaticPtyIds.has(ptyId);
  },

  isPinned(ptyId: string): boolean {
    return isScrollPinned(ptyId);
  },

  shouldDeferFitRefresh(ptyId: string): boolean {
    return isScrollRestoreLocked(ptyId);
  },

  /** Clears all scroll state when a PTY terminal unmounts. */
  clear(ptyId: string): void {
    sessionAnchorByPtyId.delete(ptyId);
    lastGoodAnchorByPtyId.delete(ptyId);
    programmaticPtyIds.delete(ptyId);
    clearScrollAnchor(ptyId);
    clearScrollRestoreLock(ptyId);
  },

  /** Dev-only snapshot of saved and pinned anchors. */
  debugSnapshot(): TerminalScrollDebugSnapshot {
    return exportScrollDebugSnapshot();
  },
};
