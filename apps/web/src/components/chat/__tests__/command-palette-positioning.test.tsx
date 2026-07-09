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

vi.mock("@/stores/commandPaletteStore", () => ({
  useCommandPaletteStore: vi.fn((selector?: (s: unknown) => unknown) => {
    const state = {
      isOpen: true,
      viewStack: [{ kind: "root" }],
      query: "",
      pendingConfirm: null,
      close: vi.fn(),
      pop: vi.fn(),
      setQuery: vi.fn(),
    };
    return selector ? selector(state) : state;
  }),
}));

vi.mock("@/lib/context-tracker", () => ({
  setContext: vi.fn(),
}));

// Mock subviews so they render nothing (avoids their own store dependencies)
vi.mock("../../palette/views/RootView", () => ({
  RootView: () => <div data-testid="root-view" />,
}));
vi.mock("../../palette/views/ProjectsView", () => ({
  ProjectsView: () => null,
}));
vi.mock("../../palette/views/BrowseView", () => ({
  BrowseView: () => null,
}));
vi.mock("../../palette/views/SelectionListView", () => ({
  SelectionListView: () => null,
}));

// Mock the settings section map so SettingsView renders without real section components
vi.mock("../../settings/settings-nav", () => ({
  SECTION_MAP: {
    model: () => <div data-testid="model-section" />,
  },
}));

import { CommandPalette } from "../../palette/CommandPalette";
import { SettingsView } from "../../settings/SettingsView";

describe("CommandPalette popup positioning", () => {
  it("does NOT have top-[15%] in the popup className", () => {
    render(<CommandPalette />);
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
    const innerDiv = container.querySelector(".max-w-\\[96rem\\]");
    expect(innerDiv?.className ?? "").not.toContain("px-10");
  });

  it("keeps px-8 padding at the sm breakpoint", () => {
    const { container } = render(<SettingsView section="model" />);
    const innerDiv = container.querySelector(".max-w-\\[96rem\\]");
    expect(innerDiv?.className ?? "").toContain("sm:px-8");
  });
});
