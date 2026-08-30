import { memo, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type RefObject } from "react";
import { useShallow } from "zustand/shallow";
import type { BrowserTabSet } from "@mcode/contracts";
import { useWorkspaceStore } from "@/features/projects/state/workspaceStore";
import { useUiStore } from "@/stores/uiStore";
import {
  useDiffStore,
  PANEL_MIN_WIDTH,
  PANEL_WIDE_WIDTH,
  COMPOSER_MIN_WIDTH,
  PANEL_SPLIT_GAP_PX,
  maxPanelWidthInSplit,
  projectRightPanelForScope,
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
  type BrowserAutomationActiveRequest,
  type BrowserAutomationLiveTarget,
  type BrowserAutomationPendingAgentOpen,
  type BrowserSessionLifecycleTab,
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
import { ProjectActionTerminalView, ProjectEnvironmentPanel } from "@/features/projects/environment";
import { useProjectActionStore } from "@/features/projects/environment/state/project-action-store";

const EMPTY_SCOPE_TERMINALS: readonly TerminalInstance[] = [];
const EMPTY_PROJECT_ACTION_RUNS: Readonly<Record<string, import("@mcode/contracts").WorkspaceEnvironmentActionRun>> = {};

interface AgentPageSelectorState {
  readonly activeRequests: ReadonlyMap<string, BrowserAutomationActiveRequest>;
  readonly lifecycleTabs: ReadonlyMap<string, BrowserSessionLifecycleTab>;
  readonly liveTargets: ReadonlyMap<string, BrowserAutomationLiveTarget>;
  readonly pendingAgentOpens: ReadonlyMap<string, BrowserAutomationPendingAgentOpen>;
}

function latestPendingAgentPageId(
  pendingAgentOpens: ReadonlyMap<string, BrowserAutomationPendingAgentOpen>,
  workspaceId: string | null,
  scopeId: string | null,
): string | null {
  let latest: BrowserAutomationPendingAgentOpen | null = null;
  for (const pending of pendingAgentOpens.values()) {
    if (pending.workspaceId !== workspaceId || pending.threadId !== scopeId) continue;
    if (!latest || pending.startedAt > latest.startedAt) latest = pending;
  }
  return latest?.tabId ?? null;
}

function latestActiveAgentPageId(
  activeRequests: ReadonlyMap<string, BrowserAutomationActiveRequest>,
  workspaceId: string | null,
  scopeId: string | null,
): string | null {
  let latest: BrowserAutomationActiveRequest | null = null;
  for (const request of activeRequests.values()) {
    if (
      request.dispatch.request.workspaceId !== workspaceId ||
      request.dispatch.target.threadId !== scopeId
    ) continue;
    if (!latest || request.startedAt > latest.startedAt) latest = request;
  }
  return latest?.dispatch.target.tabId ?? null;
}

function latestOwnedAgentPageId(
  lifecycleTabs: ReadonlyMap<string, BrowserSessionLifecycleTab>,
  liveTargets: ReadonlyMap<string, BrowserAutomationLiveTarget>,
  workspaceId: string | null,
  scopeId: string | null,
): string | null {
  let tabId: string | null = null;
  let lastUsedAt = 0;
  for (const lifecycle of lifecycleTabs.values()) {
    if (!isOwnedAgentLifecycle(lifecycle, workspaceId, scopeId)) continue;
    const targetLastUsedAt = getTargetLastUsedAt(liveTargets, workspaceId!, scopeId!, lifecycle.tabId);
    if (tabId === null || targetLastUsedAt > lastUsedAt) {
      tabId = lifecycle.tabId;
      lastUsedAt = targetLastUsedAt;
    }
  }
  return tabId;
}

function isOwnedAgentLifecycle(
  lifecycle: BrowserSessionLifecycleTab,
  workspaceId: string | null,
  scopeId: string | null,
): boolean {
  return lifecycle.workspaceId === workspaceId &&
    lifecycle.threadId === scopeId &&
    lifecycle.provenance === "agent-created" &&
    lifecycle.ownership === "owned";
}

function getTargetLastUsedAt(
  liveTargets: ReadonlyMap<string, BrowserAutomationLiveTarget>,
  workspaceId: string,
  scopeId: string,
  tabId: string,
): number {
  return liveTargets.get(browserAutomationTargetKey(workspaceId, scopeId, tabId))?.lastUsedAt ?? 0;
}

function selectAgentPageIds(
  state: AgentPageSelectorState,
  workspaceId: string | null,
  scopeId: string | null,
): readonly [string | null, string | null, string | null] {
  return [
    latestPendingAgentPageId(state.pendingAgentOpens, workspaceId, scopeId),
    latestActiveAgentPageId(state.activeRequests, workspaceId, scopeId),
    latestOwnedAgentPageId(state.lifecycleTabs, state.liveTargets, workspaceId, scopeId),
  ];
}

interface AgentBrowserPage {
  readonly tabId: string;
  readonly presenting: boolean;
}

interface ExistingPreviewReveal {
  readonly activeThreadId: string | null;
  readonly activeWorkspaceId: string | null;
  readonly agentBrowserPage: AgentBrowserPage | null;
  readonly browserTabSet: BrowserTabSet | null;
  readonly panelScopeId: string | null;
  readonly revealExistingPreview: boolean;
  readonly requestedAgentPageActivationRef: RefObject<string | null>;
}

function canRevealExistingPreview(
  hasNonPreviewTab: boolean,
  currentVisible: boolean,
  agentBrowserPage: AgentBrowserPage | null,
): boolean {
  return currentVisible && (!hasNonPreviewTab || agentBrowserPage?.presenting === true);
}

function requestExistingPreviewPageActivation({
  activeWorkspaceId,
  agentBrowserPage,
  browserTabSet,
  panelScopeId,
  requestedAgentPageActivationRef,
}: Omit<ExistingPreviewReveal, "activeThreadId" | "revealExistingPreview">): void {
  const existingPageId = getExistingPreviewPageId(agentBrowserPage, browserTabSet);
  if (!panelScopeId || !existingPageId) return;
  const activationKey = `${panelScopeId}:${existingPageId}`;
  if (!shouldActivateExistingPreview(browserTabSet, activationKey, existingPageId, requestedAgentPageActivationRef)) return;
  requestedAgentPageActivationRef.current = activationKey;
  void usePreviewTabsStore.getState().activatePage(activeWorkspaceId!, panelScopeId, existingPageId);
}

function getExistingPreviewPageId(
  agentBrowserPage: AgentBrowserPage | null,
  browserTabSet: BrowserTabSet | null,
): string | null | undefined {
  return agentBrowserPage?.tabId ?? browserTabSet?.activeTabId ?? browserTabSet?.tabs[0]?.id;
}

function shouldActivateExistingPreview(
  browserTabSet: BrowserTabSet | null,
  activationKey: string,
  existingPageId: string,
  requestedAgentPageActivationRef: RefObject<string | null>,
): boolean {
  return browserTabSet?.activeTabId !== existingPageId &&
    requestedAgentPageActivationRef.current !== activationKey;
}

function synchronizeExistingPreview({
  activeThreadId,
  activeWorkspaceId,
  agentBrowserPage,
  browserTabSet,
  panelScopeId,
  revealExistingPreview: shouldRevealExistingPreview,
  requestedAgentPageActivationRef,
}: ExistingPreviewReveal): void {
  if (!shouldRevealExistingPreview || !activeWorkspaceId) return;
  const current = useDiffStore.getState().getRightPanel(activeWorkspaceId, activeThreadId);
  const hasNonPreviewTab = current.tabInstances.some((instance) => instance.type !== "preview");
  if (!canRevealExistingPreview(hasNonPreviewTab, current.visible, agentBrowserPage)) return;
  if (current.activeTab !== "preview") {
    useDiffStore.getState().setRightPanelTab(activeWorkspaceId, activeThreadId, "preview");
  }
  requestExistingPreviewPageActivation({
    activeWorkspaceId,
    agentBrowserPage,
    browserTabSet,
    panelScopeId,
    requestedAgentPageActivationRef,
  });
}

interface PreviewPresentation {
  readonly agentBrowserPage: AgentBrowserPage | null;
  readonly browserTabSet: BrowserTabSet | null;
  readonly renderedActiveTab: string | null;
  readonly renderedActiveTabId: string | null;
  readonly renderedOpenTabs: ReturnType<typeof projectRightPanelForScope>["openTabs"];
  readonly renderedTabInstances: ReturnType<typeof projectRightPanelForScope>["tabInstances"];
}

function usePreviewPresentation({
  activeAgentRequestPageId,
  activeTab,
  activeTabId,
  activeThreadId,
  activeWorkspaceId,
  openTabs,
  ownedAgentPageId,
  panelScopeId,
  panelVisible,
  pendingAgentPageId,
  tabInstances,
}: {
  readonly activeAgentRequestPageId: string | null;
  readonly activeTab: string | null;
  readonly activeTabId: string | null;
  readonly activeThreadId: string | null;
  readonly activeWorkspaceId: string | null;
  readonly openTabs: ReturnType<typeof projectRightPanelForScope>["openTabs"];
  readonly ownedAgentPageId: string | null;
  readonly panelScopeId: string | null;
  readonly panelVisible: boolean;
  readonly pendingAgentPageId: string | null;
  readonly tabInstances: ReturnType<typeof projectRightPanelForScope>["tabInstances"];
}): PreviewPresentation {
  const browserTabSet = usePreviewTabSet(panelScopeId, activeWorkspaceId);
  const requestedAgentPageActivationRef = useRef<string | null>(null);
  const agentBrowserPage = useMemo(
    () => getAgentBrowserPage(
      activeWorkspaceId,
      panelScopeId,
      browserTabSet,
      pendingAgentPageId,
      activeAgentRequestPageId,
      ownedAgentPageId,
    ),
    [
      activeAgentRequestPageId,
      activeWorkspaceId,
      browserTabSet,
      ownedAgentPageId,
      panelScopeId,
      pendingAgentPageId,
    ],
  );
  const revealExistingPreview = isExistingPreviewVisible(
    activeTab,
    agentBrowserPage,
    browserTabSet,
    openTabs,
    panelVisible,
    tabInstances,
  );

  useLayoutEffect(() => {
    synchronizeExistingPreview({
      activeThreadId,
      activeWorkspaceId,
      agentBrowserPage,
      browserTabSet,
      panelScopeId,
      revealExistingPreview,
      requestedAgentPageActivationRef,
    });
  }, [
    activeThreadId,
    agentBrowserPage,
    activeWorkspaceId,
    browserTabSet,
    panelScopeId,
    revealExistingPreview,
  ]);

  const renderedTabInstances = addProjectedPreviewTab(tabInstances, openTabs, revealExistingPreview);
  return {
    agentBrowserPage,
    browserTabSet,
    renderedActiveTab: revealExistingPreview ? "preview" : activeTab,
    renderedActiveTabId: revealExistingPreview ? "singleton:preview" : activeTabId,
    renderedOpenTabs: renderedTabInstances.map((instance) => instance.type),
    renderedTabInstances,
  };
}

function getAgentBrowserPage(
  activeWorkspaceId: string | null,
  panelScopeId: string | null,
  browserTabSet: BrowserTabSet | null,
  pendingAgentPageId: string | null,
  activeAgentRequestPageId: string | null,
  ownedAgentPageId: string | null,
): AgentBrowserPage | null {
  if (!activeWorkspaceId || !panelScopeId || !browserTabSet) return null;
  if (hasBrowserPage(browserTabSet, pendingAgentPageId)) {
    return { tabId: pendingAgentPageId!, presenting: true };
  }
  if (hasBrowserPage(browserTabSet, activeAgentRequestPageId)) {
    return { tabId: activeAgentRequestPageId!, presenting: true };
  }
  return hasBrowserPage(browserTabSet, ownedAgentPageId)
    ? { tabId: ownedAgentPageId!, presenting: false }
    : null;
}

function hasBrowserPage(browserTabSet: BrowserTabSet, tabId: string | null): boolean {
  return tabId !== null && browserTabSet.tabs.some((tab) => tab.id === tabId);
}

function isExistingPreviewVisible(
  activeTab: string | null,
  agentBrowserPage: AgentBrowserPage | null,
  browserTabSet: BrowserTabSet | null,
  openTabs: ReturnType<typeof projectRightPanelForScope>["openTabs"],
  panelVisible: boolean,
  tabInstances: ReturnType<typeof projectRightPanelForScope>["tabInstances"],
): boolean {
  const shouldRevealAgentPage = shouldRevealActiveAgentPage(agentBrowserPage, openTabs, panelVisible);
  const shouldRestorePreviewTab = isPreviewOnlyTab(tabInstances) && activeTab !== "preview";
  return panelVisible &&
    (shouldRevealAgentPage || shouldRestorePreviewTab) &&
    (browserTabSet?.tabs.length ?? 0) > 0;
}

function shouldRevealActiveAgentPage(
  agentBrowserPage: AgentBrowserPage | null,
  openTabs: ReturnType<typeof projectRightPanelForScope>["openTabs"],
  panelVisible: boolean,
): boolean {
  return agentBrowserPage !== null &&
    (openTabs.length === 0 || (panelVisible && agentBrowserPage.presenting));
}

function isPreviewOnlyTab(
  tabInstances: ReturnType<typeof projectRightPanelForScope>["tabInstances"],
): boolean {
  return tabInstances.length === 1 && tabInstances[0]?.type === "preview";
}

function addProjectedPreviewTab(
  tabInstances: ReturnType<typeof projectRightPanelForScope>["tabInstances"],
  openTabs: ReturnType<typeof projectRightPanelForScope>["openTabs"],
  revealExistingPreview: boolean,
): ReturnType<typeof projectRightPanelForScope>["tabInstances"] {
  if (!revealExistingPreview || openTabs.includes("preview")) return tabInstances;
  return [...tabInstances, { id: "singleton:preview", type: "preview" }];
}

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

function RightPanelFrame({
  children,
  getMaxPanelWidth,
  handlePanelWidthChange,
  maximized,
  panelVisible,
  panelWidth,
}: {
  readonly children: React.ReactNode;
  readonly getMaxPanelWidth: (panel: HTMLDivElement | null) => number;
  readonly handlePanelWidthChange: (width: number, source: "preserve" | "user") => void;
  readonly maximized: boolean;
  readonly panelVisible: boolean;
  readonly panelWidth: number;
}) {
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
      style={getRightPanelVisibilityStyle(panelVisible)}
      className={getRightPanelClassName(panelVisible, maximized)}
      data-right-panel-root=""
      inert={!panelVisible ? true : undefined}
    >
      {children}
    </ResizableRightPanel>
  );
}

function getRightPanelVisibilityStyle(panelVisible: boolean): React.CSSProperties | undefined {
  if (panelVisible) return undefined;
  return { width: 0, minWidth: 0, maxWidth: 0 };
}

function getRightPanelClassName(panelVisible: boolean, maximized: boolean): string {
  return cn(
    "relative flex h-full min-h-0 min-w-0 flex-col overflow-hidden bg-background focus:outline-none",
    "transition-[width,min-width,max-width,opacity,transform] duration-200 ease-[cubic-bezier(0.22,1,0.36,1)] motion-reduce:transition-none",
    !panelVisible && "pointer-events-none translate-x-2 opacity-0",
    panelVisible && "translate-x-0 opacity-100",
    panelVisible && maximized && "flex-1",
  );
}

function RightPanelContent({
  actionTerminalActive,
  activeActionId,
  activeThreadId,
  activeWorkspaceId,
  activityRailExpanded,
  changesActive,
  panelScope,
  panelScopeId,
  previewActive,
  renderedActiveTab,
  renderedOpenTabs,
  renderedTabInstances,
  terminalActive,
  warmPreviewScopes,
  onCreateTab,
}: {
  readonly actionTerminalActive: boolean;
  readonly activeActionId: string | null;
  readonly activeThreadId: string | null;
  readonly activeWorkspaceId: string;
  readonly activityRailExpanded: boolean;
  readonly changesActive: boolean;
  readonly panelScope: PanelScope;
  readonly panelScopeId: string | null;
  readonly previewActive: boolean;
  readonly renderedActiveTab: string | null;
  readonly renderedOpenTabs: ReturnType<typeof projectRightPanelForScope>["openTabs"];
  readonly renderedTabInstances: ReturnType<typeof projectRightPanelForScope>["tabInstances"];
  readonly terminalActive: boolean;
  readonly warmPreviewScopes: readonly WarmPreviewScope[];
  readonly onCreateTab: (id: Parameters<ReturnType<typeof useDiffStore.getState>["setRightPanelTab"]>[2]) => void;
}) {
  return (
    <div className="relative flex min-h-0 min-w-0 flex-1 flex-col overflow-hidden">
      <PanelEmptyContent
        panelScope={panelScope}
        renderedOpenTabs={renderedOpenTabs}
        onCreateTab={onCreateTab}
      />
      <PlanPanelContent activeTab={renderedActiveTab} openTabs={renderedOpenTabs} threadId={activeThreadId} />
      <SubagentsPanelContent activeTab={renderedActiveTab} openTabs={renderedTabInstances} threadId={activeThreadId} />
      <CoordinationPanelContent
        activeTab={renderedActiveTab}
        openTabs={renderedOpenTabs}
        threadId={activeThreadId}
        workspaceId={activeWorkspaceId}
      />
      <EnvironmentPanelContent
        activeTab={renderedActiveTab}
        openTabs={renderedOpenTabs}
        threadId={activeThreadId}
        workspaceId={activeWorkspaceId}
      />
      <ActionTerminalContent
        active={actionTerminalActive}
        actionId={activeActionId}
        threadId={activeThreadId}
      />
      <ChangesPanelContent active={changesActive} />
      <WarmPreviewSurfaces
        activeWorkspaceId={activeWorkspaceId}
        activityRailExpanded={activityRailExpanded}
        panelScopeId={panelScopeId}
        previewActive={previewActive}
        scopes={warmPreviewScopes}
      />
      <TerminalPanelContent active={terminalActive} />
    </div>
  );
}

function PanelEmptyContent({
  panelScope,
  renderedOpenTabs,
  onCreateTab,
}: {
  readonly panelScope: PanelScope;
  readonly renderedOpenTabs: ReturnType<typeof projectRightPanelForScope>["openTabs"];
  readonly onCreateTab: (id: Parameters<ReturnType<typeof useDiffStore.getState>["setRightPanelTab"]>[2]) => void;
}) {
  if (renderedOpenTabs.length > 0) return null;
  return <PanelEmptyState scope={panelScope} openTabs={renderedOpenTabs} onOpen={onCreateTab} />;
}

function PlanPanelContent({
  activeTab,
  openTabs,
  threadId,
}: {
  readonly activeTab: string | null;
  readonly openTabs: ReturnType<typeof projectRightPanelForScope>["openTabs"];
  readonly threadId: string | null;
}) {
  if (activeTab !== "tasks" || !openTabs.includes("tasks") || !threadId) return null;
  return <PlanPanel threadId={threadId} />;
}

function SubagentsPanelContent({
  activeTab,
  openTabs,
  threadId,
}: {
  readonly activeTab: string | null;
  readonly openTabs: ReturnType<typeof projectRightPanelForScope>["tabInstances"];
  readonly threadId: string | null;
}) {
  if (activeTab !== "subagents" || !openTabs.some((instance) => instance.type === "subagents") || !threadId) {
    return null;
  }
  return <SubagentsPanel key={threadId} threadId={threadId} />;
}

function CoordinationPanelContent({
  activeTab,
  openTabs,
  threadId,
  workspaceId,
}: {
  readonly activeTab: string | null;
  readonly openTabs: ReturnType<typeof projectRightPanelForScope>["openTabs"];
  readonly threadId: string | null;
  readonly workspaceId: string;
}) {
  if (activeTab !== "coordination" || !openTabs.includes("coordination") || !threadId) return null;
  return <CoordinationPanel key={threadId} workspaceId={workspaceId} threadId={threadId} />;
}

function EnvironmentPanelContent({
  activeTab,
  openTabs,
  threadId,
  workspaceId,
}: {
  readonly activeTab: string | null;
  readonly openTabs: ReturnType<typeof projectRightPanelForScope>["openTabs"];
  readonly threadId: string | null;
  readonly workspaceId: string;
}) {
  if (activeTab !== "environment" || !openTabs.includes("environment")) return null;
  return (
    <ProjectEnvironmentPanel
      key={`${workspaceId}:${threadId ?? "base"}`}
      workspaceId={workspaceId}
      threadId={threadId ?? undefined}
      active
    />
  );
}

function ActionTerminalContent({
  active,
  actionId,
  threadId,
}: {
  readonly active: boolean;
  readonly actionId: string | null;
  readonly threadId: string | null;
}) {
  if (!active || !threadId || !actionId) return null;
  return <ProjectActionTerminalView key={`${threadId}:${actionId}`} threadId={threadId} actionId={actionId} />;
}

function ChangesPanelContent({ active }: { readonly active: boolean }) {
  return (
    <div className={active ? "flex flex-1 flex-col min-h-0" : "hidden"}>
      <DiffPanel />
    </div>
  );
}

function WarmPreviewSurfaces({
  activeWorkspaceId,
  activityRailExpanded,
  panelScopeId,
  previewActive,
  scopes,
}: {
  readonly activeWorkspaceId: string;
  readonly activityRailExpanded: boolean;
  readonly panelScopeId: string | null;
  readonly previewActive: boolean;
  readonly scopes: readonly WarmPreviewScope[];
}) {
  return scopes.map((scope) => {
    const visible = previewActive && scope.scopeId === panelScopeId && scope.workspaceId === activeWorkspaceId;
    return (
      <WarmPreviewSurface
        key={warmPreviewScopeKey(scope)}
        scope={scope}
        visible={visible}
        coveredLeft={visible && activityRailExpanded ? ACTIVITY_RAIL_FLOATING_OVERLAP_PX : 0}
      />
    );
  });
}

function TerminalPanelContent({ active }: { readonly active: boolean }) {
  return (
    <div
      className={cn(
        "absolute inset-0 z-0 flex min-h-0 flex-row overflow-hidden",
        !active && "pointer-events-none opacity-0",
      )}
      inert={!active ? true : undefined}
    >
      <TerminalPoolSlot className="relative min-h-0 min-w-0 flex-1 overflow-hidden" />
    </div>
  );
}

function RightPanelActivityRail({
  activeThreadId,
  activeWorkspaceId,
  browserTabSet,
  changesCount,
  changesFresh,
  closeRightPanelTab,
  closeRightPanelTabInstance,
  maximized,
  onCreateTab,
  onTogglePanel,
  panelScope,
  panelScopeId,
  railTerminalLabels,
  renderedActiveTabId,
  renderedTabInstances,
  reorderRightPanelTab,
  scope,
  scopeTerminals,
  setActivityRailExpanded,
  setRightPanelTabInstance,
  toggleMaximized,
}: {
  readonly activeThreadId: string | null;
  readonly activeWorkspaceId: string;
  readonly browserTabSet: BrowserTabSet | null;
  readonly changesCount: number;
  readonly changesFresh: boolean;
  readonly closeRightPanelTab: ReturnType<typeof useDiffStore.getState>["closeRightPanelTab"];
  readonly closeRightPanelTabInstance: ReturnType<typeof useDiffStore.getState>["closeRightPanelTabInstance"];
  readonly maximized: boolean;
  readonly onCreateTab: (id: Parameters<ReturnType<typeof useDiffStore.getState>["setRightPanelTab"]>[2]) => void;
  readonly onTogglePanel: () => void;
  readonly panelScope: PanelScope;
  readonly panelScopeId: string | null;
  readonly railTerminalLabels: Record<string, string>;
  readonly renderedActiveTabId: string | null;
  readonly renderedTabInstances: ReturnType<typeof projectRightPanelForScope>["tabInstances"];
  readonly reorderRightPanelTab: ReturnType<typeof useDiffStore.getState>["reorderRightPanelTab"];
  readonly scope: ScopeProgress;
  readonly scopeTerminals: readonly TerminalInstance[];
  readonly setActivityRailExpanded: (expanded: boolean) => void;
  readonly setRightPanelTabInstance: ReturnType<typeof useDiffStore.getState>["setRightPanelTabInstance"];
  readonly toggleMaximized: () => void;
}) {
  return (
    <ActivityRail
      workspaceId={activeWorkspaceId}
      tabInstances={renderedTabInstances}
      activeTabId={renderedActiveTabId}
      scope={panelScope}
      scopeProgress={scope}
      changesCount={changesCount}
      changesFresh={changesFresh}
      browserTabSet={browserTabSet}
      maximized={maximized}
      onTogglePanel={onTogglePanel}
      onToggleMaximized={toggleMaximized}
      onSelect={(instanceId) => {
        setRightPanelTabInstance(activeWorkspaceId, activeThreadId, instanceId);
        setActiveTerminalForTab(renderedTabInstances, instanceId, panelScopeId);
      }}
      onClose={(instanceId) => closePanelTab({
        activeThreadId,
        activeWorkspaceId,
        closeRightPanelTabInstance,
        instanceId,
        renderedTabInstances,
      })}
      onReorder={(instanceId, direction) =>
        reorderRightPanelTab(activeWorkspaceId, activeThreadId, instanceId, direction)}
      terminalCapReached={scopeTerminals.length >= MAX_TERMINALS_PER_SCOPE}
      terminalLabels={railTerminalLabels}
      onCreate={onCreateTab}
      onSelectBrowserPage={(instanceId, pageId) => {
        setRightPanelTabInstance(activeWorkspaceId, activeThreadId, instanceId);
        activateBrowserPage(activeWorkspaceId, panelScopeId, pageId);
      }}
      onCloseBrowserPage={(pageId) => closeBrowserPage(
        activeThreadId,
        activeWorkspaceId,
        closeRightPanelTab,
        panelScopeId,
        pageId,
      )}
      onExpandedChange={(expanded) => {
        setActivityRailExpanded(expanded);
        browserSurfacePresentationCoordinator.setActivityRailOverlap(
          expanded ? ACTIVITY_RAIL_FLOATING_OVERLAP_PX : 0,
        );
      }}
    />
  );
}

function setActiveTerminalForTab(
  tabInstances: ReturnType<typeof projectRightPanelForScope>["tabInstances"],
  instanceId: string,
  panelScopeId: string | null,
): void {
  const terminal = tabInstances.find((instance) => instance.id === instanceId);
  if (terminal?.type !== "terminal" || !panelScopeId) return;
  useTerminalStore.getState().setActiveTerminal(panelScopeId, instanceId.slice("terminal:".length));
}

function closePanelTab({
  activeThreadId,
  activeWorkspaceId,
  closeRightPanelTabInstance,
  instanceId,
  renderedTabInstances,
}: {
  readonly activeThreadId: string | null;
  readonly activeWorkspaceId: string;
  readonly closeRightPanelTabInstance: ReturnType<typeof useDiffStore.getState>["closeRightPanelTabInstance"];
  readonly instanceId: string;
  readonly renderedTabInstances: ReturnType<typeof projectRightPanelForScope>["tabInstances"];
}): void {
  const terminal = renderedTabInstances.find((instance) => instance.id === instanceId);
  if (terminal?.type !== "terminal") {
    closeRightPanelTabInstance(activeWorkspaceId, activeThreadId, instanceId);
    return;
  }
  const ptyId = instanceId.slice("terminal:".length);
  void getTransport().terminalKill(ptyId).then(() => {
    useTerminalStore.getState().removeTerminal(ptyId);
    closeRightPanelTabInstance(activeWorkspaceId, activeThreadId, instanceId);
  });
}

function activateBrowserPage(workspaceId: string, panelScopeId: string | null, pageId: string): void {
  if (!panelScopeId) return;
  void usePreviewTabsStore.getState().activatePage(workspaceId, panelScopeId, pageId);
}

function closeBrowserPage(
  activeThreadId: string | null,
  activeWorkspaceId: string,
  closeRightPanelTab: ReturnType<typeof useDiffStore.getState>["closeRightPanelTab"],
  panelScopeId: string | null,
  pageId: string,
): void {
  if (!panelScopeId) return;
  void usePreviewTabsStore.getState().closePage(activeWorkspaceId, panelScopeId, pageId, {
    onLastClose: () => closeRightPanelTab(activeWorkspaceId, activeThreadId, "preview"),
  });
}

type RightPanelTabType = ReturnType<typeof projectRightPanelForScope>["tabInstances"][number]["type"];

function useRenderedTabState({
  actionRunsByActionId,
  renderedActiveTab,
  renderedActiveTabId,
  renderedTabInstances,
  terminalLabels,
}: {
  readonly actionRunsByActionId: Readonly<Record<string, import("@mcode/contracts").WorkspaceEnvironmentActionRun>>;
  readonly renderedActiveTab: string | null;
  readonly renderedActiveTabId: string | null;
  readonly renderedTabInstances: ReturnType<typeof projectRightPanelForScope>["tabInstances"];
  readonly terminalLabels: Record<string, string>;
}) {
  return {
    actionTerminalActive: isActiveRightPanelTab(renderedActiveTab, renderedTabInstances, "action-terminal"),
    activeActionId: getActiveActionId(renderedActiveTabId, renderedActiveTab, renderedTabInstances),
    changesActive: isActiveRightPanelTab(renderedActiveTab, renderedTabInstances, "changes"),
    previewActive: isActiveRightPanelTab(renderedActiveTab, renderedTabInstances, "preview"),
    railTerminalLabels: useRailTerminalLabels(actionRunsByActionId, renderedTabInstances, terminalLabels),
    terminalActive: isActiveRightPanelTab(renderedActiveTab, renderedTabInstances, "terminal"),
  };
}

function isActiveRightPanelTab(
  activeTab: string | null,
  tabInstances: ReturnType<typeof projectRightPanelForScope>["tabInstances"],
  tabType: RightPanelTabType,
): boolean {
  return activeTab === tabType && tabInstances.some((instance) => instance.type === tabType);
}

function getActiveActionId(
  activeTabId: string | null,
  activeTab: string | null,
  tabInstances: ReturnType<typeof projectRightPanelForScope>["tabInstances"],
): string | null {
  if (!isActiveRightPanelTab(activeTab, tabInstances, "action-terminal")) return null;
  if (!activeTabId?.startsWith("action-terminal:")) return null;
  return activeTabId.slice("action-terminal:".length);
}

function useRailTerminalLabels(
  actionRunsByActionId: Readonly<Record<string, import("@mcode/contracts").WorkspaceEnvironmentActionRun>>,
  tabInstances: ReturnType<typeof projectRightPanelForScope>["tabInstances"],
  terminalLabels: Record<string, string>,
): Record<string, string> {
  return useMemo(() => ({
    ...terminalLabels,
    ...Object.fromEntries(
      tabInstances
        .filter((instance) => instance.type === "action-terminal")
        .map((instance) => [
          instance.id,
          actionRunsByActionId[instance.id.slice("action-terminal:".length)]?.actionName ?? "Project Action",
        ]),
    ),
  }), [actionRunsByActionId, tabInstances, terminalLabels]);
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

  // Select raw records by reference, then project the scope in useMemo. The
  // projection removes workspace Terminal instances only for untouched
  // threads (ADR-0020) while preserving thread-owned records.
  const ownedPanel = useDiffStore((s) =>
    activeWorkspaceId && activeThreadId
      ? s.rightPanelByThread[activeThreadId]
      : undefined,
  );
  const fallbackPanel = useDiffStore((s) =>
    activeWorkspaceId ? s.rightPanelFallbackByWorkspace[activeWorkspaceId] : undefined,
  );
  const panelState = useMemo(
    () => projectRightPanelForScope(ownedPanel, fallbackPanel, activeThreadId),
    [activeThreadId, fallbackPanel, ownedPanel],
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
      useShallow((state) => selectAgentPageIds(state, activeWorkspaceId, panelScopeId)),
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
  const actionRunsByActionId = useProjectActionStore((state) =>
    activeThreadId ? state.runsByThread[activeThreadId] ?? EMPTY_PROJECT_ACTION_RUNS : EMPTY_PROJECT_ACTION_RUNS,
  );

  const {
    browserTabSet,
    renderedActiveTab,
    renderedActiveTabId,
    renderedOpenTabs,
    renderedTabInstances,
  } = usePreviewPresentation({
    activeAgentRequestPageId,
    activeTab,
    activeTabId,
    activeThreadId,
    activeWorkspaceId,
    openTabs,
    ownedAgentPageId,
    panelScopeId,
    panelVisible,
    pendingAgentPageId,
    tabInstances,
  });

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

  const {
    actionTerminalActive,
    activeActionId,
    changesActive,
    previewActive,
    railTerminalLabels,
    terminalActive,
  } = useRenderedTabState({
    actionRunsByActionId,
    renderedActiveTab,
    renderedActiveTabId,
    renderedTabInstances,
    terminalLabels,
  });
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

  const handleCreateTab = useCallback(
    (id: Parameters<typeof setRightPanelTab>[2]) => {
      if (id === "terminal" && panelScopeId) {
        createTerminalForScope(panelScopeId);
        return;
      }
      if (activeWorkspaceId) setRightPanelTab(activeWorkspaceId, activeThreadId, id);
    },
    [activeThreadId, activeWorkspaceId, panelScopeId, setRightPanelTab],
  );

  // Keep the panel (and terminal pool) mounted when hidden so xterm instances
  // and scroll anchors survive thread switches; a hidden panel collapses to zero
  // width rather than unmounting. The panel still renders with no thread (the
  // threadless shell against the workspace fallback) and only bails when there is
  // no workspace to anchor it to.
  if (!activeWorkspaceId) return null;

  return (
    <RightPanelFrame
      getMaxPanelWidth={getMaxPanelWidth}
      handlePanelWidthChange={handlePanelWidthChange}
      maximized={maximized}
      panelVisible={panelVisible}
      panelWidth={panelWidth}
    >
      <div className="flex min-h-0 flex-1 flex-row overflow-hidden">
        <RightPanelActivityRail
          activeThreadId={activeThreadId}
          activeWorkspaceId={activeWorkspaceId}
          browserTabSet={browserTabSet}
          changesCount={changesCount}
          changesFresh={changesFresh}
          closeRightPanelTab={closeRightPanelTab}
          closeRightPanelTabInstance={closeRightPanelTabInstance}
          maximized={maximized}
          onCreateTab={handleCreateTab}
          onTogglePanel={handleTogglePanel}
          panelScope={panelScope}
          panelScopeId={panelScopeId}
          railTerminalLabels={railTerminalLabels}
          renderedActiveTabId={renderedActiveTabId}
          renderedTabInstances={renderedTabInstances}
          reorderRightPanelTab={reorderRightPanelTab}
          scope={scope}
          scopeTerminals={scopeTerminals}
          setActivityRailExpanded={setActivityRailExpanded}
          setRightPanelTabInstance={setRightPanelTabInstance}
          toggleMaximized={toggleMaximized}
        />
        <RightPanelContent
          actionTerminalActive={actionTerminalActive}
          activeActionId={activeActionId}
          activeThreadId={activeThreadId}
          activeWorkspaceId={activeWorkspaceId}
          activityRailExpanded={activityRailExpanded}
          changesActive={changesActive}
          panelScope={panelScope}
          panelScopeId={panelScopeId}
          previewActive={previewActive}
          renderedActiveTab={renderedActiveTab}
          renderedOpenTabs={renderedOpenTabs}
          renderedTabInstances={renderedTabInstances}
          terminalActive={terminalActive}
          warmPreviewScopes={warmPreviewScopes}
          onCreateTab={handleCreateTab}
        />
      </div>
    </RightPanelFrame>
  );
}
