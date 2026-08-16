import { beforeEach, describe, expect, it, vi } from "vitest";
import { useDiffStore } from "@/stores/diffStore";
import { useWorkspaceStore } from "@/features/projects/state/workspaceStore";
import { useUiStore } from "@/stores/uiStore";

const mocks = vi.hoisted(() => ({ showRightPanelAdaptive: vi.fn() }));
vi.mock("@/lib/right-panel-layout", () => ({ showRightPanelAdaptive: mocks.showRightPanelAdaptive }));

import { openSubagentDetail, openSubagentsPanel } from "../open-subagent-detail";

describe("openSubagentDetail", () => {
  beforeEach(() => {
    mocks.showRightPanelAdaptive.mockClear();
    useWorkspaceStore.setState({ activeWorkspaceId: "workspace-1", activeThreadId: "thread-1" });
    useDiffStore.setState({
      rightPanelByThread: {},
      rightPanelFallbackByWorkspace: {},
      subagentRosterTabByThread: {},
      subagentDetailByThread: {},
    });
    useUiStore.setState({ rightPanelMaximized: false, rightPanelMaximizedByLayout: false });
  });

  it("opens Subagents and selects the matching lifecycle detail", () => {
    expect(openSubagentDetail("agent-1", "finished")).toBe(true);

    const state = useDiffStore.getState();
    expect(state.subagentDetailByThread["thread-1"]).toEqual({
      id: "agent-1",
      originTab: "finished",
      scrollTop: 0,
    });
    expect(state.getRightPanel("workspace-1", "thread-1")).toMatchObject({
      activeTab: "subagents",
      openTabs: ["subagents"],
    });
    expect(mocks.showRightPanelAdaptive).toHaveBeenCalledWith("workspace-1", "thread-1");
    expect(useUiStore.getState()).toMatchObject({
      rightPanelMaximized: false,
      rightPanelMaximizedByLayout: false,
    });
  });

  it("does nothing without an active thread scope", () => {
    useWorkspaceStore.setState({ activeThreadId: null });
    expect(openSubagentDetail("agent-1", "active")).toBe(false);
    expect(mocks.showRightPanelAdaptive).not.toHaveBeenCalled();
  });

  it("leaves the roster tab unresolved for narrative-origin detail", () => {
    expect(openSubagentDetail("agent-1")).toBe(true);

    expect(useDiffStore.getState().subagentDetailByThread["thread-1"]).toEqual({
      id: "agent-1",
      scrollTop: 0,
    });
  });

  it("opens the Subagents roster without selecting a detail", () => {
    expect(openSubagentsPanel()).toBe(true);
    expect(useDiffStore.getState().subagentDetailByThread["thread-1"]).toBeUndefined();
    expect(useDiffStore.getState().getRightPanel("workspace-1", "thread-1")).toMatchObject({
      activeTab: "subagents",
      openTabs: ["subagents"],
    });
    expect(useUiStore.getState()).toMatchObject({
      rightPanelMaximized: false,
      rightPanelMaximizedByLayout: false,
    });
  });
});
