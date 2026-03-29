// apps/web/src/__tests__/TerminalView.keyhandler.test.ts
import { describe, it, expect } from "vitest";
import { shouldInterceptKeyEvent } from "@/components/terminal/terminalKeyHandler";

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
});
