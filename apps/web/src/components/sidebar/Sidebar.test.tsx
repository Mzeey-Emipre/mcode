import { fireEvent, render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

const hoisted = vi.hoisted(() => ({
  openCommandPalette: vi.fn(),
}));

vi.mock("@/stores/commandPaletteStore", () => ({
  useCommandPaletteStore: Object.assign(vi.fn(), {
    getState: () => ({ open: hoisted.openCommandPalette }),
  }),
}));

vi.mock("@/stores/uiStore", () => ({
  useUiStore: (selector: (state: unknown) => unknown) =>
    selector({
      collapseSidebar: vi.fn(),
      primarySurface: "chat",
      setPrimarySurface: vi.fn(),
    }),
}));

vi.mock("@/features/projects/state/workspaceStore", () => ({
  useWorkspaceStore: Object.assign(vi.fn(), {
    getState: () => ({ beginNewThread: vi.fn() }),
  }),
}));

vi.mock("@/features/projects", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/features/projects")>()),
  ProjectTree: () => <div data-testid="project-tree" />,
}));

vi.mock("./UpdateIndicator", () => ({
  UpdateIndicator: () => null,
}));

import { Sidebar } from "./Sidebar";

describe("Sidebar", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("opens the thread finder intent from Search threads", () => {
    render(<Sidebar onOpenSettings={vi.fn()} />);

    fireEvent.click(screen.getByRole("button", { name: "Search threads" }));

    expect(hoisted.openCommandPalette).toHaveBeenCalledWith({
      intent: "threadSearch",
    });
  });
});
