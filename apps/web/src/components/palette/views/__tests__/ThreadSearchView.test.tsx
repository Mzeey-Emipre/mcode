import { act, fireEvent, render, screen } from "@testing-library/react";
import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { Command } from "@/components/ui/command";
import { useCommandPaletteStore } from "@/stores/commandPaletteStore";
import { createMockThread, createMockWorkspace } from "@/__tests__/mocks/transport";
import type { RecentThread } from "@/transport/types";

const hoisted = vi.hoisted(() => ({
  setActiveWorkspace: vi.fn(),
  setActiveThread: vi.fn(),
  setSearchQuery: vi.fn(),
  clearSearchQuery: vi.fn(),
}));

const workspace = createMockWorkspace({
  id: "ws-search",
  name: "Caravan",
  path: "C:/src/Caravan",
});

const thread = createMockThread({
  id: "thread-search",
  workspace_id: workspace.id,
  title: "Premium sidebar",
  provider: "codex",
  branch: "feature/sidebar",
  mode: "worktree",
  worktree_path: "C:/worktrees/quiet-lantern",
});

vi.mock("@/stores/recentThreadsStore", () => ({
  useRecentThreadsStore: (selector: (state: unknown) => unknown) =>
    selector({ threads: [], loading: false, fetch: vi.fn() }),
}));

vi.mock("@/stores/sidebarSearchStore", () => ({
  useSidebarSearchStore: (selector: (state: unknown) => unknown) =>
    selector({
      serverResults: [thread],
      serverWorkspaces: [workspace],
      isSearching: false,
      searchError: false,
      setQuery: hoisted.setSearchQuery,
      clearQuery: hoisted.clearSearchQuery,
      filters: { status: [], provider: [] },
      toggleFilter: vi.fn(),
      clearFilters: vi.fn(),
      sortField: "updated_at",
      sortDirection: "desc",
      setSortField: vi.fn(),
      toggleSortDirection: vi.fn(),
    }),
}));

vi.mock("@/stores/workspaceStore", () => ({
  useWorkspaceStore: (selector: (state: unknown) => unknown) =>
    selector({
      workspaces: [workspace],
      threads: [thread],
      setActiveWorkspace: hoisted.setActiveWorkspace,
      setActiveThread: hoisted.setActiveThread,
    }),
}));

import { filterAndSortRecentThreads, ThreadSearchView } from "../ThreadSearchView";

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

beforeEach(() => {
  vi.clearAllMocks();
  act(() => {
    useCommandPaletteStore.getState().open({ intent: "threadSearch" });
    useCommandPaletteStore.getState().setQuery("quiet-lantern");
  });
});

describe("ThreadSearchView", () => {
  it("shows project, provider, branch, and worktree metadata", () => {
    render(
      <Command shouldFilter={false}>
        <ThreadSearchView />
      </Command>,
    );

    expect(screen.getByText("Premium sidebar")).toBeInTheDocument();
    expect(screen.getByText("Caravan")).toBeInTheDocument();
    expect(screen.getByText("feature/sidebar")).toBeInTheDocument();
    expect(screen.getByText("quiet-lantern")).toBeInTheDocument();
    expect(screen.getByLabelText("Provider, codex")).toBeInTheDocument();
  });

  it("opens the selected thread inside its project", () => {
    render(
      <Command shouldFilter={false}>
        <ThreadSearchView />
      </Command>,
    );

    fireEvent.click(screen.getByTestId("thread-search-result-thread-search"));

    expect(hoisted.setActiveWorkspace).toHaveBeenCalledWith("ws-search");
    expect(hoisted.setActiveThread).toHaveBeenCalledWith("thread-search");
    expect(useCommandPaletteStore.getState().isOpen).toBe(false);
  });

  it("applies the active filters and sort order to recent threads", () => {
    const recentThreads: RecentThread[] = [
      {
        ...thread,
        id: "recent-zulu",
        title: "Zulu",
        status: "completed",
        workspace_name: "Caravan",
        workspace_path: "C:/src/Caravan",
      },
      {
        ...thread,
        id: "recent-alpha",
        title: "Alpha",
        status: "active",
        workspace_name: "Caravan",
        workspace_path: "C:/src/Caravan",
      },
      {
        ...thread,
        id: "recent-beta",
        title: "Beta",
        status: "active",
        workspace_name: "Caravan",
        workspace_path: "C:/src/Caravan",
      },
    ];

    const rows = filterAndSortRecentThreads(
      recentThreads,
      { status: ["active"], provider: [] },
      "title",
      "asc",
    );

    expect(rows.map((recentThread) => recentThread.title)).toEqual([
      "Alpha",
      "Beta",
    ]);
  });
});
