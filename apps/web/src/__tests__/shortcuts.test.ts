import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { initShortcuts, getKeybindings, loadKeybindings } from "@/lib/shortcuts";
import { registerCommand, clearCommands } from "@/lib/command-registry";
import { clearKeybindings } from "@/lib/keybinding-manager";
import { resetContext, setContext } from "@/lib/context-tracker";

function createKeyEvent(overrides: Partial<KeyboardEvent> = {}): KeyboardEvent {
  const event = new KeyboardEvent("keydown", {
    key: overrides.key ?? "a",
    ctrlKey: overrides.ctrlKey ?? false,
    metaKey: overrides.metaKey ?? false,
    shiftKey: overrides.shiftKey ?? false,
    bubbles: true,
    cancelable: true,
  });
  vi.spyOn(event, "preventDefault");
  return event;
}

describe("shortcuts integration", () => {
  let cleanup: () => void;

  beforeEach(() => {
    clearKeybindings();
    clearCommands();
    resetContext();
    loadKeybindings([]);
    cleanup = initShortcuts();
  });

  afterEach(() => {
    cleanup();
  });

  it("fires a registered command when its keybinding matches", () => {
    const handler = vi.fn();
    registerCommand({ id: "test.cmd", title: "Test", category: "Test", handler });
    loadKeybindings([{ key: "mod+k", command: "test.cmd" }]);

    const event = createKeyEvent({ key: "k", ctrlKey: true });
    document.dispatchEvent(event);

    expect(handler).toHaveBeenCalled();
    expect(event.preventDefault).toHaveBeenCalled();
  });

  it("does not fire when key does not match", () => {
    const handler = vi.fn();
    registerCommand({ id: "test.cmd", title: "Test", category: "Test", handler });
    loadKeybindings([{ key: "mod+k", command: "test.cmd" }]);

    document.dispatchEvent(createKeyEvent({ key: "j", ctrlKey: true }));
    expect(handler).not.toHaveBeenCalled();
  });

  it("respects when clause: !inputFocused blocks when input is focused", () => {
    const handler = vi.fn();
    registerCommand({ id: "test.cmd", title: "Test", category: "Test", handler });
    loadKeybindings([{ key: "mod+n", command: "test.cmd", when: "!inputFocused" }]);

    // handleKeyDown calls updateFocusContext() which reads document.activeElement,
    // so we need an actual input element to simulate input focus
    const input = document.createElement("input");
    document.body.appendChild(input);
    input.focus();
    document.dispatchEvent(createKeyEvent({ key: "n", ctrlKey: true }));
    expect(handler).not.toHaveBeenCalled();

    input.blur();
    document.dispatchEvent(createKeyEvent({ key: "n", ctrlKey: true }));
    expect(handler).toHaveBeenCalled();

    document.body.removeChild(input);
  });

  it("getKeybindings returns active bindings", () => {
    loadKeybindings([{ key: "mod+k", command: "commandPalette.toggle" }]);
    expect(getKeybindings().length).toBe(1);
  });
});
