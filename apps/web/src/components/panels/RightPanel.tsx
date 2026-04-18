import type { MouseEvent as ReactMouseEvent } from "react";
import { useCallback, useEffect, useRef, useState } from "react";
import { ListChecks, Diff, X } from "lucide-react";
import { Button } from "@/components/ui/button";
import { useWorkspaceStore } from "@/stores/workspaceStore";
import { useTaskStore } from "@/stores/taskStore";
import { useDiffStore, PANEL_MIN_WIDTH, PANEL_DEFAULT_WIDTH, PANEL_WIDE_WIDTH, RIGHT_PANEL_DEFAULTS } from "@/stores/diffStore";
import { TaskPanel } from "@/components/tasks/TaskPanel";
import { TaskPanelHeader } from "@/components/tasks/TaskPanelHeader";
import { DiffPanel } from "@/components/diff";
import { useMediaQuery } from "@/hooks/useMediaQuery";
import { cn } from "@/lib/utils";

/** Right-side panel with tabs for Tasks and Changes. */
export function RightPanel() {
  const activeThreadId = useWorkspaceStore((s) => s.activeThreadId);

  // Per-thread panel state
  const panelState = useDiffStore((s) =>
    activeThreadId
      ? (s.rightPanelByThread[activeThreadId] ?? RIGHT_PANEL_DEFAULTS)
      : RIGHT_PANEL_DEFAULTS,
  );
  const { visible: panelVisible, width: panelWidth, activeTab } = panelState;

  // Zustand action refs are stable (same identity for the store's lifetime),
  // so destructuring from getState() at render time is safe and avoids
  // adding actions to useCallback/useEffect dependency arrays.
  const { setRightPanelWidth, setRightPanelTab, hideRightPanel } = useDiffStore.getState();

  const tasks = useTaskStore(
    (s) => (activeThreadId ? s.tasksByThread[activeThreadId] : undefined),
  );

  // Render the panel as a modal overlay anchored to the right edge with a
  // backdrop covering the chat whenever side-by-side layout would leave the
  // chat uncomfortably narrow. Two triggers:
  //  1. Viewport below the md breakpoint — a second pane always feels cramped.
  //  2. Panel width would leave less than CHAT_COMFORT_MIN for the chat after
  //     accounting for the sidebar — i.e. the user dragged the panel wide
  //     enough that it should pop out instead of squeezing the chat.
  const isWide = useMediaQuery("(min-width: 768px)");

  // Track viewport width so the pop-out threshold recomputes when the user
  // resizes the window (not just when they drag the panel).
  const [viewportWidth, setViewportWidth] = useState(() =>
    typeof window === "undefined" ? 0 : window.innerWidth,
  );
  useEffect(() => {
    if (typeof window === "undefined") return;
    let rafId: number | null = null;
    const onResize = () => {
      if (rafId !== null) return;
      rafId = requestAnimationFrame(() => {
        rafId = null;
        setViewportWidth(window.innerWidth);
      });
    };
    window.addEventListener("resize", onResize);
    return () => {
      window.removeEventListener("resize", onResize);
      if (rafId !== null) cancelAnimationFrame(rafId);
    };
  }, []);

  // Thresholds tuned for a readable chat column next to an expanded sidebar.
  const CHAT_COMFORT_MIN = 520;
  const SIDEBAR_BUFFER = 290;
  const LAYOUT_GAPS = 24;
  const wouldCrampChat =
    panelWidth + CHAT_COMFORT_MIN + SIDEBAR_BUFFER + LAYOUT_GAPS > viewportWidth;
  const isOverlay = !isWide || wouldCrampChat;

  // Close on Escape when overlaid.
  useEffect(() => {
    if (!isOverlay || !panelVisible || !activeThreadId) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") hideRightPanel(activeThreadId);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [isOverlay, panelVisible, activeThreadId, hideRightPanel]);

  // Focus handoff for overlay mode. When the panel pops out as a modal we
  // must move focus into it so keyboard users aren't stranded behind the
  // backdrop, and restore focus to whatever opened it when it closes.
  const panelRef = useRef<HTMLDivElement>(null);
  const previousFocusRef = useRef<HTMLElement | null>(null);
  useEffect(() => {
    if (!isOverlay || !panelVisible) return;
    previousFocusRef.current = document.activeElement as HTMLElement | null;
    // Defer to next frame so the panel is in the DOM before focus moves.
    const rafId = requestAnimationFrame(() => panelRef.current?.focus());
    return () => {
      cancelAnimationFrame(rafId);
      previousFocusRef.current?.focus?.();
    };
  }, [isOverlay, panelVisible]);

  const draggingRef = useRef(false);
  const dragListenersRef = useRef<{ move: (e: globalThis.MouseEvent) => void; up: () => void } | null>(null);
  // Ref keeps the latest panelWidth readable inside the resize handler without
  // the handler needing to be re-registered on every width change.
  const panelWidthRef = useRef(panelWidth);
  useEffect(() => { panelWidthRef.current = panelWidth; }, [panelWidth]);

  // Re-clamp stored width when the panel becomes visible or the window is resized
  // so the panel never exceeds the available space after the user shrinks the browser.
  // Runs in both inline and overlay modes: overlay renders at min(panelWidth, 90vw)
  // visually, but the stored width still drives the cramp-detection threshold.
  // Re-registers when activeThreadId changes (each thread has its own stored width).
  // Throttled with rAF so rapid resize events only trigger one recalculation per frame.
  useEffect(() => {
    if (!activeThreadId || !panelVisible) return;
    // Clamp immediately in case the stored width already exceeds the viewport.
    const maxAllowed = window.innerWidth - PANEL_MIN_WIDTH;
    if (panelWidthRef.current > maxAllowed) setRightPanelWidth(activeThreadId, maxAllowed);

    let rafId: number | null = null;
    const onResize = () => {
      if (rafId !== null) return;
      rafId = requestAnimationFrame(() => {
        rafId = null;
        const max = window.innerWidth - PANEL_MIN_WIDTH;
        if (panelWidthRef.current > max) setRightPanelWidth(activeThreadId, max);
      });
    };
    window.addEventListener("resize", onResize);
    return () => {
      window.removeEventListener("resize", onResize);
      if (rafId !== null) cancelAnimationFrame(rafId);
    };
  }, [activeThreadId, panelVisible]);

  const onDragStart = useCallback(
    (e: ReactMouseEvent) => {
      e.preventDefault();
      draggingRef.current = true;
      const startX = e.clientX;
      const startWidth = panelWidth;

      const onMouseMove = (moveEvent: globalThis.MouseEvent) => {
        if (!draggingRef.current) return;
        const delta = startX - moveEvent.clientX;
        // Always leave at least PANEL_MIN_WIDTH px for the chat area
        const viewportCap = window.innerWidth - PANEL_MIN_WIDTH;
        setRightPanelWidth(activeThreadId!, Math.min(startWidth + delta, viewportCap));
      };

      const onMouseUp = () => {
        draggingRef.current = false;
        document.removeEventListener("mousemove", onMouseMove);
        document.removeEventListener("mouseup", onMouseUp);
        dragListenersRef.current = null;
      };

      dragListenersRef.current = { move: onMouseMove, up: onMouseUp };
      document.addEventListener("mousemove", onMouseMove);
      document.addEventListener("mouseup", onMouseUp);
    },
    [panelWidth, activeThreadId],
  );

  useEffect(() => {
    return () => {
      if (dragListenersRef.current) {
        document.removeEventListener("mousemove", dragListenersRef.current.move);
        document.removeEventListener("mouseup", dragListenersRef.current.up);
        dragListenersRef.current = null;
      }
      draggingRef.current = false;
    };
  }, []);

  if (!panelVisible || !activeThreadId) return null;

  // Overlay-mode width: cap to 90vw so the chat is still partially visible
  // behind the backdrop and the panel doesn't dominate small screens.
  const overlayWidth = isOverlay
    ? `min(${panelWidth}px, 90vw)`
    : undefined;

  return (
    <>
      {/* Backdrop — only rendered in overlay mode. Click dismisses the panel. */}
      {isOverlay && (
        <div
          role="presentation"
          onClick={() => hideRightPanel(activeThreadId)}
          className="fixed inset-0 z-40 bg-foreground/30 backdrop-blur-[2px] animate-fade-up-in"
        />
      )}
      <div
        ref={panelRef}
        role={isOverlay ? "dialog" : undefined}
        aria-modal={isOverlay ? true : undefined}
        aria-label={isOverlay ? "Thread side panel" : undefined}
        tabIndex={isOverlay ? -1 : undefined}
        style={
          isOverlay
            // Drop minWidth entirely on overlay: on sub-300px viewports the
            // 90vw cap would still be exceeded by a 300px minimum.
            ? { width: overlayWidth }
            : { width: panelWidth, minWidth: PANEL_MIN_WIDTH, maxWidth: `calc(100vw - ${PANEL_MIN_WIDTH}px)` }
        }
        className={cn(
          "relative flex flex-col bg-background focus:outline-none",
          isOverlay
            ? "fixed inset-y-0 right-0 z-50 shadow-sm animate-fade-up-in"
            : "rounded-lg shadow-sm overflow-hidden",
        )}
      >
      {/* Drag handle (left edge) — double-click snaps between default and wide.
          Kept visible in overlay mode too, so the user can shrink the panel
          below the crowding threshold and snap it back into the inline layout. */}
      <div
        role="separator"
        aria-orientation="vertical"
        tabIndex={0}
        className="absolute left-0 top-0 bottom-0 w-1.5 cursor-col-resize z-10
                   hover:bg-primary/25 active:bg-primary/40 focus-visible:bg-primary/25 transition-colors duration-150"
        onMouseDown={onDragStart}
        onDoubleClick={() => {
          const viewportCap = window.innerWidth - PANEL_MIN_WIDTH;
          const target = panelWidth >= PANEL_WIDE_WIDTH
            ? PANEL_DEFAULT_WIDTH
            : Math.min(PANEL_WIDE_WIDTH, viewportCap);
          setRightPanelWidth(activeThreadId!, Math.max(PANEL_MIN_WIDTH, target));
        }}
        onKeyDown={(e) => {
          if (e.key === "Enter" || e.key === " ") {
            e.preventDefault();
            const viewportCap = window.innerWidth - PANEL_MIN_WIDTH;
            const target = panelWidth >= PANEL_WIDE_WIDTH
              ? PANEL_DEFAULT_WIDTH
              : Math.min(PANEL_WIDE_WIDTH, viewportCap);
            setRightPanelWidth(activeThreadId!, Math.max(PANEL_MIN_WIDTH, target));
          }
        }}
      />

      {/* Tab header */}
      <div className="flex-none border-b border-border/40">
        <div className="flex h-11 items-center justify-between px-3">
          <div className="flex items-center gap-0.5">
            <button
              type="button"
              onClick={() => setRightPanelTab(activeThreadId!, "tasks")}
              className={`flex items-center gap-1.5 rounded-md px-2 py-1 text-[10px] font-semibold tracking-[0.1em] uppercase transition-colors ${
                activeTab === "tasks"
                  ? "text-foreground bg-muted/50"
                  : "text-foreground/70 hover:text-foreground"
              }`}
            >
              <ListChecks size={12} />
              Tasks
            </button>
            <button
              type="button"
              onClick={() => setRightPanelTab(activeThreadId!, "changes")}
              className={`flex items-center gap-1.5 rounded-md px-2 py-1 text-[10px] font-semibold tracking-[0.1em] uppercase transition-colors ${
                activeTab === "changes"
                  ? "text-foreground bg-muted/50"
                  : "text-foreground/70 hover:text-foreground"
              }`}
            >
              <Diff size={12} />
              Changes
            </button>
          </div>
          <Button
            variant="ghost"
            size="icon-xs"
            onClick={() => hideRightPanel(activeThreadId!)}
            className="h-5 w-5 text-muted-foreground/70 hover:text-foreground hover:bg-transparent transition-colors duration-150"
            aria-label="Close panel"
          >
            <X size={11} />
          </Button>
        </div>
      </div>

      {/* Tab content */}
      {activeTab === "tasks" && (
        <>
          <TaskPanelHeader tasks={tasks ?? []} />
          <TaskPanel />
        </>
      )}
      {activeTab === "changes" && <DiffPanel />}
      </div>
    </>
  );
}
