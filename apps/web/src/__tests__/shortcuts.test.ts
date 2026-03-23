import { describe, it, expect, vi, beforeEach } from "vitest";
import { registerShortcut, handleKeyDown, getShortcuts } from "@/lib/shortcuts";

function createKeyEvent(overrides: Partial<KeyboardEvent> = {}): KeyboardEvent {
  const event = new KeyboardEvent("keydown", {
    key: overrides.key ?? "a",
    ctrlKey: overrides.ctrlKey ?? false,
    metaKey: overrides.metaKey ?? false,
    shiftKey: overrides.shiftKey ?? false,
  });
  vi.spyOn(event, "preventDefault");
  return event;
}

describe("Shortcuts", () => {
  beforeEach(() => {
    // Clear all shortcuts by unregistering
    for (const s of [...getShortcuts()]) {
      registerShortcut(s)(); // register returns unregister, which we call immediately
    }
  });

  it("registerShortcut adds to list and returns unregister fn", () => {
    const handler = vi.fn();
    const unregister = registerShortcut({ key: "k", ctrl: true, description: "test", handler });
    expect(getShortcuts().length).toBeGreaterThanOrEqual(1);
    unregister();
  });

  it("unregister function removes shortcut", () => {
    const handler = vi.fn();
    const unregister = registerShortcut({ key: "k", ctrl: true, description: "test", handler });
    const lengthBefore = getShortcuts().length;
    unregister();
    expect(getShortcuts().length).toBe(lengthBefore - 1);
  });

  it("handleKeyDown fires matching handler and prevents default", () => {
    const handler = vi.fn();
    const unregister = registerShortcut({ key: "k", ctrl: true, description: "test", handler });
    const event = createKeyEvent({ key: "k", ctrlKey: true });
    handleKeyDown(event);
    expect(handler).toHaveBeenCalled();
    expect(event.preventDefault).toHaveBeenCalled();
    unregister();
  });

  it("handleKeyDown respects ctrl/meta modifier", () => {
    const handler = vi.fn();
    const unregister = registerShortcut({ key: "k", ctrl: true, description: "test", handler });
    // Without ctrl - should not fire
    handleKeyDown(createKeyEvent({ key: "k" }));
    expect(handler).not.toHaveBeenCalled();
    // With meta - should fire (ctrl/meta are interchangeable)
    handleKeyDown(createKeyEvent({ key: "k", metaKey: true }));
    expect(handler).toHaveBeenCalled();
    unregister();
  });

  it("handleKeyDown respects shift modifier", () => {
    const handler = vi.fn();
    const unregister = registerShortcut({ key: "k", shift: true, description: "test", handler });
    handleKeyDown(createKeyEvent({ key: "k", shiftKey: false }));
    expect(handler).not.toHaveBeenCalled();
    handleKeyDown(createKeyEvent({ key: "k", shiftKey: true }));
    expect(handler).toHaveBeenCalled();
    unregister();
  });

  it("no match: handler not called", () => {
    const handler = vi.fn();
    const unregister = registerShortcut({ key: "k", ctrl: true, description: "test", handler });
    handleKeyDown(createKeyEvent({ key: "j", ctrlKey: true }));
    expect(handler).not.toHaveBeenCalled();
    unregister();
  });

  it("getShortcuts returns current list", () => {
    const handler = vi.fn();
    const unregister = registerShortcut({ key: "x", description: "test", handler });
    expect(getShortcuts().some((s) => s.key === "x")).toBe(true);
    unregister();
  });
});
