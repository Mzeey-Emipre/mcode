import type { MouseEvent as ReactMouseEvent } from "react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useWorkspaceStore } from "@/stores/workspaceStore";
import { useTaskStore } from "@/stores/taskStore";
import {
  useDiffStore,
  PANEL_MIN_WIDTH,
  PANEL_WIDE_WIDTH,
  createDefaultRightPanelState,
  getDefaultPanelWidthPx,
} from "@/stores/diffStore";
import { ScopeSplitPane } from "./ScopeSplitPane";
import { PanelEmptyState } from "./PanelEmptyState";
import { ActivityRail, type ScopeProgress } from "./ActivityRail";
import type { PanelScope } from "@/lib/panel-tabs";
import { DiffPanel } from "@/components/diff";
import { PreviewPanel } from "@/components/panels/PreviewPanel";
import { usePreviewDisplayTabSet, usePreviewTabsStore } from "@/stores/previewTabsStore";
import { TerminalTabContent } from "@/components/terminal/TerminalTabContent";
import { TerminalPoolSlot } from "@/components/terminal/TerminalPoolSlotContext";
import { useMediaQuery } from "@/hooks/useMediaQuery";
import { ensureTerminalForScope } from "@/lib/ensure-terminal";
import { cn } from "@/lib/utils";

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

/** Right-side panel: a vertical activity rail navigating open singleton tabs. */
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
  // Tabs are singletons opened on demand; an empty set means no tab is open and
  // the panel shows the card-grid empty state. Defensive default for any stored
  // row that predates the openTabs field. See ADR-0004 / issue #610.
  const openTabs = panelState.openTabs ?? [];
  // Review and Scope are creatable only in a thread; threadless the panel runs
  // against the workspace root and offers just Browser/Terminal/Files.
  const panelScope: PanelScope = activeThreadId ? "thread" : "threadless";
  // Open/closed is per-thread (falling back to the workspace threadless shell);
  // width and active tab stay workspace-global. See ADR-0004.
  const panelVisible = useDiffStore((s) =>
    activeWorkspaceId ? s.getRightPanelVisible(activeWorkspaceId, activeThreadId) : false,
  );

  // The Terminal and Preview tabs bind to the active thread, or to the
  // workspace itself in the threadless new-thread view (where they run against
  // the local workspace root). Their stores treat this as an opaque scope key.
  const panelScopeId = activeThreadId ?? activeWorkspaceId;

  // The Browser tab's open pages drive the rail's page switcher. The store is
  // seeded by the mounted PreviewPanel; reading it here lets the rail render
  // page entries (and the active-page favicon glyph) even while another tab is
  // active. Null in web builds with no bridge, where the rail keeps the single
  // Browser glyph.
  const browserTabSet = usePreviewDisplayTabSet(panelScopeId);

  // Zustand action refs are stable (same identity for the store's lifetime),
  // so destructuring from getState() at render time is safe and avoids
  // adding actions to useCallback/useEffect dependency arrays.
  const { setRightPanelWidth, setRightPanelTab, closeRightPanelTab, hideRightPanel } =
    useDiffStore.getState();

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

  // A tab's content renders only when it is both the active tab and actually
  // open. Guards against a persisted/default activeTab leaking content behind
  // the card-grid empty state when its type is not in the open set.
  const changesActive = activeTab === "changes" && openTabs.includes("changes");
  const previewActive = activeTab === "preview" && openTabs.includes("preview");
  const terminalActive = activeTab === "terminal" && openTabs.includes("terminal");

  const isChangesActive = panelVisible && changesActive;
  const changesFresh = useChangesFreshness(activeThreadId, changesCount, isChangesActive);

  // Anticipate the next step: opening the Terminal tab spawns a shell when the
  // thread has none, so the user lands in a ready terminal instead of an empty
  // pane. Gated on visibility so a hidden (persisted) terminal tab never spawns
  // in the background, and intentionally not gated on the terminal count so
  // killing the last terminal does not immediately respawn one.
  useEffect(() => {
    if (panelVisible && terminalActive && panelScopeId) {
      ensureTerminalForScope(panelScopeId);
    }
  }, [panelVisible, terminalActive, panelScopeId]);

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

      {/* Rail + content. The vertical activity rail navigates open singleton
          tabs (active lamp + hover-× close + add control) and holds the panel's
          close-chrome at its foot; the content area renders the active tab, or
          the card-grid empty state when nothing is open. */}
      <div className="flex min-h-0 flex-1 flex-row overflow-hidden">
        <ActivityRail
          openTabs={openTabs}
          activeTab={activeTab}
          scope={panelScope}
          scopeProgress={scope}
          changesCount={changesCount}
          changesFresh={changesFresh}
          browserTabSet={browserTabSet}
          onSelect={(id) => setRightPanelTab(activeWorkspaceId!, id)}
          onClose={(id) => closeRightPanelTab(activeWorkspaceId!, id)}
          onCreate={(id) => setRightPanelTab(activeWorkspaceId!, id)}
          onSelectBrowserPage={(pageId) => {
            // Focus the Browser tab and switch the guest to that page.
            setRightPanelTab(activeWorkspaceId!, "preview");
            if (panelScopeId) {
              void usePreviewTabsStore.getState().activatePage(panelScopeId, pageId);
            }
          }}
          onCloseBrowserPage={(pageId) => {
            if (!panelScopeId) return;
            // Closing the last page closes the Browser tab entirely (the rail is
            // the page switcher, so an empty browser has nothing to show).
            void usePreviewTabsStore.getState().closePage(panelScopeId, pageId, {
              onLastClose: () => closeRightPanelTab(activeWorkspaceId!, "preview"),
            });
          }}
          onClosePanel={() => {
            // Blur the close button before triggering the hide so focus is not
            // inside the panel when aria-hidden applies on re-render.
            (document.activeElement as HTMLElement | null)?.blur?.();
            hideRightPanel(activeWorkspaceId!, activeThreadId);
          }}
        />

        {/* Tab content — DiffPanel and terminal pool stay mounted (stacked) so
            turn expand state, loaded diffs, and xterm scroll anchors survive tab
            and workspace thread switches. With no tab open the panel shows the
            card-grid empty state, which is itself the create surface. */}
        <div className="relative flex min-h-0 min-w-0 flex-1 flex-col overflow-hidden">
          {openTabs.length === 0 && (
            <PanelEmptyState
              scope={panelScope}
              openTabs={openTabs}
              onOpen={(id) => setRightPanelTab(activeWorkspaceId!, id)}
            />
          )}
          {activeTab === "tasks" && openTabs.includes("tasks") && activeThreadId && (
            <ScopeSplitPane threadId={activeThreadId} parentTasks={parentTasks} />
          )}
          <div
            className={
              changesActive ? "flex flex-1 flex-col min-h-0" : "hidden"
            }
          >
            <DiffPanel />
          </div>
          {previewActive && panelScopeId && (
            <PreviewPanel threadId={panelScopeId} workspaceId={activeWorkspaceId} />
          )}
          <div
            className={cn(
              "absolute inset-0 flex min-h-0 flex-row overflow-hidden",
              !terminalActive && "pointer-events-none z-0 opacity-0",
              terminalActive && "z-10",
            )}
            aria-hidden={!terminalActive}
            inert={!terminalActive ? true : undefined}
          >
            {terminalActive && panelScopeId && (
              <TerminalTabContent threadId={panelScopeId} />
            )}
            <TerminalPoolSlot className="relative min-h-0 min-w-0 flex-1 overflow-hidden p-2" />
          </div>
        </div>
      </div>
      </div>
    </>
  );
}
