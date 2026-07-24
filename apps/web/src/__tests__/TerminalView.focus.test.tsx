import { render } from "@testing-library/react";
import { act } from "react";
import { describe, it, expect, beforeEach, vi } from "vitest";
import { emitPtyData, emitPtyExit } from "@/components/terminal/ptyDataRegistry";
import { dropRemountAnchor } from "@/components/terminal/terminalRemountScroll";

// jsdom doesn't implement ResizeObserver; TerminalView instantiates one in
// its mount effect. A no-op stub is enough — fit is exercised via the
// visibility effects, not the observer.
if (typeof globalThis.ResizeObserver === "undefined") {
  globalThis.ResizeObserver = class {
    observe() {}
    unobserve() {}
    disconnect() {}
  } as typeof ResizeObserver;
}

// Shared xterm term instance observable from the tests. write() invokes its
// completion callback synchronously so the follow-the-tail scrollToBottom (which
// runs in a trailing write callback) is exercised.
const bufferActive = { viewportY: 42, length: 100 };

let onDataListener: ((data: string) => void) | null = null;
type RestoreResult =
  | { mode: "delta" }
  | { mode: "checkpoint"; checkpoint: string }
  | { mode: "reset"; discardThrough: number };

const term = {
  options: { scrollback: 0, disableStdin: false },
  buffer: { active: bufferActive },
  cols: 80,
  rows: 24,
  loadAddon: vi.fn(),
  open: vi.fn(),
  attachCustomKeyEventHandler: vi.fn(),
  getSelection: vi.fn(() => ""),
  onData: vi.fn((listener: (data: string) => void) => {
    onDataListener = listener;
    return { dispose: vi.fn() };
  }),
  onScroll: vi.fn(() => ({ dispose: vi.fn() })),
  write: vi.fn((_data: string | Uint8Array, cb?: () => void) => cb?.()),
  paste: vi.fn(),
  clear: vi.fn(),
  refresh: vi.fn(),
  focus: vi.fn(),
  scrollToLine: vi.fn(),
  scrollToBottom: vi.fn(),
  dispose: vi.fn(),
};

const transport = {
  terminalWrite: vi.fn(() => Promise.resolve()),
  terminalResize: vi.fn(() => Promise.resolve()),
  terminalPause: vi.fn(() => Promise.resolve()),
  terminalResume: vi.fn(() => Promise.resolve()),
  terminalReattach: vi.fn<() => Promise<RestoreResult>>(() =>
    Promise.resolve({ mode: "delta" }),
  ),
  terminalCheckpoint: vi.fn(() => Promise.resolve({ accepted: true })),
  ptySetLastSeq: vi.fn(),
  ptyDeleteLastSeq: vi.fn(),
};

vi.mock("@xterm/xterm", () => {
  class Terminal {
    constructor() {
      return term as unknown as Terminal;
    }
  }
  return { Terminal };
});

vi.mock("@xterm/addon-fit", () => {
  class FitAddon {
    fit = vi.fn();
    proposeDimensions = vi.fn(() => ({ cols: 80, rows: 24 }));
  }
  return { FitAddon };
});

vi.mock("@xterm/addon-serialize", () => ({
  SerializeAddon: class {
    serialize = vi.fn(() => "serialized-screen");
  },
}));

vi.mock("@/transport", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/transport")>();
  return {
    ...actual,
    getTransport: () => transport,
  };
});

import { TerminalView } from "@/components/terminal/TerminalView";

/** Flushes init's dynamic imports and the reattach microtask chain. */
async function settle(): Promise<void> {
  for (let i = 0; i < 5; i += 1) {
    await act(async () => {
      await Promise.resolve();
    });
  }
}

describe("TerminalView lifecycle (ADR-0010)", () => {
  beforeEach(() => {
    bufferActive.viewportY = 42;
    bufferActive.length = 100;
    term.options.disableStdin = false;
    vi.clearAllMocks();
    onDataListener = null;
    term.write.mockImplementation((_data: string | Uint8Array, cb?: () => void) => cb?.());
    // clearAllMocks resets call history but keeps implementations.
    transport.terminalReattach.mockResolvedValue({ mode: "delta" });
    // The remount-scroll anchor store is module-global; React Testing Library's
    // per-test unmount captures one, so clear it for deterministic mounts.
    for (const id of [
      "pty-1",
      "pty-2",
      "pty-a",
      "pty-b",
      "pty-batch",
      "pty-cold",
      "pty-exit",
      "pty-warm",
    ]) {
      dropRemountAnchor(id);
    }
  });

  // Regression guard: term.focus() must NOT fire when the window/tab regains
  // visibility. The user may be typing in the composer when the app returns to
  // the foreground — stealing focus into xterm would contradict the Ctrl+J
  // composer behaviour.
  it("does not call term.focus() on document visibilitychange", async () => {
    await act(async () => {
      render(<TerminalView ptyId="pty-1" visible={true} threadActive={true} />);
    });
    await settle();

    const focusCallsBefore = term.focus.mock.calls.length;
    term.refresh.mockClear();

    await act(async () => {
      Object.defineProperty(document, "visibilityState", {
        value: "visible",
        configurable: true,
      });
      document.dispatchEvent(new Event("visibilitychange"));
      window.dispatchEvent(new Event("focus"));
    });

    expect(term.focus.mock.calls.length).toBe(focusCallsBefore);
    // Repaint still happens so half-painted output recovers.
    expect(term.refresh).toHaveBeenCalled();
  });

  // #748: a freshly mounted view replays the full retained scrollback window.
  it("reattaches at the latest output (lastSeq -1) on mount", async () => {
    await act(async () => {
      render(<TerminalView ptyId="pty-1" visible={true} threadActive={true} />);
    });
    await settle();

    expect(transport.terminalReattach).toHaveBeenCalledWith("pty-1", -1, true);
  });

  // Newly created PTYs are paused server-side; the view releases them on mount.
  it("resumes the PTY after the view mounts", async () => {
    await act(async () => {
      render(<TerminalView ptyId="pty-1" visible={true} threadActive={true} />);
    });
    await settle();

    expect(transport.terminalResume).toHaveBeenCalledWith("pty-1");
  });

  it("submits serialized state at the last painted sequence before cold disposal", async () => {
    const view = render(
      <TerminalView ptyId="pty-cold" visible={true} threadActive={true} />,
    );
    await settle();
    act(() => {
      emitPtyData({
        ptyId: "pty-cold",
        seq: 7,
        payload: new TextEncoder().encode("painted"),
      });
    });

    view.unmount();

    expect(transport.terminalCheckpoint).toHaveBeenCalledWith(
      "pty-cold",
      7,
      "serialized-screen",
    );
  });

  it("writes a serialized checkpoint before its contiguous delta", async () => {
    transport.terminalReattach.mockImplementationOnce(async () => {
      emitPtyData({
        ptyId: "pty-cold",
        seq: 8,
        payload: new TextEncoder().encode("delta"),
      });
      return { mode: "checkpoint", checkpoint: "\u001b[31mred" };
    });

    render(<TerminalView ptyId="pty-cold" visible={true} threadActive={true} />);
    await settle();

    const combined = term.write.mock.calls
      .map(([data]) =>
        typeof data === "string" ? data : new TextDecoder().decode(data),
      )
      .join("");
    expect(combined).toContain("\u001b[31mreddelta");
  });

  // #748: viewport opens at the tail after replay completes.
  it("follows the tail (scrollToBottom) once replay completes", async () => {
    await act(async () => {
      render(<TerminalView ptyId="pty-1" visible={true} threadActive={true} />);
    });
    await settle();

    expect(term.scrollToBottom).toHaveBeenCalled();
  });

  // #746/#748: a gap in the retained window surfaces a trim banner at the top.
  it("writes a trim banner when the replay reports a gap", async () => {
    transport.terminalReattach.mockResolvedValueOnce({
      mode: "reset",
      discardThrough: 12,
    });

    await act(async () => {
      render(<TerminalView ptyId="pty-2" visible={true} threadActive={true} />);
    });
    await settle();

    const wroteBanner = term.write.mock.calls.some(
      ([data]) => typeof data === "string" && data.includes("scrollback limit"),
    );
    expect(wroteBanner).toBe(true);
  });

  // Remount path (shell-tab / thread switch): changing ptyId disposes the old
  // view and mounts a fresh one that reattaches independently.
  it("disposes and reattaches a fresh view when ptyId changes", async () => {
    const { rerender } = render(
      <TerminalView ptyId="pty-a" visible={true} threadActive={true} />,
    );
    await settle();
    expect(transport.terminalReattach).toHaveBeenCalledWith("pty-a", -1, true);

    await act(async () => {
      rerender(<TerminalView ptyId="pty-b" visible={true} threadActive={true} />);
    });
    await settle();

    // Old view torn down (its per-pty seq tracking is cleared)...
    expect(transport.ptyDeleteLastSeq).toHaveBeenCalledWith("pty-a");
    // ...and the new pty reattaches at its own latest output.
    expect(transport.terminalReattach).toHaveBeenCalledWith("pty-b", -1, true);
  });

  // #749: the replay burst is written in a single batched term.write rather
  // than one main-thread task per chunk.
  it("batches replayed frames into a single term.write", async () => {
    let resolveReattach: (v: { mode: "delta" }) => void = () => {};
    transport.terminalReattach.mockReturnValueOnce(
      new Promise((r) => {
        resolveReattach = r;
      }),
    );

    await act(async () => {
      render(<TerminalView ptyId="pty-batch" visible={true} threadActive={true} />);
    });
    await settle(); // mounted with listeners attached; reattach still pending

    // Two replayed frames arrive while the gate is open.
    await act(async () => {
      emitPtyData({ ptyId: "pty-batch", seq: 0, payload: new Uint8Array([65]) });
      emitPtyData({ ptyId: "pty-batch", seq: 1, payload: new Uint8Array([66]) });
    });

    await act(async () => {
      resolveReattach({ mode: "delta" });
    });
    await settle();

    const dataWrites = term.write.mock.calls.filter(
      ([data]) => data instanceof Uint8Array,
    );
    expect(dataWrites.length).toBe(1);
    expect(Array.from(dataWrites[0][0] as Uint8Array)).toEqual([65, 66]);
  });

  it("keeps a cold view hidden until replay has painted", async () => {
    let resolveReattach: (value: { mode: "delta" }) => void = () => {};
    let finishReplayWrite: (() => void) | undefined;
    transport.terminalReattach.mockReturnValueOnce(
      new Promise((resolve) => {
        resolveReattach = resolve;
      }),
    );
    term.write.mockImplementation((data: string | Uint8Array, cb?: () => void) => {
      if (data instanceof Uint8Array) {
        finishReplayWrite = cb;
        return;
      }
      cb?.();
    });

    const { container } = render(
      <TerminalView ptyId="pty-cold" visible={true} threadActive={true} />,
    );
    await settle();

    await act(async () => {
      emitPtyData({ ptyId: "pty-cold", seq: 0, payload: new Uint8Array([65]) });
      resolveReattach({ mode: "delta" });
    });
    await settle();

    const terminalRoot = container.firstElementChild as HTMLElement;
    expect(terminalRoot.dataset.terminalHydrated).toBe("false");
    expect(terminalRoot.style.visibility).toBe("hidden");

    await act(async () => {
      finishReplayWrite?.();
    });
    await settle();

    expect(terminalRoot.dataset.terminalHydrated).toBe("true");
    expect(terminalRoot.style.visibility).toBe("visible");
  });

  it("stops forwarding input as soon as the PTY exits", async () => {
    render(<TerminalView ptyId="pty-exit" visible={true} threadActive={true} />);
    await settle();
    transport.terminalWrite.mockClear();

    await act(async () => {
      emitPtyExit({ ptyId: "pty-exit", code: 1 });
      onDataListener?.("echo after exit\r");
    });

    expect(transport.terminalWrite).not.toHaveBeenCalled();
    expect(term.options.disableStdin).toBe(true);
  });

  it("keeps the warm view and requests only output after its last sequence", async () => {
    const { rerender } = render(
      <TerminalView ptyId="pty-warm" visible={true} threadActive={true} />,
    );
    await settle();

    await act(async () => {
      emitPtyData({ ptyId: "pty-warm", seq: 5, payload: new Uint8Array([65]) });
    });
    rerender(
      <TerminalView ptyId="pty-warm" visible={false} threadActive={false} />,
    );
    await settle();
    expect(transport.terminalPause).toHaveBeenCalledWith("pty-warm");

    rerender(
      <TerminalView ptyId="pty-warm" visible={true} threadActive={true} />,
    );
    await settle();

    expect(transport.terminalReattach).toHaveBeenLastCalledWith("pty-warm", 5, false);
    expect(term.dispose).not.toHaveBeenCalled();
  });
});
