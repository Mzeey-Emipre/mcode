import { describe, it, expect, beforeEach } from "vitest";
import {
  parseKeybinding,
  matchesKeyEvent,
  loadKeybindings,
  getKeybindings,
  getKeybindingForCommand,
  formatKeybinding,
  clearKeybindings,
  type Keybinding,
} from "@/lib/keybinding-manager";

function createKeyEvent(overrides: Partial<KeyboardEvent> = {}): KeyboardEvent {
  return new KeyboardEvent("keydown", {
    key: overrides.key ?? "a",
    ctrlKey: overrides.ctrlKey ?? false,
    metaKey: overrides.metaKey ?? false,
    shiftKey: overrides.shiftKey ?? false,
    altKey: overrides.altKey ?? false,
  });
}

describe("parseKeybinding", () => {
  it("parses mod+k", () => {
    const parsed = parseKeybinding("mod+k");
    expect(parsed).toEqual({ mod: true, shift: false, alt: false, key: "k" });
  });

  it("parses mod+shift+n", () => {
    const parsed = parseKeybinding("mod+shift+n");
    expect(parsed).toEqual({ mod: true, shift: true, alt: false, key: "n" });
  });

  it("parses Escape (no modifiers)", () => {
    const parsed = parseKeybinding("Escape");
    expect(parsed).toEqual({ mod: false, shift: false, alt: false, key: "escape" });
  });

  it("parses mod+\\", () => {
    const parsed = parseKeybinding("mod+\\");
    expect(parsed).toEqual({ mod: true, shift: false, alt: false, key: "\\" });
  });

  it("parses mod+,", () => {
    const parsed = parseKeybinding("mod+,");
    expect(parsed).toEqual({ mod: true, shift: false, alt: false, key: "," });
  });
});

describe("matchesKeyEvent", () => {
  it("matches mod+k with ctrlKey", () => {
    const parsed = parseKeybinding("mod+k");
    const event = createKeyEvent({ key: "k", ctrlKey: true });
    expect(matchesKeyEvent(parsed, event)).toBe(true);
  });

  it("matches mod+k with metaKey", () => {
    const parsed = parseKeybinding("mod+k");
    const event = createKeyEvent({ key: "k", metaKey: true });
    expect(matchesKeyEvent(parsed, event)).toBe(true);
  });

  it("does not match mod+k without modifier", () => {
    const parsed = parseKeybinding("mod+k");
    const event = createKeyEvent({ key: "k" });
    expect(matchesKeyEvent(parsed, event)).toBe(false);
  });

  it("matches mod+shift+n", () => {
    const parsed = parseKeybinding("mod+shift+n");
    const event = createKeyEvent({ key: "N", ctrlKey: true, shiftKey: true });
    expect(matchesKeyEvent(parsed, event)).toBe(true);
  });

  it("does not match mod+n when shift is held (letter keys)", () => {
    const parsed = parseKeybinding("mod+n");
    const event = createKeyEvent({ key: "N", ctrlKey: true, shiftKey: true });
    expect(matchesKeyEvent(parsed, event)).toBe(false);
  });

  it("matches Escape without modifiers", () => {
    const parsed = parseKeybinding("Escape");
    const event = createKeyEvent({ key: "Escape" });
    expect(matchesKeyEvent(parsed, event)).toBe(true);
  });

  it("matches mod+? (shifted symbol)", () => {
    const parsed = parseKeybinding("mod+?");
    const event = createKeyEvent({ key: "?", ctrlKey: true, shiftKey: true });
    expect(matchesKeyEvent(parsed, event)).toBe(true);
  });
});

describe("loadKeybindings / getKeybindings", () => {
  beforeEach(() => {
    clearKeybindings();
  });

  it("loads keybindings from an array", () => {
    const bindings: Keybinding[] = [
      { key: "mod+k", command: "test.cmd" },
      { key: "mod+n", command: "test.new", when: "!inputFocused" },
    ];
    loadKeybindings(bindings);
    expect(getKeybindings()).toHaveLength(2);
  });

  it("merges user overrides on top of defaults", () => {
    const defaults: Keybinding[] = [
      { key: "mod+k", command: "palette.open" },
      { key: "mod+n", command: "thread.new" },
    ];
    const user: Keybinding[] = [
      { key: "mod+p", command: "palette.open" },
    ];
    loadKeybindings(defaults, user);
    const all = getKeybindings();
    // user override replaces default for palette.open
    const paletteBinding = all.find((b) => b.command === "palette.open");
    expect(paletteBinding!.key).toBe("mod+p");
    // thread.new default remains
    expect(all.find((b) => b.command === "thread.new")).toBeDefined();
  });

  it("user can remove a default with minus-prefix command", () => {
    const defaults: Keybinding[] = [
      { key: "mod+k", command: "palette.open" },
      { key: "mod+n", command: "thread.new" },
    ];
    const user: Keybinding[] = [
      { key: "", command: "-thread.new" },
    ];
    loadKeybindings(defaults, user);
    const all = getKeybindings();
    expect(all.find((b) => b.command === "thread.new")).toBeUndefined();
    expect(all).toHaveLength(1);
  });
});

describe("getKeybindingForCommand", () => {
  beforeEach(() => {
    clearKeybindings();
  });

  it("finds the keybinding for a command", () => {
    loadKeybindings([{ key: "mod+k", command: "palette.open" }]);
    expect(getKeybindingForCommand("palette.open")?.key).toBe("mod+k");
  });

  it("returns undefined for unbound commands", () => {
    loadKeybindings([]);
    expect(getKeybindingForCommand("nonexistent")).toBeUndefined();
  });
});

describe("formatKeybinding", () => {
  it("formats mod+k for display (Mac style)", () => {
    const formatted = formatKeybinding("mod+k", true);
    expect(formatted).toBe("\u2318K");
  });

  it("formats mod+k for display (Windows style)", () => {
    const formatted = formatKeybinding("mod+k", false);
    expect(formatted).toBe("Ctrl+K");
  });

  it("formats mod+shift+n", () => {
    const formatted = formatKeybinding("mod+shift+n", true);
    expect(formatted).toBe("\u2318\u21E7N");
  });

  it("formats Escape", () => {
    const formatted = formatKeybinding("Escape", true);
    expect(formatted).toBe("Esc");
  });
});
