import { memo, useEffect, useLayoutEffect, useRef, useState } from "react";
import type { Terminal, IDisposable } from "@xterm/xterm";
import type { FitAddon } from "@xterm/addon-fit";
import type { SerializeAddon } from "@xterm/addon-serialize";
import { getTransport } from "@/transport";
import { useSettingsStore } from "@/stores/settingsStore";
import { shouldInterceptKeyEvent } from "./terminalKeyHandler";
import { ClientTerminalFlowControl } from "./terminalFlowControl";
import { onPtyData, onPtyExit, onPtyReconnectGap, type PtyDataPayload } from "./ptyDataRegistry";
import { isSafeTerminalDimensions, safeFit } from "./safeFit";
import { terminalScroll } from "./terminalScrollController";
import {
  applyRemountAnchor,
  captureRemountAnchor,
  dropRemountAnchor,
} from "./terminalRemountScroll";
import { TERMINAL_POOL_REFIT } from "./terminalPoolRefit";
import { claimWebglSlot, clearWebglSlot, releaseWebglSlot } from "./terminalWebglSlot";
import {
  registerTerminalScrollHarness,
  unregisterTerminalScrollHarness,
} from "./terminalScrollHarness";
// Static import so bundler deduplicates the stylesheet
import "@xterm/xterm/css/xterm.css";

/** Cached xterm core + fit addon constructors. */
type XtermModules = {
  readonly Terminal: typeof import("@xterm/xterm").Terminal;
  readonly FitAddon: typeof import("@xterm/addon-fit").FitAddon;
};

let xtermModulesPromise: Promise<XtermModules> | null = null;

/**
 * Loads the xterm core and fit addon once and caches the result so view
 * remounts (shell-tab / thread switch) skip the cold dynamic-import cost — the
 * single biggest async gap on the remount path. Safe to call eagerly (e.g. when
 * the terminal tab becomes visible) to warm the cache before the first mount.
 */
export function loadXtermModules(): Promise<XtermModules> {
  xtermModulesPromise ??= Promise.all([
    import("@xterm/xterm"),
    import("@xterm/addon-fit"),
  ]).then(([core, fit]) => ({
    Terminal: core.Terminal,
    FitAddon: fit.FitAddon,
  }));
  return xtermModulesPromise;
}

/**
 * Perceptual budget for a terminal view remount (mount → first replay paint),
 * in milliseconds. The dev-only timing hook records the actual value on
 * `window.__mcodeTerminalMountMs` so the E2E suite can assert it stays within
 * this threshold.
 */
export const TERMINAL_REMOUNT_BUDGET_MS = 150;

type MountTimingWindow = Window & { __mcodeTerminalMountMs?: number };

/** Dev-only: record mount→first-paint latency for the remount-speed assertion. */
function recordMountTiming(ms: number): void {
  if (!import.meta.env.DEV) return;
  (window as MountTimingWindow).__mcodeTerminalMountMs = ms;
}

/** Concatenate byte chunks into one buffer for a single batched term.write. */
function concatChunks(chunks: readonly Uint8Array[], totalBytes: number): Uint8Array {
  const out = new Uint8Array(totalBytes);
  let offset = 0;
  for (const chunk of chunks) {
    out.set(chunk, offset);
    offset += chunk.length;
  }
  return out;
}

/**
 * Dev-only live-terminal counter. Exposed on `window.__mcodeLiveTerminals`
 * so Playwright can assert that every terminal is disposed after close/
 * thread-switch. Guarded by `import.meta.env.DEV` so production bundles
 * pay zero cost.
 */
type LiveTerminalWindow = Window & { __mcodeLiveTerminals?: number };

function incrementLiveTerminalCount(): void {
  if (!import.meta.env.DEV) return;
  const w = window as LiveTerminalWindow;
  w.__mcodeLiveTerminals = (w.__mcodeLiveTerminals ?? 0) + 1;
}

function decrementLiveTerminalCount(): void {
  if (!import.meta.env.DEV) return;
  const w = window as LiveTerminalWindow;
  w.__mcodeLiveTerminals = Math.max(0, (w.__mcodeLiveTerminals ?? 1) - 1);
}

// Ensures the counter starts at 0 on module load in dev so the first
// Playwright assertion has a stable baseline.
if (import.meta.env.DEV) {
  const w = window as LiveTerminalWindow;
  if (typeof w.__mcodeLiveTerminals !== "number") {
    w.__mcodeLiveTerminals = 0;
  }
}

/**
 * Dev-only active-renderer sentinel. Exposed on
 * `window.__mcodeActiveRenderer` so Playwright can assert which renderer
 * (WebGL addon vs xterm's built-in DOM renderer) is currently active.
 * Guarded by `import.meta.env.DEV` so production bundles pay zero cost.
 *
 * The "canvas" addon was removed from xterm.js v6, so the fallback path
 * now relies on xterm's built-in DOM renderer, which auto-attaches when
 * no renderer addon is loaded.
 */
type ActiveRendererWindow = Window & { __mcodeActiveRenderer?: "webgl" | "dom" };

function setActiveRenderer(name: "webgl" | "dom"): void {
  if (!import.meta.env.DEV) return;
  (window as ActiveRendererWindow).__mcodeActiveRenderer = name;
}

/**
 * Clears the dev-only active-renderer sentinel. Called on terminal
 * teardown so the sentinel does not report a stale renderer name after
 * the component unmounts.
 */
function clearActiveRenderer(): void {
  if (!import.meta.env.DEV) return;
  delete (window as ActiveRendererWindow).__mcodeActiveRenderer;
}

/**
 * Cached WebGL support result. Memoized at module scope so the probe
 * context is created at most once per session — browsers cap concurrent
 * GL contexts (~8–16) and repeated mounts would otherwise evict the
 * terminal's real WebGL context.
 */
let cachedWebglSupport: boolean | null = null;

/**
 * Returns true if the browser can create a WebGL context. Uses a throwaway
 * canvas so it does not mutate the terminal's own canvas during detection.
 * Result is memoized; the probe context is released immediately via
 * WEBGL_lose_context so it does not count against the browser's
 * concurrent-context cap.
 */
function detectWebglSupport(): boolean {
  if (cachedWebglSupport !== null) return cachedWebglSupport;
  try {
    const c = document.createElement("canvas");
    const ctx = c.getContext("webgl2") ?? c.getContext("webgl");
    if (ctx) {
      // Release the probe context immediately so it doesn't count against
      // the browser's concurrent-GL-context cap.
      const lose = (ctx as WebGLRenderingContext).getExtension(
        "WEBGL_lose_context",
      );
      lose?.loseContext();
    }
    cachedWebglSupport = ctx !== null;
  } catch {
    cachedWebglSupport = false;
  }
  return cachedWebglSupport;
}

/**
 * Returns true when the WebGL renderer should be used. Electron desktop skips
 * WebGL to avoid software-GL ReadPixels stalls that reset the viewport.
 */
function shouldUseWebglRenderer(): boolean {
  if (!detectWebglSupport()) return false;
  if (typeof window !== "undefined" && window.desktopBridge) return false;
  return true;
}

/**
 * Attempts to load the WebGL renderer. On success, installs an
 * `onContextLoss` handler that disposes the WebGL addon for the rest of
 * this terminal's session (no retry — context loss typically recurs
 * under the same conditions) and lets xterm's built-in DOM renderer
 * take over. On any failure (no GPU context, addon construction throw),
 * or if the component has unmounted, leaves the built-in DOM renderer
 * as the active renderer.
 *
 * xterm.js v6 removed the standalone canvas renderer addon, so the
 * fallback is now the DOM renderer that xterm auto-attaches whenever no
 * renderer addon is loaded (or when a loaded addon is disposed).
 *
 * Because the active renderer can change at runtime (WebGL → DOM swap),
 * the caller passes a ref object whose `current` this function
 * reassigns so that cleanup always disposes the addon actually mounted.
 *
 * The module-import await is followed by `isDisposed()` checks so a
 * racing unmount cannot attach an addon to an already-disposed terminal
 * or leave a constructed addon leaked with no owner.
 */
async function loadRenderer(
  ptyId: string,
  term: Terminal,
  rendererRef: { current: IDisposable | null },
  isDisposed: () => boolean,
): Promise<void> {
  if (shouldUseWebglRenderer()) {
    try {
      const { WebglAddon } = await import("@xterm/addon-webgl");
      if (isDisposed()) return;
      const webgl = new WebglAddon();
      if (isDisposed()) {
        try {
          webgl.dispose();
        } catch {
          // Defensive: addon may have internal state that throws.
        }
        return;
      }
      try {
        term.loadAddon(webgl);
      } catch (err) {
        // Construction succeeded but attach failed — dispose the orphaned
        // addon before rethrowing so the outer catch falls through to the
        // DOM renderer without leaking the partially-initialised WebglAddon.
        try {
          webgl.dispose();
        } catch {
          // Defensive: addon may have internal state that throws.
        }
        throw err;
      }
      rendererRef.current = webgl;
      setActiveRenderer("webgl");
      claimWebglSlot(ptyId, () => {
        try {
          webgl.dispose();
        } catch {
          // Already disposed by a racing cleanup — safe to ignore.
        }
        if (rendererRef.current === webgl) {
          rendererRef.current = null;
        }
        setActiveRenderer("dom");
      });
      webgl.onContextLoss(() => {
        // Dispose WebGL; xterm automatically falls back to its built-in
        // DOM renderer when a loaded renderer addon is disposed. The
        // xterm buffer is renderer-independent, so this repaints the
        // existing output without needing a snapshot/restore dance.
        releaseWebglSlot(ptyId);
        if (isDisposed()) return;
        rendererRef.current = null;
        setActiveRenderer("dom");
      });
      return;
    } catch (err) {
      // WebGL addon construction failed; fall through to DOM unless we
      // were disposed during the await.
      if (isDisposed()) return;
      if (import.meta.env.DEV) {
        console.warn(
          "[terminal] WebGL renderer init failed, falling back to DOM",
          err,
        );
      }
    }
  }
  // No renderer addon attached → xterm's built-in DOM renderer is active.
  setActiveRenderer("dom");
}

/** Props for {@link TerminalView}. */
interface TerminalViewProps {
  /** The PTY session ID this view is bound to. */
  readonly ptyId: string;
  /**
   * Whether this terminal is the active tab for the active workspace thread
   * (combined pool flag from {@link TerminalTabContent}).
   */
  readonly visible: boolean;
  /**
   * Whether this terminal's owning thread is the active workspace thread.
   * When false, the server pauses delivery after any in-flight output and the
   * renderer stays attached so scroll position survives a return to the thread.
   */
  readonly threadActive: boolean;
}

/** Renders a single xterm.js terminal backed by a server-side PTY via WS transport. */
export const TerminalView = memo(function TerminalView({
  ptyId,
  visible: shown,
  threadActive,
}: TerminalViewProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const termRef = useRef<Terminal | null>(null);
  const fitAddonRef = useRef<FitAddon | null>(null);
  const cleanupRef = useRef<(() => void) | null>(null);
  const flushResizeRpcRef = useRef<(() => void) | null>(null);
  const resumeWarmViewRef = useRef<(() => void) | null>(null);
  const rendererRef = useRef<IDisposable | null>(null);
  /** Cancels in-flight {@link loadRenderer} when the thread goes dormant or the effect cleans up. */
  const rendererInitCancelledRef = useRef(false);
  const shownRef = useRef(shown);
  shownRef.current = shown;

  const threadActiveRef = useRef(threadActive);
  threadActiveRef.current = threadActive;

  const prevShownRef = useRef(shown);
  const [hydrated, setHydrated] = useState(false);

  const scrollback = useSettingsStore((s) => s.settings.terminal.scrollback);
  const scrollbackRef = useRef(scrollback);
  scrollbackRef.current = scrollback;

  // Mount terminal
  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;

    let disposed = false;
    const mountStart = performance.now();

    async function init(el: HTMLElement) {
      // Cached after the first mount, so remounts skip the cold import cost.
      const [{ Terminal: XTerminal, FitAddon: XFitAddon }, serializeModule] =
        await Promise.all([
          loadXtermModules(),
          import("@xterm/addon-serialize"),
        ]);

      if (disposed || !containerRef.current) return;

      const term = new XTerminal({
        scrollback: scrollbackRef.current,
        fontSize: 13,
        fontFamily: "monospace",
        theme: {
          background: "#0a0a0f",
          foreground: "#e4e4e7",
          cursor: "#e4e4e7",
        },
      });

      const fitAddon = new XFitAddon();
      const serializeAddon: SerializeAddon = new serializeModule.SerializeAddon();
      term.loadAddon(fitAddon);
      term.loadAddon(serializeAddon);
      term.open(el);
      incrementLiveTerminalCount();

      // Intercept Ctrl/Cmd+C when text is selected — copy to clipboard instead of sending SIGINT.
      // Returning false prevents xterm from forwarding the raw \x03 byte to the PTY.
      // Only call getSelection() (a DOM range query) when the key event actually
      // matches the copy shortcut — avoids the cost on every regular keystroke.
      term.attachCustomKeyEventHandler((event: KeyboardEvent) => {
        if (shouldInterceptKeyEvent(event, term.hasSelection())) {
          const selection = term.getSelection();
          if (selection) {
            navigator.clipboard.writeText(selection).catch(() => {});
          }
          return false;
        }
        return true;
      });

      safeFit(fitAddon, el, term);

      termRef.current = term;
      fitAddonRef.current = fitAddon;
      registerTerminalScrollHarness(ptyId, term);

      const transport = getTransport();
      let exited = false;

      const flowSettings =
        useSettingsStore.getState().settings.terminal.flowControl;
      const fc = new ClientTerminalFlowControl({
        onPause: () => transport.terminalPause(ptyId).catch(() => {}),
        onResume: () => {
          if (disposed) return;
          transport.terminalResume(ptyId).catch(() => {});
        },
        highBytes: flowSettings.clientHighBytes,
        lowBytes: flowSettings.clientLowBytes,
      });

      // Right-click pastes clipboard text into the PTY (native terminal convention — no context menu).
      // term.paste() is used instead of transport.terminalWrite() so that xterm applies bracketed
      // paste mode when the shell requests it, preventing embedded newlines from auto-executing commands.
      const handleContextMenu = (e: MouseEvent) => {
        e.preventDefault();
        if (exited) return;
        navigator.clipboard
          .readText()
          .then((text) => {
            if (text) {
              term.paste(text);
            }
          })
          .catch(() => {});
      };
      el.addEventListener("contextmenu", handleContextMenu);

      // Forward keystrokes to the backend via WS RPC
      const dataDisposable = term.onData((data) => {
        if (exited) return;
        transport.terminalWrite(ptyId, data).catch(() => {});
      });

      const onUserScroll = () => {
        if (!shownRef.current) return;
        terminalScroll.onUserScroll(ptyId, term);
      };
      const scrollDisposable = term.onScroll(onUserScroll);
      // Mouse wheel may not always emit onScroll before a thread switch.
      const onWheel = onUserScroll;
      el.addEventListener("wheel", onWheel, { passive: true });

      // #748 reattach gate: a freshly mounted view replays the server's
      // retained scrollback via terminal.reattach (below), then follows the
      // tail. Because the shell keeps streaming while no view is mounted, live
      // frames (higher seq) can arrive while the reattach RPC is still in
      // flight, ahead of the replayed frames (lower seq). Buffer everything
      // until the replay completes, then write in seq order so the viewport
      // shows scrollback-then-tail, not a garbled tail-then-scrollback.
      let replaying = true;
      let replayMode: "cold" | "warm" = "cold";
      const replayPending: PtyDataPayload[] = [];
      let replayPrefix: Uint8Array | null = null;
      // Highest seq actually written. seq is monotonic per PTY, so anything not
      // strictly newer has already been painted. Guards against double delivery:
      // a newly created PTY's first prompt is both retained in the replay buffer
      // (sent by reattach) and queued in the flow-control pause buffer (re-sent
      // when resume drains it), and the resume drain lands after the gate closes.
      let lastWrittenSeq = Number.NEGATIVE_INFINITY;
      const pendingWrites = new Set<Promise<void>>();

      const trackedWrite = (
        data: string | Uint8Array,
        callback?: () => void,
      ) => {
        if (disposed) return;
        let finishWrite = () => {};
        const completed = new Promise<void>((resolve) => {
          finishWrite = resolve;
        });
        pendingWrites.add(completed);
        try {
          term.write(data, () => {
            try {
              callback?.();
            } finally {
              pendingWrites.delete(completed);
              finishWrite();
            }
          });
        } catch (error) {
          pendingWrites.delete(completed);
          finishWrite();
          throw error;
        }
      };

      const writeChunk = (detail: PtyDataPayload) => {
        if (disposed || detail.seq <= lastWrittenSeq) return;
        lastWrittenSeq = detail.seq;
        transport.ptySetLastSeq(ptyId, detail.seq);
        const n = detail.payload.length;
        fc.written(n);
        // xterm's callback form fires acked() only after bytes are committed to
        // the buffer, so client flow control reflects real write progress.
        trackedWrite(detail.payload, () => {
          fc.acked(n);
        });
      };

      const flushReplayGate = () => {
        replaying = false;
        // Replayed frames (lower seq) and any live frames buffered during the
        // reattach (higher seq) are merged here; sort restores wire order and
        // the lastWrittenSeq guard drops anything already painted.
        replayPending.sort((a, b) => a.seq - b.seq);
        const frames: Uint8Array[] = [];
        let totalBytes = 0;
        if (replayPrefix) {
          frames.push(replayPrefix);
          totalBytes += replayPrefix.length;
          replayPrefix = null;
        }
        for (const detail of replayPending) {
          if (detail.seq <= lastWrittenSeq) continue;
          lastWrittenSeq = detail.seq;
          frames.push(detail.payload);
          totalBytes += detail.payload.length;
        }
        replayPending.length = 0;

        // #751: restore the prior scroll region if the user had scrolled up
        // before unmount; otherwise follow the tail. Record remount latency once
        // the replay paints.
        const follow = () => {
          if (replayMode === "cold") {
            applyRemountAnchor(ptyId, term);
          } else {
            terminalScroll.restore(ptyId, term);
          }
          setHydrated(true);
          recordMountTiming(performance.now() - mountStart);
        };

        if (frames.length === 0) {
          follow();
          return;
        }
        // #749: write the whole replay in one pass instead of one main-thread
        // task per chunk, so a large scrollback replay paints quickly.
        transport.ptySetLastSeq(ptyId, lastWrittenSeq);
        fc.written(totalBytes);
        trackedWrite(concatChunks(frames, totalBytes), () => {
          fc.acked(totalBytes);
          follow();
        });
      };

      // Listen for PTY output via the direct callback registry. Attached BEFORE
      // awaiting the renderer so output that arrives during renderer init is
      // queued into the xterm buffer (term.write is renderer-independent) and
      // painted as soon as a renderer attaches — never dropped.
      const unsubPtyData = onPtyData(ptyId, (detail) => {
        if (replaying) {
          replayPending.push(detail);
          return;
        }
        writeChunk(detail);
      });

      // Show a reconnect banner when the server signals that the replay window
      // was exceeded and some output may have been missed.
      const unsubReconnectGap = onPtyReconnectGap(ptyId, () => {
        trackedWrite(
          "\r\n\x1b[90m[Reconnected - some output may be missing]\x1b[0m\r\n",
        );
      });

      // Listen for PTY exit via the direct callback registry (attached
      // pre-renderer for the same reason as pty-data: an early exit should
      // not be silently lost).
      const unsubPtyExit = onPtyExit(ptyId, (detail) => {
        exited = true;
        term.options.disableStdin = true;
        trackedWrite(
          `\r\n\x1b[90m[Process exited with code ${detail.code}]\x1b[0m\r\n`,
        );
        // The PTY is gone and cannot remount; drop any saved scroll anchor.
        dropRemountAnchor(ptyId);
      });

      // Resize handling:
      //
      // ResizeObserver can fire every animation frame during drag. Two distinct
      // concerns, two strategies:
      //   - Local fitAddon.fit() is cheap and keeps the terminal visibly aligned
      //     during drag → coalesce to one call per animation frame via rAF.
      //   - The terminal.resize RPC is expensive (WS → node-pty → shell repaint)
      //     → debounce to a single trailing call 100 ms after the last change.
      //
      // Skip RPCs where the character grid (cols, rows) has not changed — drags
      // that move by less than one cell of pixels otherwise send no-op resizes.
      let rafId: number | null = null;
      let rpcTimer: ReturnType<typeof setTimeout> | null = null;
      let lastSentCols = -1;
      let lastSentRows = -1;

      const flushResizeRpc = () => {
        // Clear any pending timeout so a manual flush (e.g. from the
        // visibility effect) supersedes the scheduled trailing call
        // instead of racing with it. Without this, a later timer fire
        // could double-send the resize RPC or send stale dimensions.
        if (rpcTimer !== null) {
          clearTimeout(rpcTimer);
          rpcTimer = null;
        }
        if (disposed || exited || terminalScroll.shouldDeferFitRefresh(ptyId)) return;
        const dims = fitAddonRef.current?.proposeDimensions();
        if (!isSafeTerminalDimensions(dims)) return;
        if (dims.cols === lastSentCols && dims.rows === lastSentRows) return;
        lastSentCols = dims.cols;
        lastSentRows = dims.rows;
        transport.terminalResize(ptyId, dims.cols, dims.rows).catch(() => {});
      };
      flushResizeRpcRef.current = flushResizeRpc;

      const observer = new ResizeObserver(() => {
        if (disposed || !fitAddonRef.current) return;
        // Skip fit() when the container is display:none (visible=false).
        // FitAddon.proposeDimensions() reads the parent's clientWidth/Height
        // which are 0 when hidden, producing a 2×1 grid. Resizing xterm to
        // 2 columns causes every line to wrap, overflowing the fixed-size
        // scrollback buffer and permanently truncating history.
        if (!shownRef.current || !threadActiveRef.current) return;
        if (rafId === null) {
          rafId = requestAnimationFrame(() => {
            rafId = null;
            if (
              disposed ||
              !shownRef.current ||
              !threadActiveRef.current ||
              terminalScroll.shouldDeferFitRefresh(ptyId)
            ) {
              return;
            }
            const fit = fitAddonRef.current;
            const t = termRef.current;
            if (fit && t) safeFit(fit, el, t);
          });
        }
        if (rpcTimer !== null) clearTimeout(rpcTimer);
        rpcTimer = setTimeout(flushResizeRpc, 100);
      });
      observer.observe(el);

      let cleanupStarted = false;
      const cleanup = () => {
        if (cleanupStarted) return;
        cleanupStarted = true;
        disposed = true;
        if (rafId !== null) cancelAnimationFrame(rafId);
        if (rpcTimer !== null) clearTimeout(rpcTimer);
        flushResizeRpcRef.current = null;
        resumeWarmViewRef.current = null;
        dataDisposable.dispose();
        scrollDisposable.dispose();
        el.removeEventListener("wheel", onWheel);
        el.removeEventListener("contextmenu", handleContextMenu);
        unsubPtyData();
        unsubReconnectGap();
        unsubPtyExit();
        transport.ptyDeleteLastSeq(ptyId);
        terminalScroll.clear(ptyId);
        observer.disconnect();
        releaseWebglSlot(ptyId);
        try {
          rendererRef.current?.dispose();
        } catch {
          // Renderer may already be disposed by a racing context-loss swap,
          // or the renderer never attached because loadRenderer aborted on a
          // mid-await disposal. Either way, nothing left to release here.
        }
        rendererRef.current = null;
        clearWebglSlot(ptyId);
        clearActiveRenderer();
        unregisterTerminalScrollHarness(ptyId);
        void Promise.all([...pendingWrites]).then(() => {
          // #751: remember where the user was before this view goes away so the
          // next remount can restore it (no-op when they followed the tail).
          captureRemountAnchor(ptyId, term);
          const checkpointSeq = Number.isFinite(lastWrittenSeq) ? lastWrittenSeq : -1;
          const checkpoint = serializeAddon.serialize();
          void transport
            .terminalCheckpoint(ptyId, checkpointSeq, checkpoint)
            .catch(() => {});
          term.dispose();
          decrementLiveTerminalCount();
        });
      };

      // Register cleanup BEFORE awaiting the renderer so a mid-await unmount
      // can reach it via React's teardown path, and so PTY events delivered
      // during the await are handled by listeners that already have a known
      // disposal pathway. term.write() queues into the xterm buffer even
      // before a renderer is attached, so no initial output is lost.
      cleanupRef.current = cleanup;

      if (disposed) {
        cleanup();
        cleanupRef.current = null;
        return;
      }

      // #748: replay retained scrollback into this fresh xterm, then follow the
      // tail. The reattach resolves after all replay frames have been sent (WS
      // ordering puts the data frames ahead of the RPC response), at which point
      // the gate flushes. lastSeq = -1 requests the full retained window.
      const reattach = (lastSeq: number, mode: "cold" | "warm") => {
        replaying = true;
        replayMode = mode;
        return transport
          .terminalReattach(ptyId, lastSeq, mode === "cold")
        .then((result) => {
          if (disposed) return;
          if (result.mode === "checkpoint") {
            lastWrittenSeq = result.checkpointThrough;
            transport.ptySetLastSeq(ptyId, result.checkpointThrough);
            replayPrefix = new TextEncoder().encode(result.checkpoint);
          } else if (result.mode === "reset") {
            lastWrittenSeq = result.discardThrough;
            replayPending.splice(
              0,
              replayPending.length,
              ...replayPending.filter((frame) => frame.seq > result.discardThrough),
            );
            trackedWrite(
              "\r\n[Earlier output beyond the scrollback limit was trimmed]\r\n",
            );
          }
          flushReplayGate();
        })
        .catch(() => {
          // Reattach failed (e.g. the PTY already exited); release the gate so
          // any buffered live frames still paint.
          if (disposed) return;
          flushReplayGate();
        })
        .finally(() => {
          if (!disposed && !exited && shownRef.current) {
            transport.terminalResume(ptyId).catch(() => {});
          }
        });
      };

      resumeWarmViewRef.current = () => {
        if (disposed || exited || replaying) return;
        const lastSeq = Number.isFinite(lastWrittenSeq) ? lastWrittenSeq : -1;
        void reattach(lastSeq, "warm");
      };

      // Newly created PTYs begin paused. Reattach first so retained output and
      // any paused live frames share one sequence gate, then resume.
      void reattach(-1, "cold");

      // DOM renderer only at init; WebGL loads when this terminal becomes shown
      // (see shown effect) so the pool never holds multiple GL contexts.
      setActiveRenderer("dom");

      // Auto-focus: the visibility effect's term.focus() fires before
      // init completes (termRef is still null at that point), so newly
      // created terminals wouldn't receive focus. Pull focus here after
      // init when the terminal is visible.
      if (shownRef.current) {
        term.focus();
      }
    }

    // init() awaits dynamic imports and may construct/attach xterm before
    // cleanupRef is registered. If any of those steps reject, flip the
    // disposed latch and run whatever cleanup has been wired up so no
    // partial state (live counter increment, attached listeners) leaks.
    void init(container).catch((err) => {
      console.warn("[terminal] Failed to initialize terminal", err);
      disposed = true;
      cleanupRef.current?.();
      cleanupRef.current = null;
      termRef.current = null;
      fitAddonRef.current = null;
    });

    return () => {
      disposed = true;
      rendererInitCancelledRef.current = true;
      cleanupRef.current?.();
      cleanupRef.current = null;
      termRef.current = null;
      fitAddonRef.current = null;
    };
  }, [ptyId]);

  // Save scroll on hide; arm restore on show (restore runs after paint in finishShow).
  useLayoutEffect(() => {
    const term = termRef.current;

    if (term && prevShownRef.current && !shown) {
      terminalScroll.onHide(ptyId, term);
      releaseWebglSlot(ptyId);
      getTransport().terminalPause(ptyId).catch(() => {});
    }

    if (term && shown && !prevShownRef.current) {
      terminalScroll.onShow(ptyId);
      resumeWarmViewRef.current?.();
    }

    prevShownRef.current = shown;
  }, [shown, ptyId]);

  // After layout + visibility (or pool refit), restore scroll then repaint/focus when safe.
  useEffect(() => {
    const applyRestore = () => {
      const t = termRef.current;
      if (!t || !shownRef.current) return;
      terminalScroll.restore(ptyId, t);
    };

    const finishShow = () => {
      if (!shownRef.current) return;
      const t = termRef.current;
      if (!t) return;
      applyRestore();
      const fit = fitAddonRef.current;
      if (fit) {
        safeFit(fit, containerRef.current, t);
      }
      applyRestore();
      flushResizeRpcRef.current?.();
      const pinned = terminalScroll.isPinned(ptyId);
      if (!pinned && !terminalScroll.shouldDeferFitRefresh(ptyId)) {
        t.refresh(0, t.rows - 1);
      }
      if (!pinned) {
        t.focus();
      }
    };

    const runShowSequence = () => {
      requestAnimationFrame(() => {
        applyRestore();
        requestAnimationFrame(() => {
          applyRestore();
          requestAnimationFrame(finishShow);
        });
      });
    };

    const onPoolRefit = () => {
      if (!shownRef.current) return;
      runShowSequence();
    };

    window.addEventListener(TERMINAL_POOL_REFIT, onPoolRefit);

    if (shown) {
      runShowSequence();
    }

    return () => {
      window.removeEventListener(TERMINAL_POOL_REFIT, onPoolRefit);
    };
  }, [shown, ptyId]);

  // Repaint xterm when the browser window/tab regains visibility.
  // Long background stints leave the canvas half-painted; fit + refresh
  // fixes it. Reads `shownRef` (not the prop) so the effect registers
  // listeners once and never re-registers on prop changes.
  useEffect(() => {
    const repaint = () => {
      if (!shownRef.current) return;
      const term = termRef.current;
      if (!term || terminalScroll.shouldDeferFitRefresh(ptyId)) return;
      if (terminalScroll.restoreAnchor(ptyId)) {
        terminalScroll.restore(ptyId, term);
        return;
      }
      const fit = fitAddonRef.current;
      if (fit) safeFit(fit, containerRef.current, term);
      if (!terminalScroll.shouldDeferFitRefresh(ptyId) && !terminalScroll.isPinned(ptyId)) {
        term.refresh(0, term.rows - 1);
      }
    };

    const onVisibilityChange = () => {
      if (document.visibilityState === "visible") repaint();
    };
    document.addEventListener("visibilitychange", onVisibilityChange);
    window.addEventListener("focus", repaint);
    return () => {
      document.removeEventListener("visibilitychange", onVisibilityChange);
      window.removeEventListener("focus", repaint);
    };
  }, []);

  // Sync scrollback setting to live terminal without remounting
  useEffect(() => {
    if (termRef.current) {
      termRef.current.options.scrollback = scrollback;
    }
  }, [scrollback]);

  // Attach WebGL only while shown and after scroll restore; one GL context pool-wide.
  useEffect(() => {
    if (!shown || !threadActive) {
      rendererInitCancelledRef.current = true;
      return;
    }

    const term = termRef.current;
    if (!term) return;

    rendererInitCancelledRef.current = false;
    let cancelled = false;

    const scheduleLoad = () => {
      if (cancelled || rendererInitCancelledRef.current) return;
      if (!shownRef.current || !threadActiveRef.current) return;
      if (rendererRef.current !== null) return;
      if (terminalScroll.shouldDeferFitRefresh(ptyId)) {
        requestAnimationFrame(scheduleLoad);
        return;
      }
      void loadRenderer(
        ptyId,
        term,
        rendererRef,
        () =>
          cancelled ||
          rendererInitCancelledRef.current ||
          !shownRef.current ||
          !threadActiveRef.current,
      ).then(() => {
        if (cancelled || !shownRef.current) return;
        terminalScroll.restore(ptyId, term);
      });
    };

    requestAnimationFrame(() => {
      requestAnimationFrame(scheduleLoad);
    });

    return () => {
      cancelled = true;
      rendererInitCancelledRef.current = true;
    };
  }, [shown, threadActive, ptyId]);

  return (
    <div
      ref={containerRef}
      className="h-full min-h-0 w-full"
      data-terminal-hydrated={hydrated}
      style={{ visibility: shown && hydrated ? "visible" : "hidden" }}
    />
  );
});
