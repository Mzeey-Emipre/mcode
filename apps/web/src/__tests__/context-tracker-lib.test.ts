import { describe, it, expect, beforeEach } from "vitest";
import {
  getContext,
  setContext,
  evaluateWhen,
  resetContext,
} from "@/lib/context-tracker";

describe("ContextTracker", () => {
  beforeEach(() => {
    resetContext();
  });

  it("returns default context values", () => {
    const ctx = getContext();
    expect(ctx.inputFocused).toBe(false);
    expect(ctx.terminalFocused).toBe(false);
    expect(ctx.commandPaletteOpen).toBe(false);
    expect(ctx.settingsOpen).toBe(false);
  });

  it("updates a context value", () => {
    setContext("inputFocused", true);
    expect(getContext().inputFocused).toBe(true);
  });

  it("evaluateWhen returns true for undefined when clause", () => {
    expect(evaluateWhen(undefined)).toBe(true);
  });

  it("evaluateWhen checks positive context", () => {
    setContext("inputFocused", true);
    expect(evaluateWhen("inputFocused")).toBe(true);
    expect(evaluateWhen("terminalFocused")).toBe(false);
  });

  it("evaluateWhen checks negated context", () => {
    setContext("inputFocused", false);
    expect(evaluateWhen("!inputFocused")).toBe(true);
    setContext("inputFocused", true);
    expect(evaluateWhen("!inputFocused")).toBe(false);
  });

  it("evaluateWhen returns false for unknown context keys", () => {
    expect(evaluateWhen("unknownKey")).toBe(false);
  });
});
