import type { MouseEvent as ReactMouseEvent } from "react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useWorkspaceStore } from "@/stores/workspaceStore";
import { useUiStore } from "@/stores/uiStore";
import { useTaskStore } from "@/stores/taskStore";
import {
  useDiffStore,
  PANEL_MIN_WIDTH,
  PANEL_WIDE_WIDTH,
  COMPOSER_MIN_WIDTH,
  PANEL_SPLIT_GAP_PX,
  maxPanelWidthInSplit,
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

  // Maximized mode fills the content area beside the project tree and hides the
  // chat/composer (App.tsx suppresses the chat pane). A transient view toggle,
  // not a stored width — the panel keeps its width so restoring drops back inline.
  const maximized = useUiStore((s) => s.rightPanelMaximized);
  const toggleMaximized = useUiStore((s) => s.toggleRightPanelMaximized);

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
  const { setRightPanelWidth, setRightPanelTab, closeRightPanelTab } =
    useDiffStore.getState();

  const tasks = useTaskStore(
    (s) => (activeThreadId ? s.tasksByThread[activeThreadId] : undefined),
  );

  // Scope to-do progress and visible list use only parent-agent tasks.
  const parentTasks = useMemo(
    () => (tasks ?? []).filter((t) => t.group === "Tasks"),
    [tasks],
  );

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

  // Exit maximize when the panel is hidden so the user never lands on a blank
  // full-screen shell with no panel chrome to restore from.
  const setMaximized = useUiStore.getState().setRightPanelMaximized;
  useEffect(() => {
    if (maximized && !panelVisible) setMaximized(false);
  }, [maximized, panelVisible, setMaximized]);

  const draggingRef = useRef(false);
  const dragListenersRef = useRef<{ move: (e: globalThis.MouseEvent) => void; up: () => void } | null>(null);
  const panelRootRef = useRef<HTMLDivElement>(null);
  // Ref keeps the latest panelWidth readable inside the resize handler without
  // the handler needing to be re-registered on every width change.
  const panelWidthRef = useRef(panelWidth);
  useEffect(() => { panelWidthRef.current = panelWidth; }, [panelWidth]);

  /** Max panel width that still leaves {@link COMPOSER_MIN_WIDTH}px for the chat. */
  const getMaxPanelWidth = useCallback((): number => {
    const split = panelRootRef.current?.parentElement;
    if (!split) {
      return Math.max(PANEL_MIN_WIDTH, window.innerWidth - COMPOSER_MIN_WIDTH);
    }
    return maxPanelWidthInSplit(split.clientWidth);
  }, []);

  // Re-clamp stored width when the split row shrinks (window resize, sidebar
  // toggle, etc.) so the panel never eats the composer's minimum width.
  useEffect(() => {
    if (!activeWorkspaceId || !panelVisible || maximized) return;
    const split = panelRootRef.current?.parentElement;
    if (!split) return;

    const clampToSplit = () => {
      const max = maxPanelWidthInSplit(split.clientWidth);
      if (panelWidthRef.current > max) setRightPanelWidth(activeWorkspaceId, max);
    };

    clampToSplit();

    let rafId: number | null = null;
    const ro = new ResizeObserver(() => {
      if (rafId !== null) return;
      rafId = requestAnimationFrame(() => {
        rafId = null;
        clampToSplit();
      });
    });
    ro.observe(split);
    return () => {
      ro.disconnect();
      if (rafId !== null) cancelAnimationFrame(rafId);
    };
  }, [activeWorkspaceId, panelVisible, maximized]);

  const onDragStart = useCallback(
    (e: ReactMouseEvent) => {
      e.preventDefault();
      draggingRef.current = true;
      const startX = e.clientX;
      const startWidth = panelWidth;

      const onMouseMove = (moveEvent: globalThis.MouseEvent) => {
        if (!draggingRef.current) return;
        const delta = startX - moveEvent.clientX;
        const maxWidth = getMaxPanelWidth();
        setRightPanelWidth(
          activeWorkspaceId!,
          Math.max(PANEL_MIN_WIDTH, Math.min(startWidth + delta, maxWidth)),
        );
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
    [panelWidth, activeWorkspaceId, getMaxPanelWidth],
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

  return (
    <div
      ref={panelRootRef}
      style={
        maximized
          ? undefined
          : {
              width: panelWidth,
              minWidth: PANEL_MIN_WIDTH,
              maxWidth: `calc(100% - ${COMPOSER_MIN_WIDTH}px - ${PANEL_SPLIT_GAP_PX}px)`,
            }
      }
      className={cn(
        "relative flex h-full min-h-0 min-w-0 flex-col overflow-hidden rounded-lg bg-background shadow-sm focus:outline-none",
        !panelVisible && "hidden",
        // Maximized fills the content area (App hides the chat pane); inline
        // mode is sized by the stored width above.
        maximized && "flex-1",
      )}
      // Pair aria-hidden with inert: inert auto-blurs any focused descendant on
      // apply, which avoids Chrome's "Blocked aria-hidden on an element because
      // its descendant retained focus" warning when the user clicks the close
      // button (focus is on the button when the panel is told to hide). Same
      // pattern as the terminal tab below.
      aria-hidden={!panelVisible}
      inert={!panelVisible ? true : undefined}
    >
      {/* Drag handle (left edge) — double-click snaps between default and wide.
          Hidden while maximized: the panel owns the full content area, so there
          is nothing to resize against. */}
      {!maximized && (
      <div
        role="separator"
        aria-orientation="vertical"
        aria-label="Resize panel"
        tabIndex={0}
        className="group absolute inset-y-0 left-0 z-20 flex w-3 cursor-col-resize items-stretch justify-center focus:outline-none"
        onMouseDown={onDragStart}
        onDoubleClick={() => {
          const maxWidth = getMaxPanelWidth();
          const narrow = getDefaultPanelWidthPx();
          const target =
            panelWidth >= PANEL_WIDE_WIDTH
              ? narrow
              : Math.min(PANEL_WIDE_WIDTH, maxWidth);
          setRightPanelWidth(activeWorkspaceId!, Math.max(PANEL_MIN_WIDTH, target));
        }}
        onKeyDown={(e) => {
          if (e.key === "Enter" || e.key === " ") {
            e.preventDefault();
            const maxWidth = getMaxPanelWidth();
            const narrow = getDefaultPanelWidthPx();
            const target =
              panelWidth >= PANEL_WIDE_WIDTH
                ? narrow
                : Math.min(PANEL_WIDE_WIDTH, maxWidth);
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
      )}

      {/* Rail + content. The activity rail carries the maximize toggle and, once
          tabs are open, tab navigation and the add control. With no tabs the rail
          is just the maximize button beside the empty-state create list. */}
      <div className="flex min-h-0 flex-1 flex-row overflow-hidden">
        <ActivityRail
          openTabs={openTabs}
          activeTab={activeTab}
          scope={panelScope}
          scopeProgress={scope}
          changesCount={changesCount}
          changesFresh={changesFresh}
          browserTabSet={browserTabSet}
          maximized={maximized}
          onToggleMaximized={toggleMaximized}
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
  );
}
