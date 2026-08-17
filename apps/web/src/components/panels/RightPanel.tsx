import { memo, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { useShallow } from "zustand/shallow";
import { useWorkspaceStore } from "@/features/projects/state/workspaceStore";
import { useUiStore } from "@/stores/uiStore";
import {
  useDiffStore,
  PANEL_MIN_WIDTH,
  PANEL_WIDE_WIDTH,
  COMPOSER_MIN_WIDTH,
  PANEL_SPLIT_GAP_PX,
  maxPanelWidthInSplit,
  createRightPanelState,
  createDefaultRightPanelState,
  getDefaultPanelWidthPx,
} from "@/stores/diffStore";
import { PlanPanel } from "./plan";
import { PanelEmptyState } from "./PanelEmptyState";
import {
  ACTIVITY_RAIL_FLOATING_OVERLAP_PX,
  ActivityRail,
  type ScopeProgress,
} from "./ActivityRail";
import type { PanelScope } from "@/lib/panel-tabs";
import { DiffPanel } from "@/components/diff";
import {
  BROWSER_AUTOMATION_WARM_TARGET_LIMIT,
  PreviewPanel,
  browserAutomationScopeKey,
  browserAutomationTargetKey,
  useBrowserAutomationStore,
  usePreviewTabSet,
  usePreviewTabsStore,
  browserSurfacePresentationCoordinator,
} from "@/features/preview";
import {
  MAX_TERMINALS_PER_SCOPE,
  TerminalPoolSlot,
  useTerminalStore,
  type TerminalInstance,
} from "@/features/terminal";
import { createTerminalForScope } from "@/lib/ensure-terminal";
import { toggleRightPanelAdaptive } from "@/lib/right-panel-layout";
import { getTransport } from "@/transport";
import { cn } from "@/lib/utils";
import { ResizableRightPanel } from "./ResizableRightPanel";

/** One thread/workspace Browser panel retained by the warm LRU pool. */
export interface WarmPreviewScope {
  readonly scopeId: string;
  readonly workspaceId: string;
  readonly lastUsedAt: number;
}

function warmPreviewScopeKey(scope: Pick<WarmPreviewScope, "scopeId" | "workspaceId">): string {
  return browserAutomationScopeKey(scope.workspaceId, scope.scopeId);
}

/**
 * Retain active and agent-busy Browser scopes, then fill the warm budget by
 * recency. Busy scopes are leased until their operation settles.
 */
export function reconcileWarmPreviewScopes(
  previous: readonly WarmPreviewScope[],
  next: WarmPreviewScope | null,
  busyScopeKeys: ReadonlySet<string>,
): readonly WarmPreviewScope[] {
  const byId = new Map(previous.map((scope) => [warmPreviewScopeKey(scope), scope]));
  if (next) byId.set(warmPreviewScopeKey(next), next);
  const ordered = [...byId.values()].sort((left, right) => right.lastUsedAt - left.lastUsedAt);
  const leased = ordered.filter(
    (scope) => (next !== null && warmPreviewScopeKey(scope) === warmPreviewScopeKey(next)) ||
      busyScopeKeys.has(warmPreviewScopeKey(scope)),
  );
  const selected = new Map(leased.map((scope) => [warmPreviewScopeKey(scope), scope]));
  for (const scope of ordered) {
    if (selected.size >= BROWSER_AUTOMATION_WARM_TARGET_LIMIT) break;
    selected.set(warmPreviewScopeKey(scope), scope);
  }
  const result = [...selected.values()];
  return result.length === previous.length &&
    result.every((scope, index) => scope === previous[index])
    ? previous
    : result;
}
import { SubagentsPanel } from "@/features/subagents";
import { CoordinationPanel } from "./CoordinationPanel";

const EMPTY_SCOPE_TERMINALS: readonly TerminalInstance[] = [];

interface WarmPreviewSurfaceProps {
  readonly scope: WarmPreviewScope;
  readonly visible: boolean;
  readonly coveredLeft: number;
}

const WarmPreviewSurface = memo(function WarmPreviewSurface({
  scope,
  visible,
  coveredLeft,
}: WarmPreviewSurfaceProps) {
  const automationHosted = useBrowserAutomationStore((state) =>
    state.hostedScopeIds.has(warmPreviewScopeKey(scope)),
  );
  const anchorCleanupRef = useRef<(() => void) | null>(null);
  const setAutomationAnchor = useCallback((element: HTMLDivElement | null): void => {
    anchorCleanupRef.current?.();
    anchorCleanupRef.current = element
      ? browserSurfacePresentationCoordinator.registerAutomationAnchor(
          scope.workspaceId,
          scope.scopeId,
          element,
          visible,
        )
      : null;
  }, [scope.scopeId, scope.workspaceId, visible]);
  useEffect(() => () => {
    anchorCleanupRef.current?.();
    anchorCleanupRef.current = null;
  }, []);
  useEffect(() => {
    browserSurfacePresentationCoordinator.setAutomationAnchorVisibility(
      scope.workspaceId,
      scope.scopeId,
      visible,
    );
  }, [scope.scopeId, scope.workspaceId, visible]);
  return (
    <div
      data-preview-scope={scope.scopeId}
      className={visible ? "flex min-h-0 flex-1" : "hidden"}
      inert={!visible ? true : undefined}
    >
      {automationHosted ? (
        <div
          ref={setAutomationAnchor}
          data-testid="automation-preview-dock"
          className="min-h-0 min-w-0 flex-1"
        />
      ) : (
        <PreviewPanel
          threadId={scope.scopeId}
          workspaceId={scope.workspaceId}
          presentationActive={visible}
          coveredLeft={coveredLeft}
        />
      )}
    </div>
  );
});

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

  // Read the scope's effective panel record: the active thread's own once it has
  // diverged, otherwise the workspace fallback (ADR-0012 copy-on-write). Both
  // branches return a stable store reference, so the selector does not allocate.
  const storedPanel = useDiffStore((s) =>
    activeWorkspaceId
      ? ((activeThreadId ? s.rightPanelByThread[activeThreadId] : undefined) ??
        s.rightPanelFallbackByWorkspace[activeWorkspaceId])
      : undefined,
  );
  /** Avoid a Zustand selector that allocates a fresh default object every evaluation. */
  const panelState = useMemo(
    () =>
      storedPanel
        ? createRightPanelState(storedPanel)
        : createDefaultRightPanelState(),
    [storedPanel],
  );
  const {
    width: panelWidth,
    activeTab,
    openTabs,
    tabInstances,
    activeTabId,
  } = panelState;
  // Plan is creatable only in a thread; threadless the panel runs
  // against the workspace root and offers just Browser/Terminal/Files.
  const panelScope: PanelScope = activeThreadId ? "thread" : "threadless";
  // The whole panel record (visibility included) is per-thread, falling back to
  // the workspace record for the threadless shell and uncustomized threads. See
  // ADR-0012.
  const panelVisible = useDiffStore((s) =>
    activeWorkspaceId
      ? s.getRightPanelVisible(activeWorkspaceId, activeThreadId)
      : false,
  );

  // The Terminal and Preview tabs bind to the active thread, or to the
  // workspace itself in the threadless new-thread view (where they run against
  // the local workspace root). Their stores treat this as an opaque scope key.
  const panelScopeId = activeThreadId ?? activeWorkspaceId;
  const [warmPreviewScopes, setWarmPreviewScopes] = useState<readonly WarmPreviewScope[]>([]);
  const [activityRailExpanded, setActivityRailExpanded] = useState(false);

  useEffect(() => () => {
    browserSurfacePresentationCoordinator.setActivityRailOverlap(0);
  }, []);
  const retainedPreviewScopeKeys = useMemo(
    () => new Set([
      ...(panelScopeId && activeWorkspaceId ? [browserAutomationScopeKey(activeWorkspaceId, panelScopeId)] : []),
      ...warmPreviewScopes.map(warmPreviewScopeKey),
    ]),
    [activeWorkspaceId, panelScopeId, warmPreviewScopes],
  );
  const [pendingAgentPageId, activeAgentRequestPageId, ownedAgentPageId] =
    useBrowserAutomationStore(
      useShallow((state) => {
        let pendingPage: { readonly tabId: string; readonly startedAt: number } | null = null;
        for (const pending of state.pendingAgentOpens.values()) {
          if (
            pending.workspaceId !== activeWorkspaceId ||
            pending.threadId !== panelScopeId
          ) continue;
          if (!pendingPage || pending.startedAt > pendingPage.startedAt) {
            pendingPage = { tabId: pending.tabId, startedAt: pending.startedAt };
          }
        }

        let activePage: { readonly tabId: string; readonly startedAt: number } | null = null;
        for (const { dispatch, startedAt } of state.activeRequests.values()) {
          if (dispatch.request.workspaceId !== activeWorkspaceId || dispatch.target.threadId !== panelScopeId) continue;
          if (!activePage || startedAt > activePage.startedAt) {
            activePage = { tabId: dispatch.target.tabId, startedAt };
          }
        }

        let ownedPage: { readonly tabId: string; readonly lastUsedAt: number } | null = null;
        for (const lifecycle of state.lifecycleTabs.values()) {
          if (
            lifecycle.workspaceId !== activeWorkspaceId ||
            lifecycle.threadId !== panelScopeId ||
            lifecycle.provenance !== "agent-created" ||
            lifecycle.ownership !== "owned"
          ) continue;
          const liveTarget = panelScopeId
             ? state.liveTargets.get(browserAutomationTargetKey(activeWorkspaceId, panelScopeId, lifecycle.tabId))
            : undefined;
          const lastUsedAt = liveTarget?.lastUsedAt ?? 0;
          if (!ownedPage || lastUsedAt > ownedPage.lastUsedAt) {
            ownedPage = { tabId: lifecycle.tabId, lastUsedAt };
          }
        }

        return [
          pendingPage?.tabId ?? null,
          activePage?.tabId ?? null,
          ownedPage?.tabId ?? null,
        ] as const;
      }),
    );
  const busyPreviewScopeIdList = useBrowserAutomationStore(
    useShallow((state) => [
      ...new Set(
        [...state.activeRequests.values()]
          .map(({ dispatch }) => browserAutomationScopeKey(dispatch.request.workspaceId, dispatch.target.threadId))
          .filter((scopeKey) => retainedPreviewScopeKeys.has(scopeKey)),
      ),
    ].sort()),
  );
  const busyPreviewScopeIds = useMemo(
    () => new Set(busyPreviewScopeIdList),
    [busyPreviewScopeIdList],
  );
  const terminalsByScope = useTerminalStore((s) => s.terminals);
  const scopeTerminals = panelScopeId
    ? (terminalsByScope[panelScopeId] ?? EMPTY_SCOPE_TERMINALS)
    : EMPTY_SCOPE_TERMINALS;
  const terminalLabels = useMemo(() => {
    const occurrences = new Map<string, number>();
    for (const terminal of scopeTerminals) {
      occurrences.set(terminal.label, (occurrences.get(terminal.label) ?? 0) + 1);
    }
    const seen = new Map<string, number>();
    return Object.fromEntries(scopeTerminals.map((terminal) => {
      const ordinal = (seen.get(terminal.label) ?? 0) + 1;
      seen.set(terminal.label, ordinal);
      const label = occurrences.get(terminal.label)! > 1
        ? `${terminal.label} (${ordinal})`
        : terminal.label;
      return [`terminal:${terminal.id}`, label];
    }));
  }, [scopeTerminals]);

  // The Browser tab's open pages drive the rail's page switcher. The store is
  // seeded by the mounted PreviewPanel; reading it here lets the rail render
  // page entries (and the active-page favicon glyph) even while another tab is
  // active. Null in web builds with no bridge, where the rail keeps the single
  // Browser glyph.
  const browserTabSet = usePreviewTabSet(panelScopeId, activeWorkspaceId);
  const requestedAgentPageActivationRef = useRef<string | null>(null);
  const agentBrowserPage = useMemo(() => {
    if (!activeWorkspaceId || !panelScopeId || !browserTabSet) return null;
    const hasPage = (tabId: string | null) =>
      tabId !== null && browserTabSet.tabs.some((tab) => tab.id === tabId);
    if (pendingAgentPageId && hasPage(pendingAgentPageId)) {
      return { tabId: pendingAgentPageId, presenting: true };
    }
    if (activeAgentRequestPageId && hasPage(activeAgentRequestPageId)) {
      return { tabId: activeAgentRequestPageId, presenting: true };
    }
    return ownedAgentPageId && hasPage(ownedAgentPageId)
      ? { tabId: ownedAgentPageId, presenting: false }
      : null;
  }, [
    activeAgentRequestPageId,
    activeWorkspaceId,
    browserTabSet,
    ownedAgentPageId,
    panelScopeId,
    pendingAgentPageId,
  ]);

  // Keep idle Browser pages background-only when the panel has no retained
  // tab. An explicit retained Preview tab is restored, while an empty panel
  // projects the latest agent-owned page. A live agent request takes over an
  // already-visible panel without discarding its other retained tools.
  const activeAgentBrowserPageId = agentBrowserPage?.tabId ?? null;
  const previewIsOnlyOpenTab =
    tabInstances.length === 1 && tabInstances[0]?.type === "preview";
  const shouldRevealAgentPage =
    activeAgentBrowserPageId !== null &&
    (openTabs.length === 0 || (panelVisible && agentBrowserPage?.presenting === true));
  const shouldRestorePreviewTab = previewIsOnlyOpenTab && activeTab !== "preview";
  const revealExistingPreview =
    panelVisible &&
    (shouldRevealAgentPage || shouldRestorePreviewTab) &&
    (browserTabSet?.tabs.length ?? 0) > 0;
  const renderedTabInstances = revealExistingPreview && !openTabs.includes("preview")
    ? [...tabInstances, { id: "singleton:preview", type: "preview" as const }]
    : tabInstances;
  const renderedOpenTabs = renderedTabInstances.map((instance) => instance.type);
  const renderedActiveTabId = revealExistingPreview ? "singleton:preview" : activeTabId;
  const renderedActiveTab = revealExistingPreview ? "preview" : activeTab;

  useLayoutEffect(() => {
    if (!revealExistingPreview || !activeWorkspaceId) return;
    const current = useDiffStore.getState().getRightPanel(activeWorkspaceId, activeThreadId);
    const hasNonPreviewTab = current.tabInstances.some((instance) => instance.type !== "preview");
    if (!current.visible || (hasNonPreviewTab && agentBrowserPage?.presenting !== true)) return;
    if (current.activeTab !== "preview") {
      useDiffStore.getState().setRightPanelTab(activeWorkspaceId, activeThreadId, "preview");
    }
    const existingPageId = agentBrowserPage?.tabId ??
      browserTabSet?.activeTabId ??
      browserTabSet?.tabs[0]?.id;
    const activationKey = panelScopeId && existingPageId
      ? `${panelScopeId}:${existingPageId}`
      : null;
    if (
      panelScopeId &&
      existingPageId &&
      activationKey &&
      browserTabSet?.activeTabId !== existingPageId &&
      requestedAgentPageActivationRef.current !== activationKey
    ) {
      requestedAgentPageActivationRef.current = activationKey;
      void usePreviewTabsStore.getState().activatePage(activeWorkspaceId!, panelScopeId, existingPageId);
    }
  }, [
    activeThreadId,
    agentBrowserPage,
    activeWorkspaceId,
    browserTabSet,
    panelScopeId,
    revealExistingPreview,
  ]);

  // Zustand action refs are stable (same identity for the store's lifetime),
  // so destructuring from getState() at render time is safe and avoids
  // adding actions to useCallback/useEffect dependency arrays.
  const {
    setRightPanelWidth,
    setRightPanelTab,
    setRightPanelTabInstance,
    closeRightPanelTab,
    closeRightPanelTabInstance,
    reorderRightPanelTab,
  } =
    useDiffStore.getState();

  const handlePanelWidthChange = useCallback(
    (nextWidth: number, source: "preserve" | "user") => {
      if (!activeWorkspaceId) return;
      setRightPanelWidth(activeWorkspaceId, activeThreadId, nextWidth, source);
    },
    [activeThreadId, activeWorkspaceId, setRightPanelWidth],
  );

  const handleTogglePanel = useCallback(() => {
    if (!activeWorkspaceId) return;
    const activeElement = document.activeElement;
    if (
      panelVisible &&
      activeElement instanceof HTMLElement &&
      activeElement.closest("[data-right-panel-root]")
    ) {
      activeElement.blur();
    }
    toggleRightPanelAdaptive(activeWorkspaceId, activeThreadId);
  }, [activeThreadId, activeWorkspaceId, panelVisible]);

  useLayoutEffect(() => {
    if (panelVisible) return;
    const activeElement = document.activeElement;
    if (
      activeElement instanceof HTMLElement &&
      activeElement.closest("[data-right-panel-root]")
    ) {
      activeElement.blur();
    }
  }, [panelVisible]);

  // Tab-strip glance status. Changes counts
  // distinct files across every turn snapshot (the cumulative working-tree diff
  // the user reviews and ships).
  const scope = useMemo<ScopeProgress>(() => ({ done: 0, total: 0 }), []);

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
  const changesActive = renderedActiveTab === "changes" && renderedTabInstances.some((instance) => instance.type === "changes");
  const previewActive = renderedActiveTab === "preview" && renderedTabInstances.some((instance) => instance.type === "preview");
  const terminalActive =
    renderedActiveTab === "terminal" && renderedTabInstances.some((instance) => instance.type === "terminal");
  const subagentsActive =
    renderedActiveTab === "subagents" && renderedTabInstances.some((instance) => instance.type === "subagents");

  const activePreviewScopeKey = previewActive && panelScopeId && activeWorkspaceId
    ? `${activeWorkspaceId}\u0000${panelScopeId}`
    : null;
  const previousActivePreviewScopeKeyRef = useRef<string | null>(null);
  useEffect(() => {
    if (!activePreviewScopeKey || !panelScopeId || !activeWorkspaceId) {
      previousActivePreviewScopeKeyRef.current = null;
      return;
    }
    const becameActive = previousActivePreviewScopeKeyRef.current !== activePreviewScopeKey;
    previousActivePreviewScopeKeyRef.current = activePreviewScopeKey;
    setWarmPreviewScopes((previous) => {
      const existing = previous.find((scope) =>
        scope.scopeId === panelScopeId && scope.workspaceId === activeWorkspaceId
      );
      const next = !existing || becameActive
        ? { scopeId: panelScopeId, workspaceId: activeWorkspaceId, lastUsedAt: Date.now() }
        : existing;
      return reconcileWarmPreviewScopes(previous, next, busyPreviewScopeIds);
    });
  }, [activePreviewScopeKey, activeWorkspaceId, busyPreviewScopeIds, panelScopeId]);

  const browserScopePresent = browserTabSet !== null;
  useEffect(() => {
    setWarmPreviewScopes((previous) => {
      const retained =
        !previewActive &&
        !browserScopePresent &&
        panelScopeId &&
        activeWorkspaceId &&
        !busyPreviewScopeIds.has(browserAutomationScopeKey(activeWorkspaceId, panelScopeId))
        ? previous.filter((scope) =>
            scope.scopeId !== panelScopeId || scope.workspaceId !== activeWorkspaceId
          )
        : previous;
      return reconcileWarmPreviewScopes(retained, null, busyPreviewScopeIds);
    });
  }, [activeWorkspaceId, browserScopePresent, busyPreviewScopeIds, panelScopeId, previewActive]);

  const isChangesActive = panelVisible && changesActive;
  const changesFresh = useChangesFreshness(
    activeThreadId,
    changesCount,
    isChangesActive,
  );

  // Exit maximize when the panel is hidden so the user never lands on a blank
  // full-screen shell with no panel chrome to restore from.
  const setMaximized = useUiStore.getState().setRightPanelMaximized;
  useEffect(() => {
    if (maximized && !panelVisible) setMaximized(false);
  }, [maximized, panelVisible, setMaximized]);

  /** Max panel width that still leaves {@link COMPOSER_MIN_WIDTH}px for the chat. */
  const getMaxPanelWidth = useCallback(
    (panel: HTMLDivElement | null): number => {
      const split = panel?.parentElement;
      if (!split) {
        return Math.max(
          PANEL_MIN_WIDTH,
          window.innerWidth - COMPOSER_MIN_WIDTH,
        );
      }
      return maxPanelWidthInSplit(split.clientWidth);
    },
    [],
  );

  // Keep the panel (and terminal pool) mounted when hidden so xterm instances
  // and scroll anchors survive thread switches; a hidden panel collapses to zero
  // width rather than unmounting. The panel still renders with no thread (the
  // threadless shell against the workspace fallback) and only bails when there is
  // no workspace to anchor it to.
  if (!activeWorkspaceId) return null;

  return (
    <ResizableRightPanel
      testId="right-panel"
      width={panelWidth}
      minWidth={PANEL_MIN_WIDTH}
      maxWidth={`calc(100% - ${COMPOSER_MIN_WIDTH}px - ${PANEL_SPLIT_GAP_PX}px)`}
      getMaxWidth={getMaxPanelWidth}
      defaultWidth={getDefaultPanelWidthPx()}
      wideWidth={PANEL_WIDE_WIDTH}
      separatorLabel="Resize panel"
      resizeEnabled={panelVisible && !maximized}
      onWidthChange={handlePanelWidthChange}
      style={
        !panelVisible
          ? {
              width: 0,
              minWidth: 0,
              maxWidth: 0,
            }
          : undefined
      }
      className={cn(
        "relative flex h-full min-h-0 min-w-0 flex-col overflow-hidden bg-background focus:outline-none",
        "transition-[width,min-width,max-width,opacity,transform] duration-200 ease-[cubic-bezier(0.22,1,0.36,1)] motion-reduce:transition-none",
        !panelVisible && "pointer-events-none translate-x-2 opacity-0",
        panelVisible && "translate-x-0 opacity-100",
        // Maximized fills the content area (App hides the chat pane); inline
        // mode is sized by the stored width above.
        panelVisible && maximized && "flex-1",
      )}
      data-right-panel-root=""
      inert={!panelVisible ? true : undefined}
    >
      {/* Rail + content. The activity rail carries close and maximize actions and,
          once tabs are open, tab navigation and the add control. With no tabs it
          keeps those panel actions beside the empty-state create list. */}
      <div className="flex min-h-0 flex-1 flex-row overflow-hidden">
        <ActivityRail
          workspaceId={activeWorkspaceId!}
          tabInstances={renderedTabInstances}
          activeTabId={renderedActiveTabId}
          scope={panelScope}
          scopeProgress={scope}
          changesCount={changesCount}
          changesFresh={changesFresh}
          browserTabSet={browserTabSet}
          maximized={maximized}
          onTogglePanel={handleTogglePanel}
          onToggleMaximized={toggleMaximized}
          onSelect={(instanceId) => {
            setRightPanelTabInstance(activeWorkspaceId!, activeThreadId, instanceId);
            const terminal = renderedTabInstances.find((instance) => instance.id === instanceId);
            if (terminal?.type === "terminal" && panelScopeId) {
              useTerminalStore
                .getState()
                .setActiveTerminal(panelScopeId, instanceId.slice("terminal:".length));
            }
          }}
          onClose={(instanceId) =>
            {
              const terminal = renderedTabInstances.find((instance) => instance.id === instanceId);
              if (terminal?.type === "terminal") {
                const ptyId = instanceId.slice("terminal:".length);
                void getTransport().terminalKill(ptyId).then(() => {
                  useTerminalStore.getState().removeTerminal(ptyId);
                  closeRightPanelTabInstance(activeWorkspaceId!, activeThreadId, instanceId);
                });
              } else {
                closeRightPanelTabInstance(activeWorkspaceId!, activeThreadId, instanceId);
              }
            }
          }
          onReorder={(instanceId, direction) =>
            reorderRightPanelTab(
              activeWorkspaceId!,
              activeThreadId,
              instanceId,
              direction,
            )
          }
          terminalCapReached={scopeTerminals.length >= MAX_TERMINALS_PER_SCOPE}
          terminalLabels={terminalLabels}
          onCreate={(id) => {
            if (id === "terminal" && panelScopeId) {
              createTerminalForScope(panelScopeId);
              return;
            }
            setRightPanelTab(activeWorkspaceId!, activeThreadId, id);
          }}
          onSelectBrowserPage={(instanceId, pageId) => {
            // Focus the Browser tab and switch the guest to that page.
            setRightPanelTabInstance(activeWorkspaceId!, activeThreadId, instanceId);
            if (panelScopeId) {
              void usePreviewTabsStore
                .getState()
                .activatePage(activeWorkspaceId!, panelScopeId, pageId);
            }
          }}
          onCloseBrowserPage={(pageId) => {
            if (!panelScopeId) return;
            // Closing the last page closes the Browser tab entirely (the rail is
            // the page switcher, so an empty browser has nothing to show).
            void usePreviewTabsStore
              .getState()
              .closePage(activeWorkspaceId!, panelScopeId, pageId, {
                onLastClose: () =>
                  closeRightPanelTab(
                    activeWorkspaceId!,
                    activeThreadId,
                    "preview",
                  ),
              });
          }}
          onExpandedChange={(expanded) => {
            setActivityRailExpanded(expanded);
            browserSurfacePresentationCoordinator.setActivityRailOverlap(
              expanded ? ACTIVITY_RAIL_FLOATING_OVERLAP_PX : 0,
            );
          }}
        />

        {/* Tab content — DiffPanel and terminal pool stay mounted (stacked) so
            turn expand state, loaded diffs, and xterm scroll anchors survive tab
            and workspace thread switches. With no tab open the panel shows the
            card-grid empty state, which is itself the create surface. */}
        <div className="relative flex min-h-0 min-w-0 flex-1 flex-col overflow-hidden">
          {renderedOpenTabs.length === 0 && (
            <PanelEmptyState
              scope={panelScope}
              openTabs={renderedOpenTabs}
              onOpen={(id) =>
                id === "terminal" && panelScopeId
                  ? createTerminalForScope(panelScopeId)
                  : setRightPanelTab(activeWorkspaceId!, activeThreadId, id)
              }
            />
          )}
          {renderedActiveTab === "tasks" &&
            renderedOpenTabs.includes("tasks") &&
            activeThreadId && <PlanPanel threadId={activeThreadId} />}
          {subagentsActive && activeThreadId && (
            <SubagentsPanel key={activeThreadId} threadId={activeThreadId} />
          )}
          {renderedActiveTab === "coordination" &&
            renderedOpenTabs.includes("coordination") &&
            activeThreadId &&
            activeWorkspaceId && (
              <CoordinationPanel
                key={activeThreadId}
                workspaceId={activeWorkspaceId}
                threadId={activeThreadId}
              />
            )}
          <div
            className={
              changesActive ? "flex flex-1 flex-col min-h-0" : "hidden"
            }
          >
            <DiffPanel />
          </div>
          {warmPreviewScopes.map((scope) => {
            const visible = previewActive &&
              scope.scopeId === panelScopeId &&
              scope.workspaceId === activeWorkspaceId;
            return (
              <WarmPreviewSurface
                key={warmPreviewScopeKey(scope)}
                scope={scope}
                visible={visible}
                coveredLeft={visible && activityRailExpanded ? ACTIVITY_RAIL_FLOATING_OVERLAP_PX : 0}
              />
            );
          })}
          <div
            className={cn(
              "absolute inset-0 z-0 flex min-h-0 flex-row overflow-hidden",
              !terminalActive && "pointer-events-none opacity-0",
            )}
            inert={!terminalActive ? true : undefined}
          >
            <TerminalPoolSlot className="relative min-h-0 min-w-0 flex-1 overflow-hidden" />
          </div>
        </div>
      </div>
    </ResizableRightPanel>
  );
}
