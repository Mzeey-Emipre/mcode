import { describe, it, expect, vi, beforeEach } from "vitest";

const terminalPause = vi.fn().mockResolvedValue(undefined);
const terminalResume = vi.fn().mockResolvedValue(undefined);

vi.mock("@/transport", () => ({
  getTransport: () => ({ terminalPause, terminalResume }),
}));

// Import AFTER vi.mock — vitest hoists vi.mock to the top automatically,
// so the store sees the mocked transport when the module initializes.
import { useTerminalStore } from "../terminalStore";

describe("terminalStore pause/resume wiring", () => {
  beforeEach(() => {
    terminalPause.mockClear();
    terminalResume.mockClear();
    useTerminalStore.setState({
      terminals: {},
      terminalPanelByThread: {},
      ptyToThread: {},
      terminalSearchByPty: {},
      splitMode: false,
    });
  });

  it("pauses only the selected PTY and leaves resume to the mounted view", () => {
    const store = useTerminalStore.getState();
    store.addTerminal("thread-1", "pty-a");
    store.addTerminal("thread-1", "pty-b");
    // Selecting the new shell pauses the renderer that is about to unmount.
    expect(terminalPause).toHaveBeenCalledWith("pty-a");
    expect(terminalResume).not.toHaveBeenCalled();
    terminalPause.mockClear();

    store.hideTerminalPanel("thread-1");
    expect(terminalPause).toHaveBeenCalledOnce();
    expect(terminalPause).toHaveBeenCalledWith("pty-b");
    expect(terminalResume).not.toHaveBeenCalled();

    store.showTerminalPanel("thread-1");
    expect(terminalResume).not.toHaveBeenCalled();
  });

  it("pauses the prior selection without resuming before reattach", () => {
    const store = useTerminalStore.getState();
    store.addTerminal("thread-1", "pty-a");
    store.addTerminal("thread-1", "pty-b");
    terminalPause.mockClear();

    store.setActiveTerminal("thread-1", "pty-a");

    expect(terminalPause).toHaveBeenCalledWith("pty-b");
    expect(terminalResume).not.toHaveBeenCalled();
  });

  it("no-ops when hiding an already-hidden panel", () => {
    useTerminalStore.getState().hideTerminalPanel("unknown-thread");
    expect(terminalPause).not.toHaveBeenCalled();
  });

  it("toggleTerminalPanel pauses on hide without resuming from the store", () => {
    const store = useTerminalStore.getState();
    store.addTerminal("thread-2", "pty-c");
    // Panel is visible after addTerminal. Toggle → hide → pause.
    store.toggleTerminalPanel("thread-2");
    expect(terminalPause).toHaveBeenCalledOnce();
    // Toggle again → show; TerminalView reattaches before it resumes.
    store.toggleTerminalPanel("thread-2");
    expect(terminalResume).not.toHaveBeenCalled();
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

  it("keeps search state per PTY and removes it with the PTY", () => {
    const store = useTerminalStore.getState();
    store.addTerminal("thread-1", "pty-a");
    store.addTerminal("thread-1", "pty-b");

    store.openTerminalSearch("pty-a");
    store.setTerminalSearchQuery("pty-a", "alpha");
    store.setTerminalSearchOptions("pty-a", {
      caseSensitive: true,
      wholeWord: true,
      regex: true,
    });
    store.setTerminalSearchResult("pty-a", 2, 5);

    store.openTerminalSearch("pty-b");
    store.setTerminalSearchQuery("pty-b", "beta");

    expect(useTerminalStore.getState().terminalSearchByPty).toMatchObject({
      "pty-a": {
        query: "alpha",
        options: { caseSensitive: true, wholeWord: true, regex: true },
        resultIndex: 2,
        resultCount: 5,
      },
      "pty-b": { query: "beta" },
    });

    store.removeTerminal("pty-a");
    expect(useTerminalStore.getState().terminalSearchByPty["pty-a"]).toBeUndefined();
    expect(useTerminalStore.getState().terminalSearchByPty["pty-b"]?.query).toBe("beta");
  });

  it("removes search state for PTYs omitted by reconnect reconciliation", () => {
    const store = useTerminalStore.getState();
    store.addTerminal("thread-1", "pty-stale");
    store.openTerminalSearch("pty-stale");
    store.setTerminalSearchQuery("pty-stale", "stale");

    store.reconcileActiveSessions([]);

    expect(useTerminalStore.getState().terminalSearchByPty["pty-stale"]).toBeUndefined();
  });

  it("retains an exited terminal until the user explicitly closes it", () => {
    const store = useTerminalStore.getState();
    store.addTerminal("thread-1", "pty-exited");

    store.recordTerminalExit("pty-exited", {
      code: 7,
      signal: null,
      reason: "natural",
    });

    expect(useTerminalStore.getState().terminals["thread-1"]).toEqual([
      expect.objectContaining({
        id: "pty-exited",
        state: "exited",
        exit: { code: 7, signal: null, reason: "natural" },
      }),
    ]);
    store.removeTerminal("pty-exited");
    expect(useTerminalStore.getState().terminals["thread-1"]).toBeUndefined();
  });
});
