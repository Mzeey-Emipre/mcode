import { describe, it, expect, beforeEach, vi } from "vitest";
import type { Terminal } from "@xterm/xterm";
import {
  applyRemountAnchor,
  captureRemountAnchor,
  dropRemountAnchor,
  hasRemountAnchor,
} from "../terminalRemountScroll";

/** Minimal xterm stand-in exposing only what the anchor logic reads/calls. */
function makeTerm(opts: { length: number; rows: number; viewportY: number }) {
  return {
    rows: opts.rows,
    buffer: { active: { length: opts.length, viewportY: opts.viewportY } },
    scrollToLine: vi.fn(),
    scrollToBottom: vi.fn(),
  } as unknown as Terminal & {
    scrollToLine: ReturnType<typeof vi.fn>;
    scrollToBottom: ReturnType<typeof vi.fn>;
  };
}

describe("terminalRemountScroll", () => {
  beforeEach(() => {
    // Ensure no cross-test anchor leakage for the shared ptyIds.
    dropRemountAnchor("pty-1");
    dropRemountAnchor("pty-2");
  });

  it("stores an anchor when the user had scrolled up", () => {
    // length 200, rows 24, viewport at line 100 → 76 lines from bottom.
    const term = makeTerm({ length: 200, rows: 24, viewportY: 100 });
    captureRemountAnchor("pty-1", term);
    expect(hasRemountAnchor("pty-1")).toBe(true);
  });

  it("does not store an anchor when the user was at the bottom (follow)", () => {
    // viewportY = length - rows → exactly at the bottom.
    const term = makeTerm({ length: 200, rows: 24, viewportY: 176 });
    captureRemountAnchor("pty-1", term);
    expect(hasRemountAnchor("pty-1")).toBe(false);
  });

  it("follows the tail on remount when no anchor is stored", () => {
    const term = makeTerm({ length: 200, rows: 24, viewportY: 0 });
    const restored = applyRemountAnchor("pty-1", term);
    expect(restored).toBe(false);
    expect(term.scrollToBottom).toHaveBeenCalledTimes(1);
    expect(term.scrollToLine).not.toHaveBeenCalled();
  });

  it("restores the prior scroll region on remount", () => {
    // Capture 76 lines from bottom on a 200-line buffer.
    captureRemountAnchor("pty-1", makeTerm({ length: 200, rows: 24, viewportY: 100 }));

    // Remount into a buffer of the same length: target = 200 - 24 - 76 = 100.
    const remounted = makeTerm({ length: 200, rows: 24, viewportY: 0 });
    const restored = applyRemountAnchor("pty-1", remounted);

    expect(restored).toBe(true);
    expect(remounted.scrollToLine).toHaveBeenCalledWith(100);
    expect(remounted.scrollToBottom).not.toHaveBeenCalled();
  });

  it("clamps the anchor to the top when the replayed buffer is shorter", () => {
    captureRemountAnchor("pty-1", makeTerm({ length: 500, rows: 24, viewportY: 100 })); // 376 from bottom

    // Replayed buffer only has 50 lines: 50 - 24 - 376 < 0 → clamp to 0.
    const remounted = makeTerm({ length: 50, rows: 24, viewportY: 10 });
    applyRemountAnchor("pty-1", remounted);

    expect(remounted.scrollToLine).toHaveBeenCalledWith(0);
  });

  it("re-capturing at the bottom clears a previously stored anchor", () => {
    captureRemountAnchor("pty-1", makeTerm({ length: 200, rows: 24, viewportY: 100 }));
    expect(hasRemountAnchor("pty-1")).toBe(true);
    // User scrolled back to the bottom before the next unmount.
    captureRemountAnchor("pty-1", makeTerm({ length: 200, rows: 24, viewportY: 176 }));
    expect(hasRemountAnchor("pty-1")).toBe(false);
  });

  it("dropRemountAnchor removes a stored anchor", () => {
    captureRemountAnchor("pty-2", makeTerm({ length: 200, rows: 24, viewportY: 50 }));
    expect(hasRemountAnchor("pty-2")).toBe(true);
    dropRemountAnchor("pty-2");
    expect(hasRemountAnchor("pty-2")).toBe(false);
  });
});
