import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { useTerminalStore } from "@/stores/terminalStore";

const searchHarness = vi.hoisted(() => {
  const resultListeners: Array<(result: { resultIndex: number; resultCount: number }) => void> = [];
  const resultDisposable = { dispose: vi.fn() };
  let activatedTerminalOptions: { allowProposedApi?: boolean } | null = null;
  const addon = {
    activate: vi.fn((terminal: { options: { allowProposedApi?: boolean } }) => {
      activatedTerminalOptions = terminal.options;
    }),
    clearDecorations: vi.fn(),
    dispose: vi.fn(),
    findNext: vi.fn(() => true),
    findPrevious: vi.fn(() => true),
    onDidChangeResults: vi.fn((listener: (result: { resultIndex: number; resultCount: number }) => void) => {
      if (activatedTerminalOptions?.allowProposedApi !== true) {
        throw new Error("allowProposedApi must be enabled for result events");
      }
      resultListeners.push(listener);
      return resultDisposable;
    }),
  };
  class FakeSearchAddon {
    constructor() {
      searchHarness.latestAddon = addon;
    }

    activate = addon.activate;
    clearDecorations = addon.clearDecorations;
    dispose = addon.dispose;
    findNext = addon.findNext;
    findPrevious = addon.findPrevious;
    onDidChangeResults = addon.onDidChangeResults;
  }
  const load = vi.fn(async () => ({ SearchAddon: FakeSearchAddon }));
  return {
    addon,
    FakeSearchAddon,
    latestAddon: addon as typeof addon | null,
    load,
    emitResult(result: { resultIndex: number; resultCount: number }) {
      resultListeners.forEach((listener) => listener(result));
    },
    reset() {
      resultListeners.length = 0;
      activatedTerminalOptions = null;
      resultDisposable.dispose.mockClear();
      this.latestAddon = null;
    },
    resultDisposable,
  };
});

const terminalOptions: {
  scrollback: number;
  disableStdin: boolean;
  allowProposedApi: boolean;
  screenReaderMode: boolean | undefined;
} = {
  scrollback: 0,
  disableStdin: false,
  allowProposedApi: false,
  screenReaderMode: undefined,
};

const term = {
  options: terminalOptions,
  buffer: { active: { viewportY: 0, length: 1 } },
  cols: 80,
  rows: 24,
  loadAddon: vi.fn((addon: { activate?: (terminal: { options: { allowProposedApi?: boolean } }) => void }) => {
    addon.activate?.(term);
  }),
  open: vi.fn(),
  registerLinkProvider: vi.fn(() => ({ dispose: vi.fn() })),
  attachCustomKeyEventHandler: vi.fn(),
  getSelection: vi.fn(() => ""),
  hasSelection: vi.fn(() => false),
  onData: vi.fn(() => ({ dispose: vi.fn() })),
  onScroll: vi.fn(() => ({ dispose: vi.fn() })),
  onSelectionChange: vi.fn((_listener: () => void) => ({ dispose: vi.fn() })),
  write: vi.fn((_data: string | Uint8Array, callback?: () => void) => callback?.()),
  paste: vi.fn(),
  clear: vi.fn(),
  clearSelection: vi.fn(),
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
  terminalSubscribe: vi.fn(() => vi.fn()),
  terminalDetachForSwitch: vi.fn(async () => undefined),
  terminalReattach: vi.fn(async () => ({ mode: "delta" as const })),
  terminalCheckpoint: vi.fn(async () => ({ accepted: true })),
  ptySetLastSeq: vi.fn(),
  ptyDeleteLastSeq: vi.fn(),
};

let synchronousFrameCount = 0;

if (typeof globalThis.ResizeObserver === "undefined") {
  globalThis.ResizeObserver = class {
    observe() {}
    unobserve() {}
    disconnect() {}
  } as typeof ResizeObserver;
}

vi.mock("@xterm/xterm", () => ({
  Terminal: class {
    constructor(options: { allowProposedApi?: boolean }) {
      Object.assign(term.options, options);
      return term as unknown as InstanceType<typeof import("@xterm/xterm").Terminal>;
    }
  },
}));

vi.mock("@xterm/addon-fit", () => ({
  FitAddon: class {
    fit = vi.fn();
    proposeDimensions = vi.fn(() => ({ cols: 80, rows: 24 }));
  },
}));

vi.mock("@xterm/addon-serialize", () => ({
  SerializeAddon: class {
    serialize = vi.fn(() => "serialized-screen");
  },
}));

vi.mock("@/components/terminal/terminalSearchAddon", () => ({
  loadTerminalSearchAddon: searchHarness.load,
}));

vi.mock("@/transport", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/transport")>();
  return { ...actual, getTransport: () => transport };
});

import { TerminalView } from "@/components/terminal/TerminalView";

async function settle(): Promise<void> {
  for (let index = 0; index < 6; index += 1) {
    await act(async () => {
      await Promise.resolve();
    });
  }
}

function resetTerminalSearchState(): void {
  useTerminalStore.setState({
    terminals: {},
    terminalPanelByThread: {},
    ptyToThread: {},
    terminalSearchByPty: {},
    splitMode: false,
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  term.options.allowProposedApi = false;
  searchHarness.load.mockReset().mockResolvedValue({ SearchAddon: searchHarness.FakeSearchAddon });
  searchHarness.reset();
  synchronousFrameCount = 0;
  resetTerminalSearchState();
  term.write.mockImplementation((_data: string | Uint8Array, callback?: () => void) => callback?.());
  document.documentElement.style.setProperty("--muted", "rgb(20, 20, 20)");
  document.documentElement.style.setProperty("--border", "rgb(40, 40, 40)");
  document.documentElement.style.setProperty("--primary", "rgb(220, 160, 40)");
  document.documentElement.style.setProperty("--ring", "rgb(100, 140, 220)");
  vi.spyOn(window, "requestAnimationFrame").mockImplementation((callback) => {
    if (synchronousFrameCount >= 20) return 0;
    synchronousFrameCount += 1;
    callback(0);
    return 0;
  });
});

describe("TerminalView terminal search wiring", () => {
  it("captures Ctrl+F, searches through SearchAddon, maps options, and reports results", async () => {
    const view = render(<TerminalView ptyId="pty-search" visible threadActive />);
    await settle();
    expect(term.options.allowProposedApi).toBe(true);
    expect(term.options.screenReaderMode).toBe(false);

    const handler = term.attachCustomKeyEventHandler.mock.calls[0]?.[0];
    const preventDefault = vi.fn();
    let shortcutResult: boolean | undefined;
    act(() => {
      shortcutResult = handler?.({
        altKey: false,
        ctrlKey: true,
        key: "f",
        metaKey: false,
        preventDefault,
        shiftKey: false,
      } as unknown as KeyboardEvent);
    });
    expect(shortcutResult).toBe(false);
    expect(preventDefault).toHaveBeenCalledOnce();
    expect(useTerminalStore.getState().terminalSearchByPty["pty-search"]?.open).toBe(true);

    const input = await screen.findByRole("textbox", { name: "Find in terminal" });
    await act(async () => {
      fireEvent.change(input, { target: { value: "needle" } });
      fireEvent.click(screen.getByRole("button", { name: "Terminal search options" }));
    });
    const caseSensitive = await screen.findByRole("checkbox", { name: /Case sensitive/ });
    await act(async () => {
      fireEvent.click(caseSensitive);
      fireEvent.click(screen.getByRole("checkbox", { name: /Whole word/ }));
      fireEvent.click(screen.getByRole("checkbox", { name: /Regular expression/ }));
    });

    await waitFor(() => {
      expect(searchHarness.addon.findNext).toHaveBeenCalledWith(
        "needle",
        expect.objectContaining({
          caseSensitive: true,
          wholeWord: true,
          regex: true,
          incremental: true,
          decorations: {
            matchBackground: "rgb(20, 20, 20)",
            matchBorder: "rgb(40, 40, 40)",
            matchOverviewRuler: "rgb(220, 160, 40)",
            activeMatchBackground: "rgb(220, 160, 40)",
            activeMatchBorder: "rgb(100, 140, 220)",
            activeMatchColorOverviewRuler: "rgb(100, 140, 220)",
          },
        }),
      );
    });

    act(() => {
      searchHarness.emitResult({ resultIndex: 1, resultCount: 3 });
    });
    expect(screen.getByRole("status")).toHaveTextContent("2 / 3");

    view.unmount();
    expect(searchHarness.addon.dispose).toHaveBeenCalledOnce();
    expect(searchHarness.resultDisposable.dispose).toHaveBeenCalledOnce();
  });

  it("keeps PTY search state through hide/show without reloading its addon", async () => {
    const view = render(<TerminalView ptyId="pty-persist" visible threadActive />);
    await settle();
    const handler = term.attachCustomKeyEventHandler.mock.calls[0]?.[0];
    act(() => {
      handler?.({
        altKey: false,
        ctrlKey: true,
        key: "f",
        metaKey: false,
        preventDefault: vi.fn(),
        shiftKey: false,
      } as unknown as KeyboardEvent);
    });
    const input = await screen.findByRole("textbox", { name: "Find in terminal" });
    fireEvent.change(input, { target: { value: "persisted" } });

    view.rerender(<TerminalView ptyId="pty-persist" visible={false} threadActive />);
    expect(screen.queryByTestId("terminal-search-shelf")).toBeNull();
    view.rerender(<TerminalView ptyId="pty-persist" visible threadActive />);
    expect(await screen.findByDisplayValue("persisted")).toBeInTheDocument();
    expect(searchHarness.load).toHaveBeenCalledOnce();
    view.unmount();
  });

  it("shows addon failure recovery and retries without remounting the terminal", async () => {
    const warning = vi.spyOn(console, "warn").mockImplementation(() => {});
    const addonLoadError = new Error("search addon unavailable");
    searchHarness.load
      .mockRejectedValueOnce(addonLoadError)
      .mockResolvedValueOnce({ SearchAddon: searchHarness.FakeSearchAddon });
    const view = render(<TerminalView ptyId="pty-retry" visible threadActive />);
    await settle();

    const handler = term.attachCustomKeyEventHandler.mock.calls[0]?.[0];
    act(() => {
      handler?.({
        altKey: false,
        ctrlKey: true,
        key: "f",
        metaKey: false,
        preventDefault: vi.fn(),
        shiftKey: false,
      } as unknown as KeyboardEvent);
    });
    const input = await screen.findByRole("textbox", { name: "Find in terminal" });
    fireEvent.change(input, { target: { value: "retry" } });
    await waitFor(() => expect(screen.getByRole("status")).toHaveTextContent("Search unavailable"));
    expect(warning).toHaveBeenCalledWith(
      "[terminal] Search addon failed to load",
      addonLoadError,
    );

    fireEvent.click(screen.getByRole("button", { name: "Retry terminal search" }));
    await waitFor(() => expect(searchHarness.load).toHaveBeenCalledTimes(2));
    expect(screen.queryByRole("button", { name: "Retry terminal search" })).toBeNull();
    expect(term.attachCustomKeyEventHandler).toHaveBeenCalledOnce();
    view.unmount();
    warning.mockRestore();
  });
});
