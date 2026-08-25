import { describe, it, expect, beforeEach, vi } from "vitest";
import type { BranchComparison, GitBranch } from "@mcode/contracts";
import type { RightPanelState } from "../stores/diffStore";
import {
  useDiffStore,
  PANEL_MIN_WIDTH,
  COMPOSER_MIN_WIDTH,
  PANEL_SPLIT_GAP_PX,
  maxPanelWidthInSplit,
  getDefaultPanelWidthPx,
  createDefaultRightPanelState,
  createRightPanelState,
  DEFAULT_LINE_WRAP,
} from "../stores/diffStore";

describe("diffStore", () => {
  beforeEach(() => {
    useDiffStore.setState({
      previewUrlByThread: {},
      rightPanelByThread: {},
      rightPanelFallbackByWorkspace: {},
      subagentRosterTabByThread: {},
      subagentDetailByThread: {},
      subagentReviewScopeByThread: {},
      reviewFilesVisibleByScope: {},
      snapshotsByThread: {},
      snapshotsLoadingByThread: {},
      snapshotsPendingByThread: {},
      commitsByThread: {},
      commitsLoadingByThread: {},
      selectedFile: null,
      diffContent: null,
      diffLoading: false,
      viewMode: "last-turn",
      reviewViewByThread: {},
      reviewViewManuallySelectedByThread: {},
      selectedCommitSha: null,
      renderMode: "unified",
      lineWrapByThread: {},
      inlineDiffCache: {},
      diffRevisionByScope: {},
      branchComparison: null,
      branchComparisonKey: null,
      branchManuallySelectedByScope: {},
      branchResolvedRevisionByScope: {},
    });
  });

  describe("Review Files visibility", () => {
    it("starts closed per scope and persists only explicit choices", () => {
      const store = useDiffStore.getState();

      expect(store.getReviewFilesVisible("thread-1")).toBe(false);
      store.setReviewFilesVisible("thread-1", true);

      expect(useDiffStore.getState().getReviewFilesVisible("thread-1")).toBe(true);
      expect(useDiffStore.getState().getReviewFilesVisible("thread-2")).toBe(false);
      expect(localStorage.getItem("mcode.review-files-visible.v1")).toContain('"thread-1":true');
    });
  });

  describe("subagent Review scope", () => {
    const scope = {
      label: "Explorer",
      paths: ["src/a.ts", "src/a.ts", "src/b.ts"],
      additions: 4,
      deletions: 1,
    } as const;

    it("bounds and deduplicates paths per thread without leaking to siblings", () => {
      useDiffStore.getState().setSubagentReviewScope("thread-1", scope);

      expect(useDiffStore.getState().subagentReviewScopeByThread["thread-1"]).toEqual({
        ...scope,
        paths: ["src/a.ts", "src/b.ts"],
      });
      expect(useDiffStore.getState().subagentReviewScopeByThread["thread-2"]).toBeUndefined();
    });

    it("replaces a valid scope immediately and clears it when replacement paths normalize empty", () => {
      const store = useDiffStore.getState();
      store.setSubagentReviewScope("thread-1", scope);
      store.setSubagentReviewScope("thread-1", {
        label: "Reviewer",
        paths: ["src/review.ts"],
        additions: 2,
        deletions: 0,
      });
      expect(useDiffStore.getState().subagentReviewScopeByThread["thread-1"]).toMatchObject({
        label: "Reviewer",
        paths: ["src/review.ts"],
      });

      useDiffStore.getState().setSubagentReviewScope("thread-1", {
        label: "Empty",
        paths: ["", "   "],
        additions: 0,
        deletions: 0,
      });
      expect(useDiffStore.getState().subagentReviewScopeByThread["thread-1"]).toBeUndefined();
    });

    it("preserves scope while focusing or refocusing Changes", () => {
      const store = useDiffStore.getState();
      store.setSubagentReviewScope("thread-1", scope);
      store.setRightPanelTab("workspace-1", "thread-1", "changes");
      store.setRightPanelTab("workspace-1", "thread-1", "changes");
      expect(useDiffStore.getState().subagentReviewScopeByThread["thread-1"]).toEqual({
        ...scope,
        paths: ["src/a.ts", "src/b.ts"],
      });
    });

    it("clears on ordinary Review navigation and thread deletion", () => {
      useDiffStore.getState().setSubagentReviewScope("thread-1", scope);
      useDiffStore.getState().setReviewViewForThread("thread-1", "cumulative");
      expect(useDiffStore.getState().subagentReviewScopeByThread["thread-1"]).toBeUndefined();

      useDiffStore.getState().setSubagentReviewScope("thread-1", scope);
      useDiffStore.getState().clearThread("thread-1");
      expect(useDiffStore.getState().subagentReviewScopeByThread["thread-1"]).toBeUndefined();
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

  describe("per-thread Review view default + sticky override", () => {
    const clean = { hasTurnChanges: false, isDirty: false } as const;

    it("resolves the change-state default until the user picks a view", () => {
      const { getReviewView } = useDiffStore.getState();
      expect(getReviewView("thread-1", { hasTurnChanges: true, isDirty: false })).toBe("last-turn");
      expect(getReviewView("thread-1", { hasTurnChanges: false, isDirty: true })).toBe("unstaged");
      expect(getReviewView("thread-1", clean)).toBe("branch");
    });

    it("re-evaluates live as change state changes while no pick is made", () => {
      const { getReviewView } = useDiffStore.getState();
      expect(getReviewView("thread-1", clean)).toBe("branch");
      expect(getReviewView("thread-1", { hasTurnChanges: true, isDirty: false })).toBe("last-turn");
    });

    it("sticks to the user's pick and stops re-evaluating change state", () => {
      const { setReviewViewForThread, getReviewView } = useDiffStore.getState();
      setReviewViewForThread("thread-1", "cumulative");
      expect(useDiffStore.getState().viewMode).toBe("cumulative");
      expect(getReviewView("thread-1", { hasTurnChanges: true, isDirty: true })).toBe("cumulative");
    });

    it("keeps the override per thread — a sibling keeps its own default", () => {
      const { setReviewViewForThread, getReviewView } = useDiffStore.getState();
      setReviewViewForThread("thread-1", "staged");
      expect(getReviewView("thread-1", { hasTurnChanges: true, isDirty: false })).toBe("staged");
      expect(getReviewView("thread-2", { hasTurnChanges: true, isDirty: false })).toBe("last-turn");
    });

    it("drops both the picked view and the override flag on clearThread", () => {
      const { setReviewViewForThread, clearThread, getReviewView } = useDiffStore.getState();
      setReviewViewForThread("thread-1", "staged");
      clearThread("thread-1");
      const state = useDiffStore.getState();
      expect(state.reviewViewByThread["thread-1"]).toBeUndefined();
      expect(state.reviewViewManuallySelectedByThread["thread-1"]).toBeUndefined();
      expect(getReviewView("thread-1", clean)).toBe("branch");
    });

    it("clearThread leaves a sibling thread's override intact", () => {
      const { setReviewViewForThread, clearThread, getReviewView } = useDiffStore.getState();
      setReviewViewForThread("thread-1", "staged");
      setReviewViewForThread("thread-2", "branch");
      clearThread("thread-1");
      expect(getReviewView("thread-2", { hasTurnChanges: true, isDirty: false })).toBe("branch");
    });
  });

  // The Branch comparison operand must survive a turn-driven re-resolve. A
  // `files.changed`/`turn.persisted` event bumps the scope revision, which
  // re-fetches the server default; without the sticky guard that fetch would
  // clobber the user's picked target. See ADR-0007.
  describe("sticky Branch comparison operand", () => {
    const ref = (name: string, isCurrent = false): GitBranch => ({
      name,
      shortSha: "abc1234",
      type: name.startsWith("origin/") ? "remote" : "local",
      isCurrent,
    });
    const comparison = (target: string | null): BranchComparison => ({
      base: "feature",
      target,
      refs: [ref("feature", true), ref("main"), ref("origin/main")],
      isUnborn: false,
      isComparisonAvailable: true,
    });
    const key = "ws-1:thread-1";

    it("records the resolved revision and seeds the comparison for a scope", () => {
      const { resolveBranchComparison } = useDiffStore.getState();
      resolveBranchComparison(comparison("main"), key, 3);
      const state = useDiffStore.getState();
      expect(state.branchComparison?.target).toBe("main");
      expect(state.branchComparisonKey).toBe(key);
      expect(state.branchResolvedRevisionByScope[key]).toBe(3);
    });

    it("preserves a manual target pick across a revision-bump re-resolve", () => {
      const { resolveBranchComparison, setBranchTarget } = useDiffStore.getState();
      resolveBranchComparison(comparison("main"), key, 1);
      setBranchTarget("origin/main"); // user picks a different ref

      // A turn re-resolves the server default (target "main") at a new revision.
      resolveBranchComparison(comparison("main"), key, 2);

      const state = useDiffStore.getState();
      expect(state.branchComparison?.target).toBe("origin/main");
      expect(state.branchResolvedRevisionByScope[key]).toBe(2);
    });

    it("falls back to the server default when the picked ref no longer exists", () => {
      const { resolveBranchComparison, setBranchTarget } = useDiffStore.getState();
      resolveBranchComparison(comparison("main"), key, 1);
      setBranchTarget("origin/main");

      // The picked ref is gone from the freshly resolved set (e.g. branch deleted).
      const withoutOrigin: BranchComparison = {
        ...comparison("main"),
        refs: [ref("feature", true), ref("main")],
      };
      resolveBranchComparison(withoutOrigin, key, 2);

      expect(useDiffStore.getState().branchComparison?.target).toBe("main");
    });

    it("does not preserve a pick across a scope change", () => {
      const { resolveBranchComparison, setBranchTarget } = useDiffStore.getState();
      resolveBranchComparison(comparison("main"), key, 1);
      setBranchTarget("origin/main");

      // A different scope resolves fresh — the prior scope's pick must not leak.
      resolveBranchComparison(comparison("main"), "ws-1:thread-2", 1);

      expect(useDiffStore.getState().branchComparison?.target).toBe("main");
    });

    it("drops the scope's sticky state on clearThread", () => {
      const { resolveBranchComparison, setBranchTarget, clearThread } = useDiffStore.getState();
      resolveBranchComparison(comparison("main"), key, 1);
      setBranchTarget("origin/main");

      clearThread("thread-1");

      const state = useDiffStore.getState();
      expect(state.branchManuallySelectedByScope[key]).toBeUndefined();
      expect(state.branchResolvedRevisionByScope[key]).toBeUndefined();
    });

    it("drops the scope's sticky state on clearWorkspace", () => {
      const { resolveBranchComparison, setBranchTarget, clearWorkspace } = useDiffStore.getState();
      resolveBranchComparison(comparison("main"), key, 1);
      setBranchTarget("origin/main");

      clearWorkspace("ws-1");

      const state = useDiffStore.getState();
      expect(state.branchManuallySelectedByScope[key]).toBeUndefined();
      expect(state.branchResolvedRevisionByScope[key]).toBeUndefined();
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

  describe("diff revisions", () => {
    it("increments per mutable diff scope", () => {
      const { bumpDiffRevision } = useDiffStore.getState();
      bumpDiffRevision("thread-1");
      bumpDiffRevision("thread-1");
      bumpDiffRevision("workspace-1");

      expect(useDiffStore.getState().diffRevisionByScope["thread-1"]).toBe(2);
      expect(useDiffStore.getState().diffRevisionByScope["workspace-1"]).toBe(1);
    });

    it("evicts inline diff cache entries for the refreshed mutable scope", () => {
      const { cacheInlineDiff, bumpDiffRevision } = useDiffStore.getState();
      cacheInlineDiff("thread-1", "branch", "origin/main...feat/x", "src/a.ts", "diff-a");
      cacheInlineDiff("thread-2", "branch", "origin/main...feat/y", "src/b.ts", "diff-b");

      bumpDiffRevision("thread-1");

      const state = useDiffStore.getState();
      expect(state.inlineDiffCache["thread-1:branch:origin/main...feat/x:src/a.ts"]).toBeUndefined();
      expect(state.inlineDiffCache["thread-2:branch:origin/main...feat/y:src/b.ts"]).toBe("diff-b");
    });

    it("evicts cumulative inline diff cache when snapshots refresh", () => {
      const { cacheInlineDiff, setSnapshots } = useDiffStore.getState();
      cacheInlineDiff("thread-1", "cumulative", "thread-1", "src/a.ts", "old");
      cacheInlineDiff("thread-1", "snapshot", "s1", "src/a.ts", "snapshot");

      setSnapshots("thread-1", []);

      const state = useDiffStore.getState();
      expect(state.inlineDiffCache["thread-1:cumulative:thread-1:src/a.ts"]).toBeUndefined();
      expect(state.inlineDiffCache["thread-1:snapshot:s1:src/a.ts"]).toBe("snapshot");
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
      setRightPanelWidth("ws-1", null, 500);
      showRightPanel("ws-1");
      const panel = getRightPanel("ws-1");
      expect(panel.visible).toBe(true);
      expect(panel.width).toBe(500);
    });

    it("hideRightPanel sets visible false without affecting tab", () => {
      const { showRightPanel, hideRightPanel, setRightPanelTab, getRightPanel } = useDiffStore.getState();
      showRightPanel("ws-1");
      setRightPanelTab("ws-1", null, "changes");
      hideRightPanel("ws-1");
      const panel = getRightPanel("ws-1");
      expect(panel.visible).toBe(false);
      expect(panel.activeTab).toBe("changes");
    });
  });

  describe("setRightPanelWidth", () => {
    it("should update width for one workspace", () => {
      const { setRightPanelWidth, getRightPanel } = useDiffStore.getState();
      setRightPanelWidth("ws-1", null, 500);
      expect(getRightPanel("ws-1").width).toBe(500);
      expect(getRightPanel("ws-2").width).toBe(getDefaultPanelWidthPx());
    });

    it("should clamp width to PANEL_MIN_WIDTH", () => {
      const { setRightPanelWidth, getRightPanel } = useDiffStore.getState();
      setRightPanelWidth("ws-1", null, 100);
      expect(getRightPanel("ws-1").width).toBe(PANEL_MIN_WIDTH);
    });

    it("preserves store identity when the effective width and source are unchanged", () => {
      const { setRightPanelWidth } = useDiffStore.getState();
      setRightPanelWidth("ws-1", null, 500, "user");
      const previousState = useDiffStore.getState();
      const subscriber = vi.fn();
      const unsubscribe = useDiffStore.subscribe(subscriber);

      setRightPanelWidth("ws-1", null, 500, "user");

      expect(useDiffStore.getState()).toBe(previousState);
      expect(subscriber).not.toHaveBeenCalled();
      unsubscribe();
    });
  });

  describe("maxPanelWidthInSplit", () => {
    it("reserves composer min width from the row width", () => {
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
    it("interleaves PTY-backed terminal instances with singleton tabs", () => {
      const { addRightPanelTerminalTab, setRightPanelTab, getRightPanel } = useDiffStore.getState();
      setRightPanelTab("ws-1", "thread-1", "preview");
      addRightPanelTerminalTab("ws-1", "thread-1", "pty-1");
      setRightPanelTab("ws-1", "thread-1", "changes");
      addRightPanelTerminalTab("ws-1", "thread-1", "pty-2");

      const panel = getRightPanel("ws-1", "thread-1");
      expect(panel.tabInstances.map((instance) => instance.id)).toEqual([
        "singleton:preview",
        "terminal:pty-1",
        "singleton:changes",
        "terminal:pty-2",
      ]);
      expect(panel.activeTabId).toBe("terminal:pty-2");
    });

    it("replaces a pending terminal singleton with its PTY-backed instance", () => {
      const { addRightPanelTerminalTab, setRightPanelTab, getRightPanel } =
        useDiffStore.getState();
      setRightPanelTab("ws-1", "thread-1", "terminal");

      addRightPanelTerminalTab("ws-1", "thread-1", "pty-1");

      expect(getRightPanel("ws-1", "thread-1")).toMatchObject({
        tabInstances: [{ id: "terminal:pty-1", type: "terminal" }],
        activeTabId: "terminal:pty-1",
      });
    });

    it("retains one Action terminal identity in the background until its running Action is selected", () => {
      const {
        ensureRightPanelActionTerminalTab,
        setRightPanelTab,
        setRightPanelTabInstance,
        getRightPanel,
      } = useDiffStore.getState();
      setRightPanelTab("ws-1", "thread-1", "preview");

      ensureRightPanelActionTerminalTab("ws-1", "thread-1", "build");
      ensureRightPanelActionTerminalTab("ws-1", "thread-1", "build");

      expect(getRightPanel("ws-1", "thread-1")).toMatchObject({
        activeTabId: "singleton:preview",
        tabInstances: [
          { id: "singleton:preview", type: "preview" },
          { id: "action-terminal:build", type: "action-terminal" },
        ],
      });

      setRightPanelTabInstance("ws-1", "thread-1", "action-terminal:build");
      expect(getRightPanel("ws-1", "thread-1").activeTabId).toBe("action-terminal:build");
    });
    it("preserves an explicit canonical null over a stale compatibility active tab", () => {
      const panel = createRightPanelState({
        visible: true,
        width: 500,
        tabInstances: [{ id: "singleton:changes", type: "changes" }],
        activeTabId: null,
        activeTab: "changes",
      });

      expect(panel.activeTabId).toBeNull();
      expect(panel.activeTab).toBe("tasks");
      expect(panel.openTabs).toEqual(["changes"]);
    });

    it("normalizes conflicting fallback and thread records from canonical instance state", () => {
      const conflictingFallback = {
        ...createDefaultRightPanelState(),
        visible: true,
        tabInstances: [{ id: "singleton:changes", type: "changes" }] as const,
        activeTabId: "singleton:changes",
        openTabs: [] as const,
        activeTab: "tasks" as const,
      } satisfies RightPanelState;
      const conflictingThread = {
        ...createDefaultRightPanelState(),
        visible: true,
        tabInstances: [{ id: "singleton:terminal", type: "terminal" }] as const,
        activeTabId: "singleton:terminal",
        openTabs: ["preview"] as const,
        activeTab: "preview" as const,
      } satisfies RightPanelState;
      useDiffStore.setState({
        rightPanelFallbackByWorkspace: { "ws-1": conflictingFallback },
        rightPanelByThread: { "thread-1": conflictingThread },
      });

      const { getRightPanel } = useDiffStore.getState();
      expect(getRightPanel("ws-1", "thread-untouched")).toMatchObject({
        tabInstances: [{ id: "singleton:changes", type: "changes" }],
        activeTabId: "singleton:changes",
        openTabs: ["changes"],
        activeTab: "changes",
      });
      expect(getRightPanel("ws-1", "thread-1")).toMatchObject({
        tabInstances: [{ id: "singleton:terminal", type: "terminal" }],
        activeTabId: "singleton:terminal",
        openTabs: ["terminal"],
        activeTab: "terminal",
      });
    });

    it("should update active tab for one workspace only", () => {
      const { setRightPanelTab, getRightPanel } = useDiffStore.getState();
      setRightPanelTab("ws-1", null, "changes");
      expect(getRightPanel("ws-1").activeTab).toBe("changes");
      expect(getRightPanel("ws-2").activeTab).toBe("tasks");
    });

    it("should support preview tab", () => {
      const { setRightPanelTab, getRightPanel } = useDiffStore.getState();
      setRightPanelTab("ws-1", null, "preview");
      expect(getRightPanel("ws-1").activeTab).toBe("preview");
    });

    it("defaults to no open tabs (empty-state card grid)", () => {
      const { getRightPanel } = useDiffStore.getState();
      expect(getRightPanel("ws-fresh").openTabs).toEqual([]);
    });

    it("opens a tab (adds it to openTabs) when first activated", () => {
      const { setRightPanelTab, getRightPanel } = useDiffStore.getState();
      setRightPanelTab("ws-1", null, "preview");
      expect(getRightPanel("ws-1").openTabs).toEqual(["preview"]);
      expect(getRightPanel("ws-1").activeTab).toBe("preview");
    });

    it("accumulates open tabs in open order without duplicating", () => {
      const { setRightPanelTab, getRightPanel } = useDiffStore.getState();
      setRightPanelTab("ws-1", null, "preview");
      setRightPanelTab("ws-1", null, "terminal");
      setRightPanelTab("ws-1", null, "preview"); // refocus, not reopen
      expect(getRightPanel("ws-1").openTabs).toEqual(["preview", "terminal"]);
      expect(getRightPanel("ws-1").activeTab).toBe("preview");
    });

    it("creates deterministic singleton instances in insertion order", () => {
      const { setRightPanelTab, getRightPanel } = useDiffStore.getState();
      setRightPanelTab("ws-1", null, "terminal");
      setRightPanelTab("ws-1", null, "preview");
      setRightPanelTab("ws-1", null, "changes");

      expect(getRightPanel("ws-1").tabInstances).toEqual([
        { id: "singleton:terminal", type: "terminal" },
        { id: "singleton:preview", type: "preview" },
        { id: "singleton:changes", type: "changes" },
      ]);
      expect(getRightPanel("ws-1").activeTabId).toBe("singleton:changes");
    });

    it("selects a repeatable tab by stable instance identity", () => {
      useDiffStore.setState({
        rightPanelFallbackByWorkspace: {
          "ws-1": {
            ...useDiffStore.getState().getRightPanel("ws-1"),
            tabInstances: [
              { id: "terminal:first", type: "terminal" },
              { id: "terminal:second", type: "terminal" },
            ],
            activeTabId: "terminal:first",
          },
        },
      });

      const { setRightPanelTabInstance, getRightPanel } = useDiffStore.getState();
      setRightPanelTabInstance("ws-1", null, "terminal:second");

      expect(getRightPanel("ws-1").activeTabId).toBe("terminal:second");
      expect(getRightPanel("ws-1").tabInstances).toEqual([
        { id: "terminal:first", type: "terminal" },
        { id: "terminal:second", type: "terminal" },
      ]);
    });
  });

  describe("reorderRightPanelTab", () => {
    it("moves instances without regrouping types and stops at boundaries", () => {
      const { setRightPanelTab, reorderRightPanelTab, getRightPanel } =
        useDiffStore.getState();
      setRightPanelTab("ws-1", null, "terminal");
      setRightPanelTab("ws-1", null, "preview");
      setRightPanelTab("ws-1", null, "changes");

      reorderRightPanelTab("ws-1", null, "singleton:changes", -1);
      expect(getRightPanel("ws-1").openTabs).toEqual([
        "terminal",
        "changes",
        "preview",
      ]);

      reorderRightPanelTab("ws-1", null, "singleton:terminal", -1);
      expect(getRightPanel("ws-1").openTabs).toEqual([
        "terminal",
        "changes",
        "preview",
      ]);
    });

    it("keeps thread and workspace fallback non-Terminal order independent", () => {
      const { setRightPanelTab, reorderRightPanelTab, getRightPanel } =
        useDiffStore.getState();
      for (const tab of ["terminal", "preview", "changes"] as const) {
        setRightPanelTab("ws-1", null, tab);
      }
      // ADR-0020 keeps workspace Terminal instances out of an untouched
      // thread, so reorder the surviving non-Terminal tabs in that scope.
      reorderRightPanelTab("ws-1", "thread-1", "singleton:changes", -1);

      expect(getRightPanel("ws-1", "thread-1").openTabs).toEqual([
        "changes",
        "preview",
      ]);
      expect(getRightPanel("ws-1").openTabs).toEqual([
        "terminal",
        "preview",
        "changes",
      ]);
    });
  });

  describe("closeRightPanelTab", () => {
    it("removes a tab from the open set", () => {
      const { setRightPanelTab, closeRightPanelTab, getRightPanel } = useDiffStore.getState();
      setRightPanelTab("ws-1", null, "preview");
      setRightPanelTab("ws-1", null, "terminal");
      closeRightPanelTab("ws-1", null, "preview");
      expect(getRightPanel("ws-1").openTabs).toEqual(["terminal"]);
    });

    it("moves focus to the most-recently-opened survivor when the active tab closes", () => {
      const { setRightPanelTab, closeRightPanelTab, getRightPanel } = useDiffStore.getState();
      setRightPanelTab("ws-1", null, "preview");
      setRightPanelTab("ws-1", null, "terminal"); // terminal is active
      closeRightPanelTab("ws-1", null, "terminal");
      expect(getRightPanel("ws-1").openTabs).toEqual(["preview"]);
      expect(getRightPanel("ws-1").activeTab).toBe("preview");
    });

    it("selects the item now at the removed index, then the previous item", () => {
      const {
        setRightPanelTab,
        closeRightPanelTabInstance,
        getRightPanel,
      } = useDiffStore.getState();
      setRightPanelTab("ws-1", null, "terminal");
      setRightPanelTab("ws-1", null, "preview");
      setRightPanelTab("ws-1", null, "changes");
      setRightPanelTab("ws-1", null, "preview");

      closeRightPanelTabInstance("ws-1", null, "singleton:preview");
      expect(getRightPanel("ws-1").activeTabId).toBe("singleton:changes");

      closeRightPanelTabInstance("ws-1", null, "singleton:changes");
      expect(getRightPanel("ws-1").activeTabId).toBe("singleton:terminal");
    });

    it("leaves the active tab unchanged when closing an inactive tab", () => {
      const { setRightPanelTab, closeRightPanelTab, getRightPanel } = useDiffStore.getState();
      setRightPanelTab("ws-1", null, "preview");
      setRightPanelTab("ws-1", null, "terminal"); // terminal is active
      closeRightPanelTab("ws-1", null, "preview");
      expect(getRightPanel("ws-1").activeTab).toBe("terminal");
    });

    it("empties the open set when the last tab closes (returns to card grid)", () => {
      const { setRightPanelTab, closeRightPanelTab, getRightPanel } = useDiffStore.getState();
      setRightPanelTab("ws-1", null, "preview");
      closeRightPanelTab("ws-1", null, "preview");
      expect(getRightPanel("ws-1").openTabs).toEqual([]);
    });

    it("is a no-op when the tab is not open", () => {
      const { setRightPanelTab, closeRightPanelTab, getRightPanel } = useDiffStore.getState();
      setRightPanelTab("ws-1", null, "preview");
      closeRightPanelTab("ws-1", null, "terminal");
      expect(getRightPanel("ws-1").openTabs).toEqual(["preview"]);
      expect(getRightPanel("ws-1").activeTab).toBe("preview");
    });

    it("affects only the target workspace", () => {
      const { setRightPanelTab, closeRightPanelTab, getRightPanel } = useDiffStore.getState();
      setRightPanelTab("ws-1", null, "preview");
      setRightPanelTab("ws-2", null, "preview");
      closeRightPanelTab("ws-1", null, "preview");
      expect(getRightPanel("ws-1").openTabs).toEqual([]);
      expect(getRightPanel("ws-2").openTabs).toEqual(["preview"]);
    });
  });

  // The threadless Browser/Terminal shell writes to one workspace-level fallback
  // record, which must survive having no thread active and persist across
  // navigation. See ADR-0020.
  describe("workspace fallback (threadless shell)", () => {
    it("retains visibility, width, and tab with no active thread", () => {
      const { showRightPanel, setRightPanelWidth, setRightPanelTab, getRightPanel } =
        useDiffStore.getState();
      showRightPanel("ws-1");
      setRightPanelWidth("ws-1", null, 460);
      setRightPanelTab("ws-1", null, "preview");

      const panel = getRightPanel("ws-1");
      expect(panel.visible).toBe(true);
      expect(panel.width).toBe(460);
      expect(panel.activeTab).toBe("preview");
    });

    it("writes threadless changes to the workspace fallback, never a thread record", () => {
      const { showRightPanel, setRightPanelTab } = useDiffStore.getState();
      showRightPanel("ws-1");
      setRightPanelTab("ws-1", null, "preview");

      const state = useDiffStore.getState();
      expect(state.rightPanelFallbackByWorkspace["ws-1"].visible).toBe(true);
      expect(state.rightPanelByThread).toEqual({});
    });

    it("keeps the fallback record when a thread is cleared", () => {
      const { showRightPanel, setRightPanelTab, clearThread, getRightPanel } =
        useDiffStore.getState();
      showRightPanel("ws-1");
      setRightPanelTab("ws-1", null, "changes");

      // Clearing a thread drops only that thread's record, not the fallback.
      clearThread("thread-1");

      const panel = getRightPanel("ws-1");
      expect(panel.visible).toBe(true);
      expect(panel.activeTab).toBe("changes");
    });
  });

  // The whole panel record is per-thread, read copy-on-write: a thread inherits
  // scope-neutral workspace fallback state until it writes its own entry, then
  // diverges. See ADR-0012 and ADR-0020.
  describe("per-thread panel state with workspace fallback (ADR-0012/0020)", () => {
    it("getRightPanelVisible defaults to closed for an unknown thread", () => {
      const { getRightPanelVisible } = useDiffStore.getState();
      expect(getRightPanelVisible("ws-1", "thread-1")).toBe(false);
    });

    it("showRightPanel with a thread opens only that thread", () => {
      const { showRightPanel, getRightPanelVisible } = useDiffStore.getState();
      showRightPanel("ws-1", "thread-1");
      expect(getRightPanelVisible("ws-1", "thread-1")).toBe(true);
      // thread-2 has no record and the fallback is closed, so it stays closed.
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

    it("an uncustomized thread inherits the workspace fallback record", () => {
      const { showRightPanel, setRightPanelWidth, setRightPanelTab, getRightPanel } =
        useDiffStore.getState();
      // Seed the fallback through the threadless shell.
      showRightPanel("ws-1");
      setRightPanelWidth("ws-1", null, 540);
      setRightPanelTab("ws-1", null, "preview");

      // A thread that has never written reads scope-neutral fallback state.
      const panel = getRightPanel("ws-1", "thread-untouched");
      expect(panel.visible).toBe(true);
      expect(panel.width).toBe(540);
      expect(panel.activeTab).toBe("preview");
    });

    it("does not leak workspace Terminal instances into an untouched thread or its first write", () => {
      const {
        showRightPanel,
        setRightPanelWidth,
        setRightPanelTab,
        addRightPanelTerminalTab,
        getRightPanel,
      } = useDiffStore.getState();
      showRightPanel("ws-1");
      setRightPanelWidth("ws-1", null, 540, "user");
      setRightPanelTab("ws-1", null, "preview");
      addRightPanelTerminalTab("ws-1", null, "workspace-pty-1");
      setRightPanelTab("ws-1", null, "changes");
      addRightPanelTerminalTab("ws-1", null, "workspace-pty-2");

      const untouched = getRightPanel("ws-1", "thread-untouched");
      expect(untouched).toMatchObject({
        visible: true,
        width: 540,
        widthSource: "user",
        tabInstances: [
          { id: "singleton:preview", type: "preview" },
          { id: "singleton:changes", type: "changes" },
        ],
        activeTabId: "singleton:changes",
        activeTab: "changes",
      });

      addRightPanelTerminalTab("ws-1", "thread-untouched", "thread-pty");

      expect(getRightPanel("ws-1", "thread-untouched").tabInstances).toEqual([
        { id: "singleton:preview", type: "preview" },
        { id: "singleton:changes", type: "changes" },
        { id: "terminal:thread-pty", type: "terminal" },
      ]);
      expect(getRightPanel("ws-1", "thread-untouched").activeTabId).toBe("terminal:thread-pty");
      expect(getRightPanel("ws-1").tabInstances).toEqual([
        { id: "singleton:preview", type: "preview" },
        { id: "terminal:workspace-pty-1", type: "terminal" },
        { id: "singleton:changes", type: "changes" },
        { id: "terminal:workspace-pty-2", type: "terminal" },
      ]);
    });

    it("chooses the nearest surviving right tab when an inherited Terminal is active", () => {
      useDiffStore.setState({
        rightPanelFallbackByWorkspace: {
          "ws-1": createRightPanelState({
            visible: true,
            width: 440,
            tabInstances: [
              { id: "singleton:preview", type: "preview" },
              { id: "terminal:workspace-pty", type: "terminal" },
              { id: "singleton:changes", type: "changes" },
            ],
            activeTabId: "terminal:workspace-pty",
          }),
        },
      });

      expect(useDiffStore.getState().getRightPanel("ws-1", "thread-1")).toMatchObject({
        openTabs: ["preview", "changes"],
        activeTabId: "singleton:changes",
        activeTab: "changes",
      });
    });

    it("chooses the nearest surviving left tab when no right tab remains", () => {
      useDiffStore.setState({
        rightPanelFallbackByWorkspace: {
          "ws-1": createRightPanelState({
            visible: true,
            width: 440,
            tabInstances: [
              { id: "singleton:preview", type: "preview" },
              { id: "terminal:workspace-pty", type: "terminal" },
            ],
            activeTabId: "terminal:workspace-pty",
          }),
        },
      });

      expect(useDiffStore.getState().getRightPanel("ws-1", "thread-1")).toMatchObject({
        openTabs: ["preview"],
        activeTabId: "singleton:preview",
        activeTab: "preview",
      });
    });

    it("clears active selection when an inherited panel contains only Terminals", () => {
      useDiffStore.setState({
        rightPanelFallbackByWorkspace: {
          "ws-1": createRightPanelState({
            visible: true,
            width: 440,
            tabInstances: [
              { id: "terminal:workspace-pty-1", type: "terminal" },
              { id: "terminal:workspace-pty-2", type: "terminal" },
            ],
            activeTabId: "terminal:workspace-pty-2",
          }),
        },
      });

      expect(useDiffStore.getState().getRightPanel("ws-1", "thread-1")).toMatchObject({
        openTabs: [],
        activeTabId: null,
        activeTab: "tasks",
      });
    });

    it("preserves the order and active Terminal of an existing thread-owned record", () => {
      useDiffStore.setState({
        rightPanelByThread: {
          "thread-1": createRightPanelState({
            visible: true,
            width: 440,
            tabInstances: [
              { id: "terminal:thread-pty-1", type: "terminal" },
              { id: "singleton:changes", type: "changes" },
              { id: "terminal:thread-pty-2", type: "terminal" },
            ],
            activeTabId: "terminal:thread-pty-2",
          }),
        },
        rightPanelFallbackByWorkspace: {
          "ws-1": createRightPanelState({
            visible: true,
            width: 440,
            tabInstances: [{ id: "terminal:workspace-pty", type: "terminal" }],
            activeTabId: "terminal:workspace-pty",
          }),
        },
      });

      expect(useDiffStore.getState().getRightPanel("ws-1", "thread-1")).toMatchObject({
        tabInstances: [
          { id: "terminal:thread-pty-1", type: "terminal" },
          { id: "singleton:changes", type: "changes" },
          { id: "terminal:thread-pty-2", type: "terminal" },
        ],
        activeTabId: "terminal:thread-pty-2",
        activeTab: "terminal",
      });
    });

    it("a thread diverges into its own record on first write, leaving the fallback intact", () => {
      const { setRightPanelWidth, getRightPanel } = useDiffStore.getState();
      setRightPanelWidth("ws-1", null, 540); // seed the fallback
      setRightPanelWidth("ws-1", "thread-1", 700); // thread-1 diverges

      expect(getRightPanel("ws-1", "thread-1").width).toBe(700);
      // The fallback is untouched, so the threadless shell and a sibling thread
      // both still read 540.
      expect(getRightPanel("ws-1").width).toBe(540);
      expect(getRightPanel("ws-1", "thread-2").width).toBe(540);
    });

    it("keeps per-thread records independent across threads", () => {
      const { setRightPanelTab, getRightPanel } = useDiffStore.getState();
      setRightPanelTab("ws-1", "thread-1", "preview");
      setRightPanelTab("ws-1", "thread-2", "changes");
      expect(getRightPanel("ws-1", "thread-1").activeTab).toBe("preview");
      expect(getRightPanel("ws-1", "thread-2").activeTab).toBe("changes");
    });

    it("opening a thread does not open the threadless shell", () => {
      const { showRightPanel, getRightPanelVisible } = useDiffStore.getState();
      showRightPanel("ws-1", "thread-1");
      // The threadless shell reads the fallback, which is still closed.
      expect(getRightPanelVisible("ws-1")).toBe(false);
    });

    it("clearThread drops the thread's whole panel record", () => {
      const { showRightPanel, setRightPanelTab, clearThread, getRightPanelVisible } =
        useDiffStore.getState();
      showRightPanel("ws-1", "thread-1");
      setRightPanelTab("ws-1", "thread-1", "preview");
      clearThread("thread-1");
      expect(getRightPanelVisible("ws-1", "thread-1")).toBe(false);
      expect(useDiffStore.getState().rightPanelByThread["thread-1"]).toBeUndefined();
    });
  });

  // Copy-on-write divergence timing: a thread inherits the fallback *live* until
  // its first write, then snapshots and stops tracking it. See ADR-0020.
  describe("copy-on-write divergence timing (ADR-0012/0020)", () => {
    it("an undiverged thread tracks later fallback edits without Terminal instances", () => {
      const { setRightPanelTab, getRightPanel } = useDiffStore.getState();
      setRightPanelTab("ws-1", null, "preview");
      expect(getRightPanel("ws-1", "thread-1").activeTab).toBe("preview");

      // The thread has still not written, so a later fallback edit is reflected.
      setRightPanelTab("ws-1", null, "terminal");
      expect(getRightPanel("ws-1", "thread-1").activeTab).toBe("preview");
      expect(getRightPanel("ws-1", "thread-1").tabInstances).toEqual([
        { id: "singleton:preview", type: "preview" },
      ]);
      expect(useDiffStore.getState().rightPanelByThread["thread-1"]).toBeUndefined();
    });

    it("a diverged thread is frozen from later fallback edits", () => {
      const { setRightPanelTab, setRightPanelWidth, getRightPanel } = useDiffStore.getState();
      setRightPanelTab("ws-1", null, "preview");
      // The first write diverges thread-1, snapshotting the fallback's tab.
      setRightPanelWidth("ws-1", "thread-1", 650);

      // A later fallback edit must not leak into the now-independent thread.
      setRightPanelTab("ws-1", null, "changes");
      const panel = getRightPanel("ws-1", "thread-1");
      expect(panel.activeTab).toBe("preview");
      expect(panel.width).toBe(650);
      expect(getRightPanel("ws-1").activeTab).toBe("changes");
    });

    it("opening a thread copies scope-neutral fallback state without Terminal instances", () => {
      const { setRightPanelWidth, setRightPanelTab, showRightPanel, getRightPanel } =
        useDiffStore.getState();
      setRightPanelWidth("ws-1", null, 520);
      setRightPanelTab("ws-1", null, "terminal");

      // Diverging via visibility inherits the fallback's width and tab.
      showRightPanel("ws-1", "thread-1");
      const panel = getRightPanel("ws-1", "thread-1");
      expect(panel.visible).toBe(true);
      expect(panel.width).toBe(520);
      expect(panel.openTabs).toEqual([]);
      expect(panel.activeTabId).toBeNull();
      // The fallback itself stays hidden.
      expect(getRightPanel("ws-1").visible).toBe(false);
    });

    it("treats threadId undefined and null alike as the threadless fallback", () => {
      const { setRightPanelTab, getRightPanel } = useDiffStore.getState();
      setRightPanelTab("ws-1", undefined, "preview");
      expect(getRightPanel("ws-1").activeTab).toBe("preview");
      setRightPanelTab("ws-1", null, "terminal");
      expect(getRightPanel("ws-1").activeTab).toBe("terminal");
      expect(useDiffStore.getState().rightPanelByThread).toEqual({});
    });
  });

  describe("clearWorkspace", () => {
    it("drops the fallback but keeps a diverged thread's record", () => {
      const { setRightPanelTab, clearWorkspace, getRightPanel } = useDiffStore.getState();
      setRightPanelTab("ws-1", null, "preview"); // fallback
      setRightPanelTab("ws-1", "thread-1", "changes"); // thread-1 diverged

      clearWorkspace("ws-1");

      // The fallback is gone, but the thread keeps its own record; an
      // uncustomized thread reverts to defaults.
      expect(useDiffStore.getState().rightPanelFallbackByWorkspace["ws-1"]).toBeUndefined();
      expect(getRightPanel("ws-1", "thread-1").activeTab).toBe("changes");
      expect(getRightPanel("ws-1", "thread-2")).toEqual(createDefaultRightPanelState());
    });

    it("removes the fallback record for the given workspace", () => {
      const { showRightPanel, setRightPanelTab, clearWorkspace, getRightPanel } =
        useDiffStore.getState();
      showRightPanel("ws-1");
      setRightPanelTab("ws-1", null, "preview");

      clearWorkspace("ws-1");

      expect(useDiffStore.getState().rightPanelFallbackByWorkspace["ws-1"]).toBeUndefined();
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
      expect(useDiffStore.getState().rightPanelFallbackByWorkspace["nope"]).toBeUndefined();
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

    it("does not notify subscribers when the url is unchanged", () => {
      const { setPreviewUrlForThread } = useDiffStore.getState();
      setPreviewUrlForThread("thread-1", "https://a.test");
      const previewUrls = useDiffStore.getState().previewUrlByThread;
      const subscriber = vi.fn();
      const unsubscribe = useDiffStore.subscribe(subscriber);

      setPreviewUrlForThread("thread-1", "https://a.test");

      unsubscribe();
      expect(useDiffStore.getState().previewUrlByThread).toBe(previewUrls);
      expect(subscriber).not.toHaveBeenCalled();
    });
  });

  describe("clearThread", () => {
    it("stores detail navigation per thread and clears it with the thread", () => {
      const { selectSubagentDetail, clearSubagentDetail, clearThread } = useDiffStore.getState();
      selectSubagentDetail("thread-1", { id: "agent-1", originTab: "active", scrollTop: 48 });
      selectSubagentDetail("thread-2", { id: "agent-2", originTab: "finished", scrollTop: 0 });

      clearSubagentDetail("thread-1");
      expect(useDiffStore.getState().subagentDetailByThread["thread-1"]).toBeUndefined();
      clearThread("thread-2");
      expect(useDiffStore.getState().subagentDetailByThread["thread-2"]).toBeUndefined();
    });

    it("keeps roster tabs isolated by thread and drops the deleted thread's choice", () => {
      const { setSubagentRosterTab, getSubagentRosterTab, clearThread } = useDiffStore.getState();
      setSubagentRosterTab("thread-1", "active");
      setSubagentRosterTab("thread-2", "finished");

      clearThread("thread-1");

      expect(getSubagentRosterTab("thread-1")).toBeUndefined();
      expect(getSubagentRosterTab("thread-2")).toBe("finished");
    });

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
