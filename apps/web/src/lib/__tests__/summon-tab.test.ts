import { describe, it, expect, beforeEach, vi } from "vitest";
const { createTerminalForScope } = vi.hoisted(() => ({
  createTerminalForScope: vi.fn(),
}));

vi.mock("@/lib/ensure-terminal", () => ({ createTerminalForScope }));

import { summonTab } from "@/lib/summon-tab";
import { useDiffStore } from "@/stores/diffStore";
import { useTerminalStore } from "@/features/terminal/state/terminalStore";
import { useUiStore } from "@/stores/uiStore";
import { useWorkspaceStore } from "@/stores/workspaceStore";

const WID = "ws-1";
const TID = "thread-1";

/** Read the effective panel state for the active scope. */
function panel() {
  const s = useDiffStore.getState();
  const tid = useWorkspaceStore.getState().activeThreadId;
  return {
    visible: s.getRightPanelVisible(WID, tid),
    activeTab: s.getRightPanel(WID, tid).activeTab,
    openTabs: s.getRightPanel(WID, tid).openTabs,
  };
}

describe("summonTab", () => {
  beforeEach(() => {
    createTerminalForScope.mockReset();
    useDiffStore.setState({
      rightPanelByThread: {},
      rightPanelFallbackByWorkspace: {},
    });
    useTerminalStore.setState({
      terminals: {},
      terminalPanelByThread: {},
      ptyToThread: {},
    });
    useUiStore.setState({ primarySurface: "chat" });
    useWorkspaceStore.setState({ activeWorkspaceId: WID, activeThreadId: TID });
  });

  function seedTerminal(): void {
    useTerminalStore.getState().addTerminal(TID, "pty-1", "pwsh");
    useDiffStore.getState().addRightPanelTerminalTab(WID, TID, "pty-1");
    useDiffStore.getState().showRightPanel(WID, TID);
  }

  describe("create-or-focus", () => {
    it("opens the panel and focuses the tab when the panel is closed", () => {
      expect(panel().visible).toBe(false);

      summonTab("preview");

      expect(panel().visible).toBe(true);
      expect(panel().activeTab).toBe("preview");
      expect(panel().openTabs).toContain("preview");
    });

    it("activates the terminal tab before requesting the first PTY", () => {
      summonTab("preview");
      expect(panel().openTabs).toEqual(["preview"]);

      summonTab("terminal");
      expect(createTerminalForScope).toHaveBeenCalledWith(TID);
      expect(panel()).toMatchObject({
        visible: true,
        activeTab: "terminal",
        openTabs: ["preview", "terminal"],
      });
    });

    it("focuses an open-but-inactive tab without hiding the panel", () => {
      seedTerminal();
      summonTab("preview");
      summonTab("terminal");
      expect(panel().activeTab).toBe("terminal");

      summonTab("preview");

      expect(panel().visible).toBe(true);
      expect(panel().activeTab).toBe("preview");
      // No tab was closed — both remain open.
      expect(panel().openTabs).toEqual(["terminal", "preview"]);
    });

    it("requests a replacement PTY after the final terminal tab closes", () => {
      seedTerminal();
      useDiffStore.getState().closeRightPanelTabInstance(WID, TID, "terminal:pty-1");
      useTerminalStore.getState().removeTerminal("pty-1");
      expect(panel()).toMatchObject({
        visible: true,
        activeTab: "tasks",
        openTabs: [],
      });

      summonTab("terminal");

      expect(createTerminalForScope).toHaveBeenCalledWith(TID);
    });
  });

  describe("hide-when-active", () => {
    it("hides the panel when its shortcut targets the already-active tab", () => {
      summonTab("preview");
      expect(panel().visible).toBe(true);
      expect(panel().activeTab).toBe("preview");

      summonTab("preview");

      expect(panel().visible).toBe(false);
      // The tab stays open so re-summoning restores it; only visibility toggled.
      expect(panel().openTabs).toContain("preview");
    });

    it("re-summoning after hide re-opens to the same tab", () => {
      summonTab("preview");
      summonTab("preview"); // hide
      expect(panel().visible).toBe(false);

      summonTab("preview"); // re-open

      expect(panel().visible).toBe(true);
      expect(panel().activeTab).toBe("preview");
    });
  });

  describe("Plan no-op when threadless", () => {
    beforeEach(() => {
      useWorkspaceStore.setState({ activeWorkspaceId: WID, activeThreadId: null });
    });

    it("does nothing when summoning Plan with no thread", () => {
      summonTab("tasks");

      expect(panel().visible).toBe(false);
      expect(panel().openTabs).toEqual([]);
    });

    it("still summons a workspace-global tab (Browser) with no thread", () => {
      summonTab("preview");

      expect(panel().visible).toBe(true);
      expect(panel().activeTab).toBe("preview");
    });

    it("summons Plan once a thread exists", () => {
      useWorkspaceStore.setState({ activeThreadId: TID });

      summonTab("tasks");

      expect(panel().visible).toBe(true);
      expect(panel().activeTab).toBe("tasks");
    });
  });

  describe("guards and side effects", () => {
    it("no-ops when there is no active workspace", () => {
      useWorkspaceStore.setState({ activeWorkspaceId: null, activeThreadId: null });

      summonTab("preview");

      expect(useDiffStore.getState().rightPanelByThread).toEqual({});
      expect(useDiffStore.getState().rightPanelFallbackByWorkspace).toEqual({});
    });

    it("runs onFocus on open and refocus, but not on hide", () => {
      const onFocus = vi.fn();

      summonTab("preview", onFocus); // open
      expect(onFocus).toHaveBeenCalledTimes(1);

      seedTerminal();
      summonTab("preview", onFocus); // refocus
      expect(onFocus).toHaveBeenCalledTimes(2);

      summonTab("preview", onFocus); // hide
      expect(onFocus).toHaveBeenCalledTimes(2);
    });

    it("returns to Chat and shows the requested tab from Pull requests", () => {
      seedTerminal();
      useUiStore.getState().setPrimarySurface("pullRequests");

      summonTab("terminal");

      expect(useUiStore.getState().primarySurface).toBe("chat");
      expect(panel()).toMatchObject({
        visible: true,
        activeTab: "terminal",
        openTabs: ["terminal"],
      });
    });
  });
});
