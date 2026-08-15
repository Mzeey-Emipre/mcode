import { beforeEach, describe, expect, it, vi } from "vitest";
import { resolveTerminalScreenReaderMode } from "../terminalAccessibility";

describe("terminal screen-reader mode", () => {
  beforeEach(() => {
    delete (window as unknown as Record<string, unknown>).desktopBridge;
  });

  it.each([
    ["off", false],
    ["on", true],
  ] as const)("resolves %s without assistive-technology detection", async (mode, expected) => {
    const getAccessibilitySupport = vi.fn();
    window.desktopBridge = { getAccessibilitySupport } as unknown as typeof window.desktopBridge;

    await expect(resolveTerminalScreenReaderMode(mode)).resolves.toBe(expected);
    expect(getAccessibilitySupport).not.toHaveBeenCalled();
  });

  it("resolves browser Auto to false without a trusted detection seam", async () => {
    await expect(resolveTerminalScreenReaderMode("auto")).resolves.toBe(false);
  });

  it("queries Electron support only for Auto", async () => {
    const getAccessibilitySupport = vi.fn(() => Promise.resolve(true));
    window.desktopBridge = { getAccessibilitySupport } as unknown as typeof window.desktopBridge;

    await expect(resolveTerminalScreenReaderMode("auto")).resolves.toBe(true);
    expect(getAccessibilitySupport).toHaveBeenCalledOnce();
  });

  it("fails closed when the Electron support query is invalid", async () => {
    const getAccessibilitySupport = vi.fn(() => Promise.resolve("yes" as unknown as boolean));
    window.desktopBridge = { getAccessibilitySupport } as unknown as typeof window.desktopBridge;

    await expect(resolveTerminalScreenReaderMode("auto")).resolves.toBe(false);
  });
});
