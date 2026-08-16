import { describe, expect, it, vi } from "vitest";
import type { Terminal } from "@xterm/xterm";
import {
  clearScrollAnchor,
  getPinnedScrollAnchor,
  getScrollAnchor,
  isScrollPinned,
  pinScrollAnchor,
  restoreScrollAnchor,
  restoreScrollIntent,
  saveScrollAnchorOnHide,
  touchScrollAnchor,
  unpinScrollAnchor,
} from "../terminalScrollState";

function mockTerm(viewportY: number, length: number, rows: number): Terminal {
  return {
    rows,
    buffer: { active: { viewportY, length } },
    scrollToLine: vi.fn(),
    scrollToBottom: vi.fn(),
  } as unknown as Terminal;
}

describe("terminalScrollState", () => {
  it("restoreScrollAnchor uses viewportY when the buffer length is unchanged", () => {
    const anchor = { viewportY: 42, linesFromBottom: 34, bufferLength: 100 };
    const term = mockTerm(0, 100, 24);
    restoreScrollAnchor(term, anchor);
    expect(term.scrollToLine).toHaveBeenCalledWith(42);
  });

  it("restoreScrollAnchor uses linesFromBottom when the buffer grew", () => {
    const anchor = { viewportY: 10, linesFromBottom: 50, bufferLength: 100 };
    const term = mockTerm(0, 200, 24);
    restoreScrollAnchor(term, anchor);
    // 200 - 50 - 24 = 126
    expect(term.scrollToLine).toHaveBeenCalledWith(126);
  });

  it("restoreScrollIntent keeps tail-following terminals at the bottom", () => {
    const term = mockTerm(80, 104, 24);
    restoreScrollIntent(term, { viewportY: 79, linesFromBottom: 1, bufferLength: 104 });
    expect(term.scrollToBottom).toHaveBeenCalledTimes(1);
    expect(term.scrollToLine).not.toHaveBeenCalled();
  });

  it("restoreScrollIntent keeps a reading anchor after reflow", () => {
    const term = mockTerm(0, 200, 24);
    restoreScrollIntent(term, { viewportY: 100, linesFromBottom: 8, bufferLength: 500 });
    expect(term.scrollToLine).toHaveBeenCalledWith(168);
  });

  it("touchScrollAnchor round-trips through getScrollAnchor", () => {
    const term = mockTerm(42, 100, 24);
    touchScrollAnchor("pty-1", term);
    expect(getScrollAnchor("pty-1")).toEqual({
      viewportY: 42,
      linesFromBottom: 34,
      bufferLength: 100,
    });
    clearScrollAnchor("pty-1");
    expect(getScrollAnchor("pty-1")).toBeUndefined();
  });

  it("saveScrollAnchorOnHide keeps a scrolled anchor when xterm reads viewportY 0", () => {
    touchScrollAnchor("pty-3", mockTerm(20, 44, 24));
    saveScrollAnchorOnHide("pty-3", mockTerm(0, 100, 24));
    expect(getScrollAnchor("pty-3")?.viewportY).toBe(20);
    clearScrollAnchor("pty-3");
  });

  it("pinScrollAnchor survives until unpin or clearScrollAnchor", () => {
    const anchor = { viewportY: 10, linesFromBottom: 5, bufferLength: 50 };
    pinScrollAnchor("pty-2", anchor);
    expect(isScrollPinned("pty-2")).toBe(true);
    expect(getPinnedScrollAnchor("pty-2")).toEqual(anchor);
    unpinScrollAnchor("pty-2");
    expect(isScrollPinned("pty-2")).toBe(false);
  });
});
