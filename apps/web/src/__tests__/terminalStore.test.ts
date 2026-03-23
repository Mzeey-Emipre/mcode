import { describe, it, expect, beforeEach } from "vitest";
import { useTerminalStore } from "@/stores/terminalStore";

describe("TerminalStore", () => {
  beforeEach(() => {
    useTerminalStore.setState({
      terminals: {},
      activeTerminalId: null,
      panelVisible: false,
      splitMode: false,
    });
  });

  describe("addTerminal", () => {
    it("adds a terminal to the specified thread", () => {
      useTerminalStore.getState().addTerminal("thread-1", "pty-1");

      const terminals = useTerminalStore.getState().terminals["thread-1"];
      expect(terminals).toHaveLength(1);
      expect(terminals![0].id).toBe("pty-1");
      expect(terminals![0].threadId).toBe("thread-1");
    });

    it("sets added terminal as active", () => {
      useTerminalStore.getState().addTerminal("thread-1", "pty-1");

      expect(useTerminalStore.getState().activeTerminalId).toBe("pty-1");
    });

    it("shows the panel when a terminal is added", () => {
      useTerminalStore.getState().addTerminal("thread-1", "pty-1");

      expect(useTerminalStore.getState().panelVisible).toBe(true);
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

    it("picks next available terminal when active is removed", () => {
      useTerminalStore.getState().addTerminal("thread-1", "pty-1");
      useTerminalStore.getState().addTerminal("thread-1", "pty-2");
      useTerminalStore.getState().setActiveTerminal("pty-1");

      useTerminalStore.getState().removeTerminal("pty-1");

      expect(useTerminalStore.getState().activeTerminalId).toBe("pty-2");
    });

    it("sets active to null when last terminal is removed", () => {
      useTerminalStore.getState().addTerminal("thread-1", "pty-1");

      useTerminalStore.getState().removeTerminal("pty-1");

      expect(useTerminalStore.getState().activeTerminalId).toBeNull();
    });

    it("does nothing for unknown ptyId", () => {
      useTerminalStore.getState().addTerminal("thread-1", "pty-1");

      useTerminalStore.getState().removeTerminal("pty-unknown");

      const terminals = useTerminalStore.getState().terminals["thread-1"];
      expect(terminals).toHaveLength(1);
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
    it("removes all terminals for a thread", () => {
      useTerminalStore.getState().addTerminal("thread-1", "pty-1");
      useTerminalStore.getState().addTerminal("thread-1", "pty-2");

      useTerminalStore.getState().removeAllTerminals("thread-1");

      const terminals = useTerminalStore.getState().terminals["thread-1"];
      expect(terminals).toBeUndefined();
    });

    it("hides the panel", () => {
      useTerminalStore.getState().addTerminal("thread-1", "pty-1");
      expect(useTerminalStore.getState().panelVisible).toBe(true);

      useTerminalStore.getState().removeAllTerminals("thread-1");

      expect(useTerminalStore.getState().panelVisible).toBe(false);
    });

    it("clears active terminal if it belonged to the removed thread", () => {
      useTerminalStore.getState().addTerminal("thread-1", "pty-1");
      expect(useTerminalStore.getState().activeTerminalId).toBe("pty-1");

      useTerminalStore.getState().removeAllTerminals("thread-1");

      expect(useTerminalStore.getState().activeTerminalId).toBeNull();
    });

    it("does not affect other threads", () => {
      useTerminalStore.getState().addTerminal("thread-1", "pty-1");
      useTerminalStore.getState().addTerminal("thread-2", "pty-2");

      useTerminalStore.getState().removeAllTerminals("thread-1");

      expect(useTerminalStore.getState().terminals["thread-2"]).toHaveLength(1);
    });
  });

  describe("setActiveTerminal", () => {
    it("sets the active terminal id", () => {
      useTerminalStore.getState().setActiveTerminal("pty-1");

      expect(useTerminalStore.getState().activeTerminalId).toBe("pty-1");
    });

    it("sets active terminal to null", () => {
      useTerminalStore.getState().setActiveTerminal("pty-1");
      useTerminalStore.getState().setActiveTerminal(null);

      expect(useTerminalStore.getState().activeTerminalId).toBeNull();
    });
  });

  describe("togglePanel", () => {
    it("toggles panel visibility on", () => {
      useTerminalStore.getState().togglePanel();

      expect(useTerminalStore.getState().panelVisible).toBe(true);
    });

    it("toggles panel visibility off", () => {
      useTerminalStore.getState().togglePanel();
      useTerminalStore.getState().togglePanel();

      expect(useTerminalStore.getState().panelVisible).toBe(false);
    });
  });

  describe("showPanel / hidePanel", () => {
    it("shows the panel", () => {
      useTerminalStore.getState().showPanel();

      expect(useTerminalStore.getState().panelVisible).toBe(true);
    });

    it("hides the panel", () => {
      useTerminalStore.getState().showPanel();
      useTerminalStore.getState().hidePanel();

      expect(useTerminalStore.getState().panelVisible).toBe(false);
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
