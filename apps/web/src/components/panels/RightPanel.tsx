import type { LucideIcon } from "lucide-react";
import type { MouseEvent as ReactMouseEvent } from "react";
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { ListChecks, Diff, Globe, Terminal, X } from "lucide-react";
import { Button } from "@/components/ui/button";
import { useWorkspaceStore } from "@/stores/workspaceStore";
import { useTaskStore } from "@/stores/taskStore";
import {
  useDiffStore,
  PANEL_MIN_WIDTH,
  PANEL_WIDE_WIDTH,
  createDefaultRightPanelState,
  getDefaultPanelWidthPx,
  type RightPanelTab,
} from "@/stores/diffStore";
import { ScopeSplitPane } from "./ScopeSplitPane";
import { DiffPanel } from "@/components/diff";
import { PreviewPanel } from "@/components/panels/PreviewPanel";
import { TerminalTabContent } from "@/components/terminal/TerminalTabContent";
import { TerminalPoolSlot } from "@/components/terminal/TerminalPoolSlotContext";
import { useMediaQuery } from "@/hooks/useMediaQuery";
import { ensureTerminalForScope } from "@/lib/ensure-terminal";
import { cn } from "@/lib/utils";

/** Static definition of a right-panel tab: id, label, and icon. */
interface TabDef {
  readonly id: RightPanelTab;
  readonly label: string;
  readonly icon: LucideIcon;
}

/** The four right-panel tabs, in display order. */
const TABS: readonly TabDef[] = [
  { id: "tasks", label: "Scope", icon: ListChecks },
  { id: "changes", label: "Changes", icon: Diff },
  { id: "preview", label: "Preview", icon: Globe },
  { id: "terminal", label: "Terminal", icon: Terminal },
];

/**
 * Below this rendered panel width (px) the tab strip drops inactive labels to
 * icon-only so four tabs plus their status never crowd at the 384px floor. The
 * active tab keeps its label; every tab keeps its status glyph.
 */
const COMPACT_TAB_WIDTH = 440;

/**
 * Past this many changed files the Changes badge renders "{cap}+" instead of
 * the exact number. The glance only needs "a lot"; an exact 3-4 digit count
 * adds width without information and would grow the tab on large diffs. Only
 * the rendered label is capped — the underlying count stays exact so freshness
 * detection still registers further growth above the cap.
 */
const CHANGES_COUNT_CAP = 99;

/**
 * Tracks whether the Changes tab has unreviewed new files for the active
 * thread. In-session only (the diff store is not persisted): the first time a
 * thread is seen, the current file count becomes the baseline so pre-existing
 * changes do not pulse. While the Changes tab is active the baseline tracks the
 * live count (you are looking at it, nothing is "new"); otherwise a count above
 * the baseline marks the tab fresh until it is next viewed.
 */
function useChangesFreshness(
  threadId: string | null,
  fileCount: number,
  isChangesActive: boolean,
): boolean {
  const seenByThread = useRef<Map<string, number>>(new Map());
  const [fresh, setFresh] = useState(false);

  useEffect(() => {
    if (!threadId) {
      setFresh(false);
      return;
    }
    const seen = seenByThread.current;
    const baseline = seen.get(threadId);
    if (baseline === undefined || isChangesActive) {
      seen.set(threadId, fileCount);
      setFresh(false);
      return;
    }
    setFresh(fileCount > baseline);
  }, [threadId, fileCount, isChangesActive]);

  return fresh;
}

/** Aggregate task completion across a thread's parent tasks. */
interface ScopeProgress {
  readonly done: number;
  readonly total: number;
}

/**
 * Per-tab glance status rendered beside the label: Scope task progress and the
 * Changes file count. Returns null for tabs with nothing to report so a calm
 * tab stays a bare label. Terminal and Preview carry no status yet (their
 * running/errored state is not surfaced per-thread).
 */
function TabStatus({
  tab,
  active,
  scope,
  changesCount,
  changesFresh,
}: {
  tab: RightPanelTab;
  active: boolean;
  scope: ScopeProgress;
  changesCount: number;
  changesFresh: boolean;
}) {
  if (tab === "tasks") {
    if (scope.total === 0) return null;
    const complete = scope.done === scope.total;
    return (
      <span
        className={cn(
          "font-mono text-[10px] font-medium tabular-nums tracking-normal",
          complete
            ? "text-[var(--diff-add-strong)]"
            : active
              ? "text-current"
              : "text-muted-foreground",
        )}
      >
        {scope.done}/{scope.total}
      </span>
    );
  }
  if (tab === "changes") {
    if (changesCount === 0) return null;
    const label = changesCount > CHANGES_COUNT_CAP ? `${CHANGES_COUNT_CAP}+` : String(changesCount);
    return (
      <span
        className={cn(
          "font-mono text-[10px] font-medium tabular-nums tracking-normal",
          changesFresh
            ? "changes-fresh-ring text-primary"
            : active
              ? "text-current"
              : "text-muted-foreground",
        )}
      >
        {label}
      </span>
    );
  }
  return null;
}

/**
 * Accessible name for a tab, carrying its glance status as text so screen
 * readers get the same signal sighted users read from the count and the amber
 * freshness color. Also keeps the name complete when narrow mode hides the
 * visible label.
 */
function tabAccessibleLabel(
  tab: RightPanelTab,
  scope: ScopeProgress,
  changesCount: number,
  changesFresh: boolean,
): string {
  if (tab === "tasks") {
    return scope.total > 0 ? `Scope, ${scope.done} of ${scope.total} tasks done` : "Scope";
  }
  if (tab === "changes") {
    if (changesCount === 0) return "Changes";
    const files = `${changesCount} ${changesCount === 1 ? "file" : "files"} changed`;
    return `Changes, ${files}${changesFresh ? ", new since last viewed" : ""}`;
  }
  return tab === "preview" ? "Preview" : "Terminal";
}

/** Right-side panel with tabs for Tasks, Changes, and Preview. */
export function RightPanel() {
  const activeThreadId = useWorkspaceStore((s) => s.activeThreadId);
  const activeWorkspaceId = useWorkspaceStore((s) => s.activeWorkspaceId);

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

  const storedPanel = useDiffStore((s) =>
    activeWorkspaceId ? s.rightPanelByWorkspace[activeWorkspaceId] : undefined,
  );
  /** Avoid a Zustand selector that allocates a fresh default object every evaluation. */
  const panelState = useMemo(
    () => storedPanel ?? createDefaultRightPanelState(),
    [storedPanel],
  );
  const { width: panelWidth, activeTab } = panelState;
  // Open/closed is per-thread (falling back to the workspace threadless shell);
  // width and active tab stay workspace-global. See ADR-0004.
  const panelVisible = useDiffStore((s) =>
    activeWorkspaceId ? s.getRightPanelVisible(activeWorkspaceId, activeThreadId) : false,
  );

  // The Terminal and Preview tabs bind to the active thread, or to the
  // workspace itself in the threadless new-thread view (where they run against
  // the local workspace root). Their stores treat this as an opaque scope key.
  const panelScopeId = activeThreadId ?? activeWorkspaceId;

  // Zustand action refs are stable (same identity for the store's lifetime),
  // so destructuring from getState() at render time is safe and avoids
  // adding actions to useCallback/useEffect dependency arrays.
  const { setRightPanelWidth, setRightPanelTab, hideRightPanel } = useDiffStore.getState();

  const tasks = useTaskStore(
    (s) => (activeThreadId ? s.tasksByThread[activeThreadId] : undefined),
  );

  // Only parent-agent tasks for the header count and task list display
  const parentTasks = useMemo(
    () => (tasks ?? []).filter((t) => t.group === "Tasks"),
    [tasks],
  );

  // Thresholds tuned for a readable chat column next to an expanded sidebar.
  const CHAT_COMFORT_MIN = 520;
  const SIDEBAR_BUFFER = 290;
  const LAYOUT_GAPS = 24;
  const wouldCrampChat =
    panelWidth + CHAT_COMFORT_MIN + SIDEBAR_BUFFER + LAYOUT_GAPS > viewportWidth;
  const isOverlay = !isWide || wouldCrampChat;

  // Tab-strip glance status. Scope progress counts completed and cancelled
  // tasks as settled (a dropped task is no longer pending work); Changes counts
  // distinct files across every turn snapshot (the cumulative working-tree diff
  // the user reviews and ships).
  const scope = useMemo<ScopeProgress>(() => {
    const total = parentTasks.length;
    const done = parentTasks.filter(
      (t) => t.status === "completed" || t.status === "cancelled",
    ).length;
    return { done, total };
  }, [parentTasks]);

  const snapshots = useDiffStore((s) =>
    activeThreadId ? s.snapshotsByThread[activeThreadId] : undefined,
  );
  const changesCount = useMemo(() => {
    if (!snapshots || snapshots.length === 0) return 0;
    const files = new Set<string>();
    for (const snap of snapshots) {
      for (const file of snap.files_changed) files.add(file);
    }
    return files.size;
  }, [snapshots]);

  const isChangesActive = panelVisible && activeTab === "changes";
  const changesFresh = useChangesFreshness(activeThreadId, changesCount, isChangesActive);

  // Drop inactive tab labels when the rendered panel is narrow. Overlay mode
  // renders at min(panelWidth, 90vw), so measure against that.
  const renderedTabWidth = isOverlay
    ? Math.min(panelWidth, viewportWidth * 0.9)
    : panelWidth;
  const compactTabs = renderedTabWidth < COMPACT_TAB_WIDTH;

  // Active-tab underline indicator. Measured imperatively (rather than derived
  // from layout) so it slides between tabs whose widths vary with their status.
  const headerRef = useRef<HTMLDivElement>(null);
  const tablistRef = useRef<HTMLDivElement>(null);
  const indicatorRef = useRef<HTMLSpanElement>(null);
  const measureIndicator = useCallback(() => {
    const header = headerRef.current;
    const indicator = indicatorRef.current;
    const active = tablistRef.current?.querySelector<HTMLElement>('[data-tab-active="true"]');
    if (!header || !indicator) return;
    // Drive the slide with a GPU-composited transform (translate + scaleX off a
    // 1px base) rather than animating left/width, so the underline never
    // triggers layout. scaleX(0) parks it invisibly when there is no target.
    if (!active) {
      indicator.style.transform = "scaleX(0)";
      return;
    }
    const headerRect = header.getBoundingClientRect();
    const activeRect = active.getBoundingClientRect();
    if (activeRect.width === 0) {
      indicator.style.transform = "scaleX(0)";
      return;
    }
    const offset = activeRect.left - headerRect.left;
    indicator.style.transform = `translateX(${offset}px) scaleX(${activeRect.width})`;
  }, []);
  useLayoutEffect(() => {
    measureIndicator();
  }, [measureIndicator, activeTab, panelVisible, compactTabs, scope, changesCount]);
  useEffect(() => {
    const list = tablistRef.current;
    if (!list || typeof ResizeObserver === "undefined") return;
    const ro = new ResizeObserver(() => measureIndicator());
    ro.observe(list);
    return () => ro.disconnect();
  }, [measureIndicator]);

  // Anticipate the next step: opening the Terminal tab spawns a shell when the
  // thread has none, so the user lands in a ready terminal instead of an empty
  // pane. Gated on visibility so a hidden (persisted) terminal tab never spawns
  // in the background, and intentionally not gated on the terminal count so
  // killing the last terminal does not immediately respawn one.
  useEffect(() => {
    if (panelVisible && activeTab === "terminal" && panelScopeId) {
      ensureTerminalForScope(panelScopeId);
    }
  }, [panelVisible, activeTab, panelScopeId]);

  // Close on Escape when overlaid.
  useEffect(() => {
    if (!isOverlay || !panelVisible || !activeWorkspaceId) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") hideRightPanel(activeWorkspaceId, activeThreadId);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [isOverlay, panelVisible, activeWorkspaceId, activeThreadId, hideRightPanel]);

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
  // Re-registers when activeWorkspaceId changes (each workspace has its own stored width).
  // Throttled with rAF so rapid resize events only trigger one recalculation per frame.
  useEffect(() => {
    if (!activeWorkspaceId || !panelVisible) return;
    // Clamp immediately in case the stored width already exceeds the viewport.
    const maxAllowed = window.innerWidth - PANEL_MIN_WIDTH;
    if (panelWidthRef.current > maxAllowed) setRightPanelWidth(activeWorkspaceId, maxAllowed);

    let rafId: number | null = null;
    const onResize = () => {
      if (rafId !== null) return;
      rafId = requestAnimationFrame(() => {
        rafId = null;
        const max = window.innerWidth - PANEL_MIN_WIDTH;
        if (panelWidthRef.current > max) setRightPanelWidth(activeWorkspaceId, max);
      });
    };
    window.addEventListener("resize", onResize);
    return () => {
      window.removeEventListener("resize", onResize);
      if (rafId !== null) cancelAnimationFrame(rafId);
    };
  }, [activeWorkspaceId, panelVisible]);

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
        setRightPanelWidth(activeWorkspaceId!, Math.min(startWidth + delta, viewportCap));
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
    [panelWidth, activeWorkspaceId],
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

  // Keep the panel (and terminal pool) mounted when hidden so xterm instances
  // and scroll anchors survive workspace thread switches. Workspace-global
  // visibility uses Tailwind `hidden` so layout width stays zero. The panel is
  // workspace-scoped, not thread-scoped: it renders with no thread (an empty
  // shell) and only bails when there is no workspace to anchor it to.
  if (!activeWorkspaceId) return null;

  // Overlay-mode width: cap to 90vw so the chat is still partially visible
  // behind the backdrop and the panel doesn't dominate small screens.
  const overlayWidth = isOverlay
    ? `min(${panelWidth}px, 90vw)`
    : undefined;

  return (
    <>
      {/* Backdrop — overlay mode with panel open only. Click dismisses the panel. */}
      {isOverlay && panelVisible && (
        <div
          role="presentation"
          onClick={() => {
            // Blur first so focus inside the panel does not collide with the
            // incoming aria-hidden on the panel container.
            (document.activeElement as HTMLElement | null)?.blur?.();
            hideRightPanel(activeWorkspaceId, activeThreadId);
          }}
          className="fixed inset-0 z-40 bg-foreground/30 backdrop-blur-[2px] animate-fade-up-in"
        />
      )}
      <div
        ref={panelRef}
        role={isOverlay ? "dialog" : undefined}
        aria-modal={isOverlay ? true : undefined}
        aria-label={isOverlay ? "Workspace side panel" : undefined}
        tabIndex={isOverlay ? -1 : undefined}
        style={
          isOverlay
            // Drop minWidth entirely on overlay: on narrow viewports the
            // 90vw cap would still exceed a large pixel minimum.
            ? { width: overlayWidth }
            : { width: panelWidth, minWidth: PANEL_MIN_WIDTH, maxWidth: `calc(100vw - ${PANEL_MIN_WIDTH}px)` }
        }
        className={cn(
          "relative flex h-full min-h-0 min-w-0 flex-col overflow-hidden bg-background focus:outline-none",
          !panelVisible && "hidden",
          isOverlay
            ? "fixed inset-y-0 right-0 z-50 shadow-sm animate-fade-up-in"
            : "rounded-lg shadow-sm",
        )}
        // Pair aria-hidden with inert: inert auto-blurs any focused
        // descendant on apply, which avoids Chrome's "Blocked aria-hidden on
        // an element because its descendant retained focus" warning when the
        // user clicks the close button (focus is on the button when the
        // panel is told to hide). Same pattern as the terminal tab below.
        aria-hidden={!panelVisible}
        inert={!panelVisible ? true : undefined}
      >
      {/* Drag handle (left edge) — double-click snaps between default and wide.
          Kept visible in overlay mode too, so the user can shrink the panel
          below the crowding threshold and snap it back into the inline layout. */}
      <div
        role="separator"
        aria-orientation="vertical"
        aria-label="Resize panel"
        tabIndex={0}
        className="group absolute inset-y-0 left-0 z-20 flex w-3 cursor-col-resize items-stretch justify-center focus:outline-none"
        onMouseDown={onDragStart}
        onDoubleClick={() => {
          const viewportCap = window.innerWidth - PANEL_MIN_WIDTH;
          const narrow = getDefaultPanelWidthPx();
          const target =
            panelWidth >= PANEL_WIDE_WIDTH
              ? narrow
              : Math.min(PANEL_WIDE_WIDTH, viewportCap);
          setRightPanelWidth(activeWorkspaceId!, Math.max(PANEL_MIN_WIDTH, target));
        }}
        onKeyDown={(e) => {
          if (e.key === "Enter" || e.key === " ") {
            e.preventDefault();
            const viewportCap = window.innerWidth - PANEL_MIN_WIDTH;
            const narrow = getDefaultPanelWidthPx();
            const target =
              panelWidth >= PANEL_WIDE_WIDTH
                ? narrow
                : Math.min(PANEL_WIDE_WIDTH, viewportCap);
            setRightPanelWidth(activeWorkspaceId!, Math.max(PANEL_MIN_WIDTH, target));
          }
        }}
      >
        {/* Grip: transparent at rest (the panel's radius and shadow already
            separate it from the chat — a resting hairline is redundant and
            reads as a stray line). It brightens on hover, focus, and active
            drag. Inset vertically (my-2.5) so it clears the panel's rounded
            corners instead of being clipped by overflow-hidden. */}
        <span
          aria-hidden
          className="pointer-events-none my-2.5 w-px shrink-0 rounded-full bg-transparent transition-colors group-hover:bg-border group-focus-visible:w-0.5 group-focus-visible:bg-ring group-active:w-0.5 group-active:bg-muted-foreground/60"
        />
      </div>

      {/* Tab header. The active tab is marked by Filament Amber text and a 2px
          amber underline that slides between tabs (the One Lamp Rule applied to
          tab selection); each tab carries a glance status beside its label. */}
      <div ref={headerRef} className="relative flex-none border-b border-border/40">
        <div className="flex h-11 items-center justify-between px-3">
          <div ref={tablistRef} className="flex items-center gap-0.5">
            {TABS.map((tab) => {
              const isActive = activeTab === tab.id;
              const Icon = tab.icon;
              const showLabel = isActive || !compactTabs;
              return (
                <button
                  key={tab.id}
                  type="button"
                  data-tab-active={isActive ? "true" : undefined}
                  aria-pressed={isActive}
                  aria-label={tabAccessibleLabel(tab.id, scope, changesCount, changesFresh)}
                  title={tab.label}
                  onClick={() => setRightPanelTab(activeWorkspaceId!, tab.id)}
                  className={cn(
                    "flex items-center gap-1.5 rounded-md px-2 py-1 font-mono text-[10px] font-semibold tracking-[0.16em] uppercase transition-colors",
                    isActive ? "text-primary" : "text-foreground/70 hover:text-foreground",
                  )}
                >
                  <Icon size={12} />
                  {showLabel && <span>{tab.label}</span>}
                  <TabStatus
                    tab={tab.id}
                    active={isActive}
                    scope={scope}
                    changesCount={changesCount}
                    changesFresh={changesFresh}
                  />
                </button>
              );
            })}
          </div>
          <Button
            variant="ghost"
            size="icon-xs"
            onClick={() => {
              // Blur the close button before triggering the hide so focus is
              // not inside the panel when aria-hidden applies on re-render.
              (document.activeElement as HTMLElement | null)?.blur?.();
              hideRightPanel(activeWorkspaceId!, activeThreadId);
            }}
            className="h-5 w-5 text-muted-foreground/70 hover:text-foreground hover:bg-transparent transition-colors duration-150"
            aria-label="Close panel"
          >
            <X size={11} />
          </Button>
        </div>
        <span
          ref={indicatorRef}
          data-testid="tab-indicator"
          aria-hidden
          className="pointer-events-none absolute bottom-0 left-0 h-0.5 w-px origin-left rounded-full bg-primary transition-transform duration-200 ease-[cubic-bezier(0.22,1,0.36,1)] motion-reduce:transition-none"
        />
      </div>

      {/* Tab content — DiffPanel and terminal pool stay mounted (stacked) so
          turn expand state, loaded diffs, and xterm scroll anchors survive tab
          and workspace thread switches. */}
      <div className="relative flex min-h-0 flex-1 flex-col overflow-hidden">
        {activeTab === "tasks" && activeThreadId && (
          <ScopeSplitPane threadId={activeThreadId} parentTasks={parentTasks} />
        )}
        <div className={activeTab === "changes" ? "flex flex-1 flex-col min-h-0" : "hidden"}>
          <DiffPanel />
        </div>
        {activeTab === "preview" && panelScopeId && (
          <PreviewPanel threadId={panelScopeId} workspaceId={activeWorkspaceId} />
        )}
        <div
          className={cn(
            "absolute inset-0 flex min-h-0 flex-row overflow-hidden",
            activeTab !== "terminal" && "pointer-events-none z-0 opacity-0",
            activeTab === "terminal" && "z-10",
          )}
          aria-hidden={activeTab !== "terminal"}
          inert={activeTab !== "terminal" ? true : undefined}
        >
          {activeTab === "terminal" && panelScopeId && (
            <TerminalTabContent threadId={panelScopeId} />
          )}
          <TerminalPoolSlot className="relative min-h-0 min-w-0 flex-1 overflow-hidden p-2" />
        </div>
      </div>
      </div>
    </>
  );
}
