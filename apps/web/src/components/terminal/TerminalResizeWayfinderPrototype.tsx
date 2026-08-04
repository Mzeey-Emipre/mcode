import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type PointerEvent as ReactPointerEvent,
} from "react";
import type { Terminal } from "@xterm/xterm";
import type { FitAddon } from "@xterm/addon-fit";
import {
  Activity,
  ArrowDownToLine,
  Cable,
  Check,
  CircleHelp,
  CloudOff,
  Eye,
  EyeOff,
  Gauge,
  History,
  MonitorDown,
  Play,
  Radio,
  RefreshCw,
  RotateCcw,
  ScrollText,
  TerminalSquare,
  Unplug,
  Waves,
  Zap,
} from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { ScrollArea } from "@/components/ui/scroll-area";
import {
  createTerminalWayfinderState,
  estimateCompleteTerminalGrid,
  reduceTerminalWayfinder,
  TERMINAL_WAYFINDER_IDS,
  type TerminalWayfinderAction,
  type TerminalWayfinderId,
  type TerminalWayfinderState,
} from "./terminalResizeWayfinderReducer";
import "@xterm/xterm/css/xterm.css";

const MIN_VIEWPORT_WIDTH = 160;
const MAX_VIEWPORT_WIDTH = 1_280;
const MIN_VIEWPORT_HEIGHT = 120;
const MAX_VIEWPORT_HEIGHT = 640;
const MIN_SAFE_COLS = 10;
const MIN_SAFE_ROWS = 3;
const MAX_COLS = 140;
const MAX_ROWS = 40;
const MAX_OUTPUT_BYTES = 128 * 1024;
const MAX_REPLAY_BYTES = 32 * 1024;

const WORKLOADS = [
  {
    id: "wrong-width-restoration",
    label: "Wrong-width restoration",
    detail: "80 → 120 → 80 columns with a post-restore marker.",
  },
  {
    id: "jagged-reflow",
    label: "Jagged reflow",
    detail: "Wide, combining, and emoji graphemes across narrow widths.",
  },
  {
    id: "shaky-live-resizing",
    label: "Shaky live resizing",
    detail: "ANSI-colored output while widths change repeatedly.",
  },
  {
    id: "bottom-row-clipping",
    label: "Bottom-row clipping",
    detail: "Cursor moves near the last complete row before output.",
  },
  {
    id: "high-output-pressure",
    label: "High-output pressure",
    detail: "Twenty bounded 4 KiB chunks, capped at 128 KiB.",
  },
  {
    id: "reconnect-recovery",
    label: "Reconnect recovery",
    detail: "Detached bytes replay in order with a bounded-gap marker.",
  },
  {
    id: "interactive-program",
    label: "Interactive program",
    detail: "Deterministic ready, pong, and done markers.",
  },
  {
    id: "process-cleanup",
    label: "Process cleanup",
    detail: "Lifecycle marker only; this shell fakes the PTY owner.",
  },
] as const;

type HarnessTerminal = {
  readonly term: Terminal;
  readonly fit: FitAddon;
  readonly disposables: readonly { dispose: () => void }[];
};

type HarnessTerminalMap = Partial<Record<TerminalWayfinderId, HarnessTerminal>>;
type ContainerMap = Partial<Record<TerminalWayfinderId, HTMLDivElement>>;
type PendingResize = {
  readonly pixelWidth: number;
  readonly pixelHeight: number;
  readonly reason: "control" | "raf" | "show" | "switch";
};

function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, Math.round(value)));
}

function bytesFor(value: string): number {
  return new TextEncoder().encode(value).length;
}

function lineCount(value: string): number {
  return Math.max(1, value.split("\n").length - (value.endsWith("\n") ? 1 : 0));
}

function boundedOutput(value: string): string {
  if (bytesFor(value) <= MAX_OUTPUT_BYTES) return value;
  const encoded = new TextEncoder().encode(value).slice(0, MAX_OUTPUT_BYTES);
  return new TextDecoder().decode(encoded);
}

function outputForWorkload(workloadId: string, burst = false): string {
  const e = "\u001b";
  if (workloadId === "jagged-reflow") {
    return `${e}[2J${e}[HWF:jagged:begin\n${"A界é🙂".repeat(44)}\nWF:jagged:tick:0:${"界".repeat(40)}\nWF:jagged:end\n`;
  }
  if (workloadId === "shaky-live-resizing") {
    return Array.from(
      { length: burst ? 12 : 5 },
      (_, index) => `${e}[38;5;${index % 16}mWF:resize:tick:${index}:resize${e}[0m\n`,
    ).join("");
  }
  if (workloadId === "bottom-row-clipping") {
    return `${e}[2J${e}[1;1HWF:bottom-row:top\n${e}[24;1HWF:bottom-row:initial\n${e}[8;1HWF:bottom-row:resized\nWF:bottom-row:end\n`;
  }
  if (workloadId === "high-output-pressure" || burst) {
    const payload = "0123456789abcdef".repeat(256);
    return boundedOutput(
      Array.from({ length: 20 }, (_, index) => `WF:high-output:chunk:${index}:${payload}\n`).join(""),
    );
  }
  if (workloadId === "reconnect-recovery") {
    return "WF:reconnect:middle\nWF:reconnect:after\n";
  }
  if (workloadId === "interactive-program") {
    return "WF:interactive:ready\nWF:interactive:pong\nWF:interactive:done\n";
  }
  if (workloadId === "process-cleanup") {
    return "WF:cleanup:parent\nWF:cleanup:child:in-memory\n";
  }
  return `${e}[2J${e}[HWF:wrong-width:initial\n${"W80:·".repeat(18)}\n${e}[24;1HWF:wrong-width:bottom\nWF:wrong-width:restored\n`;
}

function terminalSnapshot(term: Terminal): {
  readonly viewportY: number;
  readonly bufferLength: number;
  readonly linesFromBottom: number;
  readonly followingTail: boolean;
} {
  const buffer = term.buffer.active;
  const viewportY = Math.max(0, buffer.viewportY);
  const bufferLength = Math.max(0, buffer.length);
  const linesFromBottom = Math.max(0, bufferLength - viewportY - term.rows);
  return {
    viewportY,
    bufferLength,
    linesFromBottom,
    followingTail: linesFromBottom === 0,
  };
}

function restoreAnchor(term: Terminal, linesFromBottom: number): void {
  const buffer = term.buffer.active;
  const maxViewportY = Math.max(0, buffer.length - term.rows);
  term.scrollToLine(Math.max(0, Math.min(maxViewportY, buffer.length - linesFromBottom - term.rows)));
}

/** Minimal xterm-backed terminal behavior harness for Wayfinder #1075. */
export function TerminalResizeWayfinderPrototype() {
  const [state, setState] = useState<TerminalWayfinderState>(createTerminalWayfinderState);
  const [ready, setReady] = useState(false);
  const containerRefs = useRef<ContainerMap>({});
  const terminalRefs = useRef<HarnessTerminalMap>({});
  const pendingResizeRef = useRef<Partial<Record<TerminalWayfinderId, PendingResize>>>({});
  const resizeFrameRef = useRef<number | null>(null);
  const stateRef = useRef(state);
  const detachedOutputRef = useRef<Record<TerminalWayfinderId, string>>({ A: "", B: "" });
  const detachedGapRef = useRef<Record<TerminalWayfinderId, boolean>>({ A: false, B: false });
  const reconnectTimerRef = useRef<number | null>(null);
  stateRef.current = state;

  const dispatch = useCallback((action: TerminalWayfinderAction): void => {
    setState((current) => reduceTerminalWayfinder(current, action));
  }, []);

  const syncTelemetry = useCallback(
    (terminalId: TerminalWayfinderId): void => {
      const instance = terminalRefs.current[terminalId];
      if (!instance) return;
      const snapshot = terminalSnapshot(instance.term);
      dispatch({
        type: "scroll",
        terminalId,
        viewportY: snapshot.viewportY,
        bufferLength: snapshot.bufferLength,
        rows: instance.term.rows,
      });
    },
    [dispatch],
  );

  const applyResize = useCallback(
    (terminalId: TerminalWayfinderId, request: PendingResize): void => {
      const instance = terminalRefs.current[terminalId];
      const record = stateRef.current.terminals[terminalId];
      const estimated = estimateCompleteTerminalGrid(request.pixelWidth, request.pixelHeight);
      const hidden = stateRef.current.hidden || record.hidden;
      if (hidden) {
        dispatch({
          type: "resize-rejected",
          terminalId,
          pixelWidth: request.pixelWidth,
          pixelHeight: request.pixelHeight,
          ...estimated,
          reason: "hidden",
          at: performance.now(),
        });
        return;
      }
      if (!instance || estimated.cols < MIN_SAFE_COLS || estimated.rows < MIN_SAFE_ROWS) {
        dispatch({
          type: "resize-rejected",
          terminalId,
          pixelWidth: request.pixelWidth,
          pixelHeight: request.pixelHeight,
          ...estimated,
          reason: "unsafe",
          at: performance.now(),
        });
        return;
      }
      const before = terminalSnapshot(instance.term);
      const stable = stateRef.current.policy === "stable";
      const proposed = instance.fit.proposeDimensions();
      const proposedSafe =
        proposed != null &&
        proposed.cols >= MIN_SAFE_COLS &&
        proposed.rows >= MIN_SAFE_ROWS;
      let cols: number;
      let rows: number;
      if (stable && proposedSafe) {
        // Stable policy uses xterm's real fit path once per animation frame.
        instance.fit.fit();
        cols = clamp(instance.term.cols, MIN_SAFE_COLS, MAX_COLS);
        rows = clamp(instance.term.rows, MIN_SAFE_ROWS, MAX_ROWS);
        if (cols !== instance.term.cols || rows !== instance.term.rows) {
          instance.term.resize(cols, rows);
        }
      } else {
        const dimensions = proposedSafe ? proposed : estimated;
        cols = clamp(dimensions.cols, MIN_SAFE_COLS, MAX_COLS);
        rows = clamp(dimensions.rows, MIN_SAFE_ROWS, MAX_ROWS);
        instance.term.resize(cols, rows);
      }
      if (stable && !before.followingTail) restoreAnchor(instance.term, before.linesFromBottom);
      else instance.term.scrollToBottom();
      const after = terminalSnapshot(instance.term);
      dispatch({
        type: "resize-applied",
        terminalId,
        pixelWidth: request.pixelWidth,
        pixelHeight: request.pixelHeight,
        cols,
        rows,
        completeColumns: cols,
        completeRows: rows,
        viewportY: after.viewportY,
        bufferLength: after.bufferLength,
        linesFromBottom: after.linesFromBottom,
        followingTail: after.followingTail,
        restoredAnchor: stable && !before.followingTail,
        reason: request.reason,
        at: performance.now(),
      });
    },
    [dispatch],
  );

  const requestResize = useCallback(
    (
      terminalId: TerminalWayfinderId,
      pixelWidth: number,
      pixelHeight: number,
      reason: PendingResize["reason"] = "control",
    ): void => {
      const width = clamp(pixelWidth, MIN_VIEWPORT_WIDTH, MAX_VIEWPORT_WIDTH);
      const height = clamp(pixelHeight, MIN_VIEWPORT_HEIGHT, MAX_VIEWPORT_HEIGHT);
      const estimated = estimateCompleteTerminalGrid(width, height);
      dispatch({
        type: "resize-requested",
        terminalId,
        pixelWidth: width,
        pixelHeight: height,
        ...estimated,
        reason,
        at: performance.now(),
      });
      pendingResizeRef.current[terminalId] = {
        pixelWidth: width,
        pixelHeight: height,
        reason,
      };
      if (stateRef.current.policy === "native") {
        const pending = pendingResizeRef.current[terminalId];
        if (pending) applyResize(terminalId, pending);
        return;
      }
      if (resizeFrameRef.current !== null) return;
      resizeFrameRef.current = requestAnimationFrame(() => {
        resizeFrameRef.current = null;
        for (const id of TERMINAL_WAYFINDER_IDS) {
          const pending = pendingResizeRef.current[id];
          if (pending) applyResize(id, { ...pending, reason: "raf" });
        }
      });
    },
    [applyResize, dispatch],
  );

  const writeVisibleOutput = useCallback(
    (terminalId: TerminalWayfinderId, value: string): void => {
      const instance = terminalRefs.current[terminalId];
      if (!instance) return;
      const record = stateRef.current.terminals[terminalId];
      if (record.connection === "disconnected" || record.connection === "reconnecting") {
        const existing = detachedOutputRef.current[terminalId];
        const combined = `${existing}${value}`;
        const encoded = new TextEncoder().encode(combined);
        if (encoded.length > MAX_REPLAY_BYTES) {
          detachedOutputRef.current[terminalId] = new TextDecoder().decode(encoded.slice(-MAX_REPLAY_BYTES));
          detachedGapRef.current[terminalId] = true;
        } else {
          detachedOutputRef.current[terminalId] = combined;
        }
        dispatch({
          type: "output",
          terminalId,
          bytes: bytesFor(value),
          lines: lineCount(value),
          detached: true,
          viewportY: record.viewportY,
          bufferLength: record.bufferLength,
          linesFromBottom: record.linesFromBottom,
          followingTail: record.followingTail,
        });
        return;
      }
      const before = terminalSnapshot(instance.term);
      instance.term.write(value, () => {
        if (stateRef.current.policy === "native") instance.term.scrollToBottom();
        else if (!before.followingTail) restoreAnchor(instance.term, before.linesFromBottom);
        const after = terminalSnapshot(instance.term);
        dispatch({
          type: "output",
          terminalId,
          bytes: bytesFor(value),
          lines: lineCount(value),
          detached: false,
          viewportY: after.viewportY,
          bufferLength: after.bufferLength,
          linesFromBottom: after.linesFromBottom,
          followingTail: after.followingTail,
        });
      });
    },
    [dispatch],
  );

  const resetHarness = useCallback((): void => {
    for (const id of TERMINAL_WAYFINDER_IDS) {
      const instance = terminalRefs.current[id];
      if (instance) {
        instance.term.reset();
        instance.term.write(`WF:${id}:reset\n`, () => syncTelemetry(id));
      }
      detachedOutputRef.current[id] = "";
      detachedGapRef.current[id] = false;
    }
    pendingResizeRef.current = {};
    dispatch({ type: "reset" });
    window.requestAnimationFrame(() => {
      const current = stateRef.current;
      for (const id of TERMINAL_WAYFINDER_IDS) {
        const record = current.terminals[id];
        requestResize(id, record.pixelWidth, record.pixelHeight, "control");
      }
    });
  }, [dispatch, requestResize, syncTelemetry]);

  const reconnect = useCallback((): void => {
    const terminalId = stateRef.current.activeTerminalId;
    const record = stateRef.current.terminals[terminalId];
    if (record.connection !== "disconnected") return;
    const replay = detachedOutputRef.current[terminalId];
    const gap = detachedGapRef.current[terminalId];
    dispatch({ type: "reconnect-start", terminalId });
    reconnectTimerRef.current = window.setTimeout(() => {
      const instance = terminalRefs.current[terminalId];
      const before = instance ? terminalSnapshot(instance.term) : null;
      const finish = (): void => {
        if (!instance) return;
        if (stateRef.current.policy === "stable" && before && !before.followingTail) {
          restoreAnchor(instance.term, before.linesFromBottom);
        } else {
          instance.term.scrollToBottom();
        }
        const after = terminalSnapshot(instance.term);
        dispatch({
          type: "replay-applied",
          terminalId,
          bytes: bytesFor(replay),
          viewportY: after.viewportY,
          bufferLength: after.bufferLength,
          linesFromBottom: after.linesFromBottom,
          followingTail: after.followingTail,
          gap,
        });
        dispatch({ type: "reconnect-complete", terminalId, gap });
        detachedOutputRef.current[terminalId] = "";
        detachedGapRef.current[terminalId] = false;
      };
      if (!instance || replay.length === 0) {
        finish();
        return;
      }
      instance.term.write(replay, finish);
    }, 220);
  }, [dispatch]);

  useEffect(() => {
    let cancelled = false;
    void Promise.all([import("@xterm/xterm"), import("@xterm/addon-fit")]).then(
      ([core, fitModule]) => {
        if (cancelled) return;
        for (const id of TERMINAL_WAYFINDER_IDS) {
          const container = containerRefs.current[id];
          if (!container) continue;
          const term = new core.Terminal({
            convertEol: true,
            cursorBlink: false,
            fontFamily: "monospace",
            fontSize: 13,
            scrollback: 1_000,
            theme: {
              background: "#090a0f",
              foreground: "#e4e4e7",
              cursor: "#fbbf24",
              selectionBackground: "#5b4a18",
            },
          });
          const fit = new fitModule.FitAddon();
          term.loadAddon(fit);
          term.open(container);
          const scrollDisposable = term.onScroll(() => syncTelemetry(id));
          terminalRefs.current[id] = {
            term,
            fit,
            disposables: [scrollDisposable],
          };
          term.write(`WF:${id}:ready\n${outputForWorkload(id === "A" ? "wrong-width-restoration" : "jagged-reflow")}`);
        }
        setReady(true);
        window.requestAnimationFrame(() => {
          const current = stateRef.current;
          for (const id of TERMINAL_WAYFINDER_IDS) {
            const record = current.terminals[id];
            requestResize(id, record.pixelWidth, record.pixelHeight, "control");
          }
        });
      },
    );
    return () => {
      cancelled = true;
      if (resizeFrameRef.current !== null) cancelAnimationFrame(resizeFrameRef.current);
      if (reconnectTimerRef.current !== null) window.clearTimeout(reconnectTimerRef.current);
      for (const id of TERMINAL_WAYFINDER_IDS) {
        const instance = terminalRefs.current[id];
        instance?.disposables.forEach((disposable) => disposable.dispose());
        instance?.term.dispose();
      }
      terminalRefs.current = {};
    };
  }, [requestResize, syncTelemetry]);

  useEffect(() => {
    if (state.hidden || !ready) return;
    const record = state.terminals[state.activeTerminalId];
    requestResize(state.activeTerminalId, record.pixelWidth, record.pixelHeight, "show");
  }, [ready, requestResize, state.activeTerminalId, state.hidden]);

  const activeRecord = state.terminals[state.activeTerminalId];
  const activeWorkload = WORKLOADS.find((workload) => workload.id === state.scenario) ?? WORKLOADS[0];

  const setViewportDimension = (axis: "pixelWidth" | "pixelHeight", value: number): void => {
    const nextWidth = axis === "pixelWidth" ? value : activeRecord.pixelWidth;
    const nextHeight = axis === "pixelHeight" ? value : activeRecord.pixelHeight;
    requestResize(state.activeTerminalId, nextWidth, nextHeight);
  };

  const generateOutput = (burst = false): void => {
    writeVisibleOutput(state.activeTerminalId, boundedOutput(outputForWorkload(state.scenario, burst)));
  };

  const disconnect = (): void => {
    dispatch({ type: "disconnect", terminalId: state.activeTerminalId });
  };

  const addDetachedOutput = (): void => {
    writeVisibleOutput(state.activeTerminalId, outputForWorkload("reconnect-recovery"));
  };

  const switchTerminal = (): void => {
    const next = state.activeTerminalId === "A" ? "B" : "A";
    dispatch({ type: "switch-terminal", terminalId: next });
  };

  const handlePointerResize = (event: ReactPointerEvent<HTMLDivElement>): void => {
    const startX = event.clientX;
    const startWidth = activeRecord.pixelWidth;
    event.currentTarget.setPointerCapture(event.pointerId);
    const move = (moveEvent: PointerEvent): void => {
      if (!event.currentTarget.hasPointerCapture(event.pointerId)) return;
      setViewportDimension("pixelWidth", startWidth + moveEvent.clientX - startX);
    };
    const stop = (): void => {
      event.currentTarget.removeEventListener("pointermove", move);
      event.currentTarget.removeEventListener("pointerup", stop);
    };
    event.currentTarget.addEventListener("pointermove", move);
    event.currentTarget.addEventListener("pointerup", stop, { once: true });
  };

  const statusTone = activeRecord.connection === "connected" ? "secondary" : "destructive";
  const visibleState = state.hidden ? "hidden" : "visible";

  return (
    <main className="flex h-screen min-h-0 flex-col overflow-hidden bg-page text-foreground">
      <header className="flex flex-none items-center justify-between border-b border-border/60 bg-background px-4 py-3">
        <div className="flex min-w-0 items-center gap-3">
          <div className="flex size-8 items-center justify-center rounded-lg bg-primary text-primary-foreground">
            <TerminalSquare size={17} aria-hidden />
          </div>
          <div className="min-w-0">
            <p className="truncate text-sm font-semibold">Terminal Wayfinder</p>
            <p className="truncate text-xs text-muted-foreground">Disposable xterm-backed behavior harness · #1075</p>
          </div>
          <Badge variant="outline" size="sm">DEV ONLY</Badge>
        </div>
        <div className="flex items-center gap-2 text-xs text-muted-foreground">
          <span className="hidden sm:inline">xterm-backed seam</span>
          <Badge variant={statusTone}>{activeRecord.connection}</Badge>
        </div>
      </header>

      <section className="flex flex-none flex-wrap items-center gap-2 border-b border-border/60 bg-background px-4 py-2">
        <span className="mr-1 text-xs font-medium text-muted-foreground">Policy</span>
        <Button
          type="button"
          size="sm"
          variant={state.policy === "native" ? "secondary" : "ghost"}
          aria-pressed={state.policy === "native"}
          onClick={() => dispatch({ type: "set-policy", policy: "native" })}
        >
          <Gauge size={14} aria-hidden /> Native baseline
        </Button>
        <Button
          type="button"
          size="sm"
          variant={state.policy === "stable" ? "default" : "ghost"}
          aria-pressed={state.policy === "stable"}
          onClick={() => dispatch({ type: "set-policy", policy: "stable" })}
        >
          <Waves size={14} aria-hidden /> Stable session
        </Button>
        <span className="mx-1 h-4 w-px bg-border" aria-hidden />
        <Button type="button" size="sm" variant="outline" onClick={() => requestResize(state.activeTerminalId, 960, 360)}>
          Wide
        </Button>
        <Button type="button" size="sm" variant="outline" onClick={() => requestResize(state.activeTerminalId, 360, 360)}>
          Narrow
        </Button>
        <Button type="button" size="sm" variant="outline" onClick={() => requestResize(state.activeTerminalId, 960, 360)}>
          Wide again
        </Button>
        <Button type="button" size="sm" variant="ghost" onClick={resetHarness}>
          <RotateCcw size={14} aria-hidden /> Reset
        </Button>
        <span className="basis-full text-xs text-muted-foreground sm:basis-auto">
          Native: immediate fit + tail snap · Stable: RAF latest-wins + anchor hold + bounded replay
        </span>
      </section>

      <div className="flex min-h-0 flex-1 flex-col lg:flex-row">
        <aside className="flex min-h-0 w-full flex-none flex-col border-b border-border/60 bg-background lg:w-[30rem] lg:border-b-0 lg:border-r">
          <ScrollArea className="min-h-0 flex-1" viewportClassName="p-4">
            <section className="space-y-3">
              <div>
                <p className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">Scenario</p>
                <div className="mt-2 space-y-1">
                  {WORKLOADS.map((workload) => (
                    <Button
                      key={workload.id}
                      type="button"
                      size="sm"
                      variant={state.scenario === workload.id ? "secondary" : "ghost"}
                      className="h-auto w-full justify-start py-2 text-left"
                      onClick={() => dispatch({ type: "set-scenario", scenario: workload.id })}
                    >
                      <span className="min-w-0">
                        <span className="block truncate text-xs font-medium">{workload.label}</span>
                        <span className="block truncate text-xs text-muted-foreground">{workload.detail}</span>
                      </span>
                    </Button>
                  ))}
                </div>
              </div>

              <div className="space-y-2 border-t border-border/60 pt-3">
                <p className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">Controls</p>
                <div className="grid grid-cols-2 gap-1.5">
                  <Button type="button" size="sm" variant="outline" onClick={() => generateOutput()}>
                    <Play size={14} aria-hidden /> Output
                  </Button>
                  <Button type="button" size="sm" variant="outline" onClick={() => generateOutput(true)}>
                    <Zap size={14} aria-hidden /> High burst
                  </Button>
                  <Button type="button" size="sm" variant="outline" onClick={() => terminalRefs.current[state.activeTerminalId]?.term.scrollToLine(0)}>
                    <History size={14} aria-hidden /> History
                  </Button>
                  <Button type="button" size="sm" variant="outline" onClick={() => terminalRefs.current[state.activeTerminalId]?.term.scrollToBottom()}>
                    <ArrowDownToLine size={14} aria-hidden /> Tail
                  </Button>
                  <Button type="button" size="sm" variant="outline" onClick={() => dispatch({ type: "set-hidden", hidden: !state.hidden })}>
                    {state.hidden ? <Eye size={14} aria-hidden /> : <EyeOff size={14} aria-hidden />} {state.hidden ? "Show" : "Hide"}
                  </Button>
                  <Button type="button" size="sm" variant="outline" onClick={switchTerminal}>
                    <RefreshCw size={14} aria-hidden /> Switch A/B
                  </Button>
                  <Button type="button" size="sm" variant="outline" onClick={disconnect} disabled={activeRecord.connection !== "connected"}>
                    <Unplug size={14} aria-hidden /> Disconnect
                  </Button>
                  <Button type="button" size="sm" variant="outline" onClick={addDetachedOutput} disabled={activeRecord.connection === "connected"}>
                    <CloudOff size={14} aria-hidden /> Detached output
                  </Button>
                  <Button type="button" size="sm" variant="outline" className="col-span-2" onClick={reconnect} disabled={activeRecord.connection !== "disconnected"}>
                    <Cable size={14} aria-hidden /> Reconnect / replay
                  </Button>
                </div>
              </div>

              <div className="space-y-2 border-t border-border/60 pt-3">
                <p className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">Pixel viewport</p>
                <div className="grid grid-cols-2 gap-2">
                  <label className="space-y-1 text-xs text-muted-foreground">
                    Width
                    <Input
                      size="sm"
                      type="number"
                      min={MIN_VIEWPORT_WIDTH}
                      max={MAX_VIEWPORT_WIDTH}
                      value={activeRecord.pixelWidth}
                      onChange={(event) => setViewportDimension("pixelWidth", Number(event.target.value))}
                    />
                  </label>
                  <label className="space-y-1 text-xs text-muted-foreground">
                    Height
                    <Input
                      size="sm"
                      type="number"
                      min={MIN_VIEWPORT_HEIGHT}
                      max={MAX_VIEWPORT_HEIGHT}
                      value={activeRecord.pixelHeight}
                      onChange={(event) => setViewportDimension("pixelHeight", Number(event.target.value))}
                    />
                  </label>
                </div>
                <p className="text-xs text-muted-foreground">Drag the amber edge on the terminal to send repeated pixel resize requests.</p>
              </div>

              <div className="rounded-lg border border-border/60 bg-muted/20 p-3 text-xs text-muted-foreground">
                <div className="flex items-center gap-2 font-medium text-foreground"><CircleHelp size={14} aria-hidden /> Walkthrough</div>
                <ol className="mt-2 list-decimal space-y-1 pl-4">
                  <li>Use Wide → Narrow → Wide again while output is running.</li>
                  <li>Scroll to history, generate output, then resize.</li>
                  <li>Hide, generate output, show, then switch A → B → A.</li>
                  <li>Disconnect, add detached output, reconnect and inspect replay.</li>
                </ol>
              </div>
            </section>
          </ScrollArea>
        </aside>

        <section className="flex min-h-0 min-w-0 flex-1 flex-col bg-[#111217]">
          <div className="flex flex-none flex-wrap items-center gap-x-3 gap-y-1 border-b border-white/10 bg-[#17181f] px-3 py-2 text-xs text-zinc-300">
            <span className="flex items-center gap-1.5 font-medium text-white"><Activity size={14} aria-hidden /> {activeWorkload.label}</span>
            <span className="text-zinc-500">{activeWorkload.detail}</span>
            <span className="ml-auto flex items-center gap-1.5"><Radio size={13} className="text-amber-400" aria-hidden /> {visibleState}</span>
          </div>
          <div className="relative flex min-h-0 flex-1 overflow-auto p-4">
            {TERMINAL_WAYFINDER_IDS.map((id) => {
              const record = state.terminals[id];
              const active = id === state.activeTerminalId;
              return (
                <div
                  key={id}
                  className={active ? "relative shrink-0" : "absolute left-4 top-4 shrink-0"}
                  style={{
                    width: record.pixelWidth,
                    height: record.pixelHeight,
                    visibility: active && !state.hidden ? "visible" : "hidden",
                  }}
                  aria-hidden={!active || state.hidden}
                >
                  <div ref={(node) => { if (node) containerRefs.current[id] = node; }} className="size-full overflow-hidden rounded-md border border-amber-500/40 bg-[#090a0f] shadow-2xl" />
                  {active && !state.hidden ? (
                    <div
                      role="separator"
                      tabIndex={0}
                      aria-label="Drag to resize terminal viewport"
                      aria-orientation="vertical"
                      aria-valuemin={MIN_VIEWPORT_WIDTH}
                      aria-valuemax={MAX_VIEWPORT_WIDTH}
                      aria-valuenow={record.pixelWidth}
                      className="absolute -right-3 top-4 z-10 flex h-16 w-6 cursor-ew-resize items-center justify-center rounded-r-md border border-amber-500/50 bg-amber-500/80 text-amber-950 outline-none focus-visible:ring-2 focus-visible:ring-amber-300"
                      onPointerDown={handlePointerResize}
                      onKeyDown={(event) => {
                        const next = event.key === "ArrowLeft" ? record.pixelWidth - 24 : event.key === "ArrowRight" ? record.pixelWidth + 24 : record.pixelWidth;
                        if (next !== record.pixelWidth) {
                          event.preventDefault();
                          requestResize(id, next, record.pixelHeight);
                        }
                      }}
                    >
                      <MonitorDown size={14} aria-hidden />
                    </div>
                  ) : null}
                </div>
              );
            })}
          </div>

          <div className="grid flex-none grid-cols-2 gap-px border-t border-white/10 bg-white/10 text-xs text-zinc-300 sm:grid-cols-4 lg:grid-cols-8">
            <TelemetryCell label="pixel viewport" value={`${activeRecord.pixelWidth} × ${activeRecord.pixelHeight}px`} />
            <TelemetryCell label="grid" value={`${activeRecord.cols} × ${activeRecord.rows}`} />
            <TelemetryCell label="complete cols × rows" value={`${activeRecord.completeColumns} × ${activeRecord.completeRows}`} />
            <TelemetryCell label="viewportY" value={`${activeRecord.viewportY}`} />
            <TelemetryCell label="buffer length" value={`${activeRecord.bufferLength}`} />
            <TelemetryCell label="from bottom" value={`${activeRecord.linesFromBottom}`} />
            <TelemetryCell label="tail state" value={activeRecord.followingTail ? "following tail" : "scrolled back"} />
            <TelemetryCell label="terminal" value={`${activeRecord.label} · ${activeRecord.hidden ? "hidden" : "visible"}`} />
          </div>

          <div className="flex flex-none flex-col gap-2 border-t border-white/10 bg-[#17181f] p-3 text-xs text-zinc-300 xl:flex-row">
            <div className="flex min-w-0 flex-1 flex-wrap items-center gap-2">
              <Badge variant={activeRecord.connection === "connected" ? "secondary" : "destructive"}>{activeRecord.connection}</Badge>
              <Badge variant="outline">replay: {activeRecord.replay}</Badge>
              <span>output {activeRecord.outputBytes} B</span>
              <span>detached {activeRecord.detachedOutputBytes} B</span>
              <span>replayed {activeRecord.replayedOutputBytes} B</span>
              {activeRecord.restoredAnchor ? <span className="flex items-center gap-1 text-emerald-300"><Check size={13} aria-hidden /> anchor restored</span> : null}
              <span className="basis-full text-zinc-500">resize trace: {state.lastResizeEvents.slice(-4).map((event) => `${event.kind} ${event.terminalId} ${event.cols}×${event.rows}`).join(" · ") || "none"}</span>
            </div>
            <div className="flex min-w-0 items-center gap-2 xl:max-w-[45%]">
              <ScrollText size={13} className="shrink-0 text-amber-300" aria-hidden />
              <span className="truncate text-zinc-400">last resize: {formatResizeEvent(state.lastResizeEvents.at(-1))}</span>
            </div>
          </div>
        </section>
      </div>
    </main>
  );
}

function formatResizeEvent(event: TerminalWayfinderState["lastResizeEvents"][number] | undefined): string {
  if (!event) return "none";
  return `${event.kind} ${event.terminalId} ${event.pixelWidth}×${event.pixelHeight}px → ${event.cols}×${event.rows} (${event.reason})`;
}

function TelemetryCell({ label, value }: { readonly label: string; readonly value: string }) {
  return (
    <div className="min-w-0 bg-[#17181f] px-2.5 py-2">
      <p className="truncate text-xs uppercase tracking-wide text-zinc-500">{label}</p>
      <p className="mt-0.5 truncate font-mono tabular-nums text-zinc-100">{value}</p>
    </div>
  );
}
