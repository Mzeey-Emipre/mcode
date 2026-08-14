import { describe, expect, it, vi } from "vitest";
import type { FitAddon } from "@xterm/addon-fit";
import {
  isContainerReadyForFit,
  isSafeTerminalDimensions,
  MAX_FIT_COLS,
  MAX_FIT_ROWS,
  MIN_FIT_COLS,
  MIN_FIT_ROWS,
  safeFit,
} from "../safeFit";

describe("isSafeTerminalDimensions", () => {
  it("rejects zero and tiny grids", () => {
    expect(isSafeTerminalDimensions({ cols: 0, rows: 10 })).toBe(false);
    expect(isSafeTerminalDimensions({ cols: 2, rows: 10 })).toBe(false);
    expect(isSafeTerminalDimensions({ cols: MIN_FIT_COLS, rows: MIN_FIT_ROWS - 1 })).toBe(
      false,
    );
    expect(isSafeTerminalDimensions({ cols: MAX_FIT_COLS + 1, rows: 24 })).toBe(false);
    expect(isSafeTerminalDimensions({ cols: 80, rows: MAX_FIT_ROWS + 1 })).toBe(false);
    expect(isSafeTerminalDimensions({ cols: 80.5, rows: 24 })).toBe(false);
  });

  it("accepts dimensions at or above the minimum", () => {
    expect(
      isSafeTerminalDimensions({ cols: MIN_FIT_COLS, rows: MIN_FIT_ROWS }),
    ).toBe(true);
    expect(isSafeTerminalDimensions({ cols: 80, rows: 24 })).toBe(true);
  });
});

describe("isContainerReadyForFit", () => {
  it("rejects null and undersized elements", () => {
    expect(isContainerReadyForFit(null)).toBe(false);
    const el = document.createElement("div");
    Object.defineProperty(el, "clientWidth", { value: 10, configurable: true });
    Object.defineProperty(el, "clientHeight", { value: 10, configurable: true });
    expect(isContainerReadyForFit(el)).toBe(false);
  });

  it("accepts elements with sufficient client size", () => {
    const el = document.createElement("div");
    Object.defineProperty(el, "clientWidth", { value: 200, configurable: true });
    Object.defineProperty(el, "clientHeight", { value: 100, configurable: true });
    expect(isContainerReadyForFit(el)).toBe(true);
  });
});

describe("safeFit", () => {
  it("skips fit when cols and rows already match the terminal", () => {
    const fit = vi.fn();
    const fitAddon = {
      fit,
      proposeDimensions: () => ({ cols: 80, rows: 24 }),
    } as unknown as FitAddon;
    const el = document.createElement("div");
    Object.defineProperty(el, "clientWidth", { value: 200, configurable: true });
    Object.defineProperty(el, "clientHeight", { value: 100, configurable: true });

    expect(safeFit(fitAddon, el, { cols: 80, rows: 24 })).toBe(false);
    expect(fit).not.toHaveBeenCalled();
  });
});
