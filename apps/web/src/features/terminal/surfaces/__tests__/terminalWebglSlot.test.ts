import { describe, expect, it, vi } from "vitest";
import { claimWebglSlot, clearWebglSlot, releaseWebglSlot } from "../terminalWebglSlot";

describe("terminalWebglSlot", () => {
  it("claimWebglSlot releases the previous owner before claiming", () => {
    const releaseA = vi.fn();
    const releaseB = vi.fn();
    claimWebglSlot("pty-a", releaseA);
    claimWebglSlot("pty-b", releaseB);
    expect(releaseA).toHaveBeenCalledTimes(1);
    expect(releaseB).not.toHaveBeenCalled();
  });

  it("releaseWebglSlot only releases the current owner", () => {
    const releaseA = vi.fn();
    claimWebglSlot("pty-a", releaseA);
    releaseWebglSlot("pty-b");
    expect(releaseA).not.toHaveBeenCalled();
    releaseWebglSlot("pty-a");
    expect(releaseA).toHaveBeenCalledTimes(1);
  });

  it("clearWebglSlot removes bookkeeping without calling release", () => {
    const releaseA = vi.fn();
    claimWebglSlot("pty-a", releaseA);
    clearWebglSlot("pty-a");
    releaseWebglSlot("pty-a");
    expect(releaseA).not.toHaveBeenCalled();
  });
});
