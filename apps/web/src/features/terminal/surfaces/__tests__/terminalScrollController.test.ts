import { describe, expect, it, vi } from "vitest";
import type { Terminal } from "@xterm/xterm";
import { terminalScroll } from "../terminalScrollController";
import {
  clearScrollAnchor,
  getPinnedScrollAnchor,
  getScrollAnchor,
  isScrollPinned,
} from "../terminalScrollState";

function mockTerm(viewportY: number, length: number, rows: number): Terminal {
  return {
    rows,
    buffer: { active: { viewportY, length } },
    scrollToLine: vi.fn(),
  } as unknown as Terminal;
}

describe("terminalScrollController", () => {
  it("onHide prefers last good anchor over a zero viewport read", () => {
    const term = mockTerm(20, 44, 24);
    terminalScroll.onUserScroll("pty-h", term);
    terminalScroll.onHide("pty-h", mockTerm(0, 44, 24));
    expect(getScrollAnchor("pty-h")?.viewportY).toBe(20);
    expect(isScrollPinned("pty-h")).toBe(true);
    terminalScroll.clear("pty-h");
  });

  it("onShow arms pin and session restore", () => {
    terminalScroll.onUserScroll("pty-s", mockTerm(42, 100, 24));
    terminalScroll.onHide("pty-s", mockTerm(0, 100, 24));
    terminalScroll.onShow("pty-s");
    expect(terminalScroll.restoreAnchor("pty-s")?.viewportY).toBe(42);
    expect(getPinnedScrollAnchor("pty-s")).toBeDefined();
    terminalScroll.clear("pty-s");
  });

  it("onUserScroll clears pin", () => {
    terminalScroll.onUserScroll("pty-u", mockTerm(5, 50, 24));
    terminalScroll.onHide("pty-u", mockTerm(5, 50, 24));
    expect(isScrollPinned("pty-u")).toBe(true);
    terminalScroll.onUserScroll("pty-u", mockTerm(10, 50, 24));
    expect(isScrollPinned("pty-u")).toBe(false);
    clearScrollAnchor("pty-u");
  });
});
