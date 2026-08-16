import { render, screen, act } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { ReactElement } from "react";
import { beforeEach, describe, expect, it, vi, beforeAll } from "vitest";
import type { Workspace } from "@/transport/types";
import { useCommandPaletteStore } from "@/stores/commandPaletteStore";
import { Command } from "@/components/ui/command";

const hoisted = vi.hoisted(() => {
  const pinnedWorkspace: Workspace = {
    id: "ws-1",
    name: "Alpha",
    path: "/alpha",
    provider_config: {},
    is_git_repo: true,
    created_at: new Date().toISOString(),
    updated_at: new Date().toISOString(),
    pinned: true,
    last_opened_at: Date.now(),
    sort_order: 0,
    deleted_at: null,
  };
  return {
    pinnedWorkspace,
    setActiveWorkspace: vi.fn(),
    enrich: vi.fn(),
  };
});

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

vi.mock("../state/workspaceStore", () => ({
  useWorkspaceStore: (selector: (s: unknown) => unknown) =>
    selector({
      workspaces: [hoisted.pinnedWorkspace],
      setActiveWorkspace: hoisted.setActiveWorkspace,
      pinWorkspace: vi.fn(),
    }),
}));

vi.mock("../state/projectSelectorStore", () => ({
  useProjectSelectorStore: (selector: (s: unknown) => unknown) =>
    selector({
      enrich: hoisted.enrich,
      enrichmentCache: new Map(),
    }),
}));

import { ProjectsView } from "../ProjectsView";

/** cmdk list primitives require a parent {@link Command} for context. */
function renderWithCommandPaletteShell(ui: ReactElement) {
  return render(
    <Command shouldFilter={false} loop>
      {ui}
    </Command>,
  );
}

describe("ProjectsView", () => {
  beforeEach(() => {
    hoisted.setActiveWorkspace.mockClear();
    hoisted.enrich.mockClear();
    act(() => {
      useCommandPaletteStore.getState().close();
    });
  });

  it("switches workspace and closes after project selection", async () => {
    const user = userEvent.setup();
    act(() => {
      useCommandPaletteStore.getState().open({ intent: "projects" });
    });

    renderWithCommandPaletteShell(<ProjectsView />);

    await user.click(screen.getByTestId("project-row"));

    expect(hoisted.setActiveWorkspace).toHaveBeenCalledWith("ws-1");
    expect(useCommandPaletteStore.getState().isOpen).toBe(false);
  });
});
