// apps/web/src/__tests__/TerminalView.keyhandler.test.ts
import { describe, it, expect } from "vitest";
import {
  isTerminalSearchShortcut,
  shouldInterceptKeyEvent,
} from "@/components/terminal/terminalKeyHandler";

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
    it("intercepts Ctrl+C when terminal has a selection", () => {
      const event = makeEvent({ key: "c", ctrlKey: true });
      expect(shouldInterceptKeyEvent(event, true)).toBe(true);
    });

    it("does NOT intercept Ctrl+C when terminal has no selection", () => {
      const event = makeEvent({ key: "c", ctrlKey: true });
      expect(shouldInterceptKeyEvent(event, false)).toBe(false);
    });

    it("intercepts Cmd+C when terminal has a selection", () => {
      const event = makeEvent({ key: "c", metaKey: true });
      expect(shouldInterceptKeyEvent(event, true)).toBe(true);
    });

    it("does NOT intercept Cmd+C when terminal has no selection", () => {
      const event = makeEvent({ key: "c", metaKey: true });
      expect(shouldInterceptKeyEvent(event, false)).toBe(false);
    });
  });

  describe("Ctrl+Shift+C / Cmd+Shift+C", () => {
    it("intercepts Ctrl+Shift+C regardless of selection", () => {
      const event = makeEvent({ key: "C", ctrlKey: true, shiftKey: true });
      expect(shouldInterceptKeyEvent(event, false)).toBe(true);
    });

    it("intercepts Cmd+Shift+C regardless of selection", () => {
      const event = makeEvent({ key: "C", metaKey: true, shiftKey: true });
      expect(shouldInterceptKeyEvent(event, false)).toBe(true);
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
