/**
 * Tests for CommandPalette popup positioning and SettingsView padding classes.
 *
 * Ensures the popup uses fluid clamp-based top offset (not the old fixed 15%)
 * and that SettingsView uses the balanced px-8/py-8 padding (not px-10/py-7).
 */
import { render } from "@testing-library/react";
import { describe, it, expect, vi, beforeAll } from "vitest";

beforeAll(() => {
  if (typeof window.ResizeObserver === "undefined") {
    window.ResizeObserver = class ResizeObserver {
      observe() {}
      unobserve() {}
      disconnect() {}
    };
  }
  Element.prototype.scrollIntoView = () => {};
});

vi.mock("@/stores/uiStore", () => ({
  useUiStore: vi.fn((selector: (s: unknown) => unknown) =>
    selector({
      commandPaletteOpen: true,
      setCommandPaletteOpen: vi.fn(),
    }),
  ),
}));

vi.mock("@/lib/command-registry", () => ({
  getAllCommands: vi.fn(() => []),
  executeCommand: vi.fn(),
}));

vi.mock("@/lib/keybinding-manager", () => ({
  getKeybindingForCommand: vi.fn(() => null),
  formatKeybinding: vi.fn(() => ""),
}));

vi.mock("@/lib/context-tracker", () => ({
  setContext: vi.fn(),
}));

vi.mock("@/lib/platform", () => ({
  isMac: false,
}));

// Mock the settings section map so SettingsView renders without real section components
vi.mock("../../settings/settings-nav", () => ({
  SECTION_MAP: {
    model: () => <div data-testid="model-section" />,
  },
}));

import { CommandPalette } from "../../CommandPalette";
import { SettingsView } from "../../settings/SettingsView";

describe("CommandPalette popup positioning", () => {
  it("does NOT have top-[15%] in the popup className", () => {
    render(<CommandPalette />);
    // The Popup renders into a portal; query the full document
    const popup = document.querySelector("[class*='top-']");
    expect(popup?.className ?? "").not.toContain("top-[15%]");
  });

  it("DOES have top-[clamp in the popup className", () => {
    render(<CommandPalette />);
    const popup = document.querySelector("[class*='top-[clamp']");
    expect(popup).not.toBeNull();
  });
});

describe("SettingsView padding", () => {
  it("does NOT have px-10 in the outer div className", () => {
    const { container } = render(<SettingsView section="model" />);
    const innerDiv = container.querySelector(".max-w-4xl");
    expect(innerDiv?.className ?? "").not.toContain("px-10");
  });

  it("DOES have px-8 in the outer div className", () => {
    const { container } = render(<SettingsView section="model" />);
    const innerDiv = container.querySelector(".max-w-4xl");
    expect(innerDiv?.className ?? "").toContain("px-8");
  });
});
