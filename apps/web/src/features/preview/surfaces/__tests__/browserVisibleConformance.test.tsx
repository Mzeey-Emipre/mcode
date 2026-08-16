import { act, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { ReactElement, ReactNode } from "react";
import {
  BROWSER_AUTOMATION_CONTRACT_VERSION,
  BrowserAutomationResponseSchema,
  projectBrowserNarrativeResult,
  type BrowserTabSet,
  type BrowserAutomationControllerState,
  type BrowserAutomationResponse,
} from "@mcode/contracts";
import {
  createBrowserConformanceResourceSnapshot,
  createBrowserConformanceScenario,
  normalizeBrowserConformanceRun,
} from "@mcode/browser-conformance";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { TooltipProvider } from "@/components/ui/tooltip";
import { buildPersistedNarrativeItems } from "@/features/conversation/narrative/build-persisted-narrative";
import { ToolSummaryLine } from "@/features/conversation/narrative/ToolSummaryLine";
import type { ToolCall, ToolCallRecord } from "@/transport/types";
import { BrowserHeader, type BrowserHeaderProps } from "../BrowserHeader";
import { BrowserViewportToolbar } from "../BrowserViewportToolbar";
import { ThreadOverview } from "@/components/chat/ThreadOverview";
import type { Thread } from "@/transport";
import {
  browserAutomationTargetKey,
  releaseBrowserAutomationThreadScope,
  useBrowserAutomationStore,
} from "../../automation/browserAutomationStore";
import { previewTabsScopeKey, usePreviewTabsStore } from "../../state/previewTabsStore";
import { browserTargetRegistry } from "../../automation/services/browserTargetRegistry";
import {
  ViewportCoordinator,
  type ViewportHostOperation,
} from "../../automation/services/viewportCoordinator";
import type { BrowserSessionLifecycleTab } from "../../automation/services/browserSessionDriver";

const {
  mockThreadRecords,
  mockWorkspaceState,
} = vi.hoisted(() => ({
  mockThreadRecords: new Map(),
  mockWorkspaceState: {
    workspaces: [{ id: "workspace-visible", path: "/repo" }],
    threads: [] as Thread[],
    prUrlsByThreadId: {},
    checksById: {},
    openPrs: [],
    worktreesLoadedForWorkspace: "workspace-visible",
  },
}));

vi.mock("@/transport", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/transport")>();
  return {
    ...actual,
    getTransport: () => ({
      createBranch: vi.fn(),
      listSnapshots: vi.fn().mockResolvedValue([]),
      getWorkingTreeFiles: vi.fn().mockResolvedValue([]),
      getBranchComparison: vi.fn().mockResolvedValue(null),
      getRemoteUrl: vi.fn().mockResolvedValue({ label: "repo", webUrl: null }),
    }),
  };
});

vi.mock("@/stores/workspaceStore", () => {
  const store = Object.assign(
    vi.fn((selector: (state: typeof mockWorkspaceState) => unknown) => selector(mockWorkspaceState)),
    { getState: vi.fn(() => mockWorkspaceState), setState: vi.fn() },
  );
  return { useWorkspaceStore: store };
});

vi.mock("@/stores/threadStore", () => ({
  useThreadStore: vi.fn((selector: (state: { records: Map<string, unknown>; fetchProviderUsage: () => void }) => unknown) =>
    selector({ records: mockThreadRecords, fetchProviderUsage: vi.fn() })),
}));

vi.mock("@/hooks/usePullRequestReviewLink", () => ({ usePullRequestReviewLink: vi.fn().mockReturnValue(null) }));
vi.mock("@/hooks/useThreadGitActions", () => ({
  useThreadGitActions: vi.fn().mockReturnValue({
    prable: false,
    pr: null,
    hasCommitsAhead: null,
    checks: null,
    openPrDetail: vi.fn(),
    dirPath: null,
    createPrOpen: false,
    setCreatePrOpen: vi.fn(),
    handleCommitOrPush: vi.fn(),
    handleOpenPr: vi.fn(),
  }),
}));
vi.mock("@/features/subagents", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/features/subagents")>()),
  openSubagentsPanel: vi.fn(),
}));
vi.mock("@/stores/composerDraftStore", () => ({
  useComposerDraftStore: vi.fn((selector: (state: { setPendingPrefill: () => void }) => unknown) =>
    selector({ setPendingPrefill: vi.fn() })),
}));
vi.mock("@/stores/diffStore", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/stores/diffStore")>();
  const state = {
    snapshotsByThread: {},
    diffRevisionByScope: {},
    getRightPanelVisible: vi.fn().mockReturnValue(false),
    getRightPanel: vi.fn().mockReturnValue({ width: 380 }),
    setSnapshots: vi.fn(),
  };
  const selector = vi.fn((select: (value: typeof state) => unknown) => select(state));
  Object.assign(selector, actual.useDiffStore);
  return { ...actual, useDiffStore: selector };
});
vi.mock("@/components/ui/popover", async () => {
  const React = await vi.importActual<typeof import("react")>("react");
  const PopoverContext = React.createContext<{
    open: boolean;
    onOpenChange: (open: boolean) => void;
  }>({
    open: false,
    onOpenChange: (_open: boolean) => undefined,
  });

  return {
    Popover: ({
      children,
      open = false,
      onOpenChange = () => undefined,
    }: {
      children: ReactNode;
      open?: boolean;
      onOpenChange?: (open: boolean) => void;
    }) => (
      <PopoverContext.Provider value={{ open, onOpenChange }}>
        <div>{children}</div>
      </PopoverContext.Provider>
    ),
    PopoverTrigger: ({ render }: { render: ReactElement }) => {
      const { open, onOpenChange } = React.useContext(PopoverContext);
      return React.cloneElement(render as ReactElement<Record<string, unknown>>, {
        "aria-expanded": open,
        onClick: () => onOpenChange(!open),
      });
    },
    PopoverContent: ({ children }: { children: ReactNode }) => {
      const { open } = React.useContext(PopoverContext);
      return open ? <div>{children}</div> : null;
    },
  };
});
vi.mock("@/components/ui/dialog", () => ({
  Dialog: ({ open, children }: { open?: boolean; children: ReactNode }) => open ? <div>{children}</div> : null,
  DialogContent: ({ children }: { children: ReactNode }) => <div>{children}</div>,
  DialogDescription: ({ children }: { children: ReactNode }) => <p>{children}</p>,
  DialogFooter: ({ children }: { children: ReactNode }) => <div>{children}</div>,
  DialogTitle: ({ children }: { children: ReactNode }) => <h2>{children}</h2>,
}));

const THREAD_ID = "thread-visible-conformance";
const TAB_ID = "tab-visible-conformance";
const WORKSPACE_ID = "workspace-visible";
const TARGET_KEY = browserAutomationTargetKey(WORKSPACE_ID, THREAD_ID, TAB_ID);

const visibleScenario = createBrowserConformanceScenario({
  id: "visible-browser-surfaces",
  seed: "visible-browser-surfaces",
  commands: [
    {
      id: "act-checkout",
      operation: "act",
      args: {
        steps: [
          { operation: "click", target: { accessibleName: "Pay" } },
          { operation: "type", target: { accessibleName: "Card number" }, text: "redacted" },
          { operation: "press" },
        ],
      },
    },
    { id: "tabs-background", operation: "tabs", args: { scope: "thread" } },
    { id: "open-background", operation: "open", args: { target: "browser-tab" } },
    { id: "resize-viewport", operation: "resize", args: { width: 852, height: 393 } },
  ],
  cleanup: { baseline: createBrowserConformanceResourceSnapshot() },
});

type VisibleStepOperation = "click" | "type" | "press";

function scenarioCommand(id: string) {
  const command = visibleScenario.commands.find((candidate) => candidate.id === id);
  if (!command) throw new Error(`Missing visible Browser scenario command: ${id}`);
  return command;
}

function scenarioActSteps(): readonly {
  readonly operation: VisibleStepOperation;
  readonly target?: Readonly<Record<string, string>>;
  readonly text?: string;
}[] {
  const steps = scenarioCommand("act-checkout").args?.steps;
  if (!Array.isArray(steps)) throw new Error("Visible Browser scenario act steps are missing");
  return steps as readonly {
    readonly operation: VisibleStepOperation;
    readonly target?: Readonly<Record<string, string>>;
    readonly text?: string;
  }[];
}

const COMPLETED_ACTION_LABELS: Record<VisibleStepOperation, string> = {
  click: "Clicked the page",
  type: "Entered text",
  press: "Pressed a key",
};

function completedActionLabel(operation: VisibleStepOperation): string {
  return COMPLETED_ACTION_LABELS[operation];
}

function visibleThread(): Thread {
  return {
    id: THREAD_ID,
    workspace_id: "workspace-visible",
    title: "Visible Browser",
    status: "active",
    mode: "worktree",
    worktree_path: "/repo/.worktrees/visible-browser",
    branch: "main",
    checkout_state: "branchless",
    base_branch: "main",
    worktree_managed: true,
    issue_number: null,
    pr_number: null,
    pr_status: null,
    sdk_session_id: null,
    created_at: "2026-08-05T10:00:00Z",
    updated_at: "2026-08-05T10:00:00Z",
    model: null,
    provider: "claude",
    deleted_at: null,
    user_completed_at: null,
    scheduled_deletion_at: null,
    cleanup_state: null,
    cleanup_reason: null,
    last_context_tokens: null,
    context_window: null,
    reasoning_level: null,
    interaction_mode: null,
    orchestration_mode: null,
    permission_mode: null,
    context_window_mode: null,
    thinking: null,
    codex_fast_mode: null,
    copilot_agent: null,
    default_open_in_app: null,
    parent_thread_id: null,
    forked_from_message_id: null,
    last_compact_summary: null,
    has_file_changes: false,
  };
}

function headerProps(overrides: Partial<BrowserHeaderProps> = {}): BrowserHeaderProps {
  return {
    url: "https://example.test/checkout?token=redacted",
    pageTitle: "Checkout",
    faviconUrl: null,
    hasLoadedPage: true,
    canBack: false,
    canFwd: false,
    threadId: THREAD_ID,
    designModeActive: false,
    elementPickBusy: false,
    captureBusy: false,
    regionBusy: false,
    onNavigate: vi.fn(),
    onGoBack: vi.fn(),
    onGoForward: vi.fn(),
    onReload: vi.fn(),
    onOpenExternal: vi.fn(),
    onToggleDesign: vi.fn(),
    onScreenshot: vi.fn(),
    onNewPage: vi.fn(),
    onForceReload: vi.fn(),
    onRegionCapture: vi.fn(),
    onDumpContent: vi.fn(),
    onClearCookies: vi.fn(),
    onClearCache: vi.fn(),
    onGetZoom: vi.fn().mockResolvedValue(1),
    onSetZoom: vi.fn().mockResolvedValue(1),
    ...overrides,
  };
}

function VisibleBrowserHeader({ onStopAutomation }: { readonly onStopAutomation?: () => void }) {
  const controller = useBrowserAutomationStore((state) => state.controllers.get(TARGET_KEY) ?? null);
  const activeRequest = useBrowserAutomationStore((state) => state.activeRequests.size > 0);
  return (
    <TooltipProvider>
      <BrowserHeader
        {...headerProps()}
        automationController={controller}
        automationBusy={activeRequest}
        onStopAutomation={onStopAutomation}
      />
    </TooltipProvider>
  );
}

function visibleBrowserRun() {
  const urlInput = screen.getByRole("textbox", { name: "Preview URL" }) as HTMLInputElement;
  const menu = screen.queryByTestId("browser-overflow-menu");
  const ownsBrowser = menu
    ? Boolean(within(menu).queryByRole("menuitem", { name: "Take control" }))
    : false;
  const controlOwner = ownsBrowser ? "agent" : "none";
  const currentUrl = urlInput.getAttribute("title");
  return normalizeBrowserConformanceRun({
    outcome: { status: "completed", effect: "none", recovery: "none", ownership: controlOwner },
    finalState: {
      readiness: "ready",
      controlOwner,
      tabCount: 1,
      currentUrl,
      resources: createBrowserConformanceResourceSnapshot(),
    },
    visibleObservations: [{
      surface: "browser",
      readiness: "ready",
      controlOwner,
      tabCount: 1,
      currentUrl,
      title: urlInput.value,
      action: null,
      truncated: false,
    }],
  });
}

function browserCall(output: string, isError = false): ToolCall {
  return {
    id: "browser-visible-conformance",
    toolName: "mcp__mcode-browser__browser_act",
    toolInput: {
      operation: scenarioCommand("act-checkout").operation,
      steps: scenarioActSteps(),
    },
    output,
    isError,
    isComplete: true,
    isCancelled: false,
  };
}

function browserRecord(output: string, status: ToolCallRecord["status"] = "failed"): ToolCallRecord {
  return {
    id: "browser-visible-persisted",
    message_id: "message-visible-persisted",
    parent_tool_call_id: null,
    tool_name: "mcp__mcode-browser__browser_act",
    input_summary: JSON.stringify({
      operation: scenarioCommand("act-checkout").operation,
      steps: scenarioActSteps(),
    }),
    output_summary: output,
    status,
    started_at: "2026-08-05T10:00:00Z",
    completed_at: "2026-08-05T10:00:01Z",
    sort_order: 1,
  };
}

function parsedResponse(response: BrowserAutomationResponse): Record<string, unknown> {
  if (response.ok) return response.result as unknown as Record<string, unknown>;
  return response.error as unknown as Record<string, unknown>;
}

function interruptedResponse(): BrowserAutomationResponse {
  const steps = scenarioActSteps();
  return BrowserAutomationResponseSchema().parse({
    contractVersion: BROWSER_AUTOMATION_CONTRACT_VERSION,
    requestId: "visible-interrupted",
    sequence: 1,
    ok: true,
    result: {
      operation: "act",
      outcome: "interrupted",
      stoppingPosition: 1,
      effect: "partial",
      recovery: "yield_to_user",
      receipts: steps.map((step, index) => ({
        index,
        operation: step.operation,
        status: index === 0 ? "applied" : index === 1 ? "interrupted" : "skipped",
      })),
      finalObservation: {
        observationRef: "observation-interrupted",
        hostRevision: 1,
        documentRevision: 1,
        controlRevision: 1,
        capabilityRevision: 1,
        observationRevision: 1,
      },
    },
  });
}

function timeoutResponse(): BrowserAutomationResponse {
  return BrowserAutomationResponseSchema().parse({
    contractVersion: BROWSER_AUTOMATION_CONTRACT_VERSION,
    requestId: "visible-timeout",
    sequence: 2,
    ok: false,
    error: {
      code: "TIMEOUT",
      message: "Browser action timed out",
      retryable: true,
      stage: "effect",
      effect: "none",
      recovery: "inspect",
      correlationId: "correlation-timeout",
    },
  });
}

describe("visible Browser conformance observer", () => {
  beforeEach(() => {
    browserTargetRegistry.clear();
    mockThreadRecords.clear();
    mockWorkspaceState.threads = [visibleThread()];
    useBrowserAutomationStore.setState({
      registered: false,
      status: "unavailable",
      liveTargets: new Map(),
      controllers: new Map(),
      activeRequests: new Map(),
      pendingAgentOpens: new Map(),
      lifecycleTabs: new Map(),
      viewportByTarget: new Map(),
      viewportStateByTarget: new Map(),
      viewportCoordinators: new Map(),
      hostedScopeIds: new Set(),
    });
    usePreviewTabsStore.setState({
      tabSetByScope: {},
      liveChromeByScope: {},
      persistentTabIdsByScope: {},
    });
  });

  afterEach(() => {
    browserTargetRegistry.clear();
    useBrowserAutomationStore.getState().unregisterTarget(WORKSPACE_ID, THREAD_ID, TAB_ID);
  });

  it("observes agent ownership through the accessible Browser takeover control", async () => {
    const user = userEvent.setup();
    useBrowserAutomationStore.getState().registerTarget(WORKSPACE_ID, THREAD_ID, TAB_ID);
    useBrowserAutomationStore.getState().setControllerForTarget(WORKSPACE_ID, THREAD_ID, TAB_ID, {
      tabId: TAB_ID,
      controller: "agent",
      controlEpoch: 4,
      providerSessionId: "provider-visible",
      operation: "click",
    } satisfies BrowserAutomationControllerState);
    expect(useBrowserAutomationStore.getState().controllers.get(TARGET_KEY)?.controller).toBe("agent");
    const onStopAutomation = vi.fn();
    render(<VisibleBrowserHeader onStopAutomation={onStopAutomation} />);

    await user.click(screen.getByRole("button", { name: "More browser tools" }));
    const takeover = await screen.findByRole("menuitem", { name: "Take control" });
    expect(takeover).toBeInTheDocument();
    const agentRun = visibleBrowserRun();
    expect(agentRun.visibleObservations[0]).toMatchObject({
      surface: "browser",
      controlOwner: "agent",
      currentUrl: "https://example.test/checkout",
      title: "Checkout",
    });
    expect(agentRun.outcome.status).toBe("completed");
    expect(agentRun.outcome.status).not.toBe("unknown");

    await user.click(takeover);
    expect(onStopAutomation).toHaveBeenCalledOnce();
    await act(async () => {
      useBrowserAutomationStore.getState().setControllerForTarget(WORKSPACE_ID, THREAD_ID, TAB_ID, {
        tabId: TAB_ID,
        controller: "none",
        controlEpoch: 5,
      });
      await Promise.resolve();
    });
    await user.click(screen.getByRole("button", { name: "More browser tools" }));
    expect(screen.queryByRole("menuitem", { name: "Take control" })).not.toBeInTheDocument();
    expect(visibleBrowserRun().visibleObservations[0]?.controlOwner).toBe("none");
  });

  it("preserves partial receipts and the interrupted terminal meaning in narrative rows", () => {
    const response = interruptedResponse();
    const result = parsedResponse(response);
    const projected = projectBrowserNarrativeResult(
      "mcp__mcode-browser__browser_act",
      JSON.stringify(result),
      false,
    );
    expect(projected).not.toBeNull();
    expect(projected?.outcome).toBe("interrupted");
    expect(projected?.receipts?.map((receipt) => receipt.status)).toEqual([
      "applied",
      "interrupted",
      "skipped",
    ]);

    const normalizedReceipts = projected?.receipts?.map((receipt, index) => ({
      ...receipt,
      order: { tick: index, ordinal: index },
      commandId: `visible-step-${index}`,
      effect: receipt.status === "applied" ? "complete" : "partial",
      recovery: receipt.status === "interrupted" ? "yield_to_user" : "none",
      truncated: false,
      revisions: { host: 1, document: 1, control: 1, capability: 1, observation: index + 1 },
      errorStage: "effect",
      ownership: "user",
    }));
    const normalized = normalizeBrowserConformanceRun({
      receipts: normalizedReceipts,
      outcome: {
        ...projected,
        effect: "partial",
        recovery: "yield_to_user",
        truncated: false,
        revisions: { host: 1, document: 1, control: 1, capability: 1, observation: 1 },
        errorStage: "effect",
        ownership: "user",
      },
      finalState: { readiness: "human-control", controlOwner: "user", tabCount: 1 },
      visibleObservations: [{
        surface: "narrative",
        readiness: "human-control",
        controlOwner: "user",
        tabCount: 1,
        action: "act",
      }],
    });
    expect(normalized.outcome).toMatchObject({
      status: "interrupted",
      effect: "partial",
      recovery: "yield_to_user",
      ownership: "user",
      errorStage: "effect",
    });
    expect(normalized.receipts.every((receipt) =>
      receipt.status !== "unknown" &&
      receipt.effect !== "unknown" &&
      receipt.recovery !== "unknown" &&
      receipt.errorStage !== "unknown" &&
      receipt.ownership === "user",
    )).toBe(true);

    render(
      <ToolSummaryLine
        group={{ calls: [browserCall(JSON.stringify(result))] }}
        hasError={false}
        hasCancelled
      />,
    );
    const user = userEvent.setup();
    const steps = scenarioActSteps();
    return user.click(screen.getByRole("button", { name: "Used the browser" })).then(async () => {
      expect(screen.getByRole("button", { name: completedActionLabel(steps[0]!.operation) })).toBeInTheDocument();
      expect(screen.getByRole("button", { name: "Stopped when you took control" })).toBeInTheDocument();
      expect(screen.getByRole("button", { name: `Skipped action ${steps.length} of ${steps.length}` })).toBeInTheDocument();
      await user.click(screen.getByRole("button", { name: "Stopped when you took control" }));
      await waitFor(() => expect(screen.getByText(/Status: interrupted/)).toBeInTheDocument());
    });
  });

  it("renders a failed persisted Browser outcome with explicit terminal meaning", async () => {
    const response = timeoutResponse();
    const result = parsedResponse(response);
    const projected = projectBrowserNarrativeResult(
      "mcp__mcode-browser__browser_act",
      JSON.stringify(result),
      true,
    );
    expect(projected).toMatchObject({ outcome: "failed", errorCode: "TIMEOUT" });
    const normalized = normalizeBrowserConformanceRun({
      outcome: {
        ...projected,
        effect: "none",
        recovery: "inspect",
        truncated: false,
        revisions: { host: 1, document: 1, control: 1, capability: 1, observation: 1 },
        errorStage: "effect",
        ownership: "agent",
      },
      finalState: { readiness: "ready", controlOwner: "agent", tabCount: 1 },
    });
    expect(normalized.outcome).toMatchObject({
      status: "failed",
      effect: "none",
      recovery: "inspect",
      errorCode: "TIMEOUT",
      errorStage: "effect",
      ownership: "agent",
    });
    expect(normalized.outcome.status).not.toBe("unknown");

    const user = userEvent.setup();
    const items = buildPersistedNarrativeItems({
      tools: [browserRecord(JSON.stringify(result))],
      thoughts: [],
      hooks: [],
    });
    expect(items[0]?.type).toBe("tool-group");
    if (items[0]?.type !== "tool-group") return;
    render(<ToolSummaryLine group={items[0].group} hasError hasCancelled={false} />);
    await user.click(screen.getByRole("button", { name: "Used the browser" }));
    expect(screen.getByText("Browser action timed out")).toBeInTheDocument();
  });

  it("observes the background Browser row, agent cue, and exact open target", async () => {
    const tabSet: BrowserTabSet = {
      threadId: THREAD_ID,
      activeTabId: TAB_ID,
      tabs: [{
        id: TAB_ID,
        threadId: THREAD_ID,
        title: "Checkout",
        url: "https://example.test/checkout?token=redacted",
        faviconUrl: null,
        warm: true,
        active: true,
      }],
    };
    const lifecycle: BrowserSessionLifecycleTab = {
      workspaceId: "workspace-visible",
      threadId: THREAD_ID,
      tabId: TAB_ID,
      providerSessionId: "provider-visible",
      providerInstanceId: "instance-visible",
      provenance: "agent-created",
      ownership: "owned",
      target: {
        desktopInstanceId: "desktop-visible",
        windowId: 1,
        connectionGeneration: 1,
        threadId: THREAD_ID,
        tabId: TAB_ID,
        targetGeneration: 1,
        active: true,
        focused: false,
        lastUsedAt: 1,
        controller: { tabId: TAB_ID, controller: "agent", controlEpoch: 1 },
      },
    };
    useBrowserAutomationStore.setState({
      registered: true,
      status: "registered",
      liveTargets: new Map([[
        TARGET_KEY,
        {
          workspaceId: "workspace-visible",
          threadId: THREAD_ID,
          tabId: TAB_ID,
          revision: 1,
          lastUsedAt: 1,
        },
      ]]),
      lifecycleTabs: new Map([["lifecycle-visible", lifecycle]]),
      controllers: new Map([[TARGET_KEY, { tabId: TAB_ID, controller: "agent", controlEpoch: 1 }]]),
    });
    usePreviewTabsStore.setState({
      tabSetByScope: { [previewTabsScopeKey("workspace-visible", THREAD_ID)]: tabSet },
      liveChromeByScope: {},
      persistentTabIdsByScope: {},
    });
    const activatePage = vi.spyOn(usePreviewTabsStore.getState(), "activatePage");
    render(<ThreadOverview thread={visibleThread()} threadPaneWidth={1_400} />);

    const row = await screen.findByRole("button", {
      name: /Browser, Checkout, https:\/\/example\.test\/checkout\?token=redacted, agent controls/,
    });
    expect(row).toHaveAccessibleName(expect.stringContaining("agent controls"));
    expect(screen.getByText("Browser")).toBeInTheDocument();
    expect(screen.getByTestId(`thread-overview-browser-address-${TAB_ID}`)).toHaveTextContent(
      "https://example.test/checkout?token=redacted",
    );
    expect(row.querySelector('[data-testid="thread-overview-browser-agent-cursor"]')).toBeInTheDocument();

    const normalized = normalizeBrowserConformanceRun({
      outcome: {
        status: "completed",
        effect: "none",
        recovery: "none",
        revisions: { observation: 1 },
        ownership: "agent",
      },
      finalState: {
        readiness: "ready",
        controlOwner: "agent",
        tabCount: 1,
        currentUrl: tabSet.tabs[0]?.url ?? null,
        revisions: { observation: 1 },
        resources: createBrowserConformanceResourceSnapshot({ counts: { targets: 1 } }),
      },
      visibleObservations: [{
        surface: "thread-overview",
        readiness: "ready",
        controlOwner: "agent",
        tabCount: 1,
        currentUrl: tabSet.tabs[0]?.url ?? null,
        title: tabSet.tabs[0]?.title ?? null,
        action: scenarioCommand("open-background").operation,
        truncated: false,
      }],
    });
    expect(normalized.visibleObservations[0]).toMatchObject({
      surface: "thread-overview",
      controlOwner: "agent",
      currentUrl: "https://example.test/checkout",
      title: "Checkout",
      action: scenarioCommand("open-background").operation,
    });
    expect(normalized.outcome.status).not.toBe("unknown");
    expect(normalized.finalState.readiness).not.toBe("unknown");

    await userEvent.setup().click(row);
    expect(activatePage).toHaveBeenCalledWith(WORKSPACE_ID, THREAD_ID, TAB_ID);
  });

  it("shows a restored mounted Browser tab before Overview opens and follows later tab updates", async () => {
    let hostTabSet: BrowserTabSet = {
      threadId: THREAD_ID,
      activeTabId: TAB_ID,
      tabs: [{
        id: TAB_ID,
        threadId: THREAD_ID,
        title: "Restored page",
        url: "https://example.test/restored",
        faviconUrl: null,
        warm: true,
        active: true,
      }],
    };
    let onTabsUpdated: ((tabSet: BrowserTabSet) => void) | null = null;
    const list = vi.fn(async () => ({ ok: true as const, data: hostTabSet }));
    const originalDesktopBridge = window.desktopBridge;
    Object.defineProperty(window, "desktopBridge", {
      configurable: true,
      writable: true,
      value: {
        preview: {
          tabs: {
            list,
            onUpdated: vi.fn((listener: (tabSet: BrowserTabSet) => void) => {
              onTabsUpdated = listener;
              return vi.fn();
            }),
          },
        },
      },
    });

    try {
      useBrowserAutomationStore.setState({ registered: true, status: "registered" });
      useBrowserAutomationStore.getState().registerTarget(WORKSPACE_ID, THREAD_ID, TAB_ID);

      const firstOverview = render(
        <ThreadOverview thread={visibleThread()} threadPaneWidth={500} />,
      );

      expect(screen.queryByTestId("thread-overview-browser")).not.toBeInTheDocument();
      expect(await screen.findByRole("button", { name: "Thread overview" })).toHaveAttribute(
        "aria-expanded",
        "false",
      );
      await userEvent.click(screen.getByRole("button", { name: "Thread overview" }));
      expect(await screen.findByRole("button", {
        name: "Browser, Restored page, https://example.test/restored",
      })).toBeInTheDocument();
      expect(list).toHaveBeenCalledWith(THREAD_ID, WORKSPACE_ID);

      hostTabSet = {
        ...hostTabSet,
        tabs: [{
          ...hostTabSet.tabs[0]!,
          title: "Loaded page",
          url: "https://example.test/loaded?view=full",
          faviconUrl: "https://example.test/favicon.ico",
        }],
      };
      act(() => onTabsUpdated?.(hostTabSet));

      const loadedRow = await screen.findByRole("button", {
        name: "Browser, Loaded page, https://example.test/loaded?view=full",
      });
      expect(loadedRow.querySelector('img[src="https://example.test/favicon.ico"]')).toBeInTheDocument();
      expect(screen.getByTestId(`thread-overview-browser-address-${TAB_ID}`)).toHaveTextContent(
        "https://example.test/loaded?view=full",
      );

      firstOverview.unmount();
      usePreviewTabsStore.setState({ tabSetByScope: {}, liveChromeByScope: {} });
      render(<ThreadOverview thread={visibleThread()} threadPaneWidth={500} />);

      expect(screen.queryByTestId("thread-overview-browser")).not.toBeInTheDocument();
      await userEvent.click(screen.getByRole("button", { name: "Thread overview" }));
      expect(await screen.findByRole("button", {
        name: "Browser, Loaded page, https://example.test/loaded?view=full",
      })).toBeInTheDocument();
    } finally {
      Object.defineProperty(window, "desktopBridge", {
        configurable: true,
        writable: true,
        value: originalDesktopBridge,
      });
    }
  });

  it("observes viewport preset, orientation, and fit/actual presentation through public controls", async () => {
    const user = userEvent.setup();
    const apply = vi.fn(async (operation: ViewportHostOperation) => ({
      status: "applied" as const,
      applied: operation.requested,
    }));
    const coordinator = new ViewportCoordinator({
      initial: { width: 1_280, height: 800 },
      targetGeneration: 1,
      apply,
    });
    const { rerender } = render(
      <BrowserViewportToolbar
        coordinator={coordinator}
        state={coordinator.snapshot()}
        onClose={vi.fn()}
      />,
    );

    expect(screen.getByLabelText("Browser viewport controls")).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Viewport preset" }));
    await user.click(await screen.findByText("iPhone 15 Pro"));
    await waitFor(() => expect(apply).toHaveBeenCalledWith(
      expect.objectContaining({ requested: { width: 393, height: 852 } }),
    ));
    rerender(
      <BrowserViewportToolbar
        coordinator={coordinator}
        state={coordinator.snapshot()}
        onClose={vi.fn()}
      />,
    );
    expect(screen.getByRole("button", { name: "Viewport preset" })).toHaveTextContent("iPhone 15 Pro");
    expect(screen.getByRole("textbox", { name: "Viewport width" })).toHaveValue("393");
    expect(screen.getByRole("textbox", { name: "Viewport height" })).toHaveValue("852");

    await user.click(screen.getByRole("button", { name: "Rotate viewport to landscape" }));
    await waitFor(() => expect(apply).toHaveBeenLastCalledWith(
      expect.objectContaining({ requested: { width: 852, height: 393 } }),
    ));
    rerender(
      <BrowserViewportToolbar
        coordinator={coordinator}
        state={coordinator.snapshot()}
        onClose={vi.fn()}
      />,
    );
    expect(screen.getByRole("button", { name: "Rotate viewport to portrait" })).toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: "Viewport scale and presentation" }));
    await user.click(within(await screen.findByRole("menu")).getByRole("menuitem", { name: "Actual size" }));
    expect(coordinator.snapshot().presentation).toBe("actual");
    await user.click(screen.getByRole("button", { name: "Viewport scale and presentation" }));
    await user.click(within(await screen.findByRole("menu")).getByRole("menuitem", { name: "Fit to panel" }));
    expect(coordinator.snapshot().presentation).toBe("fit");

    const normalized = normalizeBrowserConformanceRun({
      outcome: {
        status: "completed",
        effect: "complete",
        recovery: "none",
        revisions: { observation: 3 },
        ownership: "user",
      },
      finalState: {
        readiness: "ready",
        controlOwner: "user",
        tabCount: 1,
        currentUrl: null,
        revisions: { observation: 3 },
        resources: createBrowserConformanceResourceSnapshot(),
      },
      visibleObservations: [{
        surface: "browser",
        readiness: "ready",
        controlOwner: "user",
        tabCount: 1,
        currentUrl: null,
        title: "iPhone 15 Pro · 852 × 393 · Fit to panel",
        action: scenarioCommand("resize-viewport").operation,
        truncated: false,
      }],
    });
    expect(normalized.visibleObservations[0]).toMatchObject({
      action: scenarioCommand("resize-viewport").operation,
      title: "iPhone 15 Pro · 852 × 393 · Fit to panel",
    });
    expect(normalized.outcome.status).not.toBe("unknown");
  });

  it("does not resurrect visible ownership after scope cleanup and a late controller event", async () => {
    const user = userEvent.setup();
    useBrowserAutomationStore.getState().registerTarget(WORKSPACE_ID, THREAD_ID, TAB_ID);
    useBrowserAutomationStore.getState().setControllerForTarget(WORKSPACE_ID, THREAD_ID, TAB_ID, {
      tabId: TAB_ID,
      controller: "agent",
      controlEpoch: 7,
    });
    render(<VisibleBrowserHeader onStopAutomation={vi.fn()} />);
    await user.click(screen.getByRole("button", { name: "More browser tools" }));
    expect(await screen.findByRole("menuitem", { name: "Take control" })).toBeInTheDocument();

    act(() => {
      releaseBrowserAutomationThreadScope(WORKSPACE_ID, THREAD_ID);
      useBrowserAutomationStore.getState().setControllerForTarget(WORKSPACE_ID, THREAD_ID, TAB_ID, {
        tabId: TAB_ID,
        controller: "agent",
        controlEpoch: 8,
      });
    });

    await waitFor(() => {
      expect(useBrowserAutomationStore.getState().liveTargets.size).toBe(0);
      expect(useBrowserAutomationStore.getState().controllers.size).toBe(0);
      expect(screen.queryByRole("menuitem", { name: "Take control" })).not.toBeInTheDocument();
    });
    expect(browserTargetRegistry.get(WORKSPACE_ID, THREAD_ID, TAB_ID)).toBeNull();
  });
});
