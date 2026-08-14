import type { FitAddon } from "@xterm/addon-fit";
import type { Terminal } from "@xterm/xterm";
import {
  isContainerReadyForFit,
  isSafeTerminalDimensions,
  safeFit,
} from "./safeFit";
import type { TerminalScrollAnchor } from "./terminalScrollState";

/** Complete-cell dimensions accepted by the terminal resize transport. */
export type TerminalResizeDimensions = Readonly<{
  cols: number;
  rows: number;
}>;

/** Scroll intent captured around a renderer fit. */
export type TerminalResizeScrollIntent = TerminalScrollAnchor;

/** Dependencies and callbacks for one terminal's resize controller. */
export interface TerminalResizeControllerOptions {
  readonly container: HTMLElement;
  readonly fitAddon: FitAddon;
  readonly term: Terminal;
  readonly isActive: () => boolean;
  readonly isDisposed: () => boolean;
  readonly shouldDeferFit?: () => boolean;
  readonly runProgrammatic?: (fn: () => void) => void;
  readonly captureScrollIntent?: () => TerminalResizeScrollIntent;
  readonly restoreScrollIntent?: (intent: TerminalResizeScrollIntent) => void;
  readonly sendResize: (dimensions: TerminalResizeDimensions) => Promise<void> | void;
}

/** Controls safe frame-bounded fitting and latest-wins resize transport. */
export interface TerminalResizeController {
  readonly requestFit: () => void;
  readonly flushResize: () => void;
  readonly flushBeforeInput: () => void;
  readonly observe: () => void;
  readonly dispose: () => void;
}

/** Creates the resize controller for one mounted xterm renderer. */
export function createTerminalResizeController(
  options: TerminalResizeControllerOptions,
): TerminalResizeController {
  let frameId: number | null = null;
  let resizeTimer: ReturnType<typeof setTimeout> | null = null;
  let pendingDimensions: TerminalResizeDimensions | null = null;
  let lastSentDimensions: TerminalResizeDimensions | null = null;
  let disposed = false;

  const canResize = (): boolean =>
    !disposed &&
    !options.isDisposed() &&
    options.isActive() &&
    !options.shouldDeferFit?.() &&
    isContainerReadyForFit(options.container);

  const readSafeDimensions = (): TerminalResizeDimensions | null => {
    if (!canResize()) return null;
    const dimensions = options.fitAddon.proposeDimensions();
    return isSafeTerminalDimensions(dimensions) ? dimensions : null;
  };

  const restoreAfterFit = (intent: TerminalResizeScrollIntent | undefined): void => {
    if (intent === undefined || !options.restoreScrollIntent) return;
    options.restoreScrollIntent(intent);
  };

  const fitFrame = (): void => {
    frameId = null;
    const dimensions = readSafeDimensions();
    if (!dimensions) {
      pendingDimensions = null;
      return;
    }

    pendingDimensions = dimensions;
    const applyFit = (): void => {
      const intent = options.captureScrollIntent?.();
      if (!safeFit(options.fitAddon, options.container, options.term)) return;
      restoreAfterFit(intent);
      options.term.refresh(0, Math.max(0, options.term.rows - 1));
    };
    (options.runProgrammatic ?? ((fn: () => void) => fn()))(applyFit);
  };

  const requestFit = (): void => {
    if (!canResize()) return;
    if (frameId === null) frameId = requestAnimationFrame(fitFrame);
    pendingDimensions = readSafeDimensions();
    if (resizeTimer !== null) clearTimeout(resizeTimer);
    resizeTimer = setTimeout(() => {
      resizeTimer = null;
      flushResize();
    }, 100);
  };

  const flushResize = (): void => {
    if (resizeTimer !== null) {
      clearTimeout(resizeTimer);
      resizeTimer = null;
    }
    const dimensions = readSafeDimensions();
    pendingDimensions = dimensions;
    if (!dimensions) return;
    if (
      lastSentDimensions?.cols === dimensions.cols &&
      lastSentDimensions.rows === dimensions.rows
    ) {
      pendingDimensions = null;
      return;
    }
    lastSentDimensions = dimensions;
    pendingDimensions = null;
    void options.sendResize(dimensions);
  };

  const flushBeforeInput = (): void => {
    if (pendingDimensions !== null) flushResize();
  };

  const observer = new ResizeObserver(requestFit);

  return {
    requestFit,
    flushResize,
    flushBeforeInput,
    observe: () => observer.observe(options.container),
    dispose: () => {
      if (disposed) return;
      disposed = true;
      if (frameId !== null) cancelAnimationFrame(frameId);
      if (resizeTimer !== null) clearTimeout(resizeTimer);
      observer.disconnect();
      frameId = null;
      resizeTimer = null;
      pendingDimensions = null;
    },
  };
}
