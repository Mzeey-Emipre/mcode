import { beforeEach, afterEach, describe, expect, it, vi } from "vitest";
import type { FitAddon } from "@xterm/addon-fit";
import type { Terminal } from "@xterm/xterm";
import {
  createTerminalResizeController,
  type TerminalResizeDimensions,
} from "../terminalResizeController";
import type { TerminalScrollAnchor } from "../terminalScrollState";

type ResizeCallback = () => void;
let pendingFrames: FrameRequestCallback[] = [];

class ResizeObserverStub {
  static callback: ResizeCallback | undefined;

  constructor(callback: ResizeCallback) {
    ResizeObserverStub.callback = callback;
  }

  observe(): void {}

  disconnect(): void {}
}

function makeContainer(width = 240, height = 120): HTMLElement {
  const container = document.createElement("div");
  Object.defineProperty(container, "clientWidth", { configurable: true, value: width });
  Object.defineProperty(container, "clientHeight", { configurable: true, value: height });
  return container;
}

function makeTerminal() {
  const term = {
    cols: 80,
    rows: 24,
    buffer: { active: { viewportY: 0, length: 200 } },
    refresh: vi.fn(),
  } as unknown as Terminal & { cols: number; rows: number };
  const dimensions = { cols: 80, rows: 24 };
  const fit = vi.fn(() => {
    term.cols = dimensions.cols;
    term.rows = dimensions.rows;
  });
  const fitAddon = {
    fit,
    proposeDimensions: () => dimensions,
  } as unknown as FitAddon;
  return { term, fitAddon, dimensions, fit };
}

function makeController(
  sendResize: (dimensions: TerminalResizeDimensions) => void,
  options?: {
    readonly active?: () => boolean;
    readonly runProgrammatic?: (fn: () => void) => void;
    readonly capture?: () => TerminalScrollAnchor;
    readonly restore?: (intent: TerminalScrollAnchor) => void;
  },
) {
  const { term, fitAddon, dimensions, fit } = makeTerminal();
  const container = makeContainer();
  const controller = createTerminalResizeController({
    container,
    fitAddon,
    term,
    isActive: options?.active ?? (() => true),
    isDisposed: () => false,
    runProgrammatic: options?.runProgrammatic,
    captureScrollIntent: options?.capture,
    restoreScrollIntent: options?.restore,
    sendResize,
  });
  return { controller, term, dimensions, fit, container };
}

describe("terminalResizeController", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    pendingFrames = [];
    vi.stubGlobal("ResizeObserver", ResizeObserverStub);
    vi.stubGlobal("requestAnimationFrame", (callback: FrameRequestCallback) => {
      pendingFrames.push(callback);
      return pendingFrames.length;
    });
    vi.stubGlobal("cancelAnimationFrame", (id: number) => {
      pendingFrames.splice(id - 1, 1);
    });
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  it("fits repeated notifications once per frame and sends the latest safe grid", () => {
    const sent: TerminalResizeDimensions[] = [];
    const { controller, dimensions, fit } = makeController((value) => sent.push(value));

    controller.observe();
    controller.requestFit();
    expect(pendingFrames).toHaveLength(1);
    dimensions.cols = 120;
    dimensions.rows = 30;
    ResizeObserverStub.callback?.();
    pendingFrames.shift()?.(0);
    expect(fit).toHaveBeenCalledTimes(1);

    vi.advanceTimersByTime(100);
    expect(sent).toEqual([{ cols: 120, rows: 30 }]);
    controller.dispose();
  });

  it("does nothing for inactive or unsafe containers", () => {
    const sent: TerminalResizeDimensions[] = [];
    let active = false;
    const { controller, fit } = makeController((value) => sent.push(value), {
      active: () => active,
    });

    controller.requestFit();
    vi.advanceTimersByTime(100);
    expect(fit).not.toHaveBeenCalled();
    expect(sent).toHaveLength(0);

    active = true;
    controller.dispose();
    const unsafe = makeController((value) => sent.push(value));
    Object.defineProperty(unsafe.container, "clientWidth", { configurable: true, value: 0 });
    unsafe.controller.requestFit();
    vi.advanceTimersByTime(100);
    expect(unsafe.fit).not.toHaveBeenCalled();
    expect(sent).toHaveLength(0);
    unsafe.controller.dispose();
  });

  it("does not send duplicate grid dimensions", () => {
    const sent: TerminalResizeDimensions[] = [];
    const { controller } = makeController((value) => sent.push(value));

    controller.requestFit();
    vi.advanceTimersByTime(100);
    controller.requestFit();
    vi.advanceTimersByTime(100);
    expect(sent).toEqual([{ cols: 80, rows: 24 }]);
    controller.dispose();
  });

  it("restores the captured intent and refreshes the final row after fitting", () => {
    const intent: TerminalScrollAnchor = {
      viewportY: 20,
      linesFromBottom: 8,
      bufferLength: 200,
    };
    const restore = vi.fn();
    const { controller, term, dimensions } = makeController(vi.fn(), {
      capture: () => intent,
      restore,
    });

    dimensions.cols = 100;
    dimensions.rows = 30;
    controller.requestFit();
    pendingFrames.shift()?.(0);
    expect(restore).toHaveBeenCalledWith(intent);
    expect(term.refresh).toHaveBeenCalledWith(0, 29);
    controller.dispose();
  });

  it("wraps fit and restore in one programmatic scroll transaction", () => {
    const events: string[] = [];
    const intent: TerminalScrollAnchor = {
      viewportY: 20,
      linesFromBottom: 8,
      bufferLength: 200,
    };
    const { controller, dimensions, fit } = makeController(vi.fn(), {
      runProgrammatic: (fn) => {
        events.push("enter");
        fn();
        events.push("exit");
      },
      capture: () => {
        events.push("capture");
        return intent;
      },
      restore: () => events.push("restore"),
    });
    fit.mockImplementation(() => events.push("fit"));
    dimensions.cols = 100;
    dimensions.rows = 30;
    controller.requestFit();
    pendingFrames.shift()?.(0);

    expect(events).toEqual(["enter", "capture", "fit", "restore", "exit"]);
    controller.dispose();
  });

  it("flushes a pending resize before later input is forwarded", () => {
    const events: string[] = [];
    const { controller } = makeController(() => events.push("resize"));

    controller.requestFit();
    controller.flushBeforeInput();
    events.push("input");
    expect(events).toEqual(["resize", "input"]);
    controller.dispose();
  });
});
