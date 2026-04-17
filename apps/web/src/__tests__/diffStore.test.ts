import { describe, it, expect, beforeEach } from "vitest";
import {
  useDiffStore,
  RIGHT_PANEL_DEFAULTS,
  PANEL_DEFAULT_WIDTH,
  PANEL_MIN_WIDTH,
} from "../stores/diffStore";

describe("diffStore", () => {
  beforeEach(() => {
    useDiffStore.setState({
      rightPanelByThread: {},
      snapshotsByThread: {},
      snapshotsLoadingByThread: {},
      commitsByThread: {},
      commitsLoadingByThread: {},
      selectedFile: null,
      diffContent: null,
      diffLoading: false,
      viewMode: "by-turn",
      renderMode: "unified",
      lineWrap: false,
    });
  });

  describe("getRightPanel", () => {
    it("should return defaults for unknown thread", () => {
      const { getRightPanel } = useDiffStore.getState();
      expect(getRightPanel("unknown")).toEqual(RIGHT_PANEL_DEFAULTS);
    });

    it("should return stored state for known thread", () => {
      const { showRightPanel, getRightPanel } = useDiffStore.getState();
      showRightPanel("thread-1");
      expect(getRightPanel("thread-1").visible).toBe(true);
    });
  });

  describe("toggleRightPanel", () => {
    it("should flip visibility for one thread", () => {
      const { toggleRightPanel, getRightPanel } = useDiffStore.getState();
      toggleRightPanel("thread-1");
      expect(getRightPanel("thread-1").visible).toBe(true);
      toggleRightPanel("thread-1");
      expect(getRightPanel("thread-1").visible).toBe(false);
    });

    it("should not affect other threads", () => {
      const { toggleRightPanel, getRightPanel } = useDiffStore.getState();
      toggleRightPanel("thread-1");
      expect(getRightPanel("thread-2").visible).toBe(false);
    });
  });

  describe("showRightPanel / hideRightPanel", () => {
    it("showRightPanel sets visible true without affecting width", () => {
      const { showRightPanel, setRightPanelWidth, getRightPanel } = useDiffStore.getState();
      setRightPanelWidth("thread-1", 500);
      showRightPanel("thread-1");
      const panel = getRightPanel("thread-1");
      expect(panel.visible).toBe(true);
      expect(panel.width).toBe(500);
    });

    it("hideRightPanel sets visible false without affecting tab", () => {
      const { showRightPanel, hideRightPanel, setRightPanelTab, getRightPanel } = useDiffStore.getState();
      showRightPanel("thread-1");
      setRightPanelTab("thread-1", "changes");
      hideRightPanel("thread-1");
      const panel = getRightPanel("thread-1");
      expect(panel.visible).toBe(false);
      expect(panel.activeTab).toBe("changes");
    });
  });

  describe("setRightPanelWidth", () => {
    it("should update width for one thread", () => {
      const { setRightPanelWidth, getRightPanel } = useDiffStore.getState();
      setRightPanelWidth("thread-1", 500);
      expect(getRightPanel("thread-1").width).toBe(500);
      expect(getRightPanel("thread-2").width).toBe(PANEL_DEFAULT_WIDTH);
    });

    it("should clamp width to PANEL_MIN_WIDTH", () => {
      const { setRightPanelWidth, getRightPanel } = useDiffStore.getState();
      setRightPanelWidth("thread-1", 100);
      expect(getRightPanel("thread-1").width).toBe(PANEL_MIN_WIDTH);
    });
  });

  describe("setRightPanelTab", () => {
    it("should update active tab for one thread only", () => {
      const { setRightPanelTab, getRightPanel } = useDiffStore.getState();
      setRightPanelTab("thread-1", "changes");
      expect(getRightPanel("thread-1").activeTab).toBe("changes");
      expect(getRightPanel("thread-2").activeTab).toBe("tasks");
    });
  });

  describe("clearThread", () => {
    it("should remove all per-thread entries", () => {
      const { showRightPanel, setSnapshots, setSnapshotsLoading, setCommits, setCommitsLoading, clearThread, getRightPanel } =
        useDiffStore.getState();
      showRightPanel("thread-1");
      setSnapshots("thread-1", [{ id: "s1" } as never]);
      setSnapshotsLoading("thread-1", true);
      setCommits("thread-1", [{ sha: "c1" } as never]);
      setCommitsLoading("thread-1", true);

      clearThread("thread-1");

      const state = useDiffStore.getState();
      expect(state.rightPanelByThread["thread-1"]).toBeUndefined();
      expect(getRightPanel("thread-1")).toEqual(RIGHT_PANEL_DEFAULTS);
      expect(state.snapshotsByThread["thread-1"]).toBeUndefined();
      expect(state.snapshotsLoadingByThread["thread-1"]).toBeUndefined();
      expect(state.commitsByThread["thread-1"]).toBeUndefined();
      expect(state.commitsLoadingByThread["thread-1"]).toBeUndefined();
    });

    it("should not affect other threads", () => {
      const { showRightPanel, setSnapshots, setSnapshotsLoading, setCommits, setCommitsLoading, clearThread, getRightPanel } =
        useDiffStore.getState();
      showRightPanel("thread-1");
      showRightPanel("thread-2");
      setSnapshots("thread-1", [{ id: "s1" } as never]);
      setSnapshots("thread-2", [{ id: "s2" } as never]);
      setSnapshotsLoading("thread-2", true);
      setCommits("thread-2", [{ sha: "c2" } as never]);
      setCommitsLoading("thread-2", true);

      clearThread("thread-1");

      const state = useDiffStore.getState();
      expect(getRightPanel("thread-2").visible).toBe(true);
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

});
