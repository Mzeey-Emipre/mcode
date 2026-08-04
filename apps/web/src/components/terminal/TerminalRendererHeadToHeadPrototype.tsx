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
  markerCoverage,
  restoreRendererViewportAnchor,
  TERMINAL_RENDERER_WORKLOAD_IDS,
  TERMINAL_RENDERER_WORKLOAD_LIMITS,
  type RendererViewportAnchor,
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

const WORKLOADS: readonly Workload[] = [
  {
    id: "wrong-width-restoration",
    label: "Wrong-width restoration",
    purpose: "80 → 120 → 80 complete-cell resize and bottom-row marker.",
    markers: ["WF:wrong-width:initial", "WF:wrong-width:bottom", "WF:wrong-width:restored"],
  },
  {
    id: "jagged-reflow",
    label: "Jagged reflow",
    purpose: "Wide, combining, and emoji graphemes across four narrow widths.",
    markers: ["WF:jagged:begin", "WF:jagged:end"],
  },
  {
    id: "shaky-live-resizing",
    label: "Shaky live resizing",
    purpose: "ANSI color output while resize requests are coalesced at frame rate.",
    markers: ["WF:resize:tick", "WF:resize:end"],
  },
  {
    id: "bottom-row-clipping",
    label: "Bottom-row clipping",
    purpose: "Cursor movement near the final complete row before output.",
    markers: ["WF:bottom-row:top", "WF:bottom-row:end"],
  },
  {
    id: "high-output-pressure",
    label: "High-output pressure",
    purpose: "Twenty bounded 4 KiB chunks, capped at 128 KiB.",
    markers: ["WF:high-output:begin", "WF:high-output:end"],
  },
  {
    id: "reconnect-recovery",
    label: "Reconnect recovery",
    purpose: "Pause and reattach with bounded replay and a visible gap state.",
    markers: ["WF:reconnect:before", "WF:reconnect:after"],
  },
  {
    id: "interactive-program",
    label: "Interactive program",
    purpose: "Ready, ping/pong, and done markers through the same PTY input path.",
    markers: ["WF:interactive:ready", "WF:interactive:pong", "WF:interactive:done"],
  },
  {
    id: "process-cleanup",
    label: "Process cleanup",
    purpose: "Parent and child lifecycle markers followed by explicit PTY cleanup.",
    markers: ["WF:cleanup:parent", "WF:cleanup:child:"],
  },
];

const PROGRAMS: Readonly<Record<TerminalRendererWorkloadId, string>> = {
  "wrong-width-restoration": String.raw`const e="\x1b";process.stdout.write(e+"[2J"+e+"[HWF:wrong-width:initial\n"+"W80:·".repeat(18)+"\n"+e+"[24;1HWF:wrong-width:bottom\n");setTimeout(()=>process.stdout.write("WF:wrong-width:restored\n"),160);setTimeout(()=>process.exit(0),280);`,
  "jagged-reflow": String.raw`const e="\x1b";const wide="A界é🙂".repeat(40);process.stdout.write(e+"[2J"+e+"[HWF:jagged:begin\n"+wide+"\n");let i=0;const t=setInterval(()=>process.stdout.write("WF:jagged:tick:"+i+++":"+wide.slice(0,120)+"\n"),45);setTimeout(()=>{clearInterval(t);process.stdout.write("WF:jagged:end\n");process.exit(0)},320);`,
  "shaky-live-resizing": String.raw`const e="\x1b";let i=0;const t=setInterval(()=>process.stdout.write("WF:resize:tick:"+i+++":"+e+"[38;5;"+(i%16)+"mresize"+e+"[0m\n"),15);setTimeout(()=>{clearInterval(t);process.stdout.write(e+"[0mWF:resize:end\n");process.exit(0)},300);`,
  "bottom-row-clipping": String.raw`const e="\x1b";process.stdout.write(e+"[2J"+e+"[1;1HWF:bottom-row:top\n"+e+"[24;1HWF:bottom-row:initial\n");setTimeout(()=>process.stdout.write(e+"[8;1HWF:bottom-row:resized\n"),80);setTimeout(()=>process.stdout.write("WF:bottom-row:end\n"),180);setTimeout(()=>process.exit(0),260);`,
  "high-output-pressure": String.raw`const p="0123456789abcdef".repeat(256);process.stdout.write("WF:high-output:begin\n");for(let i=0;i<20;i++)process.stdout.write("WF:high-output:chunk:"+i+":"+p+"\n");process.stdout.write("WF:high-output:end\n");process.exit(0);`,
  "reconnect-recovery": String.raw`let p="";process.stdout.write("WF:reconnect:before\n");process.stdin.setEncoding("utf8");process.stdin.on("data",c=>{p+=c;let n=p.search(/[\r\n]/);while(n>=0){const l=p.slice(0,n);p=p.slice(n+1);if(p.startsWith("\n"))p=p.slice(1);if(l==="gap"){setTimeout(()=>process.stdout.write("WF:reconnect:middle\n"),60);setTimeout(()=>process.stdout.write("WF:reconnect:after\n"),220);setTimeout(()=>process.exit(0),340)}n=p.search(/[\r\n]/)}});`,
  "interactive-program": String.raw`let p="";process.stdout.write("WF:interactive:ready\n");process.stdin.setEncoding("utf8");process.stdin.on("data",c=>{p+=c;let n=p.search(/[\r\n]/);while(n>=0){const l=p.slice(0,n);p=p.slice(n+1);if(p.startsWith("\n"))p=p.slice(1);if(l==="ping")process.stdout.write("WF:interactive:pong\n");if(l==="exit"){process.stdout.write("WF:interactive:done\n");process.exit(0)}n=p.search(/[\r\n]/)}});`,
  "process-cleanup": String.raw`const{spawn}=require("node:child_process");const c=spawn(process.execPath,["-e","setInterval(()=>{},1000)"],{stdio:"ignore"});process.stdout.write("WF:cleanup:parent\n");process.stdout.write("WF:cleanup:child:"+c.pid+"\n");setInterval(()=>{},1000);`,
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

/** Throwaway route for comparing strengthened xterm with real libghostty-vt. */
export function TerminalRendererHeadToHeadPrototype() {
  const activeThreadId = useWorkspaceStore((state) => state.activeThreadId);
  const activeWorkspaceId = useWorkspaceStore((state) => state.activeWorkspaceId);
  const [candidate, setCandidate] = useState<TerminalRendererCandidate>("xterm");
  const [workloadId, setWorkloadId] = useState<TerminalRendererWorkloadId>(
    TERMINAL_RENDERER_WORKLOAD_IDS[0],
  );
  const [pty, setPty] = useState<{ id: string; shell: string } | null>(null);
  const [connectionError, setConnectionError] = useState<string | null>(null);
  const [ghosttyStatus, setGhosttyStatus] = useState<GhosttyStatus>("loading");
  const [ghosttyError, setGhosttyError] = useState<string | null>(null);
  const [visible, setVisible] = useState(true);
  const [dimensions, setDimensions] = useState({ cols: INITIAL_COLS, rows: INITIAL_ROWS });
  const [metrics, setMetrics] = useState<Metrics>(() => initialMetrics(WORKLOADS[0]));
  const [ghosttySnapshot, setGhosttySnapshot] = useState({ dirtyRows: 0, renderCount: 0, text: "" });
  const workload = useMemo(
    () => WORKLOADS.find((item) => item.id === workloadId) ?? WORKLOADS[0],
    [workloadId],
  );

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

  const renderGhostty = useCallback((): void => {
    const renderer = ghosttyRef.current;
    const canvas = ghosttyCanvasRef.current;
    if (!renderer || !canvas) return;
    const started = performance.now();
    const snapshot = renderer.render(canvas);
    setGhosttySnapshot(snapshot);
    updateMetrics({
      lastPaintMs: performance.now() - started,
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
          const term = terminalRef.current;
          const started = performance.now();
          term?.write(bounded, () => {
            const patch: {
              outputBytes: number;
              outputFrames: number;
              lastPaintMs: number;
              switchLatencyMs?: number;
              markerCoverage?: number;
            } = {
              outputBytes: outputBytesRef.current,
              outputFrames: metricsRef.current.outputFrames + 1,
              lastPaintMs: performance.now() - started,
            };
            if (candidateChangedAtRef.current !== null) {
              patch.switchLatencyMs = performance.now() - candidateChangedAtRef.current;
              candidateChangedAtRef.current = null;
            }
            const xtermText = term ? textFromXterm(term) : "";
            if (candidateRef.current === "xterm") {
              patch.markerCoverage = markerCoverage(xtermText, workloadRef.current.markers);
            }
            updateMetrics(patch);
          });
          const renderer = ghosttyRef.current;
          if (renderer) {
            renderer.write(bounded);
            renderGhosttyRef.current();
          } else {
            pendingBytesRef.current.push(bounded.slice());
            let pendingLength = pendingBytesRef.current.reduce((sum, bytes) => sum + bytes.byteLength, 0);
            while (pendingLength > TERMINAL_RENDERER_WORKLOAD_LIMITS.maxReplayBytes && pendingBytesRef.current.length > 0) {
              pendingLength -= pendingBytesRef.current.shift()?.byteLength ?? 0;
            }
          }
        });
        const exitUnsubscribe = onPtyExit(created.ptyId, () => updateMetrics({ processExited: true }));
        const gapUnsubscribe = onPtyReconnectGap(created.ptyId, () => updateMetrics({ replayGap: true }));
        await transport.terminalReattach(created.ptyId, 0, true);
        await transport.terminalResume(created.ptyId);
        ptySessionRef.current = {
          id: created.ptyId,
          cleanup: () => {
            dataUnsubscribe();
            exitUnsubscribe();
            gapUnsubscribe();
          },
        };
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
    candidateChangedAtRef.current = performance.now();
    setCandidate(next);
  };

  const runWorkload = async (): Promise<void> => {
    const id = ptyRef.current;
    if (!id) return;
    outputBytesRef.current = 0;
    updateMetrics({ ...initialMetrics(workload), replayGap: false, processExited: false });
    const command = encodeNodeProgram(PROGRAMS[workload.id]);
    await getTransport().terminalWrite(id, "\u0003\r");
    await new Promise((resolve) => setTimeout(resolve, 120));
    await getTransport().terminalWrite(id, command);
    if (workload.id === "wrong-width-restoration") {
      setTimeout(() => requestResize(120, 24), 100);
      setTimeout(() => requestResize(80, 24), 220);
    } else if (workload.id === "jagged-reflow") {
      [39, 40, 41, 40].forEach((cols, index) => setTimeout(() => requestResize(cols, 24), 70 + index * 20));
    } else if (workload.id === "shaky-live-resizing") {
      Array.from({ length: 8 }, (_, index) => setTimeout(() => requestResize(72 + (index % 4) * 3, 24), 30 + index * 25));
    } else if (workload.id === "reconnect-recovery") {
      setTimeout(() => { void getTransport().terminalPause(id); }, 90);
      setTimeout(() => { void getTransport().terminalReattach(id, lastSeqRef.current, false); }, 220);
      setTimeout(() => { void getTransport().terminalResume(id); }, 260);
    } else if (workload.id === "interactive-program") {
      setTimeout(() => writeInput("ping\r"), 220);
      setTimeout(() => writeInput("exit\r"), 420);
    } else if (workload.id === "process-cleanup") {
      setTimeout(() => { void getTransport().terminalKill(id); }, 1_000);
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

  return (
    <main className="min-h-screen bg-[#080b11] px-6 py-6 text-slate-100">
      <div className="mx-auto max-w-[1500px] space-y-5">
        <header className="flex flex-wrap items-start justify-between gap-4 border-b border-slate-800 pb-5">
          <div>
            <div className="mb-2 flex items-center gap-2"><Badge variant="outline">PROTOTYPE</Badge><Badge variant="secondary">#1078</Badge></div>
            <h1 className="text-2xl font-semibold tracking-tight">Renderer head-to-head</h1>
            <p className="mt-1 max-w-3xl text-sm text-slate-400">One server-owned PTY, one raw byte stream, and the same bounded corpus for strengthened xterm and real libghostty-vt Canvas state.</p>
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
          <Button size="sm" onClick={() => void runWorkload()} disabled={!pty || ghosttyStatus !== "ready"}><Send className="mr-1 h-3.5 w-3.5" />Run on same PTY</Button>
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
          <div className="mb-2 flex items-center gap-2 font-medium"><Activity className="h-4 w-4 text-amber-300" />Accessible text projection ({activeText.length.toLocaleString()} chars)</div>
          <pre className="max-h-40 overflow-auto whitespace-pre-wrap text-slate-400">{activeText.slice(-8_000)}</pre>
          {connectionError ? <div className="mt-3 rounded bg-red-950/40 p-2 font-mono text-red-300">PTy error: {connectionError}</div> : null}
        </section>
      </div>
    </main>
  );
}
