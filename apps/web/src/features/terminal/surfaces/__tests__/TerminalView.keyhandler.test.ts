// apps/web/src/__tests__/TerminalView.keyhandler.test.ts
import { describe, it, expect } from "vitest";
import {
  isTerminalPasteShortcut,
  isTerminalMiddleClickPaste,
  isTerminalSearchShortcut,
  shouldInterceptKeyEvent,
} from "../terminalKeyHandler";

function makeEvent(overrides: Partial<KeyboardEvent>): KeyboardEvent {
  return {
    type: "keydown",
    key: "",
    ctrlKey: false,
    metaKey: false,
    shiftKey: false,
    ...overrides,
  } as KeyboardEvent;
}

describe("shouldInterceptKeyEvent", () => {
  describe("Ctrl+C / Cmd+C", () => {
    it("lets Ctrl+C reach the PTY when terminal has a selection", () => {
      const event = makeEvent({ key: "c", ctrlKey: true });
      expect(shouldInterceptKeyEvent(event, true, "other")).toBe(false);
    });

    it("does NOT intercept Ctrl+C when terminal has no selection", () => {
      const event = makeEvent({ key: "c", ctrlKey: true });
      expect(shouldInterceptKeyEvent(event, false, "other")).toBe(false);
    });

    it("intercepts Cmd+C when terminal has a selection", () => {
      const event = makeEvent({ key: "c", metaKey: true });
      expect(shouldInterceptKeyEvent(event, true, "mac")).toBe(true);
    });

    it("does NOT intercept Cmd+C when terminal has no selection", () => {
      const event = makeEvent({ key: "c", metaKey: true });
      expect(shouldInterceptKeyEvent(event, false, "mac")).toBe(false);
    });
  });

  describe("platform copy shortcuts", () => {
    it("intercepts Ctrl+Shift+C regardless of selection", () => {
      const event = makeEvent({ key: "C", ctrlKey: true, shiftKey: true });
      expect(shouldInterceptKeyEvent(event, false)).toBe(true);
    });

    it("does not swallow platform-invalid Cmd+Shift+C", () => {
      const event = makeEvent({ key: "C", metaKey: true, shiftKey: true });
      expect(shouldInterceptKeyEvent(event, false, "mac")).toBe(false);
    });
  });

  describe("platform paste shortcuts", () => {
    it("accepts Cmd+V on macOS", () => {
      expect(isTerminalPasteShortcut(makeEvent({ key: "v", metaKey: true }), "mac")).toBe(true);
    });

    it("accepts Ctrl+Shift+V on Windows and Linux", () => {
      const event = makeEvent({ key: "v", ctrlKey: true, shiftKey: true });
      expect(isTerminalPasteShortcut(event, "windows")).toBe(true);
      expect(isTerminalPasteShortcut(event, "linux")).toBe(true);
    });

    it("does not swallow Linux Ctrl+V", () => {
      expect(isTerminalPasteShortcut(makeEvent({ key: "v", ctrlKey: true }), "linux")).toBe(false);
    });

    it("does not intercept copy, paste, or search while composing text", () => {
      const event = makeEvent({
        key: "c",
        ctrlKey: true,
        shiftKey: true,
        isComposing: true,
      });

      expect(shouldInterceptKeyEvent(event, true, "other")).toBe(false);
      expect(isTerminalPasteShortcut(makeEvent({ ...event, key: "v" }), "other")).toBe(false);
      expect(isTerminalSearchShortcut(makeEvent({ ...event, key: "f", shiftKey: false }))).toBe(false);
    });
  });

  describe("middle-click paste", () => {
    it("allows middle-click only on Linux", () => {
      const event = { button: 1 } as MouseEvent;
      expect(isTerminalMiddleClickPaste(event, "linux")).toBe(true);
      expect(isTerminalMiddleClickPaste(event, "mac")).toBe(false);
      expect(isTerminalMiddleClickPaste(event, "windows")).toBe(false);
    });

    it("ignores other mouse buttons on Linux", () => {
      expect(isTerminalMiddleClickPaste({ button: 0 }, "linux")).toBe(false);
      expect(isTerminalMiddleClickPaste({ button: 2 }, "linux")).toBe(false);
    });
  });

  describe("unrelated keys", () => {
    it("does not intercept plain 'a'", () => {
      const event = makeEvent({ key: "a" });
      expect(shouldInterceptKeyEvent(event, false)).toBe(false);
    });

    it("does not intercept Ctrl+Z", () => {
      const event = makeEvent({ key: "z", ctrlKey: true });
      expect(shouldInterceptKeyEvent(event, false)).toBe(false);
    });

    it("does not intercept Ctrl+V (paste is handled by xterm natively)", () => {
      const event = makeEvent({ key: "v", ctrlKey: true });
      expect(shouldInterceptKeyEvent(event, false)).toBe(false);
    });
  });

  // Regression guard for issue #316: after backgrounding the app, users reported
  // the spacebar no longer reaching the shell. Any key interception on " " would
  // break normal typing — this test pins the behaviour.
  describe("space key (regression #316)", () => {
    it("does not intercept plain space", () => {
      const event = makeEvent({ key: " " });
      expect(shouldInterceptKeyEvent(event, false)).toBe(false);
    });

    it("does not intercept space with a selection present", () => {
      const event = makeEvent({ key: " " });
      expect(shouldInterceptKeyEvent(event, true)).toBe(false);
    });

    it("does not intercept Ctrl+Space", () => {
      const event = makeEvent({ key: " ", ctrlKey: true });
      expect(shouldInterceptKeyEvent(event, false)).toBe(false);
    });

    it("does not intercept Shift+Space", () => {
      const event = makeEvent({ key: " ", shiftKey: true });
      expect(shouldInterceptKeyEvent(event, false)).toBe(false);
    });
  });
});

describe("isTerminalSearchShortcut", () => {
  it("accepts Ctrl+F and Cmd+F", () => {
    expect(isTerminalSearchShortcut(makeEvent({ key: "f", ctrlKey: true }))).toBe(true);
    expect(isTerminalSearchShortcut(makeEvent({ key: "F", metaKey: true }))).toBe(true);
  });

  it("does not intercept modified or unrelated keys", () => {
    expect(isTerminalSearchShortcut(makeEvent({ key: "f" }))).toBe(false);
    expect(isTerminalSearchShortcut(makeEvent({ key: "f", ctrlKey: true, shiftKey: true }))).toBe(false);
    expect(isTerminalSearchShortcut(makeEvent({ key: "f", metaKey: true, altKey: true }))).toBe(false);
    expect(isTerminalSearchShortcut(makeEvent({ key: "g", ctrlKey: true }))).toBe(false);
  });
});
