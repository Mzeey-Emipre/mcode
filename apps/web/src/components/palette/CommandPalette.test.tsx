import { render, screen, waitFor } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

vi.mock("@/stores/commandPaletteStore", () => ({
  useCommandPaletteStore: (selector: (state: unknown) => unknown) =>
    selector({
      isOpen: true,
      viewStack: [{ kind: "threadSearch" }],
      query: "",
      setQuery: vi.fn(),
      close: vi.fn(),
      pop: vi.fn(),
      pendingConfirm: null,
    }),
}));

vi.mock("@/lib/context-tracker", () => ({
  setContext: vi.fn(),
}));

vi.mock("./views/RootView", () => ({
  RootView: () => null,
}));
vi.mock("./views/ProjectsView", () => ({
  ProjectsView: () => null,
}));
vi.mock("./views/BrowseView", () => ({
  BrowseView: () => null,
}));
vi.mock("./views/SelectionListView", () => ({
  SelectionListView: () => null,
}));
vi.mock("./views/ThreadSearchView", () => ({
  ThreadSearchView: () => null,
}));

import { CommandPalette } from "./CommandPalette";

describe("CommandPalette", () => {
  it("focuses the thread search input when opened with the thread finder intent", async () => {
    render(<CommandPalette />);

    const input = screen.getByLabelText("Search threads");
    await waitFor(() => expect(input).toHaveFocus());
  });
});
