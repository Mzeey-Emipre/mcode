import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type KeyboardEvent as ReactKeyboardEvent,
} from "react";
import { Terminal } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";
import { Activity, Check, Clipboard, Copy, Eye, EyeOff, RefreshCw, Send, Square, WifiOff } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { getTransport } from "@/transport";
import { startPushListeners, stopPushListeners } from "@/transport/ws-events";
import { useWorkspaceStore } from "@/stores/workspaceStore";
import { onPtyData, onPtyExit, onPtyReconnectGap } from "./ptyDataRegistry";
import { GhosttyVtCanvasRenderer } from "./GhosttyVtCanvasRenderer";
import {
  coalesceRendererResize,
  compareRendererInputFrames,
  markerCoverage,
  RENDERER_CAPABILITY_MATRIX,
  restoreRendererViewportAnchor,
  summarizeRendererTimings,
  TERMINAL_RENDERER_WORKLOAD_IDS,
  TERMINAL_RENDERER_WORKLOAD_LIMITS,
  type RendererViewportAnchor,
  type RendererRunMetrics,
  type RendererInputFrame,
  type TerminalRendererCandidate,
  type TerminalRendererWorkloadId,
} from "./rendererHeadToHeadModel";
import "@xterm/xterm/css/xterm.css";

type GhosttyStatus = "loading" | "ready" | "blocked";

type Workload = {
  readonly id: TerminalRendererWorkloadId;
  readonly label: string;
  readonly purpose: string;
  readonly markers: readonly string[];
  readonly expectedProgramBytes: number | null;
};

type Metrics = {
  readonly outputBytes: number;
  readonly outputFrames: number;
  readonly resizeCount: number;
  readonly lastPaintMs: number | null;
  readonly switchLatencyMs: number | null;
  readonly inputLatencyMs: number | null;
  readonly markerCoverage: number;
  readonly replayGap: boolean;
  readonly processExited: boolean;
};

type CandidateTimingState = {
  readonly parseSamples: number[];
  readonly paintSamples: number[];
  readonly resizeSamples: number[];
  readonly switchSamples: number[];
  throughputBytesPerSecond: number | null;
  processingDurationMs: number;
  markerCoverage: number;
  droppedFrames: number;
  lostInputEvents: number;
  longFrameCount: number;
  failures: string[];
};

type ComparisonRun = {
  readonly run: number;
  readonly workloadId: TerminalRendererWorkloadId;
  readonly order: readonly TerminalRendererCandidate[];
  readonly timingMethod: "paired-isolated-replay";
  readonly inputFrames: readonly RendererInputFrame[];
  readonly inputFrameCount: number;
  readonly dispatchedFrameEqual: boolean;
  readonly outputBytes: number;
  readonly outputFrames: number;
  readonly outputTruncated: boolean;
  readonly expectedProgramBytes: number | null;
  readonly completion: "marker" | "process-exit" | "timeout" | "error";
  readonly transportFailure: string | null;
  readonly classification: "pass" | "candidate-failure" | "harness-indeterminate" | "harness-failure";
  readonly resizeCount: number;
  readonly markerCoverage: Readonly<Record<TerminalRendererCandidate, number>>;
  readonly droppedFrames: Readonly<Record<TerminalRendererCandidate, number>>;
  readonly lostInputEvents: Readonly<Record<TerminalRendererCandidate, number>>;
  readonly metrics: Readonly<Record<TerminalRendererCandidate, RendererRunMetrics>>;
  readonly failures: readonly string[];
};

type WorkloadCompletion = "marker" | "process-exit" | "timeout" | "error";

const WORKLOADS: readonly Workload[] = [
  {
    id: "wrong-width-restoration",
    label: "Wrong-width restoration",
    purpose: "80 → 120 → 80 complete-cell resize and bottom-row marker.",
    markers: ["WF:wrong-width:initial", "WF:wrong-width:bottom", "WF:wrong-width:restored"],
    expectedProgramBytes: null,
  },
  {
    id: "jagged-reflow",
    label: "Jagged reflow",
    purpose: "Wide, combining, and emoji graphemes across four narrow widths.",
    markers: ["WF:jagged:begin", "WF:jagged:end"],
    expectedProgramBytes: null,
  },
  {
    id: "shaky-live-resizing",
    label: "Shaky live resizing",
    purpose: "ANSI color output while resize requests are coalesced at frame rate.",
    markers: ["WF:resize:tick", "WF:resize:end"],
    expectedProgramBytes: null,
  },
  {
    id: "bottom-row-clipping",
    label: "Bottom-row clipping",
    purpose: "Cursor movement near the final complete row before output.",
    markers: ["WF:bottom-row:top", "WF:bottom-row:end"],
    expectedProgramBytes: null,
  },
  {
    id: "high-output-pressure",
    label: "High-output pressure",
    purpose: "Twenty bounded 4 KiB chunks, capped at 128 KiB.",
    markers: ["WF:high-output:begin", "WF:high-output:end"],
    expectedProgramBytes: 82_450,
  },
  {
    id: "reconnect-recovery",
    label: "Reconnect recovery",
    purpose: "Pause and reattach with bounded replay and a visible gap state.",
    markers: ["WF:reconnect:before", "WF:reconnect:after"],
    expectedProgramBytes: null,
  },
  {
    id: "interactive-program",
    label: "Interactive program",
    purpose: "Ready, ping/pong, and done markers through the same PTY input path.",
    markers: ["WF:interactive:ready", "WF:interactive:pong", "WF:interactive:done"],
    expectedProgramBytes: null,
  },
  {
    id: "process-cleanup",
    label: "Process cleanup",
    purpose: "Parent and child lifecycle markers followed by explicit PTY cleanup.",
    markers: ["WF:cleanup:parent", "WF:cleanup:child:"],
    expectedProgramBytes: null,
  },
];

const PROGRAMS: Readonly<Record<TerminalRendererWorkloadId, string>> = {
  "wrong-width-restoration": String.raw`const e = "\x1b";
const fill = (width, label) => label + "·".repeat(Math.max(0, width - label.length));
process.stdout.write(e + "[2J" + e + "[H");
process.stdout.write("WF:wrong-width:initial\n");
process.stdout.write(fill(80, "W80:") + "\n");
process.stdout.write(e + "[24;1H" + "WF:wrong-width:bottom\n");
setTimeout(() => process.stdout.write("WF:wrong-width:restored\n"), 160);
setTimeout(() => process.exit(0), 280);`,
  "jagged-reflow": String.raw`const e = "\x1b";
const wide = "A界é🙂".repeat(40);
process.stdout.write(e + "[2J" + e + "[H" + "WF:jagged:begin\n");
process.stdout.write(wide + "\n");
let tick = 0;
const timer = setInterval(() => {
  process.stdout.write("WF:jagged:tick:" + tick + ":" + wide.slice(0, 120) + "\n");
  tick += 1;
}, 45);
setTimeout(() => { clearInterval(timer); process.stdout.write("WF:jagged:end\n"); process.exit(0); }, 320);`,
  "shaky-live-resizing": String.raw`const e = "\x1b";
let tick = 0;
const timer = setInterval(() => {
  process.stdout.write("WF:resize:tick:" + tick + ":" + e + "[38;5;" + (tick % 16) + "mresize\n");
  tick += 1;
}, 15);
setTimeout(() => { clearInterval(timer); process.stdout.write(e + "[0mWF:resize:end\n"); process.exit(0); }, 300);`,
  "bottom-row-clipping": String.raw`const e = "\x1b";
process.stdout.write(e + "[2J" + e + "[1;1H" + "WF:bottom-row:top\n");
process.stdout.write(e + "[24;1H" + "WF:bottom-row:initial\n");
setTimeout(() => process.stdout.write(e + "[8;1H" + "WF:bottom-row:resized\n"), 80);
setTimeout(() => process.stdout.write("WF:bottom-row:end\n"), 180);
setTimeout(() => process.exit(0), 260);`,
  "high-output-pressure": String.raw`const payload = "0123456789abcdef".repeat(256);
process.stdout.write("WF:high-output:begin\n");
for (let index = 0; index < 20; index += 1) {
  process.stdout.write("WF:high-output:chunk:" + index + ":" + payload + "\n");
}
process.stdout.write("WF:high-output:end\n");
process.exit(0);`,
  "reconnect-recovery": String.raw`let pending = "";
process.stdout.write("WF:reconnect:before\n");
process.stdin.setEncoding("utf8");
process.stdin.on("data", (chunk) => {
  pending += chunk;
  let newline = pending.search(/[\r\n]/);
  while (newline >= 0) {
    const line = pending.slice(0, newline);
    pending = pending.slice(newline + 1);
    if (pending.startsWith("\n")) pending = pending.slice(1);
    if (line === "gap") {
      setTimeout(() => process.stdout.write("WF:reconnect:middle\n"), 60);
      setTimeout(() => process.stdout.write("WF:reconnect:after\n"), 220);
      setTimeout(() => process.exit(0), 340);
    }
    newline = pending.search(/[\r\n]/);
  }
});`,
  "interactive-program": String.raw`let pending = "";
process.stdout.write("WF:interactive:ready\n");
process.stdin.setEncoding("utf8");
process.stdin.on("data", (chunk) => {
  pending += chunk;
  let newline = pending.search(/[\r\n]/);
  while (newline >= 0) {
    const line = pending.slice(0, newline);
    pending = pending.slice(newline + 1);
    if (pending.startsWith("\n")) pending = pending.slice(1);
    if (line === "ping") process.stdout.write("WF:interactive:pong\n");
    if (line === "exit") { process.stdout.write("WF:interactive:done\n"); process.exit(0); }
    newline = pending.search(/[\r\n]/);
  }
});`,
  "process-cleanup": String.raw`const { spawn } = require("node:child_process");
const child = spawn(process.execPath, ["-e", "setTimeout(() => {}, 50)"], { stdio: "ignore" });
process.stdout.write("WF:cleanup:parent\n");
process.stdout.write("WF:cleanup:child:" + child.pid + "\n");
child.once("exit", () => process.stdout.write("WF:cleanup:child-exit\n"));
setTimeout(() => process.exit(0), 180);`,
};

const INITIAL_COLS = 80;
const INITIAL_ROWS = 24;
const CELL_WIDTH = 9;
const CELL_HEIGHT = 18;

function encodeNodeProgram(source: string): string {
  const bytes = new TextEncoder().encode(source);
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return `node -e "eval(Buffer.from('${btoa(binary)}','base64').toString())"\r`;
}

function terminalAnchor(term: Terminal): RendererViewportAnchor {
  const buffer = term.buffer.active;
  const linesFromBottom = Math.max(
    0,
    buffer.length - buffer.viewportY - term.rows,
  );
  return { linesFromBottom, followingTail: linesFromBottom === 0 };
}

function textFromXterm(term: Terminal): string {
  const lines: string[] = [];
  for (let index = 0; index < term.buffer.active.length; index += 1) {
    lines.push(term.buffer.active.getLine(index)?.translateToString(true) ?? "");
  }
  return lines.join("\n");
}

function keyToPtyData(event: ReactKeyboardEvent<HTMLDivElement>): string | null {
  if (event.key.length === 1) return event.key;
  if (event.key === "Enter") return "\r";
  if (event.key === "Backspace") return "\u007f";
  if (event.key === "Tab") return "\t";
  const arrows: Record<string, string> = {
    ArrowUp: "\u001b[A",
    ArrowDown: "\u001b[B",
    ArrowRight: "\u001b[C",
    ArrowLeft: "\u001b[D",
  };
  return arrows[event.key] ?? null;
}

function initialMetrics(workload: Workload): Metrics {
  return {
    outputBytes: 0,
    outputFrames: 0,
    resizeCount: 0,
    lastPaintMs: null,
    switchLatencyMs: null,
    inputLatencyMs: null,
    markerCoverage: markerCoverage("", workload.markers),
    replayGap: false,
    processExited: false,
  };
}

function initialCandidateTimingState(): CandidateTimingState {
  return {
    parseSamples: [],
    paintSamples: [],
    resizeSamples: [],
    switchSamples: [],
    throughputBytesPerSecond: null,
    processingDurationMs: 0,
    markerCoverage: 0,
    droppedFrames: 0,
    lostInputEvents: 0,
    longFrameCount: 0,
    failures: [],
  };
}

function candidateRunMetrics(state: CandidateTimingState): RendererRunMetrics {
  return {
    parseRender: summarizeRendererTimings(state.parseSamples),
    paintBoundary: summarizeRendererTimings(state.paintSamples),
    throughputBytesPerSecond: state.throughputBytesPerSecond,
    resizeToStablePaintMs: state.resizeSamples.at(-1) ?? null,
    switchRestoreMs: state.switchSamples.at(-1) ?? null,
    markerCoverage: state.markerCoverage,
    droppedFrames: state.droppedFrames,
    lostInputEvents: state.lostInputEvents,
    longFrameCount: state.longFrameCount,
    failures: state.failures,
  };
}

function frameDigest(bytes: Uint8Array): string {
  let hash = 2166136261;
  for (const byte of bytes) hash = Math.imul(hash ^ byte, 16777619);
  return (hash >>> 0).toString(16).padStart(8, "0");
}

/** Throwaway route for comparing strengthened xterm with real libghostty-vt. */
export function TerminalRendererHeadToHeadPrototype() {
  const activeThreadId = useWorkspaceStore((state) => state.activeThreadId);
  const activeWorkspaceId = useWorkspaceStore((state) => state.activeWorkspaceId);
  const [candidate, setCandidate] = useState<TerminalRendererCandidate>("xterm");
  const [workloadId, setWorkloadId] = useState<TerminalRendererWorkloadId>(
    TERMINAL_RENDERER_WORKLOAD_IDS[0],
  );
  const [pty, setPty] = useState<{ id: string; shell: string } | null>(null);
  const [ptyReady, setPtyReady] = useState(false);
  const [connectionError, setConnectionError] = useState<string | null>(null);
  const [ghosttyStatus, setGhosttyStatus] = useState<GhosttyStatus>("loading");
  const [ghosttyError, setGhosttyError] = useState<string | null>(null);
  const [visible, setVisible] = useState(true);
  const [dimensions, setDimensions] = useState({ cols: INITIAL_COLS, rows: INITIAL_ROWS });
  const [metrics, setMetrics] = useState<Metrics>(() => initialMetrics(WORKLOADS[0]));
  const [runMode, setRunMode] = useState<"quick" | "thirty">("quick");
  const [comparisonRuns, setComparisonRuns] = useState<ComparisonRun[]>([]);
  const [comparisonRunning, setComparisonRunning] = useState(false);
  const [sizeManifest, setSizeManifest] = useState<{ xterm: { rawBytes: number; gzipBytes: number; webglAddon: { rawBytes: number; gzipBytes: number } }; ghostty: { rawBytes: number; gzipBytes: number } } | null>(null);
  const [ghosttySnapshot, setGhosttySnapshot] = useState({ dirtyRows: 0, renderCount: 0, text: "" });
  const workload = useMemo(
    () => WORKLOADS.find((item) => item.id === workloadId) ?? WORKLOADS[0],
    [workloadId],
  );

  useEffect(() => {
    void fetch("/prototypes/renderer-size-manifest.json")
      .then((response) => response.ok ? response.json() : null)
      .then((manifest: typeof sizeManifest) => setSizeManifest(manifest))
      .catch(() => setSizeManifest(null));
  }, []);

  useEffect(() => {
    startPushListeners();
    return () => stopPushListeners();
  }, []);
  const xtermContainerRef = useRef<HTMLDivElement>(null);
  const ghosttyCanvasRef = useRef<HTMLCanvasElement>(null);
  const ghosttySurfaceRef = useRef<HTMLDivElement>(null);
  const terminalRef = useRef<Terminal | null>(null);
  const fitRef = useRef<FitAddon | null>(null);
  const ghosttyRef = useRef<GhosttyVtCanvasRenderer | null>(null);
  const ptyRef = useRef<string | null>(null);
  const lastSeqRef = useRef(0);
  const outputBytesRef = useRef(0);
  const pendingBytesRef = useRef<Uint8Array[]>([]);
  const pendingResizeRef = useRef<Array<{ cols: number; rows: number; requestedAt: number }>>([]);
  const resizeFrameRef = useRef<number | null>(null);
  const candidateChangedAtRef = useRef<number | null>(null);
  const candidateRef = useRef(candidate);
  const workloadRef = useRef(workload);
  const metricsRef = useRef(metrics);
  const visibleRef = useRef(visible);
  const renderGhosttyRef = useRef<() => void>(() => undefined);
  const ptySessionRef = useRef<{ id: string; cleanup: () => void } | null>(null);
  const ptyCreatePromiseRef = useRef<Promise<void> | null>(null);
  const ptyCleanupTimerRef = useRef<number | null>(null);
  const ptyMountCountRef = useRef(0);
  const inputReadyRef = useRef(false);
  const processExitedRef = useRef(false);
  const candidateFrameStreamsRef = useRef<Record<TerminalRendererCandidate, RendererInputFrame[]>>({ xterm: [], ghostty: [] });
  const workloadCompletionRef = useRef<WorkloadCompletion | null>(null);
  const workloadErrorRef = useRef<string | null>(null);
  const candidateTimingRef = useRef<Record<TerminalRendererCandidate, CandidateTimingState>>({
    xterm: initialCandidateTimingState(),
    ghostty: initialCandidateTimingState(),
  });
  const inputFramesRef = useRef<RendererInputFrame[]>([]);
  const inputPayloadsRef = useRef<Uint8Array[]>([]);
  const resizeTraceRef = useRef<Array<{ cols: number; rows: number; frameIndex: number }>>([]);
  const frameStartRef = useRef(performance.now());
  const lastSeqObservedRef = useRef<number | null>(null);
  const resizeStartedAtRef = useRef<Record<TerminalRendererCandidate, number | null>>({ xterm: null, ghostty: null });
  const switchStartedAtRef = useRef<Record<TerminalRendererCandidate, number | null>>({ xterm: null, ghostty: null });
  const comparisonRunNumberRef = useRef(0);
  const comparisonOrderRef = useRef<readonly TerminalRendererCandidate[]>(["xterm", "ghostty"]);
  candidateRef.current = candidate;
  workloadRef.current = workload;
  metricsRef.current = metrics;
  visibleRef.current = visible;
  const updateMetrics = useCallback((patch: Partial<Metrics>): void => {
    setMetrics((current) => {
      const next = { ...current, ...patch };
      metricsRef.current = next;
      return next;
    });
  }, []);

  const recordCandidateFrame = useCallback((
    rendererCandidate: TerminalRendererCandidate,
    bytes: number,
    startedAt: number,
    paintBoundaryMs: number,
  ): void => {
    const state = candidateTimingRef.current[rendererCandidate];
    const parseRenderMs = performance.now() - startedAt;
    state.processingDurationMs += parseRenderMs;
    state.parseSamples.push(parseRenderMs);
    state.paintSamples.push(paintBoundaryMs);
    if (parseRenderMs > 16.7) state.longFrameCount += 1;
    if (state.parseSamples.length > 300) state.parseSamples.shift();
    if (state.paintSamples.length > 300) state.paintSamples.shift();
    const elapsedMs = Math.max(1, performance.now() - frameStartRef.current);
    state.throughputBytesPerSecond = (outputBytesRef.current / elapsedMs) * 1000;
    state.markerCoverage = rendererCandidate === "xterm"
      ? markerCoverage(terminalRef.current ? textFromXterm(terminalRef.current) : "", workloadRef.current.markers)
      : markerCoverage(ghosttySnapshot.text, workloadRef.current.markers);
    if (switchStartedAtRef.current[rendererCandidate] !== null) {
      state.switchSamples.push(performance.now() - switchStartedAtRef.current[rendererCandidate]!);
      switchStartedAtRef.current[rendererCandidate] = null;
    }
    void bytes;
  }, [ghosttySnapshot.text]);

  const renderGhostty = useCallback((): void => {
    const renderer = ghosttyRef.current;
    const canvas = ghosttyCanvasRef.current;
    if (!renderer || !canvas) return;
    const started = performance.now();
    const snapshot = renderer.render(canvas);
    setGhosttySnapshot(snapshot);
    const parseRenderMs = performance.now() - started;
    const paintStarted = performance.now();
    requestAnimationFrame(() => {
      const state = candidateTimingRef.current.ghostty;
      state.parseSamples.push(parseRenderMs);
      state.paintSamples.push(performance.now() - paintStarted);
      if (parseRenderMs > 16.7) state.longFrameCount += 1;
      if (state.parseSamples.length > 300) state.parseSamples.shift();
      if (state.paintSamples.length > 300) state.paintSamples.shift();
      state.markerCoverage = markerCoverage(snapshot.text, workloadRef.current.markers);
      if (resizeStartedAtRef.current.ghostty !== null) {
        state.resizeSamples.push(performance.now() - resizeStartedAtRef.current.ghostty);
        resizeStartedAtRef.current.ghostty = null;
      }
      if (switchStartedAtRef.current.ghostty !== null) {
        state.switchSamples.push(performance.now() - switchStartedAtRef.current.ghostty);
        switchStartedAtRef.current.ghostty = null;
      }
    });
    updateMetrics({
      lastPaintMs: parseRenderMs,
      markerCoverage: markerCoverage(snapshot.text, workload.markers),
    });
  }, [updateMetrics, workload.markers]);
  renderGhosttyRef.current = renderGhostty;

  const applyResize = useCallback(
    (request: { cols: number; rows: number; requestedAt: number }): void => {
      const term = terminalRef.current;
      if (!term || !ptyRef.current) return;
      const anchor = terminalAnchor(term);
      const dimensionsChanged = term.cols !== request.cols || term.rows !== request.rows;
      if (dimensionsChanged) {
        resizeStartedAtRef.current.xterm = performance.now();
        resizeStartedAtRef.current.ghostty = resizeStartedAtRef.current.xterm;
        resizeTraceRef.current.push({ cols: request.cols, rows: request.rows, frameIndex: inputFramesRef.current.length });
        term.resize(request.cols, request.rows);
        ghosttyRef.current?.resize(request.cols, request.rows, CELL_WIDTH, CELL_HEIGHT);
        setDimensions({ cols: request.cols, rows: request.rows });
      }
      term.scrollToLine(
        restoreRendererViewportAnchor(anchor, term.buffer.active.length, term.rows),
      );
      updateMetrics({ resizeCount: metricsRef.current.resizeCount + 1 });
      void getTransport().terminalResize(ptyRef.current, request.cols, request.rows).catch((error: unknown) => {
        setConnectionError(error instanceof Error ? error.message : String(error));
      });
      renderGhosttyRef.current();
      requestAnimationFrame(() => {
        const started = resizeStartedAtRef.current.xterm;
        if (started === null) return;
        candidateTimingRef.current.xterm.resizeSamples.push(performance.now() - started);
        resizeStartedAtRef.current.xterm = null;
      });
    },
    [updateMetrics],
  );

  const requestResize = useCallback(
    (cols: number, rows: number): void => {
      pendingResizeRef.current.push({ cols, rows, requestedAt: performance.now() });
      if (resizeFrameRef.current !== null) return;
      resizeFrameRef.current = requestAnimationFrame(() => {
        resizeFrameRef.current = null;
        const request = coalesceRendererResize(pendingResizeRef.current);
        pendingResizeRef.current = [];
        if (request) applyResize(request);
      });
    },
    [applyResize],
  );

  const writeInput = useCallback((data: string): void => {
    const id = ptyRef.current;
    if (!id || data.length === 0) return;
    const started = performance.now();
    void getTransport().terminalWrite(id, data).then(() => {
      updateMetrics({ inputLatencyMs: performance.now() - started });
    }).catch((error: unknown) => {
      setConnectionError(error instanceof Error ? error.message : String(error));
    });
  }, [updateMetrics]);

  useEffect(() => {
    const container = xtermContainerRef.current;
    if (!container) return undefined;
    const term = new Terminal({
      cols: INITIAL_COLS,
      rows: INITIAL_ROWS,
      scrollback: 2_000,
      cursorBlink: true,
      fontFamily: "ui-monospace, SFMono-Regular, Consolas, monospace",
      fontSize: 13,
      theme: { background: "#10141d", foreground: "#f1f5f9", cursor: "#f59e0b" },
    });
    const fit = new FitAddon();
    term.loadAddon(fit);
    term.open(container);
    terminalRef.current = term;
    fitRef.current = fit;
    const handleResize = (): void => requestResize(term.cols, term.rows);
    const resizeDisposable = term.onResize(handleResize);
    const dataDisposable = term.onData((data) => {
      if (inputReadyRef.current) writeInput(data);
    });
    const inputReadyTimer = window.setTimeout(() => {
      inputReadyRef.current = true;
    }, 800);
    const resizeObserver = new ResizeObserver(() => {
      if (visibleRef.current) fit.fit();
    });
    resizeObserver.observe(container);
    requestAnimationFrame(() => fit.fit());
    return () => {
      resizeObserver.disconnect();
      window.clearTimeout(inputReadyTimer);
      resizeDisposable.dispose();
      dataDisposable.dispose();
      term.dispose();
      terminalRef.current = null;
      fitRef.current = null;
    };
  }, [requestResize, writeInput]);

  useEffect(() => {
    ptyMountCountRef.current += 1;
    if (ptyCleanupTimerRef.current !== null) {
      window.clearTimeout(ptyCleanupTimerRef.current);
      ptyCleanupTimerRef.current = null;
    }
    const transport = getTransport();
    const run = async (): Promise<void> => {
      try {
        const scopeId = activeThreadId ?? activeWorkspaceId ?? (await transport.listWorkspaces())[0]?.id;
        if (!scopeId) throw new Error("A workspace is required before creating the comparison PTY");
        const created = await transport.terminalCreate(scopeId);
        if (ptyMountCountRef.current === 0) {
          await transport.terminalKill(created.ptyId);
          return;
        }
        ptyRef.current = created.ptyId;
        setPty({ id: created.ptyId, shell: created.shell });
        const dataUnsubscribe = onPtyData(created.ptyId, ({ payload, seq }) => {
          lastSeqRef.current = Math.max(lastSeqRef.current, seq);
          const remaining = TERMINAL_RENDERER_WORKLOAD_LIMITS.maxOutputBytes - outputBytesRef.current;
          if (remaining <= 0) return;
          const bounded = payload.slice(0, remaining);
          outputBytesRef.current += bounded.byteLength;
          const digest = frameDigest(bounded);
          const inputFrame = { seq, bytes: bounded.byteLength, digest };
          inputFramesRef.current.push(inputFrame);
          inputPayloadsRef.current.push(bounded.slice());
          if (inputFramesRef.current.length > 1_000) inputFramesRef.current.shift();
          if (inputPayloadsRef.current.length > 1_000) inputPayloadsRef.current.shift();
          if (lastSeqObservedRef.current !== null && seq > lastSeqObservedRef.current + 1) {
            const gap = seq - lastSeqObservedRef.current - 1;
            candidateTimingRef.current.xterm.droppedFrames += gap;
            candidateTimingRef.current.ghostty.droppedFrames += gap;
          }
          lastSeqObservedRef.current = seq;
          const applyXterm = (): void => {
            const term = terminalRef.current;
            if (!term) return;
            candidateFrameStreamsRef.current.xterm.push(inputFrame);
            const started = performance.now();
            term.write(bounded, () => {
              const parseRenderMs = performance.now() - started;
              requestAnimationFrame(() => {
                const paintBoundaryMs = performance.now() - started;
                recordCandidateFrame("xterm", bounded.byteLength, started, paintBoundaryMs);
                updateMetrics({
                  outputBytes: outputBytesRef.current,
                  outputFrames: metricsRef.current.outputFrames + 1,
                  lastPaintMs: parseRenderMs,
                  markerCoverage: markerCoverage(textFromXterm(term), workloadRef.current.markers),
                  switchLatencyMs: candidateChangedAtRef.current === null ? metricsRef.current.switchLatencyMs : paintBoundaryMs,
                });
                candidateChangedAtRef.current = null;
              });
            });
          };
          const applyGhostty = (): void => {
            const renderer = ghosttyRef.current;
            if (renderer) {
              candidateFrameStreamsRef.current.ghostty.push(inputFrame);
              renderer.write(bounded);
              renderGhosttyRef.current();
            } else {
              pendingBytesRef.current.push(bounded.slice());
              let pendingLength = pendingBytesRef.current.reduce((sum, bytes) => sum + bytes.byteLength, 0);
              while (pendingLength > TERMINAL_RENDERER_WORKLOAD_LIMITS.maxReplayBytes && pendingBytesRef.current.length > 0) {
                pendingLength -= pendingBytesRef.current.shift()?.byteLength ?? 0;
              }
            }
          };
          const frameOrder: readonly TerminalRendererCandidate[] = seq % 2 === 0
            ? ["ghostty", "xterm"]
            : ["xterm", "ghostty"];
          for (const orderedCandidate of frameOrder) {
            if (orderedCandidate === "xterm") applyXterm();
            else applyGhostty();
          }
        });
        const exitUnsubscribe = onPtyExit(created.ptyId, () => {
          processExitedRef.current = true;
          updateMetrics({ processExited: true });
        });
        const gapUnsubscribe = onPtyReconnectGap(created.ptyId, () => updateMetrics({ replayGap: true }));
        await transport.terminalReattach(created.ptyId, 0, true);
        await transport.terminalResume(created.ptyId);
        await transport.terminalWrite(created.ptyId, "\r");
        await new Promise((resolve) => setTimeout(resolve, 300));
        ptySessionRef.current = {
          id: created.ptyId,
          cleanup: () => {
            dataUnsubscribe();
            exitUnsubscribe();
            gapUnsubscribe();
          },
        };
        window.setTimeout(() => setPtyReady(true), 500);
      } catch (error: unknown) {
        if (ptyMountCountRef.current > 0) {
          setConnectionError(error instanceof Error ? error.message : String(error));
        }
      }
    };
    if (ptySessionRef.current === null && ptyCreatePromiseRef.current === null) {
      ptyCreatePromiseRef.current = run();
    }
    return () => {
      ptyMountCountRef.current = Math.max(0, ptyMountCountRef.current - 1);
      ptyCleanupTimerRef.current = window.setTimeout(() => {
        ptyCleanupTimerRef.current = null;
        if (ptyMountCountRef.current > 0) return;
        const session = ptySessionRef.current;
        if (session) {
          session.cleanup();
          void transport.terminalKill(session.id).catch(() => undefined);
          ptySessionRef.current = null;
          ptyRef.current = null;
          setPty(null);
          setPtyReady(false);
        }
      }, 250);
    };
  }, []);

  useEffect(() => {
    let disposed = false;
    void GhosttyVtCanvasRenderer.create(dimensions.cols, dimensions.rows)
      .then((renderer) => {
        if (disposed) {
          renderer.dispose();
          return;
        }
        ghosttyRef.current = renderer;
        setGhosttyStatus("ready");
        for (const bytes of pendingBytesRef.current) renderer.write(bytes);
        pendingBytesRef.current = [];
        renderGhosttyRef.current();
      })
      .catch((error: unknown) => {
        if (disposed) return;
        setGhosttyStatus("blocked");
        setGhosttyError(error instanceof Error ? error.message : String(error));
      });
    return () => {
      disposed = true;
      ghosttyRef.current?.dispose();
      ghosttyRef.current = null;
    };
  }, []);

  useEffect(() => {
    renderGhosttyRef.current();
  }, [dimensions]);

  useEffect(() => {
    const onWindowResize = (): void => {
      if (visibleRef.current) fitRef.current?.fit();
    };
    window.addEventListener("resize", onWindowResize);
    return () => window.removeEventListener("resize", onWindowResize);
  }, [visible]);

  const selectCandidate = (next: TerminalRendererCandidate): void => {
    if (next === "ghostty" && ghosttyStatus !== "ready") return;
    const started = performance.now();
    candidateChangedAtRef.current = started;
    switchStartedAtRef.current[next] = started;
    setCandidate(next);
  };

  const runWorkload = async (requestedWorkload: Workload = workload): Promise<void> => {
    const id = ptyRef.current;
    if (!id) return;
    workloadRef.current = requestedWorkload;
    comparisonRunNumberRef.current += 1;
    comparisonOrderRef.current = comparisonRunNumberRef.current % 2 === 0
      ? ["ghostty", "xterm"]
      : ["xterm", "ghostty"];
    outputBytesRef.current = 0;
    frameStartRef.current = performance.now();
    inputFramesRef.current = [];
    inputPayloadsRef.current = [];
    candidateFrameStreamsRef.current = { xterm: [], ghostty: [] };
    resizeTraceRef.current = [];
    lastSeqObservedRef.current = null;
    processExitedRef.current = false;
    workloadCompletionRef.current = null;
    workloadErrorRef.current = null;
    candidateTimingRef.current = { xterm: initialCandidateTimingState(), ghostty: initialCandidateTimingState() };
    updateMetrics({ ...initialMetrics(requestedWorkload), replayGap: false, processExited: false });
    const command = encodeNodeProgram(PROGRAMS[requestedWorkload.id]);
    await getTransport().terminalWrite(id, "\u0003\r");
    await new Promise((resolve) => setTimeout(resolve, 500));
    await getTransport().terminalWrite(id, command);
    if (requestedWorkload.id === "wrong-width-restoration") {
      setTimeout(() => requestResize(120, 24), 40);
      setTimeout(() => requestResize(80, 24), 120);
    } else if (requestedWorkload.id === "jagged-reflow") {
      [39, 40, 41, 40].forEach((cols, index) => setTimeout(() => requestResize(cols, 24), 35 + index * 12));
    } else if (requestedWorkload.id === "shaky-live-resizing") {
      [[100, 30], [101, 30], [99, 29], [100, 30], [98, 28], [100, 30]].forEach(([cols, rows], index) => setTimeout(() => requestResize(cols, rows), 30 + index * 15));
    } else if (requestedWorkload.id === "reconnect-recovery") {
      setTimeout(() => writeInput("gap\r"), 20);
      setTimeout(() => { void getTransport().terminalPause(id); }, 90);
      setTimeout(() => { void getTransport().terminalReattach(id, lastSeqRef.current, false); }, 220);
      setTimeout(() => { void getTransport().terminalResume(id); }, 260);
    } else if (requestedWorkload.id === "interactive-program") {
      setTimeout(() => writeInput("ping\r"), 40);
      setTimeout(() => writeInput("exit\r"), 100);
    }
  };

  const waitForPaint = (): Promise<number> => new Promise((resolve) => {
    const started = performance.now();
    requestAnimationFrame(() => resolve(performance.now() - started));
  });

  const replayCandidate = async (
    rendererCandidate: TerminalRendererCandidate,
    payloads: readonly Uint8Array[],
    resizeTrace: readonly { cols: number; rows: number; frameIndex: number }[],
    replayWorkload: Workload,
  ): Promise<CandidateTimingState> => {
    const state = initialCandidateTimingState();
    const host = document.createElement("div");
    host.style.cssText = "position:fixed;left:-10000px;top:-10000px;width:1200px;height:500px;overflow:hidden;";
    document.body.appendChild(host);
    let replayTerm: Terminal | null = null;
    let replayGhostty: GhosttyVtCanvasRenderer | null = null;
    let replayCanvas: HTMLCanvasElement | null = null;
    try {
      if (rendererCandidate === "xterm") {
        replayTerm = new Terminal({ cols: INITIAL_COLS, rows: INITIAL_ROWS, scrollback: 2_000, fontFamily: "ui-monospace, monospace", fontSize: 13, theme: { background: "#10141d", foreground: "#f1f5f9" } });
        replayTerm.open(host);
      } else {
        replayCanvas = document.createElement("canvas");
        replayCanvas.width = INITIAL_COLS * CELL_WIDTH;
        replayCanvas.height = INITIAL_ROWS * CELL_HEIGHT;
        host.appendChild(replayCanvas);
        replayGhostty = await GhosttyVtCanvasRenderer.create(INITIAL_COLS, INITIAL_ROWS);
      }
      let resizeIndex = 0;
      let resizeStartedAt: number | null = null;
      for (let frameIndex = 0; frameIndex < payloads.length; frameIndex += 1) {
        while (resizeIndex < resizeTrace.length && resizeTrace[resizeIndex]!.frameIndex <= frameIndex) {
          const resize = resizeTrace[resizeIndex]!;
          if (replayTerm) replayTerm.resize(resize.cols, resize.rows);
          if (replayGhostty && replayCanvas) {
            replayGhostty.resize(resize.cols, resize.rows, CELL_WIDTH, CELL_HEIGHT);
            replayCanvas.width = resize.cols * CELL_WIDTH;
            replayCanvas.height = resize.rows * CELL_HEIGHT;
          }
          resizeStartedAt = performance.now();
          resizeIndex += 1;
        }
        const payload = payloads[frameIndex]!;
        const frameStarted = performance.now();
        if (replayTerm) {
          let settled = false;
          const callback = new Promise<void>((resolve) => replayTerm!.write(payload, () => {
            if (settled) return;
            settled = true;
            const parseRenderMs = performance.now() - frameStarted;
            state.parseSamples.push(parseRenderMs);
            state.processingDurationMs += parseRenderMs;
            if (parseRenderMs > 16.7) state.longFrameCount += 1;
            requestAnimationFrame(() => {
              state.paintSamples.push(performance.now() - frameStarted);
              if (resizeStartedAt !== null) {
                state.resizeSamples.push(performance.now() - resizeStartedAt);
                resizeStartedAt = null;
              }
            });
            resolve();
          }));
          const timer = new Promise<"timeout">((resolve) => window.setTimeout(() => resolve("timeout"), 250));
          const result = await Promise.race([callback.then(() => "complete" as const), timer]);
          if (result === "timeout") {
            settled = true;
            state.failures.push(`${rendererCandidate} write callback timeout at frame ${frameIndex}`);
          }
        } else {
          replayGhostty!.write(payload);
          replayGhostty!.render(replayCanvas!);
          const parseRenderMs = performance.now() - frameStarted;
          state.parseSamples.push(parseRenderMs);
          state.processingDurationMs += parseRenderMs;
          if (parseRenderMs > 16.7) state.longFrameCount += 1;
          requestAnimationFrame(() => {
            state.paintSamples.push(performance.now() - frameStarted);
            if (resizeStartedAt !== null) {
              state.resizeSamples.push(performance.now() - resizeStartedAt);
              resizeStartedAt = null;
            }
          });
        }
      }
      await waitForPaint();
      state.throughputBytesPerSecond = payloads.reduce((sum, payload) => sum + payload.byteLength, 0) / Math.max(0.01, state.processingDurationMs) * 1000;
      state.markerCoverage = rendererCandidate === "xterm"
        ? markerCoverage(replayTerm ? textFromXterm(replayTerm) : "", replayWorkload.markers)
        : markerCoverage(replayGhostty && replayCanvas ? replayGhostty.render(replayCanvas).text : "", replayWorkload.markers);
      if (state.markerCoverage < 1) state.failures.push(`${rendererCandidate} replay marker coverage below 100%`);
      return state;
    } finally {
      replayTerm?.dispose();
      replayGhostty?.dispose();
      host.remove();
    }
  };

  const runPairedReplay = async (replayWorkload: Workload): Promise<Readonly<Record<TerminalRendererCandidate, RendererRunMetrics>>> => {
    const firstOrder: readonly TerminalRendererCandidate[] = comparisonRunNumberRef.current % 2 === 0 ? ["ghostty", "xterm"] : ["xterm", "ghostty"];
    const secondOrder = [...firstOrder].reverse() as readonly TerminalRendererCandidate[];
    const passStates: Record<TerminalRendererCandidate, CandidateTimingState[]> = { xterm: [], ghostty: [] };
    for (const order of [firstOrder, secondOrder]) {
      for (const rendererCandidate of order) {
        passStates[rendererCandidate].push(await replayCandidate(rendererCandidate, inputPayloadsRef.current, resizeTraceRef.current, replayWorkload));
      }
    }
    const aggregate = (states: readonly CandidateTimingState[]): RendererRunMetrics => {
      const merged = initialCandidateTimingState();
      for (const state of states) {
        merged.parseSamples.push(...state.parseSamples);
        merged.paintSamples.push(...state.paintSamples);
        merged.longFrameCount += state.longFrameCount;
        merged.processingDurationMs += state.processingDurationMs;
        merged.markerCoverage = Math.min(merged.markerCoverage || 1, state.markerCoverage);
        merged.throughputBytesPerSecond = merged.throughputBytesPerSecond === null ? state.throughputBytesPerSecond : (merged.throughputBytesPerSecond + (state.throughputBytesPerSecond ?? 0)) / 2;
        merged.failures.push(...state.failures);
      }
      return candidateRunMetrics(merged);
    };
    return { xterm: aggregate(passStates.xterm), ghostty: aggregate(passStates.ghostty) };
  };

  const captureComparisonRun = async (): Promise<ComparisonRun> => {
    const xtermMetrics = candidateRunMetrics(candidateTimingRef.current.xterm);
    const ghosttyMetrics = candidateRunMetrics(candidateTimingRef.current.ghostty);
    const replayMetrics = await runPairedReplay(workloadRef.current);
    const replayWithSwitch = {
      xterm: { ...replayMetrics.xterm, switchRestoreMs: replayMetrics.xterm.switchRestoreMs ?? xtermMetrics.switchRestoreMs },
      ghostty: { ...replayMetrics.ghostty, switchRestoreMs: replayMetrics.ghostty.switchRestoreMs ?? ghosttyMetrics.switchRestoreMs },
    } satisfies Readonly<Record<TerminalRendererCandidate, RendererRunMetrics>>;
    const dispatchedFrameEqual = compareRendererInputFrames(
      candidateFrameStreamsRef.current.xterm,
      candidateFrameStreamsRef.current.ghostty,
    );
    const inputReceiptIndeterminate = (workloadRef.current.id === "reconnect-recovery" || workloadRef.current.id === "interactive-program")
      && workloadCompletionRef.current === "timeout";
    const failures: string[] = [];
    if (!inputReceiptIndeterminate) {
      for (const rendererCandidate of ["xterm", "ghostty"] as const) {
        for (const failure of replayMetrics[rendererCandidate].failures) {
          failures.push(`${rendererCandidate} replay: ${failure}`);
        }
      }
    }
    if (!dispatchedFrameEqual) failures.push("dispatched frame streams differ");
    if (inputFramesRef.current.length === 0) failures.push("no PTY frames captured");
    if (!inputReceiptIndeterminate && xtermMetrics.markerCoverage < 1) failures.push("xterm workload markers missing");
    if (!inputReceiptIndeterminate && ghosttyMetrics.markerCoverage < 1) {
      failures.push(
        workloadRef.current.id === "high-output-pressure"
          ? "ghostty scrollback/capability gate: viewport projection lost high-output begin marker"
          : "ghostty workload markers missing",
      );
    }
    if (workloadErrorRef.current) failures.push(workloadErrorRef.current);
    const expectedBytes = workloadRef.current.expectedProgramBytes;
    if (expectedBytes !== null && outputBytesRef.current < expectedBytes) {
      workloadErrorRef.current ??= `transport-neutral harness/input failure: ${outputBytesRef.current.toLocaleString()} bytes captured below ${expectedBytes.toLocaleString()} expected program bytes`;
      if (!failures.includes(workloadErrorRef.current)) failures.push(workloadErrorRef.current);
    }
    if (inputReceiptIndeterminate) {
      failures.push("harness-indeterminate: PTY input receipt was not proven before timeout");
    }
    const classification: ComparisonRun["classification"] = workloadErrorRef.current
      ? "harness-failure"
      : inputReceiptIndeterminate
        ? "harness-indeterminate"
        : failures.length > 0
          ? "candidate-failure"
          : "pass";
    return {
      run: comparisonRunNumberRef.current,
      workloadId: workloadRef.current.id,
      order: comparisonOrderRef.current,
      timingMethod: "paired-isolated-replay",
      inputFrames: inputFramesRef.current.slice(0, 200),
      inputFrameCount: inputFramesRef.current.length,
      dispatchedFrameEqual,
      outputBytes: outputBytesRef.current,
      outputFrames: inputFramesRef.current.length,
      outputTruncated: outputBytesRef.current >= TERMINAL_RENDERER_WORKLOAD_LIMITS.maxOutputBytes,
      expectedProgramBytes: workloadRef.current.expectedProgramBytes,
      completion: workloadCompletionRef.current ?? "timeout",
      transportFailure: workloadErrorRef.current,
      classification,
      resizeCount: metricsRef.current.resizeCount,
      markerCoverage: { xterm: xtermMetrics.markerCoverage, ghostty: ghosttyMetrics.markerCoverage },
      droppedFrames: { xterm: xtermMetrics.droppedFrames, ghostty: ghosttyMetrics.droppedFrames },
      lostInputEvents: { xterm: xtermMetrics.lostInputEvents, ghostty: ghosttyMetrics.lostInputEvents },
      metrics: replayWithSwitch,
      failures,
    };
  };

  const runWorkloadAndCapture = async (nextWorkload: Workload): Promise<ComparisonRun> => {
    setWorkloadId(nextWorkload.id);
    try {
      await runWorkload(nextWorkload);
    } catch (error: unknown) {
      workloadErrorRef.current = `workload input failed: ${error instanceof Error ? error.message : String(error)}`;
      workloadCompletionRef.current = "error";
    }
    if (workloadCompletionRef.current !== "error") {
      await new Promise<void>((resolve) => {
        let finished = false;
        let pollTimer: number | null = null;
        const finish = (completion: WorkloadCompletion): void => {
          if (finished) return;
          finished = true;
          if (pollTimer !== null) window.clearTimeout(pollTimer);
          workloadCompletionRef.current = completion;
          resolve();
        };
        const deadline = window.setTimeout(() => finish("timeout"), TERMINAL_RENDERER_WORKLOAD_LIMITS.maxDurationMs);
        const check = (): void => {
          if (finished) return;
          if (processExitedRef.current) {
            window.clearTimeout(deadline);
            finish("process-exit");
            return;
          }
          if (candidateTimingRef.current.xterm.markerCoverage >= 1 || candidateTimingRef.current.ghostty.markerCoverage >= 1) {
            window.clearTimeout(deadline);
            finish("marker");
            return;
          }
          pollTimer = window.setTimeout(check, 40);
        };
        check();
      });
    }
    return captureComparisonRun();
  };

  const runComparison = async (): Promise<void> => {
    if (!ptyRef.current || !ptyReady || ghosttyStatus !== "ready" || comparisonRunning) return;
    setComparisonRunning(true);
    setComparisonRuns([]);
    const repetitions = runMode === "thirty" ? 30 : 1;
    try {
      await new Promise((resolve) => setTimeout(resolve, 500));
      for (let repetition = 0; repetition < repetitions; repetition += 1) {
        for (const nextWorkload of WORKLOADS) {
          let run: ComparisonRun;
          try {
            run = await runWorkloadAndCapture(nextWorkload);
          } catch (error: unknown) {
            const message = `comparison harness failure: ${error instanceof Error ? error.message : String(error)}`;
            run = {
              run: comparisonRunNumberRef.current,
              workloadId: nextWorkload.id,
              order: comparisonOrderRef.current,
              timingMethod: "paired-isolated-replay",
              inputFrames: inputFramesRef.current.slice(0, 200),
              inputFrameCount: inputFramesRef.current.length,
              dispatchedFrameEqual: compareRendererInputFrames(candidateFrameStreamsRef.current.xterm, candidateFrameStreamsRef.current.ghostty),
              outputBytes: outputBytesRef.current,
              outputFrames: inputFramesRef.current.length,
              outputTruncated: outputBytesRef.current >= TERMINAL_RENDERER_WORKLOAD_LIMITS.maxOutputBytes,
              expectedProgramBytes: nextWorkload.expectedProgramBytes,
              completion: "error",
              transportFailure: message,
              classification: "harness-failure",
              resizeCount: metricsRef.current.resizeCount,
              markerCoverage: { xterm: candidateTimingRef.current.xterm.markerCoverage, ghostty: candidateTimingRef.current.ghostty.markerCoverage },
              droppedFrames: { xterm: candidateTimingRef.current.xterm.droppedFrames, ghostty: candidateTimingRef.current.ghostty.droppedFrames },
              lostInputEvents: { xterm: candidateTimingRef.current.xterm.lostInputEvents, ghostty: candidateTimingRef.current.ghostty.lostInputEvents },
              metrics: { xterm: candidateRunMetrics(candidateTimingRef.current.xterm), ghostty: candidateRunMetrics(candidateTimingRef.current.ghostty) },
              failures: [message],
            };
          }
          setComparisonRuns((current) => [...current, run].slice(-240));
        }
      }
    } finally {
      setComparisonRunning(false);
    }
  };

  const reconnect = async (): Promise<void> => {
    if (!ptyRef.current) return;
    await getTransport().terminalReattach(ptyRef.current, lastSeqRef.current, false);
    await getTransport().terminalResume(ptyRef.current);
  };

  const copyGhosttyText = async (): Promise<void> => {
    await navigator.clipboard.writeText(ghosttySnapshot.text);
  };

  const activeText = candidate === "ghostty"
    ? ghosttySnapshot.text
    : terminalRef.current
      ? textFromXterm(terminalRef.current)
      : "";
  const activeStatus = candidate === "ghostty" ? ghosttyStatus : "ready";
  const comparisonReport = {
    schemaVersion: 1,
    mode: runMode,
    workloadIds: WORKLOADS.map((item) => item.id),
    runCount: comparisonRuns.length,
    timingMethod: "paired-isolated-replay",
    timingNotes: [
      "xterm write callback measures parser/accept completion; Ghostty sync timing includes Canvas rendering.",
      "output-to-next-requestAnimationFrame is a directional painted-latency signal, not presentation-complete proof.",
      "Parser throughput does not prove a renderer winner.",
    ],
    memory: { status: "not-measured", reason: "Browser heap isolation was not credible in this route." },
    capabilityMatrix: RENDERER_CAPABILITY_MATRIX,
    gate: {
      allWorkloadsPresent: comparisonRuns.length >= WORKLOADS.length,
      artifactComplete: comparisonRuns.length >= WORKLOADS.length,
      dispatchedFrameEqual: comparisonRuns.every((run) => run.dispatchedFrameEqual),
      capabilityFailures: RENDERER_CAPABILITY_MATRIX.filter((row) => row.xterm === "fail" || row.ghostty === "fail").map((row) => row.capability),
      candidateFailures: comparisonRuns.filter((run) => run.classification === "candidate-failure").map((run) => `${run.run}:${run.workloadId}`),
      harnessIndeterminateRuns: comparisonRuns.filter((run) => run.classification === "harness-indeterminate").map((run) => `${run.run}:${run.workloadId}`),
      harnessFailures: comparisonRuns.filter((run) => run.classification === "harness-failure" || run.transportFailure !== null).map((run) => `${run.run}:${run.workloadId}`),
      overallCandidatePass: false,
    },
    runs: comparisonRuns,
  };

  return (
    <main className="min-h-screen bg-[#080b11] px-6 py-6 text-slate-100">
      <div className="mx-auto max-w-[1500px] space-y-5">
        <header className="flex flex-wrap items-start justify-between gap-4 border-b border-slate-800 pb-5">
          <div>
            <div className="mb-2 flex items-center gap-2"><Badge variant="outline">PROTOTYPE</Badge><Badge variant="secondary">#1078</Badge></div>
            <h1 className="text-2xl font-semibold tracking-tight">Renderer head-to-head</h1>
            <p className="mt-1 max-w-3xl text-sm text-slate-400">Question: which renderer should Mcode adopt? One server-owned PTY, one bounded corpus, and two real candidates with the same byte stream.</p>
          </div>
          <div className="rounded-lg border border-amber-700/60 bg-amber-950/30 px-3 py-2 text-xs text-amber-200">Throwaway evidence surface. Not a production terminal.</div>
        </header>

        <section className="grid gap-3 md:grid-cols-3">
          <div className="rounded-lg border border-slate-800 bg-slate-950/60 p-3 text-sm"><div className="text-xs uppercase tracking-wide text-slate-500">Server PTY</div><div className="mt-1 font-mono text-xs">{pty ? `${pty.id} · ${pty.shell}` : "creating…"}</div><div className="mt-1 text-xs text-slate-500">Both candidates receive identical seq-ordered frames.</div></div>
          <div className="rounded-lg border border-slate-800 bg-slate-950/60 p-3 text-sm"><div className="text-xs uppercase tracking-wide text-slate-500">Grid</div><div className="mt-1 font-mono">{dimensions.cols} × {dimensions.rows}</div><div className="mt-1 text-xs text-slate-500">Latest-wins resize, max {TERMINAL_RENDERER_WORKLOAD_LIMITS.maxCols} × {TERMINAL_RENDERER_WORKLOAD_LIMITS.maxRows}.</div></div>
          <div className="rounded-lg border border-slate-800 bg-slate-950/60 p-3 text-sm"><div className="text-xs uppercase tracking-wide text-slate-500">Workload</div><div className="mt-1">{workload.label}</div><div className="mt-1 text-xs text-slate-500">{workload.purpose}</div></div>
        </section>

        <section className="grid gap-3 lg:grid-cols-2">
          <button type="button" onClick={() => selectCandidate("xterm")} className={`rounded-lg border p-4 text-left transition ${candidate === "xterm" ? "border-cyan-500 bg-cyan-950/20" : "border-slate-800 bg-slate-950/40"}`}>
            <div className="flex items-center justify-between"><div className="flex items-center gap-2 font-medium"><Check className="h-4 w-4 text-cyan-300" />Strengthened xterm</div><Badge variant="outline">runnable</Badge></div>
            <div className="mt-2 text-xs text-slate-400">@xterm/xterm with fit, scroll-anchor restoration, frame-coalesced resize, PTY flow control, and input telemetry.</div>
          </button>
          <button type="button" disabled={ghosttyStatus !== "ready"} onClick={() => selectCandidate("ghostty")} className={`rounded-lg border p-4 text-left transition ${candidate === "ghostty" ? "border-violet-500 bg-violet-950/20" : "border-slate-800 bg-slate-950/40"} disabled:cursor-not-allowed disabled:opacity-60`}>
            <div className="flex items-center justify-between"><div className="flex items-center gap-2 font-medium"><Activity className="h-4 w-4 text-violet-300" />libghostty-vt + Mcode Canvas</div><Badge variant={ghosttyStatus === "ready" ? "outline" : "destructive"}>{ghosttyStatus}</Badge></div>
            <div className="mt-2 text-xs text-slate-400">Vendored upstream WASM terminal parser and render-state dirty-row iterator. No xterm adapter or text fallback.</div>
            {ghosttyError ? <div className="mt-2 rounded bg-red-950/40 p-2 font-mono text-[11px] text-red-300">Blocked: {ghosttyError}</div> : null}
          </button>
        </section>

        <section className="flex flex-wrap items-center gap-2 rounded-lg border border-slate-800 bg-slate-950/50 p-3">
          <label className="text-xs text-slate-400" htmlFor="renderer-workload">Workload</label>
          <select id="renderer-workload" value={workloadId} onChange={(event) => setWorkloadId(event.target.value as TerminalRendererWorkloadId)} className="rounded border border-slate-700 bg-slate-900 px-2 py-1 text-sm">
            {WORKLOADS.map((item) => <option key={item.id} value={item.id}>{item.label}</option>)}
          </select>
          <Button size="sm" onClick={() => void runWorkload()} disabled={!pty || !ptyReady || ghosttyStatus !== "ready"}><Send className="mr-1 h-3.5 w-3.5" />Run on same PTY</Button>
          <label className="ml-2 text-xs text-slate-400" htmlFor="renderer-run-mode">Comparison mode</label>
          <select id="renderer-run-mode" value={runMode} onChange={(event) => setRunMode(event.target.value as "quick" | "thirty")} className="rounded border border-slate-700 bg-slate-900 px-2 py-1 text-sm">
            <option value="quick">Quick: 8 workloads × 1</option>
            <option value="thirty">Explicit: 8 workloads × 30</option>
          </select>
          <Button data-testid="run-comparison" size="sm" variant="secondary" onClick={() => void runComparison()} disabled={!pty || !ptyReady || ghosttyStatus !== "ready" || comparisonRunning}><Activity className="mr-1 h-3.5 w-3.5" />{comparisonRunning ? "Comparing…" : "Run comparison"}</Button>
          <Button size="sm" variant="outline" onClick={() => void reconnect()} disabled={!pty}><RefreshCw className="mr-1 h-3.5 w-3.5" />Reattach</Button>
          <Button size="sm" variant="outline" onClick={() => setVisible((value) => !value)}><Eye className="mr-1 h-3.5 w-3.5" />{visible ? "Hide" : "Show"} surface</Button>
          <Button size="sm" variant="destructive" onClick={() => { if (ptyRef.current) void getTransport().terminalKill(ptyRef.current); }} disabled={!pty}><Square className="mr-1 h-3.5 w-3.5" />Kill PTY</Button>
        </section>

        <section className="grid gap-4 xl:grid-cols-[minmax(0,1fr)_300px]">
          <div className="relative min-h-[440px] overflow-hidden rounded-lg border border-slate-800 bg-[#10141d]">
            <div ref={xtermContainerRef} className={`absolute inset-0 p-3 ${candidate === "xterm" ? "opacity-100" : "pointer-events-none opacity-0"}`} aria-hidden={candidate !== "xterm"} />
            <div ref={ghosttySurfaceRef} className={`absolute inset-0 overflow-auto p-3 ${candidate === "ghostty" ? "opacity-100" : "pointer-events-none opacity-0"}`} tabIndex={0} onKeyDown={(event) => { const data = keyToPtyData(event); if (data) { event.preventDefault(); writeInput(data); } }} aria-label="libghostty-vt Canvas terminal input">
              <canvas ref={ghosttyCanvasRef} width={dimensions.cols * CELL_WIDTH} height={dimensions.rows * CELL_HEIGHT} className="block max-w-full" />
              <pre className="sr-only" aria-live="polite">{ghosttySnapshot.text}</pre>
            </div>
            {!visible ? <div className="absolute inset-0 grid place-items-center bg-slate-950/90 text-sm text-slate-300"><EyeOff className="mr-2 inline h-4 w-4" />Surface hidden. Parser and PTY state remain mounted.</div> : null}
          </div>
          <aside className="space-y-3 rounded-lg border border-slate-800 bg-slate-950/60 p-4 text-xs">
            <div className="flex items-center justify-between"><span className="uppercase tracking-wide text-slate-500">Telemetry</span>{metrics.replayGap ? <Badge variant="destructive"><WifiOff className="mr-1 h-3 w-3" />replay gap</Badge> : null}</div>
            <dl className="grid grid-cols-[1fr_auto] gap-y-2"><dt className="text-slate-500">Candidate</dt><dd>{candidate} · {activeStatus}</dd><dt className="text-slate-500">Output</dt><dd>{metrics.outputBytes.toLocaleString()} bytes / {metrics.outputFrames} frames</dd><dt className="text-slate-500">Last paint</dt><dd>{metrics.lastPaintMs === null ? "–" : `${metrics.lastPaintMs.toFixed(2)} ms`}</dd><dt className="text-slate-500">Switch latency</dt><dd>{metrics.switchLatencyMs === null ? "–" : `${metrics.switchLatencyMs.toFixed(2)} ms`}</dd><dt className="text-slate-500">Input latency</dt><dd>{metrics.inputLatencyMs === null ? "–" : `${metrics.inputLatencyMs.toFixed(2)} ms`}</dd><dt className="text-slate-500">Resize requests</dt><dd>{metrics.resizeCount} / {TERMINAL_RENDERER_WORKLOAD_LIMITS.maxResizeCount}</dd><dt className="text-slate-500">Marker coverage</dt><dd>{Math.round(metrics.markerCoverage * 100)}%</dd><dt className="text-slate-500">Ghostty dirty rows</dt><dd>{ghosttySnapshot.dirtyRows} · {ghosttySnapshot.renderCount} renders</dd><dt className="text-slate-500">Lifecycle</dt><dd>{metrics.processExited ? "exited" : "running"}</dd></dl>
            <div className="border-t border-slate-800 pt-3 text-[11px] text-slate-500">Caps: 12 resizes, 10 ms minimum spacing, 128 KiB output, 32 KiB replay, 2 s run, 3 s process lifetime.</div>
            <div className="border-t border-slate-800 pt-3 text-[11px] text-slate-500">Canvas supports basic printable keys, arrows, Enter, Tab, Backspace, and a screen-reader text projection. IME, dead-key composition, mouse protocol, and native selection parity remain open gates.</div>
            {candidate === "ghostty" ? <Button size="sm" variant="outline" onClick={() => void copyGhosttyText()}><Clipboard className="mr-1 h-3.5 w-3.5" />Copy projection</Button> : <div className="text-[11px] text-slate-500"><Copy className="mr-1 inline h-3 w-3" />xterm owns selection and clipboard in this candidate.</div>}
          </aside>
        </section>

        <section className="rounded-lg border border-slate-800 bg-slate-950/50 p-4 text-xs">
          <div className="flex flex-wrap items-baseline justify-between gap-2">
            <div>
              <h2 className="font-medium">Interactive comparison matrix</h2>
              <p className="mt-1 text-slate-500">Each row is one bounded corpus run. p50/p95/p99/max are paired isolated replays (A→B then B→A) over captured bytes and resize trace. xterm write callbacks measure parser/accept completion, while Ghostty sync timing includes Canvas rendering. Output-to-next-requestAnimationFrame is the fair painted-latency signal.</p>
            </div>
            <span data-testid="comparison-status" className="font-mono text-slate-500">{comparisonRuns.length} runs retained (max 240) · {comparisonRunning ? "running" : "idle"}</span>
          </div>
          <div className="mt-3 overflow-x-auto">
            <table className="w-full min-w-[980px] border-collapse" data-testid="comparison-matrix">
              <thead><tr className="border-b border-slate-800 text-left text-slate-500"><th className="p-2">Run / workload</th><th className="p-2">Order</th><th className="p-2">Input</th><th className="p-2">xterm p50 / p95 / p99 / max</th><th className="p-2">Ghostty p50 / p95 / p99 / max</th><th className="p-2">Markers / drops / failures</th></tr></thead>
              <tbody>
                {comparisonRuns.map((run) => {
                  const xtermTiming = run.metrics.xterm.paintBoundary;
                  const ghosttyTiming = run.metrics.ghostty.paintBoundary;
                  const timing = (value: typeof xtermTiming): string => [value.p50Ms, value.p95Ms, value.p99Ms, value.maxMs].map((item) => item === null ? "–" : item.toFixed(1)).join(" / ");
                  return <tr key={`${run.run}-${run.workloadId}`} className="border-b border-slate-900 align-top"><td className="p-2"><div className="font-medium">#{run.run} {run.workloadId}</div><div className="text-slate-500">{run.outputBytes.toLocaleString()} bytes · {run.outputFrames} frames · {run.resizeCount} resizes · {run.completion}</div></td><td className="p-2 font-mono">{run.order.join(" → ")}</td><td className="p-2">{run.dispatchedFrameEqual ? <span className="text-emerald-300">dispatched equal</span> : <span className="text-red-300">dispatched mismatch</span>}<div className="text-slate-500">{run.inputFrameCount} frames ({run.inputFrames.length} retained)</div></td><td className="p-2 font-mono">{timing(xtermTiming)} ms<div className="text-slate-500">throughput {run.metrics.xterm.throughputBytesPerSecond === null ? "–" : `${Math.round(run.metrics.xterm.throughputBytesPerSecond).toLocaleString()} B/s`}</div></td><td className="p-2 font-mono">{timing(ghosttyTiming)} ms<div className="text-slate-500">throughput {run.metrics.ghostty.throughputBytesPerSecond === null ? "–" : `${Math.round(run.metrics.ghostty.throughputBytesPerSecond).toLocaleString()} B/s`}</div></td><td className="p-2">{run.classification}<div>{Math.round(run.markerCoverage.xterm * 100)}% / {Math.round(run.markerCoverage.ghostty * 100)}%</div><div className="text-slate-500">drops {run.droppedFrames.xterm} / {run.droppedFrames.ghostty} · lost input {run.lostInputEvents.xterm} / {run.lostInputEvents.ghostty}</div>{run.failures.length > 0 ? <div className="text-red-300">{run.failures.join(", ")}</div> : <div className="text-emerald-300">pass</div>}</td></tr>;
                })}
              </tbody>
            </table>
          </div>
          <details className="mt-3"><summary className="cursor-pointer text-slate-400">Raw per-run JSON</summary><pre data-testid="raw-results" className="mt-2 max-h-72 overflow-auto rounded bg-slate-950 p-3 text-[10px] text-slate-400">{JSON.stringify(comparisonReport, null, 2)}</pre></details>
        </section>

        <section className="grid gap-4 lg:grid-cols-2">
          <div className="rounded-lg border border-slate-800 bg-slate-950/50 p-4 text-xs"><h2 className="font-medium">Capability matrix</h2><p className="mt-1 text-slate-500">Interactive and platform behavior is reported separately from parser timing. Failed production-required cells and not-measured cells are not performance wins.</p><div className="mt-3 overflow-x-auto"><table className="w-full min-w-[520px] border-collapse"><thead><tr className="border-b border-slate-800 text-left text-slate-500"><th className="p-2">Capability</th><th className="p-2">xterm</th><th className="p-2">Ghostty</th><th className="p-2">Evidence</th></tr></thead><tbody>{RENDERER_CAPABILITY_MATRIX.map((row) => <tr key={row.capability} className="border-b border-slate-900"><td className="p-2">{row.capability}</td><td className="p-2">{row.xterm}</td><td className="p-2">{row.ghostty}</td><td className="p-2 text-slate-500">{row.note}</td></tr>)}</tbody></table></div></div>
          <div className="rounded-lg border border-slate-800 bg-slate-950/50 p-4 text-xs"><h2 className="font-medium">Artifact size</h2><p className="mt-1 text-slate-500">Measured from pinned package files and the committed Ghostty WASM artifact. Memory is explicitly not measured in this browser route.</p>{sizeManifest ? <dl className="mt-3 grid grid-cols-[1fr_auto] gap-y-2"><dt className="text-slate-500">xterm core + fit + serialize</dt><dd className="font-mono">{sizeManifest.xterm.rawBytes.toLocaleString()} raw / {sizeManifest.xterm.gzipBytes.toLocaleString()} gzip</dd><dt className="text-slate-500">xterm with WebGL addon</dt><dd className="font-mono">{sizeManifest.xterm.webglAddon.rawBytes.toLocaleString()} raw / {sizeManifest.xterm.webglAddon.gzipBytes.toLocaleString()} gzip</dd><dt className="text-slate-500">Ghostty WASM</dt><dd className="font-mono">{sizeManifest.ghostty.rawBytes.toLocaleString()} raw / {sizeManifest.ghostty.gzipBytes.toLocaleString()} gzip</dd><dt className="text-slate-500">Memory</dt><dd>not measured</dd></dl> : <div className="mt-3 text-slate-500">Loading committed size manifest…</div>}<div className="mt-3 border-t border-slate-800 pt-3 text-slate-500">Raw bytes and per-file gzip sums are descriptive evidence, not a production bundle-size gate.</div></div>
        </section>

        <section className="rounded-lg border border-slate-800 bg-slate-950/50 p-4 text-xs">
          <div className="mb-2 flex items-center gap-2 font-medium"><Activity className="h-4 w-4 text-amber-300" />Accessible text projection ({activeText.length.toLocaleString()} chars)</div>
          <pre className="max-h-40 overflow-auto whitespace-pre-wrap text-slate-400">{activeText.slice(-8_000)}</pre>
          {connectionError ? <div className="mt-3 rounded bg-red-950/40 p-2 font-mono text-red-300">PTy error: {connectionError}</div> : null}
        </section>
      </div>
    </main>
  );
}
