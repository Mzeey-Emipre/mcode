import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  palette: {
    isOpen: true,
    viewStack: [{ kind: "threadSearch" }],
    query: "",
    setQuery: vi.fn(),
    close: vi.fn(),
    pop: vi.fn(),
    pendingConfirm: null as (() => void) | null,
  },
}));

vi.mock("@/stores/commandPaletteStore", () => ({
  useCommandPaletteStore: (selector: (state: unknown) => unknown) =>
    selector(mocks.palette),
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
  beforeEach(() => {
    mocks.palette.viewStack = [{ kind: "threadSearch" }];
    mocks.palette.query = "";
    mocks.palette.pendingConfirm = null;
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  it("focuses the thread search input when opened with the thread finder intent", async () => {
    render(<CommandPalette />);

    const input = screen.getByLabelText("Search threads");
    await waitFor(() => expect(input).toHaveFocus());
  });

  it("shows the enabled add-project tooltip and confirms the selected folder", async () => {
    const confirm = vi.fn();
    mocks.palette.query = "~/project";
    mocks.palette.pendingConfirm = confirm;
    const user = userEvent.setup();

    render(<CommandPalette />);

    const addProject = screen.getByTestId("palette-add-folder");
    await user.hover(addProject.parentElement!);
    await waitFor(() => {
      expect(document.querySelector('[data-slot="tooltip-content"]')).toHaveTextContent(
        "Add this folder as a project",
      );
    });

    fireEvent.click(addProject);
    expect(confirm).toHaveBeenCalledOnce();
  });

  it("shows the disabled add-project tooltip while keeping the action unavailable", async () => {
    mocks.palette.query = "~/project";
    const user = userEvent.setup();

    render(<CommandPalette />);

    const addProject = screen.getByTestId("palette-add-folder");
    expect(addProject).toBeDisabled();
    await user.hover(addProject.parentElement!);
    await waitFor(() => {
      expect(document.querySelector('[data-slot="tooltip-content"]')).toHaveTextContent(
        "Choose a folder before adding a project",
      );
    });
  });
});
