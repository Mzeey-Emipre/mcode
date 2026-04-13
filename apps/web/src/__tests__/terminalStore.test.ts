import { describe, it, expect, beforeEach } from "vitest";
import { useTerminalStore, TERMINAL_PANEL_DEFAULTS } from "@/stores/terminalStore";

describe("TerminalStore", () => {
  beforeEach(() => {
    useTerminalStore.setState({
      terminals: {},
      terminalPanelByThread: {},
      splitMode: false,
    });
  });

  describe("addTerminal", () => {
    it("should add a terminal and set per-thread panel state", () => {
      const { addTerminal, getTerminalPanel } = useTerminalStore.getState();
      addTerminal("thread-1", "pty-1");

      const state = useTerminalStore.getState();
      expect(state.terminals["thread-1"]).toHaveLength(1);
      expect(state.terminals["thread-1"]![0]!.id).toBe("pty-1");

      const panel = getTerminalPanel("thread-1");
      expect(panel.visible).toBe(true);
      expect(panel.activeTerminalId).toBe("pty-1");
    });

    it("should isolate panel state between threads", () => {
      const { addTerminal, getTerminalPanel } = useTerminalStore.getState();
      addTerminal("thread-1", "pty-1");
      addTerminal("thread-2", "pty-2");

      expect(getTerminalPanel("thread-1").activeTerminalId).toBe("pty-1");
      expect(getTerminalPanel("thread-2").activeTerminalId).toBe("pty-2");
    });

    it("adds multiple terminals to the same thread", () => {
      useTerminalStore.getState().addTerminal("thread-1", "pty-1");
      useTerminalStore.getState().addTerminal("thread-1", "pty-2");

      const terminals = useTerminalStore.getState().terminals["thread-1"];
      expect(terminals).toHaveLength(2);
    });

    it("adds terminals to different threads independently", () => {
      useTerminalStore.getState().addTerminal("thread-1", "pty-1");
      useTerminalStore.getState().addTerminal("thread-2", "pty-2");

      expect(useTerminalStore.getState().terminals["thread-1"]).toHaveLength(1);
      expect(useTerminalStore.getState().terminals["thread-2"]).toHaveLength(1);
    });
  });

  describe("label generation", () => {
    it("labels first terminal as 'Terminal 1'", () => {
      useTerminalStore.getState().addTerminal("thread-1", "pty-1");

      const terminals = useTerminalStore.getState().terminals["thread-1"];
      expect(terminals![0].label).toBe("Terminal 1");
    });

    it("labels second terminal as 'Terminal 2'", () => {
      useTerminalStore.getState().addTerminal("thread-1", "pty-1");
      useTerminalStore.getState().addTerminal("thread-1", "pty-2");

      const terminals = useTerminalStore.getState().terminals["thread-1"];
      expect(terminals![1].label).toBe("Terminal 2");
    });

    it("fills gaps in numbering by incrementing from max", () => {
      useTerminalStore.getState().addTerminal("thread-1", "pty-1");
      useTerminalStore.getState().addTerminal("thread-1", "pty-2");
      useTerminalStore.getState().addTerminal("thread-1", "pty-3");

      // Remove Terminal 2
      useTerminalStore.getState().removeTerminal("pty-2");

      // Add another - should be Terminal 4 (max was 3, increment)
      useTerminalStore.getState().addTerminal("thread-1", "pty-4");

      const terminals = useTerminalStore.getState().terminals["thread-1"];
      const labels = terminals!.map((t) => t.label);
      expect(labels).toContain("Terminal 4");
    });
  });

  describe("removeTerminal", () => {
    it("removes a terminal by ptyId", () => {
      useTerminalStore.getState().addTerminal("thread-1", "pty-1");
      useTerminalStore.getState().addTerminal("thread-1", "pty-2");

      useTerminalStore.getState().removeTerminal("pty-1");

      const terminals = useTerminalStore.getState().terminals["thread-1"];
      expect(terminals).toHaveLength(1);
      expect(terminals![0].id).toBe("pty-2");
    });

    it("should set activeTerminalId to first remaining when active is removed", () => {
      const { addTerminal, removeTerminal, getTerminalPanel } = useTerminalStore.getState();
      addTerminal("thread-1", "pty-1");
      addTerminal("thread-1", "pty-2");
      removeTerminal("pty-2");

      expect(getTerminalPanel("thread-1").activeTerminalId).toBe("pty-1");
    });

    it("should set activeTerminalId to null when last terminal removed", () => {
      const { addTerminal, removeTerminal, getTerminalPanel } = useTerminalStore.getState();
      addTerminal("thread-1", "pty-1");
      removeTerminal("pty-1");

      expect(getTerminalPanel("thread-1").activeTerminalId).toBeNull();
    });

    it("does nothing for unknown ptyId", () => {
      useTerminalStore.getState().addTerminal("thread-1", "pty-1");

      useTerminalStore.getState().removeTerminal("pty-unknown");

      const terminals = useTerminalStore.getState().terminals["thread-1"];
      expect(terminals).toHaveLength(1);
    });

    it("should not affect other threads", () => {
      const { addTerminal, removeTerminal, getTerminalPanel } = useTerminalStore.getState();
      addTerminal("thread-1", "pty-1");
      addTerminal("thread-2", "pty-2");
      removeTerminal("pty-1");

      expect(getTerminalPanel("thread-2").activeTerminalId).toBe("pty-2");
    });

    it("removes terminal from correct thread when multiple threads exist", () => {
      useTerminalStore.getState().addTerminal("thread-1", "pty-1");
      useTerminalStore.getState().addTerminal("thread-2", "pty-2");

      useTerminalStore.getState().removeTerminal("pty-1");

      expect(useTerminalStore.getState().terminals["thread-1"]).toBeUndefined();
      expect(useTerminalStore.getState().terminals["thread-2"]).toHaveLength(1);
    });
  });

  describe("removeAllTerminals", () => {
    it("should remove terminals but preserve panel config", () => {
      const { addTerminal, removeAllTerminals, getTerminalPanel } = useTerminalStore.getState();
      addTerminal("thread-1", "pty-1");
      removeAllTerminals("thread-1");

      const state = useTerminalStore.getState();
      expect(state.terminals["thread-1"]).toBeUndefined();
      // Panel config preserved (height, visibility) but activeTerminalId nulled.
      const panel = getTerminalPanel("thread-1");
      expect(panel.visible).toBe(true);
      expect(panel.activeTerminalId).toBeNull();
    });

    it("should not affect other threads", () => {
      const { addTerminal, removeAllTerminals, getTerminalPanel } = useTerminalStore.getState();
      addTerminal("thread-1", "pty-1");
      addTerminal("thread-2", "pty-2");
      removeAllTerminals("thread-1");

      expect(getTerminalPanel("thread-2").visible).toBe(true);
      expect(getTerminalPanel("thread-2").activeTerminalId).toBe("pty-2");
    });

    it("removes all terminals for a thread", () => {
      useTerminalStore.getState().addTerminal("thread-1", "pty-1");
      useTerminalStore.getState().addTerminal("thread-1", "pty-2");

      useTerminalStore.getState().removeAllTerminals("thread-1");

      const terminals = useTerminalStore.getState().terminals["thread-1"];
      expect(terminals).toBeUndefined();
    });

    it("does not affect other threads terminals", () => {
      useTerminalStore.getState().addTerminal("thread-1", "pty-1");
      useTerminalStore.getState().addTerminal("thread-2", "pty-2");

      useTerminalStore.getState().removeAllTerminals("thread-1");

      expect(useTerminalStore.getState().terminals["thread-2"]).toHaveLength(1);
    });
  });

  describe("clearThread", () => {
    it("should remove both terminals and panel state", () => {
      const { addTerminal, clearThread, getTerminalPanel } = useTerminalStore.getState();
      addTerminal("thread-1", "pty-1");
      clearThread("thread-1");

      const state = useTerminalStore.getState();
      expect(state.terminals["thread-1"]).toBeUndefined();
      expect(state.terminalPanelByThread["thread-1"]).toBeUndefined();
      expect(getTerminalPanel("thread-1")).toEqual(TERMINAL_PANEL_DEFAULTS);
    });

    it("should not affect other threads", () => {
      const { addTerminal, clearThread, getTerminalPanel } = useTerminalStore.getState();
      addTerminal("thread-1", "pty-1");
      addTerminal("thread-2", "pty-2");
      clearThread("thread-1");

      expect(getTerminalPanel("thread-2").visible).toBe(true);
      expect(getTerminalPanel("thread-2").activeTerminalId).toBe("pty-2");
    });
  });

  describe("per-thread panel actions", () => {
    it("getTerminalPanel returns defaults for unknown thread", () => {
      const { getTerminalPanel } = useTerminalStore.getState();
      expect(getTerminalPanel("unknown")).toEqual(TERMINAL_PANEL_DEFAULTS);
    });

    it("toggleTerminalPanel flips visibility for one thread only", () => {
      const { toggleTerminalPanel, getTerminalPanel } = useTerminalStore.getState();
      toggleTerminalPanel("thread-1");
      expect(getTerminalPanel("thread-1").visible).toBe(true);
      toggleTerminalPanel("thread-1");
      expect(getTerminalPanel("thread-1").visible).toBe(false);
    });

    it("showTerminalPanel sets visible true without affecting other fields", () => {
      const { showTerminalPanel, setTerminalPanelHeight, getTerminalPanel } = useTerminalStore.getState();
      setTerminalPanelHeight("thread-1", 450);
      showTerminalPanel("thread-1");
      const panel = getTerminalPanel("thread-1");
      expect(panel.visible).toBe(true);
      expect(panel.height).toBe(450);
    });

    it("hideTerminalPanel sets visible false without affecting other fields", () => {
      const { showTerminalPanel, hideTerminalPanel, setTerminalPanelHeight, getTerminalPanel } = useTerminalStore.getState();
      showTerminalPanel("thread-1");
      setTerminalPanelHeight("thread-1", 450);
      hideTerminalPanel("thread-1");
      const panel = getTerminalPanel("thread-1");
      expect(panel.visible).toBe(false);
      expect(panel.height).toBe(450);
    });

    it("setTerminalPanelHeight updates height for one thread only", () => {
      const { setTerminalPanelHeight, getTerminalPanel } = useTerminalStore.getState();
      setTerminalPanelHeight("thread-1", 450);
      expect(getTerminalPanel("thread-1").height).toBe(450);
      expect(getTerminalPanel("thread-2").height).toBe(300); // default
    });

    it("setActiveTerminal scoped to thread", () => {
      const { addTerminal, setActiveTerminal, getTerminalPanel } = useTerminalStore.getState();
      addTerminal("thread-1", "pty-1");
      addTerminal("thread-1", "pty-2");
      setActiveTerminal("thread-1", "pty-1");
      expect(getTerminalPanel("thread-1").activeTerminalId).toBe("pty-1");
    });
  });

  describe("toggleSplit", () => {
    it("toggles split mode on", () => {
      useTerminalStore.getState().toggleSplit();

      expect(useTerminalStore.getState().splitMode).toBe(true);
    });

    it("toggles split mode off", () => {
      useTerminalStore.getState().toggleSplit();
      useTerminalStore.getState().toggleSplit();

      expect(useTerminalStore.getState().splitMode).toBe(false);
    });
  });
});
