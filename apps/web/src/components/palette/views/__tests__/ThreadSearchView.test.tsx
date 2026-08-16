import { act, fireEvent, render, screen } from "@testing-library/react";
import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { Command } from "@/components/ui/command";
import { useCommandPaletteStore } from "@/stores/commandPaletteStore";
import { useUiStore } from "@/stores/uiStore";
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
  updated_at: new Date().toISOString(),
  user_completed_at: "2026-08-12T08:00:00.000Z",
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

vi.mock("@/features/projects/state/workspaceStore", () => ({
  useWorkspaceStore: (selector: (state: unknown) => unknown) =>
    selector({
      workspaces: [workspace],
      threads: [thread],
      checksById: {},
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
    useUiStore.setState({
      projectThreadViews: { "another-project": "active" },
    });
    useCommandPaletteStore.getState().open({ intent: "threadSearch" });
    useCommandPaletteStore.getState().setQuery("quiet-lantern");
  });
});

describe("ThreadSearchView", () => {
  it("shows a compact provider-free record with project, branch, and state", () => {
    render(
      <Command shouldFilter={false}>
        <ThreadSearchView />
      </Command>,
    );

    expect(screen.getByText("Premium sidebar")).toBeInTheDocument();
    expect(screen.getByText("Premium sidebar")).toHaveClass("line-through");
    expect(screen.getByText("Caravan")).toBeInTheDocument();
    expect(screen.getByText("feature/sidebar")).toBeInTheDocument();
    expect(screen.getByText("now")).toBeInTheDocument();
    expect(screen.queryByText("quiet-lantern")).not.toBeInTheDocument();
    expect(screen.queryByLabelText("Provider, codex")).not.toBeInTheDocument();
    expect(screen.getByTestId("thread-search-result-thread-search")).toHaveClass("min-h-9");
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
    expect(useUiStore.getState().projectThreadViews).toEqual({
      "another-project": "active",
      "ws-search": "completed",
    });
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
