import { describe, it, expect, beforeEach } from "vitest";
import {
  useDiffStore,
  PANEL_MIN_WIDTH,
  COMPOSER_MIN_WIDTH,
  PANEL_SPLIT_GAP_PX,
  maxPanelWidthInSplit,
  getDefaultPanelWidthPx,
  createDefaultRightPanelState,
  DEFAULT_LINE_WRAP,
} from "../stores/diffStore";

describe("diffStore", () => {
  beforeEach(() => {
    useDiffStore.setState({
      previewUrlByThread: {},
      rightPanelByWorkspace: {},
      rightPanelVisibleByThread: {},
      snapshotsByThread: {},
      snapshotsLoadingByThread: {},
      snapshotsPendingByThread: {},
      commitsByThread: {},
      commitsLoadingByThread: {},
      selectedFile: null,
      diffContent: null,
      diffLoading: false,
      viewMode: "last-turn",
      selectedCommitSha: null,
      renderMode: "unified",
      lineWrapByThread: {},
    });
  });

  describe("commit picker operand", () => {
    it("starts with no resolved picked commit", () => {
      expect(useDiffStore.getState().selectedCommitSha).toBeNull();
    });

    it("stores the picked commit SHA", () => {
      useDiffStore.getState().setSelectedCommitSha("abc1234");
      expect(useDiffStore.getState().selectedCommitSha).toBe("abc1234");
    });

    it("resets the picked commit when the active view changes", () => {
      const { setSelectedCommitSha, setViewMode } = useDiffStore.getState();
      setSelectedCommitSha("abc1234");
      setViewMode("commit");
      expect(useDiffStore.getState().selectedCommitSha).toBeNull();
    });
  });

  describe("line wrap", () => {
    it("defaults to wrapped for threads with no stored preference", () => {
      const { getLineWrap } = useDiffStore.getState();
      expect(getLineWrap("thread-1")).toBe(DEFAULT_LINE_WRAP);
      expect(DEFAULT_LINE_WRAP).toBe(true);
    });

    it("toggles and stores preference per thread", () => {
      const { toggleLineWrap, getLineWrap } = useDiffStore.getState();
      expect(getLineWrap("thread-1")).toBe(true);
      toggleLineWrap("thread-1");
      expect(getLineWrap("thread-1")).toBe(false);
      expect(getLineWrap("thread-2")).toBe(true);
      toggleLineWrap("thread-1");
      expect(getLineWrap("thread-1")).toBe(true);
    });

    it("clears stored preference when the thread is cleared", () => {
      const { toggleLineWrap, getLineWrap, clearThread } = useDiffStore.getState();
      toggleLineWrap("thread-1");
      expect(getLineWrap("thread-1")).toBe(false);
      clearThread("thread-1");
      expect(getLineWrap("thread-1")).toBe(true);
      expect(useDiffStore.getState().lineWrapByThread["thread-1"]).toBeUndefined();
    });
  });

  describe("getRightPanel", () => {
    it("should return defaults for unknown workspace", () => {
      const { getRightPanel } = useDiffStore.getState();
      expect(getRightPanel("unknown")).toEqual(createDefaultRightPanelState());
    });

    it("should return stored state for known workspace", () => {
      const { showRightPanel, getRightPanel } = useDiffStore.getState();
      showRightPanel("ws-1");
      expect(getRightPanel("ws-1").visible).toBe(true);
    });
  });

  describe("toggleRightPanel", () => {
    it("should flip visibility for one workspace", () => {
      const { toggleRightPanel, getRightPanel } = useDiffStore.getState();
      toggleRightPanel("ws-1");
      expect(getRightPanel("ws-1").visible).toBe(true);
      toggleRightPanel("ws-1");
      expect(getRightPanel("ws-1").visible).toBe(false);
    });

    it("should not affect other workspaces", () => {
      const { toggleRightPanel, getRightPanel } = useDiffStore.getState();
      toggleRightPanel("ws-1");
      expect(getRightPanel("ws-2").visible).toBe(false);
    });
  });

  describe("showRightPanel / hideRightPanel", () => {
    it("showRightPanel sets visible true without affecting width", () => {
      const { showRightPanel, setRightPanelWidth, getRightPanel } = useDiffStore.getState();
      setRightPanelWidth("ws-1", 500);
      showRightPanel("ws-1");
      const panel = getRightPanel("ws-1");
      expect(panel.visible).toBe(true);
      expect(panel.width).toBe(500);
    });

    it("hideRightPanel sets visible false without affecting tab", () => {
      const { showRightPanel, hideRightPanel, setRightPanelTab, getRightPanel } = useDiffStore.getState();
      showRightPanel("ws-1");
      setRightPanelTab("ws-1", "changes");
      hideRightPanel("ws-1");
      const panel = getRightPanel("ws-1");
      expect(panel.visible).toBe(false);
      expect(panel.activeTab).toBe("changes");
    });
  });

  describe("setRightPanelWidth", () => {
    it("should update width for one workspace", () => {
      const { setRightPanelWidth, getRightPanel } = useDiffStore.getState();
      setRightPanelWidth("ws-1", 500);
      expect(getRightPanel("ws-1").width).toBe(500);
      expect(getRightPanel("ws-2").width).toBe(getDefaultPanelWidthPx());
    });

    it("should clamp width to PANEL_MIN_WIDTH", () => {
      const { setRightPanelWidth, getRightPanel } = useDiffStore.getState();
      setRightPanelWidth("ws-1", 100);
      expect(getRightPanel("ws-1").width).toBe(PANEL_MIN_WIDTH);
    });
  });

  describe("maxPanelWidthInSplit", () => {
    it("reserves composer min width and split gap from the row width", () => {
      const split = 1200;
      expect(maxPanelWidthInSplit(split)).toBe(
        split - COMPOSER_MIN_WIDTH - PANEL_SPLIT_GAP_PX,
      );
    });

    it("never returns below PANEL_MIN_WIDTH", () => {
      expect(maxPanelWidthInSplit(500)).toBe(PANEL_MIN_WIDTH);
    });
  });

  describe("setRightPanelTab", () => {
    it("should update active tab for one workspace only", () => {
      const { setRightPanelTab, getRightPanel } = useDiffStore.getState();
      setRightPanelTab("ws-1", "changes");
      expect(getRightPanel("ws-1").activeTab).toBe("changes");
      expect(getRightPanel("ws-2").activeTab).toBe("tasks");
    });

    it("should support preview tab", () => {
      const { setRightPanelTab, getRightPanel } = useDiffStore.getState();
      setRightPanelTab("ws-1", "preview");
      expect(getRightPanel("ws-1").activeTab).toBe("preview");
    });

    it("defaults to no open tabs (empty-state card grid)", () => {
      const { getRightPanel } = useDiffStore.getState();
      expect(getRightPanel("ws-fresh").openTabs).toEqual([]);
    });

    it("opens a tab (adds it to openTabs) when first activated", () => {
      const { setRightPanelTab, getRightPanel } = useDiffStore.getState();
      setRightPanelTab("ws-1", "preview");
      expect(getRightPanel("ws-1").openTabs).toEqual(["preview"]);
      expect(getRightPanel("ws-1").activeTab).toBe("preview");
    });

    it("accumulates open tabs in open order without duplicating", () => {
      const { setRightPanelTab, getRightPanel } = useDiffStore.getState();
      setRightPanelTab("ws-1", "preview");
      setRightPanelTab("ws-1", "terminal");
      setRightPanelTab("ws-1", "preview"); // refocus, not reopen
      expect(getRightPanel("ws-1").openTabs).toEqual(["preview", "terminal"]);
      expect(getRightPanel("ws-1").activeTab).toBe("preview");
    });
  });

  describe("closeRightPanelTab", () => {
    it("removes a tab from the open set", () => {
      const { setRightPanelTab, closeRightPanelTab, getRightPanel } = useDiffStore.getState();
      setRightPanelTab("ws-1", "preview");
      setRightPanelTab("ws-1", "terminal");
      closeRightPanelTab("ws-1", "preview");
      expect(getRightPanel("ws-1").openTabs).toEqual(["terminal"]);
    });

    it("moves focus to the most-recently-opened survivor when the active tab closes", () => {
      const { setRightPanelTab, closeRightPanelTab, getRightPanel } = useDiffStore.getState();
      setRightPanelTab("ws-1", "preview");
      setRightPanelTab("ws-1", "terminal"); // terminal is active
      closeRightPanelTab("ws-1", "terminal");
      expect(getRightPanel("ws-1").openTabs).toEqual(["preview"]);
      expect(getRightPanel("ws-1").activeTab).toBe("preview");
    });

    it("leaves the active tab unchanged when closing an inactive tab", () => {
      const { setRightPanelTab, closeRightPanelTab, getRightPanel } = useDiffStore.getState();
      setRightPanelTab("ws-1", "preview");
      setRightPanelTab("ws-1", "terminal"); // terminal is active
      closeRightPanelTab("ws-1", "preview");
      expect(getRightPanel("ws-1").activeTab).toBe("terminal");
    });

    it("empties the open set when the last tab closes (returns to card grid)", () => {
      const { setRightPanelTab, closeRightPanelTab, getRightPanel } = useDiffStore.getState();
      setRightPanelTab("ws-1", "preview");
      closeRightPanelTab("ws-1", "preview");
      expect(getRightPanel("ws-1").openTabs).toEqual([]);
    });

    it("is a no-op when the tab is not open", () => {
      const { setRightPanelTab, closeRightPanelTab, getRightPanel } = useDiffStore.getState();
      setRightPanelTab("ws-1", "preview");
      closeRightPanelTab("ws-1", "terminal");
      expect(getRightPanel("ws-1").openTabs).toEqual(["preview"]);
      expect(getRightPanel("ws-1").activeTab).toBe("preview");
    });

    it("affects only the target workspace", () => {
      const { setRightPanelTab, closeRightPanelTab, getRightPanel } = useDiffStore.getState();
      setRightPanelTab("ws-1", "preview");
      setRightPanelTab("ws-2", "preview");
      closeRightPanelTab("ws-1", "preview");
      expect(getRightPanel("ws-1").openTabs).toEqual([]);
      expect(getRightPanel("ws-2").openTabs).toEqual(["preview"]);
    });
  });

  // The panel is workspace-global: its open state must survive having no thread
  // active (e.g. the threadless workspace shell) and persist across navigation.
  describe("workspace-global persistence", () => {
    it("retains visibility, width, and tab with no active thread", () => {
      const { showRightPanel, setRightPanelWidth, setRightPanelTab, getRightPanel } =
        useDiffStore.getState();
      showRightPanel("ws-1");
      setRightPanelWidth("ws-1", 460);
      setRightPanelTab("ws-1", "preview");

      // No thread keying is involved, so re-reading the workspace slice returns
      // the same state regardless of which (or no) thread is active.
      const panel = getRightPanel("ws-1");
      expect(panel.visible).toBe(true);
      expect(panel.width).toBe(460);
      expect(panel.activeTab).toBe("preview");
    });

    it("keeps panel state when threads are cleared", () => {
      const { showRightPanel, setRightPanelTab, clearThread, getRightPanel } =
        useDiffStore.getState();
      showRightPanel("ws-1");
      setRightPanelTab("ws-1", "changes");

      // Clearing a thread must not touch the workspace-global panel slice.
      clearThread("thread-1");

      const panel = getRightPanel("ws-1");
      expect(panel.visible).toBe(true);
      expect(panel.activeTab).toBe("changes");
    });
  });

  // Open/closed is per-thread within a workspace: opening the panel on one
  // thread must not open it on a sibling thread, while width and active tab
  // remain shared workspace-global state. See ADR-0004.
  describe("per-thread visibility", () => {
    it("getRightPanelVisible defaults to closed for an unknown thread", () => {
      const { getRightPanelVisible } = useDiffStore.getState();
      expect(getRightPanelVisible("ws-1", "thread-1")).toBe(false);
    });

    it("showRightPanel with a thread opens only that thread", () => {
      const { showRightPanel, getRightPanelVisible } = useDiffStore.getState();
      showRightPanel("ws-1", "thread-1");
      expect(getRightPanelVisible("ws-1", "thread-1")).toBe(true);
      expect(getRightPanelVisible("ws-1", "thread-2")).toBe(false);
    });

    it("hideRightPanel with a thread closes only that thread", () => {
      const { showRightPanel, hideRightPanel, getRightPanelVisible } = useDiffStore.getState();
      showRightPanel("ws-1", "thread-1");
      showRightPanel("ws-1", "thread-2");
      hideRightPanel("ws-1", "thread-1");
      expect(getRightPanelVisible("ws-1", "thread-1")).toBe(false);
      expect(getRightPanelVisible("ws-1", "thread-2")).toBe(true);
    });

    it("toggleRightPanel with a thread flips only that thread", () => {
      const { toggleRightPanel, getRightPanelVisible } = useDiffStore.getState();
      toggleRightPanel("ws-1", "thread-1");
      expect(getRightPanelVisible("ws-1", "thread-1")).toBe(true);
      toggleRightPanel("ws-1", "thread-1");
      expect(getRightPanelVisible("ws-1", "thread-1")).toBe(false);
    });

    it("shares width and active tab across threads in the same workspace", () => {
      const { showRightPanel, setRightPanelWidth, setRightPanelTab, getRightPanel } =
        useDiffStore.getState();
      showRightPanel("ws-1", "thread-1");
      setRightPanelWidth("ws-1", 540);
      setRightPanelTab("ws-1", "preview");

      // Width and tab live on the workspace slice, so a sibling thread sees them.
      const panel = getRightPanel("ws-1");
      expect(panel.width).toBe(540);
      expect(panel.activeTab).toBe("preview");
    });

    it("threadless visibility is independent of per-thread visibility", () => {
      const { showRightPanel, getRightPanelVisible } = useDiffStore.getState();
      showRightPanel("ws-1", "thread-1");
      // No thread → reads the workspace threadless slice, still closed.
      expect(getRightPanelVisible("ws-1")).toBe(false);
      showRightPanel("ws-1");
      expect(getRightPanelVisible("ws-1")).toBe(true);
      // Opening threadless must not retroactively open a different thread.
      expect(getRightPanelVisible("ws-1", "thread-2")).toBe(false);
    });

    it("clearThread drops the thread's visibility entry", () => {
      const { showRightPanel, clearThread, getRightPanelVisible } = useDiffStore.getState();
      showRightPanel("ws-1", "thread-1");
      clearThread("thread-1");
      expect(getRightPanelVisible("ws-1", "thread-1")).toBe(false);
      expect(useDiffStore.getState().rightPanelVisibleByThread["thread-1"]).toBeUndefined();
    });
  });

  describe("clearWorkspace", () => {
    it("removes the panel slice for the given workspace", () => {
      const { showRightPanel, setRightPanelTab, clearWorkspace, getRightPanel } =
        useDiffStore.getState();
      showRightPanel("ws-1");
      setRightPanelTab("ws-1", "preview");

      clearWorkspace("ws-1");

      expect(useDiffStore.getState().rightPanelByWorkspace["ws-1"]).toBeUndefined();
      expect(getRightPanel("ws-1")).toEqual(createDefaultRightPanelState());
    });

    it("does not affect other workspaces", () => {
      const { showRightPanel, clearWorkspace, getRightPanel } = useDiffStore.getState();
      showRightPanel("ws-1");
      showRightPanel("ws-2");

      clearWorkspace("ws-1");

      expect(getRightPanel("ws-2").visible).toBe(true);
    });

    it("is a no-op for an unknown workspace", () => {
      const { clearWorkspace } = useDiffStore.getState();
      expect(() => clearWorkspace("nope")).not.toThrow();
      expect(useDiffStore.getState().rightPanelByWorkspace["nope"]).toBeUndefined();
    });
  });

  describe("setPreviewUrlForThread", () => {
    it("stores url per thread independently", () => {
      const { setPreviewUrlForThread } = useDiffStore.getState();
      setPreviewUrlForThread("thread-1", "https://a.test");
      setPreviewUrlForThread("thread-2", "https://b.test");
      const state = useDiffStore.getState();
      expect(state.previewUrlByThread["thread-1"]).toBe("https://a.test");
      expect(state.previewUrlByThread["thread-2"]).toBe("https://b.test");
    });
  });

  describe("clearThread", () => {
    it("should remove all per-thread entries", () => {
      const {
        setSnapshots,
        setSnapshotsLoading,
        setCommits,
        setCommitsLoading,
        setPreviewUrlForThread,
        clearThread,
      } =
        useDiffStore.getState();
      setSnapshots("thread-1", [{ id: "s1" } as never]);
      setSnapshotsLoading("thread-1", true);
      setCommits("thread-1", [{ sha: "c1" } as never]);
      setCommitsLoading("thread-1", true);
      setPreviewUrlForThread("thread-1", "https://example.com");

      clearThread("thread-1");

      const state = useDiffStore.getState();
      expect(state.previewUrlByThread["thread-1"]).toBeUndefined();
      expect(state.snapshotsByThread["thread-1"]).toBeUndefined();
      expect(state.snapshotsLoadingByThread["thread-1"]).toBeUndefined();
      expect(state.commitsByThread["thread-1"]).toBeUndefined();
      expect(state.commitsLoadingByThread["thread-1"]).toBeUndefined();
    });

    it("should not affect other threads", () => {
      const { setSnapshots, setSnapshotsLoading, setCommits, setCommitsLoading, clearThread } =
        useDiffStore.getState();
      setSnapshots("thread-1", [{ id: "s1" } as never]);
      setSnapshots("thread-2", [{ id: "s2" } as never]);
      setSnapshotsLoading("thread-2", true);
      setCommits("thread-2", [{ sha: "c2" } as never]);
      setCommitsLoading("thread-2", true);

      clearThread("thread-1");

      const state = useDiffStore.getState();
      expect(state.snapshotsByThread["thread-2"]).toHaveLength(1);
      expect(state.snapshotsLoadingByThread["thread-2"]).toBe(true);
      expect(state.commitsByThread["thread-2"]).toHaveLength(1);
      expect(state.commitsLoadingByThread["thread-2"]).toBe(true);
    });

    it("should clear selectedFile when it belongs to deleted thread", () => {
      useDiffStore.setState({
        selectedFile: { source: "snapshot", id: "snap-1", filePath: "a.ts", threadId: "thread-1" },
        diffContent: "diff text",
        diffLoading: true,
      });
      useDiffStore.getState().clearThread("thread-1");
      const state = useDiffStore.getState();
      expect(state.selectedFile).toBeNull();
      expect(state.diffContent).toBeNull();
      expect(state.diffLoading).toBe(false);
    });

    it("should preserve selectedFile when it belongs to a different thread", () => {
      const file = { source: "commit" as const, id: "abc123", filePath: "b.ts", threadId: "thread-2" };
      useDiffStore.setState({
        selectedFile: file,
        diffContent: "other diff",
        diffLoading: false,
      });
      useDiffStore.getState().clearThread("thread-1");
      const state = useDiffStore.getState();
      expect(state.selectedFile).toEqual(file);
      expect(state.diffContent).toBe("other diff");
    });
  });

  describe("markSnapshotsPending", () => {
    it("sets the pending flag for the given thread", () => {
      useDiffStore.getState().markSnapshotsPending("thread-1", true);
      expect(useDiffStore.getState().snapshotsPendingByThread["thread-1"]).toBe(true);
    });

    it("clears the pending flag when called with false", () => {
      useDiffStore.getState().markSnapshotsPending("thread-1", true);
      useDiffStore.getState().markSnapshotsPending("thread-1", false);
      expect(useDiffStore.getState().snapshotsPendingByThread["thread-1"]).toBeUndefined();
    });

    it("does not affect other threads", () => {
      useDiffStore.getState().markSnapshotsPending("thread-1", true);
      expect(useDiffStore.getState().snapshotsPendingByThread["thread-2"]).toBeUndefined();
    });

    it("is cleared when setSnapshots runs for the same thread", () => {
      useDiffStore.getState().markSnapshotsPending("thread-1", true);
      useDiffStore.getState().setSnapshots("thread-1", []);
      expect(useDiffStore.getState().snapshotsPendingByThread["thread-1"]).toBeUndefined();
    });

    it("is cleared by clearThread", () => {
      useDiffStore.getState().markSnapshotsPending("thread-1", true);
      useDiffStore.getState().clearThread("thread-1");
      expect(useDiffStore.getState().snapshotsPendingByThread["thread-1"]).toBeUndefined();
    });
  });

});
