import { beforeEach, describe, expect, it } from "vitest";
import { setLayoutMeasurements } from "@/lib/composer-layout";
import {
  hideRightPanelAdaptive,
  showRightPanelAdaptive,
} from "@/lib/right-panel-layout";
import { useDiffStore } from "@/stores/diffStore";
import { useUiStore } from "@/stores/uiStore";

function resetDiffStore() {
  useDiffStore.setState({
    previewUrlByThread: {},
    rightPanelByThread: {},
    rightPanelFallbackByWorkspace: {},
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
}

function resetUiStore() {
  useUiStore.setState({
    sidebarCollapsed: false,
    sidebarCollapsedByLayout: false,
    sidebarFloating: false,
    shortcutHelpOpen: false,
    rightPanelMaximized: false,
    rightPanelMaximizedByLayout: false,
  });
}

describe("right-panel-layout", () => {
  beforeEach(() => {
    resetDiffStore();
    resetUiStore();
    setLayoutMeasurements(1200, 1200);
  });

  it("recomputes auto-owned panel width from the current chat row on each open", () => {
    showRightPanelAdaptive("ws-1", "thread-1");
    expect(useDiffStore.getState().getRightPanel("ws-1", "thread-1")).toMatchObject({
      width: 600,
      widthSource: "auto",
    });

    hideRightPanelAdaptive("ws-1", "thread-1");
    setLayoutMeasurements(1000, 1000);
    showRightPanelAdaptive("ws-1", "thread-1");

    expect(useDiffStore.getState().getRightPanel("ws-1", "thread-1")).toMatchObject({
      width: 500,
      widthSource: "auto",
    });
  });

  it("does not overwrite a user-owned panel width on reopen", () => {
    showRightPanelAdaptive("ws-1", "thread-1");
    useDiffStore.getState().setRightPanelWidth("ws-1", "thread-1", 520, "user");

    hideRightPanelAdaptive("ws-1", "thread-1");
    setLayoutMeasurements(1400, 1400);
    showRightPanelAdaptive("ws-1", "thread-1");

    expect(useDiffStore.getState().getRightPanel("ws-1", "thread-1")).toMatchObject({
      width: 520,
      widthSource: "user",
    });
  });
});
