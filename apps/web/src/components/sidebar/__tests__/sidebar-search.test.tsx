import { describe, it, expect, beforeEach } from "vitest";
import { createMockThread } from "@/__tests__/mocks/transport";
import { useSidebarSearchStore } from "@/stores/sidebarSearchStore";

beforeEach(() => {
  useSidebarSearchStore.setState({
    query: "",
    isSearching: false,
    serverResults: [],
    serverWorkspaces: [],
    sortField: "updated_at",
    sortDirection: "desc",
    filters: { status: [], provider: [] },
    expandedSnapshot: null,
  });
  localStorage.clear();
});

describe("sidebarSearchStore", () => {
  it("sets and clears query", () => {
    useSidebarSearchStore.setState({
      serverResults: [createMockThread({ id: "stale-result" })],
      serverWorkspaces: [{ id: "ws-stale", name: "Stale", path: "/stale" }],
    });
    useSidebarSearchStore.getState().setQuery("test");
    expect(useSidebarSearchStore.getState().query).toBe("test");
    expect(useSidebarSearchStore.getState().isSearching).toBe(true);
    expect(useSidebarSearchStore.getState().serverResults).toEqual([]);
    expect(useSidebarSearchStore.getState().serverWorkspaces).toEqual([]);

    useSidebarSearchStore.getState().clearAll();
    expect(useSidebarSearchStore.getState().query).toBe("");
  });

  it("toggles filters on and off", () => {
    const { toggleFilter } = useSidebarSearchStore.getState();
    toggleFilter("status", "active");
    expect(useSidebarSearchStore.getState().filters.status).toEqual(["active"]);

    toggleFilter("status", "errored");
    expect(useSidebarSearchStore.getState().filters.status).toEqual(["active", "errored"]);

    toggleFilter("status", "active");
    expect(useSidebarSearchStore.getState().filters.status).toEqual(["errored"]);
  });

  it("clears all filters", () => {
    const { toggleFilter, clearFilters } = useSidebarSearchStore.getState();
    toggleFilter("status", "active");
    toggleFilter("provider", "claude");
    clearFilters();
    expect(useSidebarSearchStore.getState().filters).toEqual({ status: [], provider: [] });
  });

  it("persists sort preference to localStorage", () => {
    useSidebarSearchStore.getState().setSortField("title");
    useSidebarSearchStore.getState().setSortDirection("asc");

    const stored = JSON.parse(localStorage.getItem("mcode-sidebar-search-prefs")!);
    expect(stored.sortField).toBe("title");
    expect(stored.sortDirection).toBe("asc");
  });

  it("toggles sort direction", () => {
    expect(useSidebarSearchStore.getState().sortDirection).toBe("desc");
    useSidebarSearchStore.getState().toggleSortDirection();
    expect(useSidebarSearchStore.getState().sortDirection).toBe("asc");
    useSidebarSearchStore.getState().toggleSortDirection();
    expect(useSidebarSearchStore.getState().sortDirection).toBe("desc");
  });

  it("persists filters to localStorage", () => {
    useSidebarSearchStore.getState().toggleFilter("status", "errored");
    useSidebarSearchStore.getState().toggleFilter("provider", "claude");

    const stored = JSON.parse(localStorage.getItem("mcode-sidebar-search-prefs")!);
    expect(stored.filters.status).toEqual(["errored"]);
    expect(stored.filters.provider).toEqual(["claude"]);
  });

  it("snapshots expanded state only once per search session", () => {
    expect(useSidebarSearchStore.getState().expandedSnapshot).toBeNull();

    useSidebarSearchStore.getState().setExpandedSnapshot({ ws1: true, ws2: false });
    expect(useSidebarSearchStore.getState().expandedSnapshot).toEqual({ ws1: true, ws2: false });

    // Second call should be ignored
    useSidebarSearchStore.getState().setExpandedSnapshot({ ws1: false });
    expect(useSidebarSearchStore.getState().expandedSnapshot).toEqual({ ws1: true, ws2: false });
  });

  it("clearAll resets query and snapshot", () => {
    useSidebarSearchStore.getState().setQuery("test");
    useSidebarSearchStore.getState().setExpandedSnapshot({ ws1: true });
    useSidebarSearchStore.getState().clearAll();

    expect(useSidebarSearchStore.getState().query).toBe("");
    expect(useSidebarSearchStore.getState().expandedSnapshot).toBeNull();
    expect(useSidebarSearchStore.getState().isSearching).toBe(false);
  });
});
