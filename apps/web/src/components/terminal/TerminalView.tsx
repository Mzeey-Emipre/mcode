import { memo, useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import type { Terminal, IDisposable } from "@xterm/xterm";
import type { SerializeAddon } from "@xterm/addon-serialize";
import type { SearchAddon } from "@xterm/addon-search";
import type { TerminalSettings } from "@mcode/contracts";
import { getTransport } from "@/transport";
import { useSettingsStore } from "@/stores/settingsStore";
import { useDiffStore } from "@/stores/diffStore";
import { useTerminalStore, type TerminalSearchOptions } from "@/stores/terminalStore";
import { useWorkspaceStore } from "@/stores/workspaceStore";
import { isTerminalSearchShortcut, shouldInterceptKeyEvent } from "./terminalKeyHandler";
import { ClientTerminalFlowControl } from "./terminalFlowControl";
import {
  TERMINAL_CLEANUP_TIMEOUT_MS,
  type TerminalDataEvent,
} from "@/terminal/terminal-client";
import { terminalScroll } from "./terminalScrollController";
import {
  captureScrollAnchor,
} from "./terminalScrollState";
import {
  createTerminalResizeController,
  type TerminalResizeController,
} from "./terminalResizeController";
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
import {
  compileTerminalSearchRegex,
  TerminalSearchShelf,
  type TerminalSearchAddonState,
  type TerminalSearchDirection,
  type TerminalSearchRunResult,
} from "./TerminalSearchShelf";
import { loadTerminalSearchAddon } from "./terminalSearchAddon";
// Static import so bundler deduplicates the stylesheet
import "@xterm/xterm/css/xterm.css";

/** Cached xterm core + fit addon constructors. */
type XtermModules = {
  readonly Terminal: typeof import("@xterm/xterm").Terminal;
  readonly FitAddon: typeof import("@xterm/addon-fit").FitAddon;
};

let xtermModulesPromise: Promise<XtermModules> | null = null;
const TERMINAL_BACKGROUND = "#0a0a0f";

function resolveTerminalSearchColor(token: string): string {
  const color = getComputedStyle(document.documentElement)
    .getPropertyValue(token)
    .trim();
  if (!color) {
    throw new Error(`Terminal search color token ${token} is unavailable`);
  }
  return color;
}

function resolveTerminalSearchDecorations() {
  return {
    matchBackground: resolveTerminalSearchColor("--muted"),
    matchBorder: resolveTerminalSearchColor("--border"),
    matchOverviewRuler: resolveTerminalSearchColor("--primary"),
    activeMatchBackground: resolveTerminalSearchColor("--primary"),
    activeMatchBorder: resolveTerminalSearchColor("--ring"),
    activeMatchColorOverviewRuler: resolveTerminalSearchColor("--ring"),
  };
}

const TERMINAL_FONT_SIZES: Record<TerminalSettings["presentation"]["fontSize"], number> = {
  xs: 11,
  sm: 13,
  md: 15,
  lg: 17,
  xl: 19,
};
const TERMINAL_LINE_HEIGHTS: Record<TerminalSettings["presentation"]["lineHeight"], number> = {
  compact: 1.1,
  normal: 1.2,
  relaxed: 1.4,
};

function getTerminalOptions(settings: TerminalSettings): {
  readonly scrollback: number;
  readonly fontFamily: string;
  readonly fontSize: number;
  readonly lineHeight: number;
  readonly cursorStyle: TerminalSettings["presentation"]["cursorStyle"];
  readonly cursorBlink: boolean;
  readonly screenReaderMode: boolean;
} {
  return {
    scrollback: settings.behavior.scrollback,
    fontFamily: settings.presentation.fontFamily,
    fontSize: TERMINAL_FONT_SIZES[settings.presentation.fontSize],
    lineHeight: TERMINAL_LINE_HEIGHTS[settings.presentation.lineHeight],
    cursorStyle: settings.presentation.cursorStyle,
    cursorBlink: settings.presentation.cursorBlink,
    // xterm exposes a boolean only. Automatic has no reliable renderer-side
    // accessibility signal, so it keeps xterm's default disabled state.
    screenReaderMode: settings.accessibility.screenReaderMode === "on",
  };
}

function applyTerminalSettings(term: Terminal, settings: TerminalSettings): void {
  const options = getTerminalOptions(settings);
  term.options.scrollback = options.scrollback;
  term.options.fontFamily = options.fontFamily;
  term.options.fontSize = options.fontSize;
  term.options.lineHeight = options.lineHeight;
  term.options.cursorStyle = options.cursorStyle;
  term.options.cursorBlink = options.cursorBlink;
  term.options.screenReaderMode = options.screenReaderMode;
  if (term.element) {
    term.element.style.fontVariantLigatures = settings.presentation.ligatures ? "normal" : "none";
  }
}

function settleWithin<T>(promise: Promise<T>, fallback: T): Promise<T> {
  return new Promise((resolve) => {
    let settled = false;
    const finish = (value: T) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(value);
    };
    const timer = setTimeout(
      () => finish(fallback),
      TERMINAL_CLEANUP_TIMEOUT_MS,
    );
    promise.then(finish, () => finish(fallback));
  });
}

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
  /** Called after the renderer is fully disposed during a shell handoff. */
  readonly onDisposed?: () => void;
}

/** Renders a single xterm.js terminal backed by a server-side PTY via WS transport. */
export const TerminalView = memo(function TerminalView({
  ptyId,
  visible: shown,
  threadActive,
  onDisposed,
}: TerminalViewProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const fitHostRef = useRef<HTMLDivElement>(null);
  const termRef = useRef<Terminal | null>(null);
  const resizeControllerRef = useRef<TerminalResizeController | null>(null);
  const cleanupRef = useRef<(() => void) | null>(null);
  const flushResizeRpcRef = useRef<(() => void) | null>(null);
  const resumeWarmViewRef = useRef<(() => void) | null>(null);
  const rendererRef = useRef<IDisposable | null>(null);
  const searchAddonRef = useRef<SearchAddon | null>(null);
  const searchResultDisposableRef = useRef<IDisposable | null>(null);
  const openSearchRef = useRef<() => void>(() => {});
  const [searchAddonState, setSearchAddonState] = useState<TerminalSearchAddonState>("loading");
  const [searchAddonRetry, setSearchAddonRetry] = useState(0);
  const [termReady, setTermReady] = useState(false);
  /** Cancels in-flight {@link loadRenderer} when the thread goes dormant or the effect cleans up. */
  const rendererInitCancelledRef = useRef(false);
  const onDisposedRef = useRef(onDisposed);
  onDisposedRef.current = onDisposed;
  const disposedNotifiedRef = useRef(false);
  const shownRef = useRef(shown);
  shownRef.current = shown;

  const threadActiveRef = useRef(threadActive);
  threadActiveRef.current = threadActive;

  const prevShownRef = useRef(shown);
  const [hydrated, setHydrated] = useState(false);

  const terminalSettings = useSettingsStore((s) => s.settings.terminal);
  const terminalSettingsRef = useRef(terminalSettings);
  terminalSettingsRef.current = terminalSettings;
  const copyOnSelectRef = useRef(terminalSettings.behavior.copyOnSelect);
  copyOnSelectRef.current = terminalSettings.behavior.copyOnSelect;
  const confirmMultilinePasteRef = useRef(terminalSettings.behavior.confirmMultilinePaste);
  confirmMultilinePasteRef.current = terminalSettings.behavior.confirmMultilinePaste;

  // Mount terminal
  useEffect(() => {
    const container = containerRef.current;
    const fitHost = fitHostRef.current;
    if (!container || !fitHost) return;

    disposedNotifiedRef.current = false;
    let disposed = false;
    const mountStart = performance.now();

    async function init(el: HTMLElement) {
      // Cached after the first mount, so remounts skip the cold import cost.
      const [{ Terminal: XTerminal, FitAddon: XFitAddon }, serializeModule] =
        await Promise.all([
          loadXtermModules(),
          import("@xterm/addon-serialize"),
        ]);
      if (disposed || !containerRef.current || !fitHostRef.current) {
        if (!disposedNotifiedRef.current) {
          disposedNotifiedRef.current = true;
          onDisposedRef.current?.();
        }
        return;
      }

      const term = new XTerminal({
        ...getTerminalOptions(terminalSettingsRef.current),
        allowProposedApi: true,
        theme: {
          background: TERMINAL_BACKGROUND,
          foreground: "#e4e4e7",
          cursor: "#e4e4e7",
        },
      });

      const fitAddon = new XFitAddon();
      const serializeAddon: SerializeAddon = new serializeModule.SerializeAddon();
      term.loadAddon(fitAddon);
      term.loadAddon(serializeAddon);
      term.open(el);
      applyTerminalSettings(term, terminalSettingsRef.current);
      incrementLiveTerminalCount();
      let exited = false;

      const pasteText = (text: string) => {
        if (!text) return;
        if (confirmMultilinePasteRef.current && /\r?\n/.test(text) && !window.confirm("Paste multiple lines into the terminal?")) {
          return;
        }
        term.paste(text);
      };

      const selectionDisposable = term.onSelectionChange(() => {
        if (!copyOnSelectRef.current || exited) return;
        const selection = term.getSelection();
        if (selection) {
          navigator.clipboard.writeText(selection).catch(() => {});
        }
      });

      // Intercept Ctrl/Cmd+C when text is selected — copy to clipboard instead of sending SIGINT.
      // Returning false prevents xterm from forwarding the raw \x03 byte to the PTY.
      // Only call getSelection() (a DOM range query) when the key event actually
      // matches the copy shortcut — avoids the cost on every regular keystroke.
      term.attachCustomKeyEventHandler((event: KeyboardEvent) => {
        if (isTerminalSearchShortcut(event)) {
          event.preventDefault();
          openSearchRef.current();
          return false;
        }
        if (shouldInterceptKeyEvent(event, term.hasSelection())) {
          const selection = term.getSelection();
          if (selection) {
            navigator.clipboard.writeText(selection).catch(() => {});
          }
          return false;
        }
        return true;
      });

      termRef.current = term;
      setTermReady(true);
      registerTerminalScrollHarness(ptyId, term);

      const transport = getTransport();

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
            pasteText(text);
          })
          .catch(() => {});
      };
      el.addEventListener("contextmenu", handleContextMenu);

      const handlePaste = (event: ClipboardEvent) => {
        if (!confirmMultilinePasteRef.current) return;
        const text = event.clipboardData?.getData("text/plain") ?? "";
        if (!text || !/\r?\n/.test(text)) return;
        event.preventDefault();
        pasteText(text);
      };
      el.addEventListener("paste", handlePaste, true);

      // Forward keystrokes to the backend via WS RPC
      const dataDisposable = term.onData((data) => {
        if (exited) return;
        resizeControllerRef.current?.flushBeforeInput();
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
      const replayPending: TerminalDataEvent[] = [];
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

      const writeChunk = (detail: TerminalDataEvent) => {
        if (disposed || detail.seq <= lastWrittenSeq) return;
        lastWrittenSeq = detail.seq;
        const n = detail.payload.length;
        fc.written(n);
        // xterm's callback form fires acked() only after bytes are committed to
        // the buffer, so client flow control reflects real write progress.
        trackedWrite(detail.payload, () => {
          fc.acked(n);
          transport.ptySetLastSeq(ptyId, detail.seq);
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
        fc.written(totalBytes);
        trackedWrite(concatChunks(frames, totalBytes), () => {
          fc.acked(totalBytes);
          transport.ptySetLastSeq(ptyId, lastWrittenSeq);
          follow();
        });
      };

      // Listen for PTY output via the direct callback registry. Attached BEFORE
      // awaiting the renderer so output that arrives during renderer init is
      // queued into the xterm buffer (term.write is renderer-independent) and
      // painted as soon as a renderer attaches — never dropped.
      const unsubPtyData = transport.terminalSubscribe(ptyId, { onData: (detail) => {
        if (replaying) {
          replayPending.push(detail);
          return;
        }
        writeChunk(detail);
      }});

      // Show a reconnect banner when the server signals that the replay window
      // was exceeded and some output may have been missed.
      const unsubReconnectGap = transport.terminalSubscribe(ptyId, { onReconnectGap: () => {
        trackedWrite(
          "\r\n\x1b[90m[Reconnected - some output may be missing]\x1b[0m\r\n",
        );
      }});

      // Listen for PTY exit via the direct callback registry (attached
      // pre-renderer for the same reason as pty-data: an early exit should
      // not be silently lost).
      const unsubPtyExit = transport.terminalSubscribe(ptyId, { onExit: (detail) => {
        exited = true;
        term.options.disableStdin = true;
        trackedWrite(
          `\r\n\x1b[90m[Process exited with code ${detail.code}]\x1b[0m\r\n`,
        );
        // The PTY is gone and cannot remount; drop any saved scroll anchor.
        dropRemountAnchor(ptyId);
        const terminal = useTerminalStore.getState();
        const scopeId = terminal.ptyToThread[ptyId];
        if (!scopeId) return;
        terminal.removeTerminal(ptyId);
        const workspace = useWorkspaceStore.getState();
        const thread = workspace.threads.find((candidate) => candidate.id === scopeId);
        const workspaceId = thread?.workspace_id ??
          (workspace.workspaces.some((candidate) => candidate.id === scopeId) ? scopeId : undefined);
        if (workspaceId) {
          useDiffStore.getState().closeRightPanelTabInstance(
            workspaceId,
            thread ? scopeId : undefined,
            `terminal:${ptyId}`,
          );
        }
      }});

      const resizeController = createTerminalResizeController({
        container: el,
        fitAddon,
        term,
        isActive: () => shownRef.current && threadActiveRef.current,
        isDisposed: () => disposed || exited,
        shouldDeferFit: () => terminalScroll.shouldDeferFitRefresh(ptyId),
        runProgrammatic: (fn) => terminalScroll.runProgrammatic(ptyId, fn),
        captureScrollIntent: () => captureScrollAnchor(term),
        restoreScrollIntent: (intent) => {
          terminalScroll.restoreAfterResize(ptyId, term, intent);
        },
        sendResize: ({ cols, rows }) =>
          transport.terminalResize(ptyId, cols, rows).catch(() => {}),
      });
      resizeControllerRef.current = resizeController;
      flushResizeRpcRef.current = resizeController.flushResize;
      resizeController.observe();
      resizeController.requestFit();

      let cleanupStarted = false;
      const cleanup = () => {
        if (cleanupStarted) return;
        cleanupStarted = true;
        disposed = true;
        resizeController.dispose();
        resizeControllerRef.current = null;
        flushResizeRpcRef.current = null;
        resumeWarmViewRef.current = null;
        openSearchRef.current = () => {};
        setTermReady(false);
        dataDisposable.dispose();
        scrollDisposable.dispose();
        selectionDisposable.dispose();
        el.removeEventListener("wheel", onWheel);
        el.removeEventListener("contextmenu", handleContextMenu);
        el.removeEventListener("paste", handlePaste, true);
        unsubPtyData();
        unsubReconnectGap();
        unsubPtyExit();
        transport.ptyDeleteLastSeq(ptyId);
        terminalScroll.clear(ptyId);
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
        const checkpoint = settleWithin(Promise.all([...pendingWrites]).then(() => {
          // #751: remember where the user was before this view goes away so the
          // next remount can restore it (no-op when they followed the tail).
          captureRemountAnchor(ptyId, term);
          const checkpointSeq = Number.isFinite(lastWrittenSeq) ? lastWrittenSeq : -1;
          return {
            seq: checkpointSeq,
            data: serializeAddon.serialize(),
          };
        }), undefined);
        let detach: Promise<void>;
        try {
          // Capture the attachment before the checkpoint can yield. The client
          // uses this synchronous call to bind checkpoint and detach together.
          detach = transport.terminalDetachForSwitch(ptyId, checkpoint);
        } catch {
          detach = Promise.reject(new Error("Terminal detach failed"));
        }
        void settleWithin(detach, undefined).finally(() => {
          try {
            term.dispose();
          } finally {
            decrementLiveTerminalCount();
            if (!disposedNotifiedRef.current) {
              disposedNotifiedRef.current = true;
              onDisposedRef.current?.();
            }
          }
        }).catch(() => {});
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
    void init(fitHost).catch((err) => {
      console.warn("[terminal] Failed to initialize terminal", err);
      disposed = true;
      const hadCleanup = cleanupRef.current !== null;
      cleanupRef.current?.();
      cleanupRef.current = null;
      termRef.current = null;
      if (!hadCleanup && !disposedNotifiedRef.current) {
        disposedNotifiedRef.current = true;
        onDisposedRef.current?.();
      }
    });

    return () => {
      disposed = true;
      rendererInitCancelledRef.current = true;
      cleanupRef.current?.();
      cleanupRef.current = null;
      termRef.current = null;
      setTermReady(false);
    };
  }, [ptyId]);

  // Keep SearchAddon loading separate from xterm construction so a rejected
  // addon import can recover without remounting the sole terminal renderer.
  useEffect(() => {
    if (!termReady) return;
    const term = termRef.current;
    if (!term) return;

    let cancelled = false;
    let constructedSearchAddon: SearchAddon | null = null;
    setSearchAddonState("loading");

    void loadTerminalSearchAddon()
      .then(({ SearchAddon: XSearchAddon }) => {
        if (cancelled || termRef.current !== term) return;
        const searchAddon = new XSearchAddon();
        constructedSearchAddon = searchAddon;
        if (cancelled || termRef.current !== term) {
          searchAddon.dispose();
          return;
        }
        term.loadAddon(searchAddon);
        const resultDisposable = searchAddon.onDidChangeResults((result) => {
          useTerminalStore
            .getState()
            .setTerminalSearchResult(ptyId, result.resultIndex, result.resultCount);
        });
        searchAddonRef.current = searchAddon;
        searchResultDisposableRef.current = resultDisposable;
        setSearchAddonState("ready");
      })
      .catch((error: unknown) => {
        if (cancelled) return;
        constructedSearchAddon?.dispose();
        constructedSearchAddon = null;
        setSearchAddonState("failed");
        if (import.meta.env.DEV) {
          console.warn("[terminal] Search addon failed to load", error);
        }
      });

    return () => {
      cancelled = true;
      searchResultDisposableRef.current?.dispose();
      searchResultDisposableRef.current = null;
      searchAddonRef.current?.dispose();
      searchAddonRef.current = null;
    };
  }, [ptyId, searchAddonRetry, termReady]);

  // Save scroll on hide; arm restore on show (restore runs after paint in finishShow).
  useLayoutEffect(() => {
    const term = termRef.current;

    if (term && prevShownRef.current && !shown) {
      terminalScroll.onHide(ptyId, term);
      releaseWebglSlot(ptyId);
    }

    if (term && shown && !prevShownRef.current) {
      terminalScroll.onShow(ptyId);
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
      resizeControllerRef.current?.requestFit();
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
      resizeControllerRef.current?.requestFit();
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

  // Apply safe Terminal presentation and behavior changes to the open xterm.
  useEffect(() => {
    if (termRef.current) {
      applyTerminalSettings(termRef.current, terminalSettings);
    }
  }, [terminalSettings]);

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

  openSearchRef.current = () => {
    if (shownRef.current) {
      useTerminalStore.getState().openTerminalSearch(ptyId);
    }
  };

  const clearSearch = useCallback(() => {
    searchAddonRef.current?.clearDecorations();
    termRef.current?.clearSelection();
    useTerminalStore.getState().clearTerminalSearchResult(ptyId);
  }, [ptyId]);

  const runSearch = useCallback(
    (
      query: string,
      options: TerminalSearchOptions,
      direction: TerminalSearchDirection,
    ): TerminalSearchRunResult => {
      const searchAddon = searchAddonRef.current;
      if (!searchAddon) {
        return { kind: "error", message: "Search unavailable" };
      }
      if (options.regex && !compileTerminalSearchRegex(query, options.caseSensitive)) {
        searchAddon.clearDecorations();
        useTerminalStore.getState().clearTerminalSearchResult(ptyId);
        return "invalid-regex";
      }
      try {
        const found = direction === "next"
          ? searchAddon.findNext(query, {
              ...options,
              incremental: true,
              decorations: resolveTerminalSearchDecorations(),
            })
          : searchAddon.findPrevious(query, {
              ...options,
              incremental: true,
              decorations: resolveTerminalSearchDecorations(),
            });
        if (!found) {
          useTerminalStore.getState().clearTerminalSearchResult(ptyId);
          return "no-matches";
        }
        return "found";
      } catch (error) {
        searchAddon.clearDecorations();
        useTerminalStore.getState().clearTerminalSearchResult(ptyId);
        return {
          kind: "error",
          message: error instanceof Error && error.message
            ? `Search failed: ${error.message}`
            : "Search failed",
        };
      }
    },
    [ptyId],
  );

  const restoreFocus = useCallback(() => {
    termRef.current?.focus();
  }, []);

  const retrySearchAddon = useCallback(() => {
    setSearchAddonRetry((retry) => retry + 1);
  }, []);

  return (
    <div
      ref={containerRef}
      className="flex h-full min-h-0 w-full flex-col overflow-hidden"
      data-terminal-hydrated={hydrated}
      data-testid="terminal-render-content"
      style={{
        backgroundColor: TERMINAL_BACKGROUND,
        visibility: shown && hydrated ? "visible" : "hidden",
      }}
    >
      <div ref={fitHostRef} className="min-h-0 flex-1 w-full p-3" />
      {termReady ? (
        <TerminalSearchShelf
          ptyId={ptyId}
          active={shown}
          onSearch={runSearch}
          onClear={clearSearch}
          onRestoreFocus={restoreFocus}
          addonState={searchAddonState}
          onRetry={retrySearchAddon}
        />
      ) : null}
    </div>
  );
});
