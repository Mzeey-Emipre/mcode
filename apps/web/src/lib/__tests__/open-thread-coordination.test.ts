import { beforeEach, describe, expect, it, vi } from "vitest";
import { useDiffStore } from "@/stores/diffStore";
import { useWorkspaceStore } from "@/features/projects/state/workspaceStore";

const mocks = vi.hoisted(() => ({ showRightPanelAdaptive: vi.fn() }));
vi.mock("@/lib/right-panel-layout", () => ({ showRightPanelAdaptive: mocks.showRightPanelAdaptive }));

import { openThreadCoordinationPanel } from "../open-thread-coordination";

describe("openThreadCoordinationPanel", () => {
  beforeEach(() => {
    mocks.showRightPanelAdaptive.mockClear();
    useWorkspaceStore.setState({ activeWorkspaceId: "workspace-1", activeThreadId: "thread-1" });
    useDiffStore.setState({ rightPanelByThread: {}, rightPanelFallbackByWorkspace: {} });
  });

  it("opens the coordination tab for the active Project and Thread", () => {
    expect(openThreadCoordinationPanel()).toBe(true);
    expect(useDiffStore.getState().getRightPanel("workspace-1", "thread-1")).toMatchObject({
      activeTab: "coordination",
      openTabs: ["coordination"],
    });
    expect(mocks.showRightPanelAdaptive).toHaveBeenCalledWith("workspace-1", "thread-1");
  });

  it("does nothing without an active thread identity", () => {
    useWorkspaceStore.setState({ activeThreadId: null });
    expect(openThreadCoordinationPanel()).toBe(false);
    expect(mocks.showRightPanelAdaptive).not.toHaveBeenCalled();
  });
});
