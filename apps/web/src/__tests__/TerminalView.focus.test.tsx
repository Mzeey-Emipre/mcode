import { render } from "@testing-library/react";
import { act } from "react";
import { describe, it, expect, beforeEach, vi } from "vitest";
import { getDefaultSettings } from "@mcode/contracts";
import { useSettingsStore } from "@/stores/settingsStore";
import {
  emitPtyData,
  emitPtyExit,
  onPtyData,
  onPtyExit,
  onPtyReconnectGap,
} from "@/terminal/pty-data-registry";
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
let onSelectionListener: (() => void) | null = null;
let serializedScreen = "serialized-screen";
let lastTerminalOptions: Record<string, unknown> | undefined;
type RestoreResult =
  | { mode: "delta" }
  | { mode: "checkpoint"; checkpoint: string; checkpointThrough: number }
  | { mode: "reset"; discardThrough: number };

const term = {
  options: { scrollback: 0, disableStdin: false } as Record<string, unknown>,
  element: { style: {} },
  buffer: { active: bufferActive },
  cols: 80,
  rows: 24,
  loadAddon: vi.fn(),
  open: vi.fn(),
  attachCustomKeyEventHandler: vi.fn(),
  getSelection: vi.fn(() => ""),
  hasSelection: vi.fn(() => false),
  onData: vi.fn((listener: (data: string) => void) => {
    onDataListener = listener;
    return { dispose: vi.fn() };
  }),
  onScroll: vi.fn(() => ({ dispose: vi.fn() })),
  onSelectionChange: vi.fn((listener: () => void) => {
    onSelectionListener = listener;
    return { dispose: vi.fn() };
  }),
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
  terminalSubscribe: vi.fn((ptyId: string, subscription: {
    onData?: (event: { ptyId: string; payload: Uint8Array; seq: number }) => void;
    onExit?: (event: { ptyId: string; code: number }) => void;
    onReconnectGap?: () => void;
  }) => {
    const unsubs = [
      subscription.onData ? onPtyData(ptyId, subscription.onData) : undefined,
      subscription.onExit ? onPtyExit(ptyId, subscription.onExit) : undefined,
      subscription.onReconnectGap ? onPtyReconnectGap(ptyId, subscription.onReconnectGap) : undefined,
    ].filter((unsubscribe): unsubscribe is () => void => Boolean(unsubscribe));
    return () => unsubs.forEach((unsubscribe) => unsubscribe());
  }),
  terminalDetachForSwitch: vi.fn(async (
    ptyId: string,
    checkpoint?: Promise<{ seq: number; data: string } | undefined>,
  ) => {
    const state = checkpoint ? await checkpoint : undefined;
    if (state) {
      await transport.terminalCheckpoint(ptyId, state.seq, state.data);
    }
  }),
  terminalReattach: vi.fn<() => Promise<RestoreResult>>(() =>
    Promise.resolve({ mode: "delta" }),
  ),
  terminalCheckpoint: vi.fn((_ptyId: string, _seq: number, _data: string) =>
    Promise.resolve({ accepted: true })),
  ptySetLastSeq: vi.fn(),
  ptyDeleteLastSeq: vi.fn(),
};

vi.mock("@xterm/xterm", () => {
  class Terminal {
    constructor(options: Record<string, unknown>) {
      lastTerminalOptions = options;
      Object.assign(term.options, options);
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
    serialize = vi.fn(() => serializedScreen);
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
    onSelectionListener = null;
    lastTerminalOptions = undefined;
    serializedScreen = "serialized-screen";
    Object.assign(term.options, { scrollback: 0, disableStdin: false });
    useSettingsStore.setState({ settings: getDefaultSettings(), loaded: true });
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

  it("mounts xterm in the padded fit host inside the render surface", async () => {
    const { container } = render(
      <TerminalView ptyId="pty-1" visible={true} threadActive={true} />,
    );
    await settle();

    const renderSurface = container.querySelector(
      '[data-testid="terminal-render-content"]',
    );
    const fitHost = renderSurface?.firstElementChild;

    expect(renderSurface).toHaveClass("flex", "flex-col", "overflow-hidden");
    expect(fitHost).toHaveClass("min-h-0", "flex-1", "w-full", "p-3");
    expect(fitHost?.parentElement).toBe(renderSurface);
    expect(term.open).toHaveBeenCalledWith(fitHost);
  });

  it("applies Terminal preferences to xterm and live selection and paste boundaries", async () => {
    const defaults = getDefaultSettings();
    const clipboard = { writeText: vi.fn().mockResolvedValue(undefined) };
    const originalClipboard = navigator.clipboard;
    Object.defineProperty(navigator, "clipboard", { configurable: true, value: clipboard });
    const confirm = vi.spyOn(window, "confirm").mockReturnValue(true);
    useSettingsStore.setState({
      settings: {
        ...defaults,
        terminal: {
          ...defaults.terminal,
          presentation: {
            ...defaults.terminal.presentation,
            fontFamily: "Test Sans",
            fontSize: "xl",
            lineHeight: "relaxed",
            cursorStyle: "bar",
            cursorBlink: true,
            ligatures: true,
          },
          behavior: {
            ...defaults.terminal.behavior,
            scrollback: 2500,
            copyOnSelect: true,
            confirmMultilinePaste: true,
          },
          accessibility: { screenReaderMode: "on" },
        },
      },
      loaded: true,
    });

    const { container } = render(
      <TerminalView ptyId="pty-1" visible={true} threadActive={true} />,
    );
    await settle();

    expect(lastTerminalOptions).toMatchObject({
      scrollback: 2500,
      fontFamily: "Test Sans",
      fontSize: 19,
      lineHeight: 1.4,
      cursorStyle: "bar",
      cursorBlink: true,
      screenReaderMode: true,
    });

    term.getSelection.mockReturnValue("selected");
    act(() => onSelectionListener?.());
    expect(clipboard.writeText).toHaveBeenCalledWith("selected");

    const pasteEvent = new Event("paste", { bubbles: true, cancelable: true });
    Object.defineProperty(pasteEvent, "clipboardData", {
      value: { getData: () => "one\ntwo" },
    });
    const pasteBoundary = container.querySelector<HTMLElement>(
      '[data-testid="terminal-render-content"] > div',
    );
    expect(pasteBoundary).not.toBeNull();
    act(() => pasteBoundary?.dispatchEvent(pasteEvent));
    expect(confirm).toHaveBeenCalledWith("Paste multiple lines into the terminal?");
    expect(term.paste).toHaveBeenCalledWith("one\ntwo");

    const current = useSettingsStore.getState().settings.terminal;
    act(() => {
      useSettingsStore.getState()._applyTerminalPreferences({
        presentation: {
          ...current.presentation,
          fontFamily: "Live Sans",
          fontSize: "xs",
          lineHeight: "compact",
          cursorStyle: "underline",
          cursorBlink: false,
          ligatures: false,
        },
        behavior: { ...current.behavior, scrollback: 100 },
        accessibility: { screenReaderMode: "off" },
      });
    });
    await settle();
    expect(term.options).toMatchObject({
      scrollback: 100,
      fontFamily: "Live Sans",
      fontSize: 11,
      lineHeight: 1.1,
      cursorStyle: "underline",
      cursorBlink: false,
      screenReaderMode: false,
    });

    const applyScreenReaderMode = (screenReaderMode: "off" | "auto" | "on") => {
      const next = useSettingsStore.getState().settings.terminal;
      useSettingsStore.getState()._applyTerminalPreferences({
        presentation: next.presentation,
        behavior: next.behavior,
        accessibility: { screenReaderMode },
      });
    };
    act(() => applyScreenReaderMode("auto"));
    await settle();
    expect(term.options.screenReaderMode).toBe(false);
    act(() => applyScreenReaderMode("on"));
    await settle();
    expect(term.options.screenReaderMode).toBe(true);

    Object.defineProperty(navigator, "clipboard", { configurable: true, value: originalClipboard });
    confirm.mockRestore();
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
    await settle();

    expect(transport.terminalDetachForSwitch).toHaveBeenCalledWith(
      "pty-cold",
      expect.any(Promise),
    );
  });

  it("does not resume after a paused replay batch paints during cleanup", async () => {
    let finishWrite: (() => void) | undefined;
    let resolveReattach: (value: { mode: "delta" }) => void = () => {};
    transport.terminalReattach.mockReturnValueOnce(
      new Promise((resolve) => {
        resolveReattach = resolve;
      }),
    );
    term.write.mockImplementation((data: string | Uint8Array, cb?: () => void) => {
      if (data instanceof Uint8Array) {
        finishWrite = () => {
          cb?.();
        };
        return;
      }
      cb?.();
    });

    const view = render(
      <TerminalView ptyId="pty-cold" visible={true} threadActive={true} />,
    );
    await settle();
    act(() => {
      emitPtyData({
        ptyId: "pty-cold",
        seq: 7,
        payload: new Uint8Array(262_145),
      });
      resolveReattach({ mode: "delta" });
    });
    await settle();
    expect(transport.terminalPause).toHaveBeenCalledWith("pty-cold");
    transport.terminalResume.mockClear();

    view.unmount();

    expect(transport.terminalCheckpoint).not.toHaveBeenCalled();
    expect(term.dispose).not.toHaveBeenCalled();

    await act(async () => {
      serializedScreen = "painted";
      finishWrite?.();
    });
    await settle();

    expect(transport.terminalCheckpoint).toHaveBeenCalledWith(
      "pty-cold",
      7,
      "painted",
    );
    expect(transport.terminalResume).not.toHaveBeenCalled();
    expect(term.dispose).toHaveBeenCalledOnce();
  });

  it("waits for a boundary write before checkpointing and disposing", async () => {
    let finishBoundaryWrite: (() => void) | undefined;
    term.write.mockImplementation((data: string | Uint8Array, cb?: () => void) => {
      if (typeof data === "string" && data.includes("Process exited")) {
        finishBoundaryWrite = () => {
          serializedScreen = data;
          cb?.();
        };
        return;
      }
      cb?.();
    });

    const view = render(
      <TerminalView ptyId="pty-exit" visible={true} threadActive={true} />,
    );
    await settle();
    act(() => {
      emitPtyExit({ ptyId: "pty-exit", code: 1 });
    });

    view.unmount();

    expect(transport.terminalCheckpoint).not.toHaveBeenCalled();
    expect(term.dispose).not.toHaveBeenCalled();

    await act(async () => {
      finishBoundaryWrite?.();
    });
    await settle();

    expect(transport.terminalCheckpoint).toHaveBeenCalledWith(
      "pty-exit",
      -1,
      expect.stringContaining("Process exited with code 1"),
    );
    expect(term.dispose).toHaveBeenCalledOnce();
  });

  it("writes a serialized checkpoint before its contiguous delta", async () => {
    transport.terminalReattach.mockImplementationOnce(async () => {
      emitPtyData({
        ptyId: "pty-cold",
        seq: 8,
        payload: new TextEncoder().encode("delta"),
      });
      return {
        mode: "checkpoint",
        checkpoint: "\u001b[31mred",
        checkpointThrough: 7,
      };
    });

    render(<TerminalView ptyId="pty-cold" visible={true} threadActive={true} />);
    await settle();

    const combined = term.write.mock.calls
      .map(([data]) =>
        typeof data === "string" ? data : new TextDecoder().decode(data),
      )
      .join("");
    expect(combined).toContain("\u001b[31mreddelta");
    expect(transport.ptySetLastSeq).toHaveBeenCalledWith("pty-cold", 8);
  });

  it("advances the processed floor for a checkpoint-only remount", async () => {
    transport.terminalReattach.mockResolvedValueOnce({
      mode: "checkpoint",
      checkpoint: "checkpoint-only",
      checkpointThrough: 41,
    });

    render(<TerminalView ptyId="pty-cold" visible={true} threadActive={true} />);
    await settle();

    expect(transport.ptySetLastSeq).toHaveBeenCalledWith("pty-cold", 41);
    const checkpointWrite = term.write.mock.calls.find(
      ([data]) =>
        data instanceof Uint8Array &&
        new TextDecoder().decode(data) === "checkpoint-only",
    );
    expect(checkpointWrite).toBeDefined();
    expect(checkpointWrite?.[1]).toEqual(expect.any(Function));
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
    transport.terminalReattach.mockImplementationOnce(async () => {
      emitPtyData({
        ptyId: "pty-2",
        seq: 12,
        payload: new TextEncoder().encode("unsafe-retained-tail"),
      });
      return {
        mode: "reset",
        discardThrough: 12,
      };
    });

    await act(async () => {
      render(<TerminalView ptyId="pty-2" visible={true} threadActive={true} />);
    });
    await settle();

    const wroteBanner = term.write.mock.calls.some(
      ([data]) => typeof data === "string" && data.includes("scrollback limit"),
    );
    expect(wroteBanner).toBe(true);
    expect(
      term.write.mock.calls.some(([data]) =>
        new TextDecoder().decode(
          typeof data === "string" ? new TextEncoder().encode(data) : data,
        ).includes("unsafe-retained-tail"),
      ),
    ).toBe(false);

    act(() => {
      emitPtyData({
        ptyId: "pty-2",
        seq: 13,
        payload: new TextEncoder().encode("future-safe"),
      });
    });
    expect(
      term.write.mock.calls.some(([data]) =>
        new TextDecoder().decode(
          typeof data === "string" ? new TextEncoder().encode(data) : data,
        ).includes("future-safe"),
      ),
    ).toBe(true);
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
    expect(transport.terminalResume).not.toHaveBeenCalled();

    // Replay and live frames can arrive out of order while the gate is open;
    // a repeated frame may also be redelivered when the paused stream resumes.
    await act(async () => {
      emitPtyData({ ptyId: "pty-batch", seq: 2, payload: new Uint8Array([67]) });
      emitPtyData({ ptyId: "pty-batch", seq: 1, payload: new Uint8Array([66]) });
      emitPtyData({ ptyId: "pty-batch", seq: 2, payload: new Uint8Array([67]) });
    });

    await act(async () => {
      resolveReattach({ mode: "delta" });
    });
    await settle();

    const dataWrites = term.write.mock.calls.filter(
      ([data]) => data instanceof Uint8Array,
    );
    expect(dataWrites.length).toBe(1);
    expect(Array.from(dataWrites[0][0] as Uint8Array)).toEqual([66, 67]);
    expect(transport.terminalResume).toHaveBeenCalledWith("pty-batch");
    expect(
      transport.terminalReattach.mock.invocationCallOrder[0],
    ).toBeLessThan(transport.terminalResume.mock.invocationCallOrder[0]!);

    term.write.mockClear();
    act(() => {
      emitPtyData({ ptyId: "pty-batch", seq: 1, payload: new Uint8Array([66]) });
      emitPtyData({ ptyId: "pty-batch", seq: 2, payload: new Uint8Array([67]) });
      emitPtyData({ ptyId: "pty-batch", seq: 3, payload: new Uint8Array([68]) });
    });

    const tailWrites = term.write.mock.calls.filter(
      ([data]) => data instanceof Uint8Array,
    );
    expect(tailWrites).toHaveLength(1);
    expect(Array.from(tailWrites[0][0] as Uint8Array)).toEqual([68]);
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
    expect(transport.terminalPause).not.toHaveBeenCalled();

    rerender(
      <TerminalView ptyId="pty-warm" visible={true} threadActive={true} />,
    );
    await settle();

    expect(transport.terminalReattach).toHaveBeenCalledTimes(1);
    expect(term.dispose).not.toHaveBeenCalled();
  });
});
