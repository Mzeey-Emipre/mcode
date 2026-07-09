import { describe, it, expect, vi, beforeEach } from "vitest";

const terminalPause = vi.fn().mockResolvedValue(undefined);
const terminalResume = vi.fn().mockResolvedValue(undefined);

vi.mock("@/transport", () => ({
  getTransport: () => ({ terminalPause, terminalResume }),
}));

// Import AFTER vi.mock — vitest hoists vi.mock to the top automatically,
// so the store sees the mocked transport when the module initializes.
import { useTerminalStore } from "./terminalStore";

describe("terminalStore pause/resume wiring", () => {
  beforeEach(() => {
    terminalPause.mockClear();
    terminalResume.mockClear();
    useTerminalStore.setState({
      terminals: {},
      terminalPanelByThread: {},
      ptyToThread: {},
      splitMode: false,
    });
  });

  it("pauses all PTYs on hide and resumes on show", () => {
    const store = useTerminalStore.getState();
    store.addTerminal("thread-1", "pty-a");
    store.addTerminal("thread-1", "pty-b");
    // addTerminal makes the panel visible; no pause/resume should have fired yet.
    expect(terminalPause).not.toHaveBeenCalled();
    expect(terminalResume).not.toHaveBeenCalled();

    store.hideTerminalPanel("thread-1");
    expect(terminalPause).toHaveBeenCalledTimes(2);
    expect(terminalResume).not.toHaveBeenCalled();

    store.showTerminalPanel("thread-1");
    expect(terminalResume).toHaveBeenCalledTimes(2);
  });

  it("no-ops when hiding an already-hidden panel", () => {
    useTerminalStore.getState().hideTerminalPanel("unknown-thread");
    expect(terminalPause).not.toHaveBeenCalled();
  });

  it("toggleTerminalPanel pauses when visible, resumes when hidden", () => {
    const store = useTerminalStore.getState();
    store.addTerminal("thread-2", "pty-c");
    // Panel is visible after addTerminal. Toggle → hide → pause.
    store.toggleTerminalPanel("thread-2");
    expect(terminalPause).toHaveBeenCalledOnce();
    // Toggle again → show → resume.
    store.toggleTerminalPanel("thread-2");
    expect(terminalResume).toHaveBeenCalledOnce();
  });

  it("reconciles stale client PTYs when the restarted server reports none", () => {
    const store = useTerminalStore.getState();
    store.addTerminal("thread-1", "stale-pty");

    store.reconcileActiveSessions([]);

    expect(useTerminalStore.getState().terminals["thread-1"]).toBeUndefined();
    expect(useTerminalStore.getState().ptyToThread["stale-pty"]).toBeUndefined();
  });

  it("restores server-only PTYs and removes client-only PTYs on reconnect", () => {
    const store = useTerminalStore.getState();
    store.addTerminal("thread-1", "client-only");

    store.reconcileActiveSessions([
      { ptyId: "server-pty", threadId: "thread-2" },
    ]);

    const next = useTerminalStore.getState();
    expect(next.terminals["thread-1"]).toBeUndefined();
    expect(next.terminals["thread-2"]?.map((terminal) => terminal.id)).toEqual([
      "server-pty",
    ]);
    expect(next.terminalPanelByThread["thread-2"]?.activeTerminalId).toBe(
      "server-pty",
    );
  });
});
