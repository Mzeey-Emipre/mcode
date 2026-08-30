import type {
  BrowserAutomationHostDispatch,
  BrowserAutomationHostDispatchTarget,
  BrowserAutomationOwnedTab,
  BrowserAutomationResponse,
  BrowserAutomationActStep,
  BrowserAutomationEvaluateResult,
  BrowserAutomationResult,
  BrowserAutomationErrorCode,
  BrowserAutomationOperation,
  BrowserAutomationHostRuntime,
} from "@mcode/contracts";
import {
  BROWSER_AUTOMATION_HOST_OPERATIONS,
  BROWSER_AUTOMATION_MAX_EXPRESSION_BYTES,
  BROWSER_AUTOMATION_OPERATIONS,
} from "@mcode/contracts";
import { BROWSER_AUTOMATION_MAX_INSPECT_TABS as MAX_LIFECYCLE_TABS } from "@mcode/contracts";

const MAX_IDEMPOTENCY_RECORDS = 256;
const IDEMPOTENCY_TTL_MS = 30 * 60_000;
const SECRET_TEXT = /\b(password|token|secret|authorization|cookie|credential|session|api[_-]?key)\b\s*[:=]\s*[^,;\s]+/gi;
const CONTROL_TAKING_OPERATIONS = new Set([
  "navigate",
  "resize",
  "click",
  "type",
  "press",
  "scroll",
  "evaluate",
  "back",
  "forward",
  "reload",
  "hover",
  "drag",
]);

const WEB_RUNTIME_OPERATIONS = [
  "inspect",
  "act",
  "tabs",
  "status",
  "open",
  "navigate",
  "snapshot",
  "screenshot",
  "click",
  "type",
] as const satisfies readonly BrowserAutomationOperation[];
const WEB_RUNTIME_ACT_OPERATIONS = ["navigate", "click", "type"] as const satisfies readonly BrowserAutomationActStep["operation"][];
const ELECTRON_RUNTIME_ACT_OPERATIONS = [
  "navigate",
  "back",
  "forward",
  "reload",
  "wait",
  "click",
  "type",
  "press",
  "scroll",
] as const satisfies readonly BrowserAutomationActStep["operation"][];

function observationTargetKey(workspaceId: string, threadId: string, tabId: string): string {
  return JSON.stringify([workspaceId, threadId, tabId]);
}

/** Options that affect the operations a runtime can truthfully advertise. */
export interface BrowserAutomationRuntimeOperationOptions {
  readonly recordingAvailable?: boolean;
}

/** Returns the one operation set shared by runtime descriptors, status, and registration. */
export function getBrowserAutomationRuntimeOperations(
  runtime: BrowserAutomationHostRuntime,
  options: BrowserAutomationRuntimeOperationOptions = {},
): readonly BrowserAutomationOperation[] {
  if (runtime === "web") return WEB_RUNTIME_OPERATIONS;
  const recordingAvailable = options.recordingAvailable ?? true;
  return Array.from(new Set([
    ...BROWSER_AUTOMATION_OPERATIONS,
    ...BROWSER_AUTOMATION_HOST_OPERATIONS.filter((operation) =>
      recordingAvailable || (operation !== "recordingStart" && operation !== "recordingStop"),
    ),
  ]));
}

/** Returns the act-step mechanics supported by the selected Browser runtime. */
export function getBrowserAutomationRuntimeActOperations(
  runtime: BrowserAutomationHostRuntime,
): readonly BrowserAutomationActStep["operation"][] {
  return runtime === "web" ? WEB_RUNTIME_ACT_OPERATIONS : ELECTRON_RUNTIME_ACT_OPERATIONS;
}

function sanitizePublicDetail(value: unknown): string {
  return String(value ?? "")
    .replace(/https?:\/\/[^\s"']+/gi, "[URL]")
    .replace(SECRET_TEXT, "$1=[REDACTED]")
    .slice(0, 256);
}

type OpenDispatch = BrowserAutomationHostDispatch & {
  request: Extract<BrowserAutomationHostDispatch["request"], { operation: "open" }>;
};

interface IdempotencyRecord {
  readonly fingerprint: string;
  readonly target: { workspaceId: string; threadId: string; tabId: string; windowId: number; targetGeneration: number };
  lastUsedAt: number;
  readonly promise: Promise<BrowserAutomationResponse>;
}

interface ObservationRecord {
  readonly hostRevision: number;
  readonly documentRevision: number;
  readonly controlRevision: number;
  readonly capabilityRevision: number;
  readonly humanInteractionRevision: number;
  readonly targetKey: string;
  readonly workspaceId: string;
  readonly threadId: string;
  readonly providerSessionId: string;
  readonly providerInstanceId: string;
  observationRevision: number;
  readonly targets: ReadonlyMap<string, BrowserAutomationHostDispatchTarget>;
}

interface TabReplayRecord {
  readonly fingerprint: string;
  readonly target: { workspaceId: string; threadId: string; tabId: string };
  lastUsedAt: number;
  readonly promise: Promise<BrowserAutomationResponse>;
}

interface ControlledTab extends BrowserAutomationOwnedTab {
  target: BrowserAutomationHostDispatchTarget;
}

interface ProviderTabSession {
  readonly workspaceId: string;
  readonly providerSessionId: string;
  readonly providerInstanceId: string;
  lastDispatch: BrowserAutomationHostDispatch;
  current: BrowserAutomationHostDispatchTarget | null;
  readonly tabs: Map<string, ControlledTab>;
}

interface HumanInteractionScope {
  readonly workspaceId: string;
  readonly threadId: string;
  readonly providerSessionId: string;
}

type ActReceipt = {
  readonly index: number;
  readonly operation: string;
  readonly status: "applied" | "satisfied" | "failed" | "interrupted" | "skipped";
  readonly message?: string;
};

interface ActProgress {
  readonly receipts: ActReceipt[];
  outcome: "completed" | "failed" | "interrupted";
  effect: "none" | "partial" | "complete";
  stoppingPosition: number;
  documentRevision: number;
}

interface PreparedEvaluation {
  readonly request: Extract<BrowserAutomationHostDispatch["request"], { operation: "evaluate" }>;
  readonly observation: ObservationRecord;
  readonly deadline: number;
}

type TabDisposition = "close" | "release" | "handoff" | "deliverable";

interface PreparedTabMutation {
  readonly dispatch: BrowserAutomationHostDispatch;
  readonly request: Extract<BrowserAutomationHostDispatch["request"], { operation: "tabs" }>;
  readonly observation: ObservationRecord;
  readonly capabilityRevision: number;
  readonly session: ProviderTabSession;
  readonly adapter: BrowserSessionTabLifecycleAdapter | undefined;
  readonly liveTargets: Map<string, BrowserAutomationHostDispatchTarget>;
  readonly requestedTabId: string | undefined;
  readonly liveTarget: BrowserAutomationHostDispatchTarget | undefined;
}

interface FinalizationPlanEntry {
  readonly tabId: string;
  readonly controlled: ControlledTab;
  readonly disposition: TabDisposition;
}

/** One lifecycle-backed Browser tab projected for renderer consumers. */
export interface BrowserSessionLifecycleTab extends BrowserAutomationOwnedTab {
  readonly workspaceId: string;
  readonly threadId: string;
  readonly providerSessionId: string;
  readonly providerInstanceId: string;
  readonly target: BrowserAutomationHostDispatchTarget;
}

/** Runtime implementation used by the client BrowserSessionDriver. */
export interface BrowserSessionRuntimeAdapter {
  execute(
    dispatch: BrowserAutomationHostDispatch,
    signal: AbortSignal,
  ): Promise<BrowserAutomationResponse>;
}

/** Runtime mechanics used by the driver to enumerate and physically close Preview tabs. */
export interface BrowserSessionTabLifecycleAdapter {
  list(dispatch: BrowserAutomationHostDispatch): Promise<readonly BrowserAutomationHostDispatchTarget[]>;
  close(target: BrowserAutomationHostDispatchTarget, workspaceId: string): Promise<void>;
  activate?(target: BrowserAutomationHostDispatchTarget, workspaceId: string): Promise<void>;
}

/** Renderer-side adapter that forwards Browser v2 commands to Electron preload. */
export class ElectronBrowserSessionAdapter implements BrowserSessionRuntimeAdapter {
  constructor(
    private readonly executeRequest: (
      dispatch: BrowserAutomationHostDispatch,
      signal: AbortSignal,
    ) => Promise<BrowserAutomationResponse>,
  ) {}

  execute(dispatch: BrowserAutomationHostDispatch, signal: AbortSignal): Promise<BrowserAutomationResponse> {
    return this.executeRequest(dispatch, signal);
  }
}

/** Runtime selection inputs for the single Browser v2 command boundary. */
export interface BrowserSessionDriverOptions {
  readonly web: BrowserSessionRuntimeAdapter;
  readonly electron: BrowserSessionRuntimeAdapter;
  readonly isElectron?: () => boolean;
  readonly getCapabilityRevision?: () => number;
  readonly getHostRevision?: (dispatch: BrowserAutomationHostDispatch) => number;
  readonly getDocumentRevision?: (dispatch: BrowserAutomationHostDispatch) => number;
  readonly getControlRevision?: (dispatch: BrowserAutomationHostDispatch) => number;
  readonly getHumanInteractionRevision?: (dispatch: BrowserAutomationHostDispatch) => number;
  readonly supportedActOperations?: readonly string[] | (() => readonly string[]);
  readonly webTabs?: BrowserSessionTabLifecycleAdapter;
  readonly electronTabs?: BrowserSessionTabLifecycleAdapter;
  /** Receives the bounded lifecycle projection after ownership changes. */
  readonly onLifecycleChange?: (tabs: readonly BrowserSessionLifecycleTab[]) => void;
}

/**
 * Client orchestration boundary for Browser v2 commands. The driver chooses
 * the active runtime adapter; broker transport and native Electron mechanics
 * stay outside this class.
 */
export class BrowserSessionDriver {
  private readonly isElectron: () => boolean;
  private readonly idempotency = new Map<string, IdempotencyRecord>();
  private readonly tabIdempotency = new Map<string, TabReplayRecord>();
  private readonly observations = new Map<string, ObservationRecord>();
  private readonly humanInteractionRevisions = new Map<string, number>();
  private readonly humanInteractionScopes = new Map<string, HumanInteractionScope>();
  private readonly tabSessions = new Map<string, ProviderTabSession>();
  private readonly activeTabMutations = new Set<string>();

  constructor(private readonly options: BrowserSessionDriverOptions) {
    this.isElectron = options.isElectron ?? (() => typeof window !== "undefined" && typeof window.desktopBridge?.preview === "object");
  }

  /** Dispatch one broker-authorized Browser v2 command through the active runtime adapter. */
  execute(
    dispatch: BrowserAutomationHostDispatch,
    signal: AbortSignal,
  ): Promise<BrowserAutomationResponse> {
    const initialDrift = this.revisionDrift(dispatch);
    if (initialDrift) return Promise.resolve(initialDrift);
    return this.executeRequest(dispatch, signal);
  }

  private executeRequest(
    dispatch: BrowserAutomationHostDispatch,
    signal: AbortSignal,
  ): Promise<BrowserAutomationResponse> {
    const operation = dispatch.request?.operation;
    if (operation === "evaluate") return this.executeEvaluate(dispatch, signal);
    if (operation === "act") return this.executeAct(dispatch, signal);
    if (operation === "tabs") return this.executeTabs(dispatch, signal);
    return operation === "open"
      ? this.executeOpen(dispatch, signal)
      : this.executeAdapter(dispatch, signal);
  }

  private executeOpen(
    dispatch: BrowserAutomationHostDispatch,
    signal: AbortSignal,
  ): Promise<BrowserAutomationResponse> {
    const request = dispatch.request as OpenDispatch["request"];
    if (request.args.idempotencyKey === undefined) return this.executeAdapter(dispatch, signal);
    this.pruneIdempotency();
    const replay = this.openReplay(dispatch, request);
    return replay ?? this.startIdempotentOpen(dispatch, request, signal);
  }

  private openReplay(
    dispatch: BrowserAutomationHostDispatch,
    request: OpenDispatch["request"],
  ): Promise<BrowserAutomationResponse> | undefined {
    const key = this.openIdempotencyKey(request);
    const existing = this.idempotency.get(key);
    if (!existing) return undefined;
    if (!this.isOpenTarget(existing, dispatch, request)) {
      this.idempotency.delete(key);
      return undefined;
    }
    existing.lastUsedAt = Date.now();
    if (existing.fingerprint !== this.openFingerprint(request)) {
      return Promise.resolve(this.openIdempotencyConflict(request));
    }
    return existing.promise.then((response) => ({ ...response, requestId: request.requestId, sequence: request.sequence }));
  }

  private isOpenTarget(
    record: IdempotencyRecord,
    dispatch: BrowserAutomationHostDispatch,
    request: OpenDispatch["request"],
  ): boolean {
    return record.target.workspaceId === request.workspaceId &&
      record.target.threadId === request.threadId &&
      record.target.tabId === dispatch.target.tabId &&
      record.target.windowId === dispatch.target.windowId &&
      record.target.targetGeneration === dispatch.target.targetGeneration;
  }

  private openIdempotencyConflict(request: OpenDispatch["request"]): BrowserAutomationResponse {
    return {
      contractVersion: request.contractVersion,
      requestId: request.requestId,
      sequence: request.sequence,
      ok: false,
      error: {
        code: "IDEMPOTENCY_CONFLICT",
        message: "The idempotency key was already used with different browser_open arguments",
        retryable: false,
        stage: "validation",
        effect: "none",
        recovery: "manual",
      },
    };
  }

  private startIdempotentOpen(
    dispatch: BrowserAutomationHostDispatch,
    request: OpenDispatch["request"],
    signal: AbortSignal,
  ): Promise<BrowserAutomationResponse> {
    const mutationKey = this.sessionKey(dispatch);
    if (this.activeTabMutations.has(mutationKey)) {
      return Promise.resolve(this.failure(dispatch, "BROWSER_BUSY", "Another browser mutation is active for this provider session", "wait"));
    }
    const session = this.tabSession(dispatch);
    if (this.agentCreatedTabCount(session) >= 3) {
      return Promise.resolve(this.failure(dispatch, "BROWSER_BUSY", "This provider session already owns three agent-created tabs", "wait"));
    }
    this.activeTabMutations.add(mutationKey);
    const promise = this.executeAdapter(this.normalizedOpenDispatch(dispatch, request), signal)
      .then((response) => this.recordOpenedTab(session, dispatch, response))
      .finally(() => this.activeTabMutations.delete(mutationKey));
    this.rememberOpenReplay(dispatch, request, promise);
    return promise;
  }

  private agentCreatedTabCount(session: ProviderTabSession): number {
    return [...session.tabs.values()].filter((tab) => tab.provenance === "agent-created" && tab.ownership !== "released").length;
  }

  private normalizedOpenDispatch(
    dispatch: BrowserAutomationHostDispatch,
    request: OpenDispatch["request"],
  ): OpenDispatch {
    return {
      ...dispatch,
      request: {
        ...request,
        args: {
          ...(request.args.url ? { url: request.args.url } : {}),
          idempotencyKey: request.args.idempotencyKey!,
        },
      },
    } as OpenDispatch;
  }

  private recordOpenedTab(
    session: ProviderTabSession,
    dispatch: BrowserAutomationHostDispatch,
    response: BrowserAutomationResponse,
  ): BrowserAutomationResponse {
    if (!response.ok) return this.withObservationRef(response);
    session.current = dispatch.target;
    session.tabs.set(dispatch.target.tabId, {
      tabId: dispatch.target.tabId,
      provenance: "agent-created",
      ownership: "owned",
      target: dispatch.target,
    });
    this.publishLifecycleProjectionInternal();
    return this.withObservationRef(response);
  }

  private rememberOpenReplay(
    dispatch: BrowserAutomationHostDispatch,
    request: OpenDispatch["request"],
    promise: Promise<BrowserAutomationResponse>,
  ): void {
    this.idempotency.set(this.openIdempotencyKey(request), {
      fingerprint: this.openFingerprint(request),
      target: {
        workspaceId: request.workspaceId,
        threadId: request.threadId,
        tabId: dispatch.target.tabId,
        windowId: dispatch.target.windowId,
        targetGeneration: dispatch.target.targetGeneration,
      },
      lastUsedAt: Date.now(),
      promise,
    });
    this.evictOldestReplay(this.idempotency);
  }

  private openIdempotencyKey(request: OpenDispatch["request"]): string {
    return JSON.stringify([
      request.workspaceId,
      request.threadId,
      request.providerSessionId,
      request.providerInstanceId,
      request.args.idempotencyKey,
    ]);
  }

  private openFingerprint(request: OpenDispatch["request"]): string {
    return JSON.stringify({ url: request.args.url ?? null, workspaceId: request.workspaceId, threadId: request.threadId });
  }

  private evictOldestReplay(records: Map<string, IdempotencyRecord>): void {
    while (records.size > MAX_IDEMPOTENCY_RECORDS) {
      const oldest = records.keys().next().value as string | undefined;
      if (!oldest) return;
      records.delete(oldest);
    }
  }

  /** Clears bounded replay state when a provider session or host is released. */
  clearIdempotency(): void {
    this.idempotency.clear();
    this.tabIdempotency.clear();
    this.observations.clear();
    this.humanInteractionRevisions.clear();
    this.humanInteractionScopes.clear();
  }

  /** Invalidates observations for one target after trusted human input. */
  invalidateTargetObservations(workspaceId: string, threadId: string, tabId: string): void {
    const targetKey = observationTargetKey(workspaceId, threadId, tabId);
    this.humanInteractionRevisions.set(
      targetKey,
      (this.humanInteractionRevisions.get(targetKey) ?? 0) + 1,
    );
    for (const [observationRef, observation] of this.observations) {
      if (observation.targetKey === targetKey || [...observation.targets.values()].some(
        (target) => observationTargetKey(observation.workspaceId, target.threadId, target.tabId) === targetKey,
      )) {
        this.observations.delete(observationRef);
      }
    }
  }

  /** Publishes retained browser ownership after a host reconnects. */
  publishLifecycleProjection(): void {
    this.publishLifecycleProjectionInternal();
  }

  /** Clears replay state bound to one browser target after that target closes or is replaced. */
  clearIdempotencyForTarget(workspaceId: string, threadId: string, tabId: string): void {
    this.invalidateTargetObservations(workspaceId, threadId, tabId);
    const targetKey = observationTargetKey(workspaceId, threadId, tabId);
    this.clearHumanInteractionTarget(targetKey);
    this.clearTargetReplayRecords(this.idempotency, workspaceId, threadId, tabId);
    this.clearTargetReplayRecords(this.tabIdempotency, workspaceId, threadId, tabId);
    this.clearTargetFromSessions(workspaceId, threadId, tabId);
    this.publishLifecycleProjectionInternal();
  }

  private clearTargetReplayRecords(
    records: Map<string, IdempotencyRecord | TabReplayRecord>,
    workspaceId: string,
    threadId: string,
    tabId: string,
  ): void {
    for (const [key, record] of records) {
      if (record.target.workspaceId === workspaceId && record.target.threadId === threadId && record.target.tabId === tabId) {
        records.delete(key);
      }
    }
  }

  private clearTargetFromSessions(workspaceId: string, threadId: string, tabId: string): void {
    for (const session of this.tabSessions.values()) {
      if (session.workspaceId !== workspaceId) continue;
      this.clearCurrentSessionTarget(session, threadId, tabId);
      this.clearSessionTab(session, threadId, tabId);
    }
  }

  private clearCurrentSessionTarget(session: ProviderTabSession, threadId: string, tabId: string): void {
    if (session.current?.threadId === threadId && session.current.tabId === tabId) session.current = null;
  }

  private clearSessionTab(session: ProviderTabSession, threadId: string, tabId: string): void {
    const target = session.tabs.get(tabId)?.target;
    if (target?.threadId === threadId) session.tabs.delete(tabId);
  }

  /** Returns the exact target selected by a successful lifecycle response. */
  responseTarget(dispatch: BrowserAutomationHostDispatch, response: BrowserAutomationResponse): BrowserAutomationHostDispatchTarget {
    if (!response.ok || response.result.operation !== "tabs") return dispatch.target;
    return this.tabSessions.get(this.sessionKey(dispatch))?.current ?? dispatch.target;
  }

  /** Settles every tab owned or claimed by one terminated provider session. */
  async releaseProviderSession(providerSessionId: string): Promise<void> {
    this.clearObservations((observation) => observation.providerSessionId === providerSessionId);
    this.clearHumanInteractionScopes((scope) => scope.providerSessionId === providerSessionId);
    await this.releaseSessions((session) => session.providerSessionId === providerSessionId);
  }

  /** Settles every tab owned or claimed by one deleted thread. */
  async releaseThread(workspaceId: string, threadId: string): Promise<void> {
    this.clearObservations((observation) => observation.workspaceId === workspaceId && observation.threadId === threadId);
    this.clearHumanInteractionScopes((scope) => scope.workspaceId === workspaceId && scope.threadId === threadId);
    await this.releaseSessions((session) => session.workspaceId === workspaceId &&
      [...session.tabs.values()].some((tab) => tab.target.threadId === threadId));
  }

  /** Settles every tab owned or claimed by one deleted workspace. */
  async releaseWorkspace(workspaceId: string): Promise<void> {
    this.clearObservations((observation) => observation.workspaceId === workspaceId);
    this.clearHumanInteractionScopes((scope) => scope.workspaceId === workspaceId);
    await this.releaseSessions((session) => session.workspaceId === workspaceId);
  }

  private withObservationRef(response: BrowserAutomationResponse): BrowserAutomationResponse {
    if (!response.ok || !response.result || (response.result.operation !== "open" && response.result.operation !== "inspect") || response.result.observationRef) return response;
    return { ...response, result: { ...response.result, observationRef: globalThis.crypto.randomUUID() } };
  }

  private executeAdapter(
    dispatch: BrowserAutomationHostDispatch,
    signal: AbortSignal,
    options: { readonly implicitClaim?: boolean } = {},
  ): Promise<BrowserAutomationResponse> {
    const drift = this.revisionDrift(dispatch);
    if (drift) return Promise.resolve(drift);
    return (this.isElectron() ? this.options.electron : this.options.web).execute(dispatch, signal)
      .then(async (response) => {
        let normalized = this.withObservationRef(response);
        if (normalized.ok && normalized.result?.operation === "inspect") {
          const targets = await this.tabAdapter()?.list(dispatch);
          if (targets) {
            normalized = {
              ...normalized,
              result: { ...normalized.result, tabs: [...targets] },
            };
          }
        }
        if (normalized.ok && options.implicitClaim !== false && this.isControlTakingOperation(dispatch.request.operation)) {
          this.claimSuccessfulTarget(dispatch);
        }
        return this.rememberObservation(normalized, dispatch);
      });
  }

  private executeAct(
    dispatch: BrowserAutomationHostDispatch,
    signal: AbortSignal,
  ): Promise<BrowserAutomationResponse> {
    const request = dispatch.request as Extract<BrowserAutomationHostDispatch["request"], { operation: "act" }>;
    const observation = this.observations.get(request.args.observationRef);
    const capabilityRevision = this.options.getCapabilityRevision?.() ?? dispatch.connection?.capabilityRevision ?? 1;
    const supported = typeof this.options.supportedActOperations === "function" ? this.options.supportedActOperations() : this.options.supportedActOperations;
    if (this.hasUnsupportedActStep(request.args.steps, supported)) {
      return Promise.resolve(this.actFailure(dispatch, "UNSUPPORTED_OPERATION", "Browser runtime cannot execute every browser_act step"));
    }
    if (!observation || !this.actObservationCurrent(dispatch, observation, capabilityRevision)) {
      return Promise.resolve(this.actFailure(dispatch, "STALE_TARGET_GENERATION", "Browser observation is stale; inspect before browser_act"));
    }
    this.observations.delete(request.args.observationRef);
    const deadline = Math.min(dispatch.request.deadline, Date.now() + request.args.deadlineMs);
    return this.executeActSteps(dispatch, request, observation, signal, deadline)
      .then((progress) => this.actResponse(request, observation, capabilityRevision, progress))
      .then((response) => this.claimCompletedActTarget(dispatch, request.args.steps, response));
  }

  private hasUnsupportedActStep(
    steps: readonly BrowserAutomationActStep[],
    supported: readonly string[] | undefined,
  ): boolean {
    return supported !== undefined && steps.some((step) => step.operation !== "assert" && !supported.includes(step.operation));
  }

  private actObservationCurrent(
    dispatch: BrowserAutomationHostDispatch,
    observation: ObservationRecord,
    capabilityRevision: number,
  ): boolean {
    const current = this.currentObservationBinding(dispatch, capabilityRevision);
    return observation.hostRevision === current.hostRevision &&
      observation.documentRevision === current.documentRevision &&
      observation.controlRevision === current.controlRevision &&
      observation.capabilityRevision === current.capabilityRevision &&
      observation.humanInteractionRevision === this.currentHumanInteractionRevision(dispatch);
  }

  private async executeActSteps(
    dispatch: BrowserAutomationHostDispatch,
    request: Extract<BrowserAutomationHostDispatch["request"], { operation: "act" }>,
    observation: ObservationRecord,
    signal: AbortSignal,
    deadline: number,
  ): Promise<ActProgress> {
    const progress: ActProgress = {
      receipts: [],
      outcome: "completed",
      effect: "none",
      stoppingPosition: request.args.steps.length,
      documentRevision: observation.documentRevision,
    };
    for (let index = 0; index < request.args.steps.length; index += 1) {
      const step = request.args.steps[index]!;
      const interruption = this.actInterruption(dispatch, observation, signal, deadline);
      if (interruption) {
        this.interruptAct(progress, request.args.steps, step, index, interruption);
        break;
      }
      const response = await this.executeActStep(dispatch, step, signal, deadline, index);
      if (!response.ok) {
        this.failAct(progress, request.args.steps, step, index, response);
        break;
      }
      this.recordCompletedActStep(progress, step, index);
      if (this.invalidatesActDocument(step.operation)) {
        progress.documentRevision += 1;
        progress.stoppingPosition = index + 1;
        this.recordSkippedActSteps(progress.receipts, request.args.steps, index + 1);
        break;
      }
    }
    if (progress.outcome !== "completed" && progress.effect === "complete") progress.effect = "partial";
    return progress;
  }

  private actInterruption(
    dispatch: BrowserAutomationHostDispatch,
    observation: ObservationRecord,
    signal: AbortSignal,
    deadline: number,
  ): string | undefined {
    if (signal.aborted || Date.now() >= deadline) return "Browser batch interrupted before the next effect";
    if (this.revisionDrift(dispatch) || !this.observationStillCurrent(dispatch, observation)) {
      return "Browser observation was invalidated";
    }
    return undefined;
  }

  private interruptAct(
    progress: ActProgress,
    steps: readonly BrowserAutomationActStep[],
    step: BrowserAutomationActStep,
    index: number,
    message: string,
  ): void {
    progress.outcome = "interrupted";
    progress.stoppingPosition = index;
    progress.receipts.push({ index, operation: step.operation, status: "interrupted", message });
    this.recordSkippedActSteps(progress.receipts, steps, index + 1);
  }

  private async executeActStep(
    dispatch: BrowserAutomationHostDispatch,
    step: BrowserAutomationActStep,
    signal: AbortSignal,
    deadline: number,
    index: number,
  ): Promise<BrowserAutomationResponse> {
    const stepDispatch = this.stepDispatch(dispatch, step, deadline, index);
    return step.operation === "assert"
      ? this.executeAssertStep(stepDispatch, step, signal, deadline)
      : this.executeAdapter(stepDispatch, signal, { implicitClaim: false });
  }

  private failAct(
    progress: ActProgress,
    steps: readonly BrowserAutomationActStep[],
    step: BrowserAutomationActStep,
    index: number,
    response: Extract<BrowserAutomationResponse, { ok: false }>,
  ): void {
    progress.outcome = this.isCancellation(response.error.code) ? "interrupted" : "failed";
    progress.stoppingPosition = index;
    progress.receipts.push({
      index,
      operation: step.operation,
      status: progress.outcome === "interrupted" ? "interrupted" : "failed",
      message: sanitizePublicDetail(response.error.message),
    });
    this.recordSkippedActSteps(progress.receipts, steps, index + 1);
  }

  private recordCompletedActStep(progress: ActProgress, step: BrowserAutomationActStep, index: number): void {
    progress.effect = "complete";
    progress.receipts.push({
      index,
      operation: step.operation,
      status: step.operation === "assert" || step.operation === "wait" ? "satisfied" : "applied",
    });
  }

  private recordSkippedActSteps(receipts: ActReceipt[], steps: readonly BrowserAutomationActStep[], from: number): void {
    for (let index = from; index < steps.length; index += 1) {
      receipts.push({ index, operation: steps[index]!.operation, status: "skipped" });
    }
  }

  private invalidatesActDocument(operation: BrowserAutomationActStep["operation"]): boolean {
    return operation === "navigate" || operation === "back" || operation === "forward" || operation === "reload";
  }

  private actResponse(
    request: Extract<BrowserAutomationHostDispatch["request"], { operation: "act" }>,
    observation: ObservationRecord,
    capabilityRevision: number,
    progress: ActProgress,
  ): BrowserAutomationResponse {
    const nextObservationRef = globalThis.crypto.randomUUID();
    const finalObservation = {
      observationRef: nextObservationRef,
      hostRevision: observation.hostRevision,
      documentRevision: progress.documentRevision,
      controlRevision: observation.controlRevision,
      capabilityRevision,
      observationRevision: observation.observationRevision + 1,
    };
    this.rememberActObservation(nextObservationRef, finalObservation, observation, capabilityRevision);
    return {
      contractVersion: request.contractVersion,
      requestId: request.requestId,
      sequence: request.sequence,
      ok: true,
      result: {
        operation: "act",
        outcome: progress.outcome,
        stoppingPosition: progress.stoppingPosition,
        effect: progress.effect,
        recovery: "inspect",
        receipts: progress.receipts,
        finalObservation,
        nextObservationRef,
      },
    } as BrowserAutomationResponse;
  }

  private rememberActObservation(
    observationRef: string,
    finalObservation: {
      readonly hostRevision: number;
      readonly documentRevision: number;
      readonly controlRevision: number;
      readonly capabilityRevision: number;
      readonly observationRevision: number;
    },
    observation: ObservationRecord,
    capabilityRevision: number,
  ): void {
    this.observations.set(observationRef, {
      hostRevision: finalObservation.hostRevision,
      documentRevision: finalObservation.documentRevision,
      controlRevision: finalObservation.controlRevision,
      capabilityRevision,
      humanInteractionRevision: observation.humanInteractionRevision,
      targetKey: observation.targetKey,
      workspaceId: observation.workspaceId,
      threadId: observation.threadId,
      providerSessionId: observation.providerSessionId,
      providerInstanceId: observation.providerInstanceId,
      observationRevision: finalObservation.observationRevision,
      targets: observation.targets,
    });
  }

  private claimCompletedActTarget(
    dispatch: BrowserAutomationHostDispatch,
    steps: readonly BrowserAutomationActStep[],
    response: BrowserAutomationResponse,
  ): BrowserAutomationResponse {
    if (response.ok && response.result.operation === "act" && response.result.outcome === "completed" && steps.some((step) => this.isControlTakingOperation(step.operation))) {
      this.claimSuccessfulTarget(dispatch);
    }
    return response;
  }

  private executeEvaluate(
    dispatch: BrowserAutomationHostDispatch,
    signal: AbortSignal,
  ): Promise<BrowserAutomationResponse> {
    const prepared = this.prepareEvaluation(dispatch, signal);
    return "response" in prepared
      ? Promise.resolve(prepared.response)
      : this.executePreparedEvaluation(dispatch, prepared, signal);
  }

  private prepareEvaluation(
    dispatch: BrowserAutomationHostDispatch,
    signal: AbortSignal,
  ): PreparedEvaluation | { readonly response: BrowserAutomationResponse } {
    if (!this.isElectron()) {
      return { response: this.operationFailure(dispatch, "UNSUPPORTED_OPERATION", "Browser evaluation requires the Electron runtime") };
    }
    const request = dispatch.request as Extract<BrowserAutomationHostDispatch["request"], { operation: "evaluate" }>;
    const capabilityRevision = this.options.getCapabilityRevision?.() ?? dispatch.connection?.capabilityRevision ?? 1;
    const observed = this.evaluationObservation(dispatch, request, capabilityRevision);
    if ("response" in observed) return observed;
    const { observation } = observed;
    const deadline = Math.min(dispatch.request.deadline, Date.now() + request.args.deadlineMs);
    const interruption = this.evaluatePreEffectInterruption(dispatch, observation, signal, deadline);
    if (interruption) {
      this.observations.delete(request.args.observationRef);
      return { response: interruption };
    }
    if (this.revisionDrift(dispatch) || !this.observationStillCurrent(dispatch, observation)) {
      return { response: this.operationFailure(dispatch, "STALE_TARGET_GENERATION", "Browser observation changed before browser_evaluate") };
    }
    this.observations.delete(request.args.observationRef);
    return { request, observation, deadline };
  }

  private evaluationObservation(
    dispatch: BrowserAutomationHostDispatch,
    request: Extract<BrowserAutomationHostDispatch["request"], { operation: "evaluate" }>,
    capabilityRevision: number,
  ): { readonly observation: ObservationRecord } | { readonly response: BrowserAutomationResponse } {
    const observation = this.observations.get(request.args.observationRef);
    if (!observation) {
      return { response: this.operationFailure(dispatch, "STALE_TARGET_GENERATION", "Browser observation is stale; inspect before browser_evaluate") };
    }
    return this.evaluateObservationCurrent(dispatch, observation, capabilityRevision)
      ? { observation }
      : { response: this.operationFailure(dispatch, "STALE_TARGET_GENERATION", "Browser observation is stale; inspect before browser_evaluate") };
  }

  private evaluateObservationCurrent(
    dispatch: BrowserAutomationHostDispatch,
    observation: ObservationRecord,
    capabilityRevision: number,
  ): boolean {
    const current = this.currentObservationBinding(dispatch, capabilityRevision);
    return observation.hostRevision === current.hostRevision &&
      observation.documentRevision === current.documentRevision &&
      observation.controlRevision === current.controlRevision &&
      observation.capabilityRevision === current.capabilityRevision;
  }

  private evaluatePreEffectInterruption(
    dispatch: BrowserAutomationHostDispatch,
    observation: ObservationRecord,
    signal: AbortSignal,
    deadline: number,
  ): BrowserAutomationResponse | undefined {
    if (!signal.aborted && Date.now() < deadline) return undefined;
    return this.evaluateEnvelope(dispatch, observation, {
      outcome: "interrupted",
      effect: "none",
      status: "interrupted",
      message: signal.aborted
        ? "Browser evaluation was interrupted before the effect"
        : "Browser evaluation deadline elapsed before the effect",
    });
  }

  private executePreparedEvaluation(
    dispatch: BrowserAutomationHostDispatch,
    prepared: PreparedEvaluation,
    signal: AbortSignal,
  ): Promise<BrowserAutomationResponse> {
    const boundedDispatch: BrowserAutomationHostDispatch = {
      ...dispatch,
      request: { ...dispatch.request, deadline: prepared.deadline },
    };
    return this.options.electron.execute(boundedDispatch, signal)
      .then(
        (response) => this.evaluateResponse(dispatch, prepared.observation, response, signal),
        (cause: unknown) => this.evaluateRejection(dispatch, prepared.observation, cause),
      );
  }

  private evaluateRejection(
    dispatch: BrowserAutomationHostDispatch,
    observation: ObservationRecord,
    cause: unknown,
  ): BrowserAutomationResponse {
    const interrupted = this.isCancellation(cause);
    return this.evaluateEnvelope(dispatch, observation, {
      outcome: interrupted ? "interrupted" : "failed",
      effect: "partial",
      status: interrupted ? "interrupted" : "failed",
      message: sanitizePublicDetail(cause instanceof Error ? cause.message : cause),
    });
  }

  private evaluateResponse(
    dispatch: BrowserAutomationHostDispatch,
    observation: ObservationRecord,
    response: BrowserAutomationResponse,
    signal: AbortSignal,
  ): BrowserAutomationResponse {
    const boundary = this.evaluateCompletionBoundary(dispatch, observation, signal);
    if (boundary) return boundary;
    if (!response.ok) {
      const interrupted = this.isCancellation(response.error.code);
      return this.evaluateEnvelope(dispatch, observation, {
        outcome: interrupted ? "interrupted" : "failed",
        effect: response.error.effect === "none" ? "none" : "partial",
        status: interrupted ? "interrupted" : "failed",
        message: sanitizePublicDetail(response.error.message),
      });
    }
    if (response.result.operation !== "evaluate" || !this.isRawEvaluateResult(response.result)) {
      return this.evaluateEnvelope(dispatch, observation, {
        outcome: "failed",
        effect: "partial",
        status: "failed",
        message: "Electron browser evaluation returned an invalid result",
      });
    }
    if (new TextEncoder().encode(response.result.valueJson).byteLength > BROWSER_AUTOMATION_MAX_EXPRESSION_BYTES) {
      return this.evaluateEnvelope(dispatch, observation, {
        outcome: "failed",
        effect: "complete",
        status: "failed",
        message: "Evaluation result exceeds 64 KiB",
      });
    }
    return this.evaluateEnvelope(dispatch, observation, {
      outcome: "completed",
      effect: "complete",
      status: "applied",
      valueJson: response.result.valueJson,
    });
  }

  private evaluateCompletionBoundary(
    dispatch: BrowserAutomationHostDispatch,
    observation: ObservationRecord,
    signal: AbortSignal,
  ): BrowserAutomationResponse | null {
    if (signal.aborted) {
      return this.evaluateEnvelope(dispatch, observation, {
        outcome: "interrupted",
        effect: "partial",
        status: "interrupted",
        message: "Browser evaluation was interrupted before completion",
      });
    }
    const drift = this.revisionDrift(dispatch);
    if (drift) return drift;
    if (!this.observationStillCurrent(dispatch, observation)) {
      return this.operationFailure(dispatch, "STALE_TARGET_GENERATION", "Browser observation changed before browser_evaluate completed");
    }
    return null;
  }

  private evaluateEnvelope(
    dispatch: BrowserAutomationHostDispatch,
    observation: ObservationRecord,
    outcome: {
      readonly outcome: "completed" | "failed" | "interrupted";
      readonly effect: "none" | "partial" | "complete";
      readonly status: "applied" | "failed" | "interrupted";
      readonly message?: string;
      readonly valueJson?: string;
    },
  ): BrowserAutomationResponse {
    const capabilityRevision = this.options.getCapabilityRevision?.() ?? observation.capabilityRevision;
    const current = this.currentObservationBinding(dispatch, capabilityRevision);
    const nextObservationRef = globalThis.crypto.randomUUID();
    const finalObservation = {
      observationRef: nextObservationRef,
      hostRevision: current.hostRevision,
      documentRevision: current.documentRevision,
      controlRevision: current.controlRevision,
      capabilityRevision: current.capabilityRevision,
      observationRevision: observation.observationRevision + 1,
    };
    this.observations.set(nextObservationRef, {
      hostRevision: finalObservation.hostRevision,
      documentRevision: finalObservation.documentRevision,
      controlRevision: finalObservation.controlRevision,
      capabilityRevision: finalObservation.capabilityRevision,
      humanInteractionRevision: observation.humanInteractionRevision,
      targetKey: observation.targetKey,
      workspaceId: observation.workspaceId,
      threadId: observation.threadId,
      providerSessionId: observation.providerSessionId,
      providerInstanceId: observation.providerInstanceId,
      observationRevision: finalObservation.observationRevision,
      targets: observation.targets,
    });
    const result: BrowserAutomationEvaluateResult = {
      operation: "evaluate",
      outcome: outcome.outcome,
      stoppingPosition: outcome.outcome === "completed" ? 1 : 0,
      effect: outcome.effect,
      recovery: "inspect",
      receipts: [{
        index: 0,
        operation: "evaluate",
        status: outcome.status,
        ...(outcome.message ? { message: outcome.message.slice(0, 1_024) } : {}),
      }],
      finalObservation,
      nextObservationRef,
      ...(outcome.valueJson !== undefined ? { valueJson: outcome.valueJson } : {}),
    };
    return {
      contractVersion: dispatch.request.contractVersion,
      requestId: dispatch.request.requestId,
      sequence: dispatch.request.sequence,
      ok: true,
      result,
    };
  }

  private isRawEvaluateResult(
    result: Extract<BrowserAutomationResult, { operation: "evaluate" }>,
  ): result is Extract<BrowserAutomationResult, { operation: "evaluate"; valueJson: string; controlEpoch: number }> {
    return result.operation === "evaluate" && typeof result.valueJson === "string" && !("outcome" in result);
  }

  private isCancellation(value: unknown): boolean {
    if (typeof value === "string") {
      return value === "OPERATION_CANCELLED" || value === "HUMAN_INTERRUPTED" || value === "DEADLINE_EXCEEDED";
    }
    if (typeof value === "object" && value !== null && "code" in value) {
      const code = (value as { code?: unknown }).code;
      return code === "OPERATION_CANCELLED" || code === "HUMAN_INTERRUPTED" || code === "DEADLINE_EXCEEDED";
    }
    return value instanceof Error && /cancel|interrupt|deadline|abort/i.test(value.message);
  }

  private operationFailure(
    dispatch: BrowserAutomationHostDispatch,
    code: Extract<BrowserAutomationErrorCode, "UNSUPPORTED_OPERATION" | "STALE_TARGET_GENERATION" | "CAPABILITY_CHANGED">,
    message: string,
  ): BrowserAutomationResponse {
    return {
      contractVersion: dispatch.request.contractVersion,
      requestId: dispatch.request.requestId,
      sequence: dispatch.request.sequence,
      ok: false,
      error: {
        code,
        message,
        retryable: false,
        stage: "observation",
        effect: "none",
        recovery: "inspect",
      },
    };
  }

  private executeTabs(dispatch: BrowserAutomationHostDispatch, signal: AbortSignal): Promise<BrowserAutomationResponse> {
    const request = dispatch.request as Extract<BrowserAutomationHostDispatch["request"], { operation: "tabs" }>;
    if (signal.aborted) {
      return Promise.resolve(this.tabCancellation(dispatch, "Browser tab mutation was interrupted before the effect"));
    }
    const replay = this.tabReplay(dispatch, request);
    return replay ?? this.startTabsMutation(dispatch, request, signal);
  }

  private tabReplay(
    dispatch: BrowserAutomationHostDispatch,
    request: Extract<BrowserAutomationHostDispatch["request"], { operation: "tabs" }>,
  ): Promise<BrowserAutomationResponse> | undefined {
    const replay = this.tabIdempotency.get(this.tabIdempotencyKey(request));
    if (!replay) return undefined;
    replay.lastUsedAt = Date.now();
    if (replay.fingerprint !== JSON.stringify(request.args)) {
      return Promise.resolve(this.failure(dispatch, "IDEMPOTENCY_CONFLICT", "The idempotency key was already used with different browser_tabs arguments", "manual"));
    }
    return replay.promise.then((response) => ({ ...response, requestId: request.requestId, sequence: request.sequence }));
  }

  private startTabsMutation(
    dispatch: BrowserAutomationHostDispatch,
    request: Extract<BrowserAutomationHostDispatch["request"], { operation: "tabs" }>,
    signal: AbortSignal,
  ): Promise<BrowserAutomationResponse> {
    const sessionKey = this.sessionKey(dispatch);
    if (this.activeTabMutations.has(sessionKey)) {
      return Promise.resolve(this.failure(dispatch, "BROWSER_BUSY", "Another browser mutation is active for this provider session", "wait"));
    }
    const observation = this.observations.get(request.args.observationRef);
    const capabilityRevision = this.options.getCapabilityRevision?.() ?? dispatch.connection?.capabilityRevision ?? 1;
    if (!observation || !this.observationStillCurrent(dispatch, observation)) {
      return Promise.resolve(this.failure(dispatch, "STALE_TARGET_GENERATION", "Browser observation is stale; inspect before browser_tabs", "inspect"));
    }
    this.observations.delete(request.args.observationRef);
    this.activeTabMutations.add(sessionKey);
    const promise = this.applyTabsMutation(dispatch, observation, capabilityRevision, signal)
      .finally(() => this.activeTabMutations.delete(sessionKey));
    this.rememberTabsReplay(dispatch, request, promise);
    this.pruneIdempotency();
    return promise;
  }

  private rememberTabsReplay(
    dispatch: BrowserAutomationHostDispatch,
    request: Extract<BrowserAutomationHostDispatch["request"], { operation: "tabs" }>,
    promise: Promise<BrowserAutomationResponse>,
  ): void {
    this.tabIdempotency.set(this.tabIdempotencyKey(request), {
      fingerprint: JSON.stringify(request.args),
      target: {
        workspaceId: request.workspaceId,
        threadId: request.threadId,
        tabId: dispatch.target.tabId,
      },
      lastUsedAt: Date.now(),
      promise,
    });
  }

  private tabIdempotencyKey(
    request: Extract<BrowserAutomationHostDispatch["request"], { operation: "tabs" }>,
  ): string {
    return JSON.stringify([
      request.workspaceId,
      request.threadId,
      request.providerSessionId,
      request.providerInstanceId,
      request.args.idempotencyKey,
    ]);
  }

  private async applyTabsMutation(
    dispatch: BrowserAutomationHostDispatch,
    observation: ObservationRecord,
    capabilityRevision: number,
    signal: AbortSignal,
  ): Promise<BrowserAutomationResponse> {
    const session = this.tabSession(dispatch);
    const adapter = this.tabAdapter();
    if (signal.aborted) return this.tabCancellation(dispatch, "Browser tab mutation was interrupted before enumeration");
    const targets = adapter ? await adapter.list(dispatch) : [dispatch.target];
    const liveTargets = new Map(targets.map((target) => [target.tabId, target]));
    const prepared = this.prepareTabsMutation(dispatch, observation, capabilityRevision, session, adapter, liveTargets, signal);
    if ("response" in prepared) return prepared.response;
    const actionResponse = await this.applyTabAction(prepared, signal);
    if (actionResponse) return actionResponse;
    return this.completeTabsMutation(prepared, signal);
  }

  private prepareTabsMutation(
    dispatch: BrowserAutomationHostDispatch,
    observation: ObservationRecord,
    capabilityRevision: number,
    session: ProviderTabSession,
    adapter: BrowserSessionTabLifecycleAdapter | undefined,
    liveTargets: Map<string, BrowserAutomationHostDispatchTarget>,
    signal: AbortSignal,
  ): PreparedTabMutation | { readonly response: BrowserAutomationResponse } {
    if (signal.aborted) return { response: this.tabCancellation(dispatch, "Browser tab mutation was interrupted before the next effect") };
    if (!this.observationStillCurrent(dispatch, observation)) {
      return { response: this.failure(dispatch, "STALE_TARGET_GENERATION", "Browser generations changed before the next tab effect", "inspect") };
    }
    const request = dispatch.request as Extract<BrowserAutomationHostDispatch["request"], { operation: "tabs" }>;
    const requestedTabId = this.requestedTabId(request, session);
    const targetResponse = this.validateRequestedTab(dispatch, observation, liveTargets, requestedTabId);
    if (targetResponse) return { response: targetResponse };
    const finalizeResponse = this.validateFinalizedTabs(dispatch, request, observation, liveTargets, session);
    if (finalizeResponse) return { response: finalizeResponse };
    return {
      dispatch,
      request,
      observation,
      capabilityRevision,
      session,
      adapter,
      liveTargets,
      requestedTabId,
      liveTarget: requestedTabId ? liveTargets.get(requestedTabId) : undefined,
    };
  }

  private requestedTabId(
    request: Extract<BrowserAutomationHostDispatch["request"], { operation: "tabs" }>,
    session: ProviderTabSession,
  ): string | undefined {
    if (request.args.action === "select" || request.args.action === "claim") return request.args.tabId;
    if (request.args.action === "release" || request.args.action === "close") return request.args.tabId ?? session.current?.tabId;
    return undefined;
  }

  private validateRequestedTab(
    dispatch: BrowserAutomationHostDispatch,
    observation: ObservationRecord,
    liveTargets: ReadonlyMap<string, BrowserAutomationHostDispatchTarget>,
    tabId: string | undefined,
  ): BrowserAutomationResponse | undefined {
    if (!tabId) return undefined;
    const observed = observation.targets.get(tabId);
    const live = liveTargets.get(tabId);
    if (this.sameTargetGeneration(observed, live)) return undefined;
    return this.failure(dispatch, "STALE_TARGET_GENERATION", "The selected Browser tab changed after it was observed", "inspect");
  }

  private sameTargetGeneration(
    observed: BrowserAutomationHostDispatchTarget | undefined,
    live: BrowserAutomationHostDispatchTarget | undefined,
  ): boolean {
    return observed !== undefined && live !== undefined &&
      observed.targetGeneration === live.targetGeneration &&
      observed.connectionGeneration === live.connectionGeneration;
  }

  private validateFinalizedTabs(
    dispatch: BrowserAutomationHostDispatch,
    request: Extract<BrowserAutomationHostDispatch["request"], { operation: "tabs" }>,
    observation: ObservationRecord,
    liveTargets: ReadonlyMap<string, BrowserAutomationHostDispatchTarget>,
    session: ProviderTabSession,
  ): BrowserAutomationResponse | undefined {
    if (request.args.action !== "finalize") return undefined;
    const stale = [...session.tabs.values()].some((controlled) =>
      !this.sameTargetGeneration(observation.targets.get(controlled.tabId), liveTargets.get(controlled.tabId)));
    return stale
      ? this.failure(dispatch, "STALE_TARGET_GENERATION", "A controlled Browser tab changed after it was observed", "inspect")
      : undefined;
  }

  private async applyTabAction(
    prepared: PreparedTabMutation,
    signal: AbortSignal,
  ): Promise<BrowserAutomationResponse | undefined> {
    const { action } = prepared.request.args;
    if (action === "select") return this.selectTab(prepared);
    if (action === "claim") return this.claimTab(prepared);
    if (action === "release" || action === "close") return this.releaseOrCloseTab(prepared, signal);
    return action === "finalize" ? this.finalizeTabs(prepared, signal) : undefined;
  }

  private selectTab(prepared: PreparedTabMutation): undefined {
    const target = prepared.liveTarget;
    if (!target) return undefined;
    prepared.session.current = target;
    const controlled = prepared.session.tabs.get(target.tabId);
    if (controlled) prepared.session.tabs.set(target.tabId, { ...controlled, target });
    return undefined;
  }

  private claimTab(prepared: PreparedTabMutation): undefined {
    if (prepared.liveTarget) this.claimOrUpdateTab(prepared.session, prepared.liveTarget);
    return undefined;
  }

  private async releaseOrCloseTab(
    prepared: PreparedTabMutation,
    signal: AbortSignal,
  ): Promise<BrowserAutomationResponse | undefined> {
    const tabId = prepared.requestedTabId;
    if (!tabId) return undefined;
    const controlled = prepared.session.tabs.get(tabId);
    if (prepared.request.args.action === "close" && controlled?.provenance === "agent-created") {
      return (await this.closeControlledTab(
        prepared.dispatch,
        prepared.session,
        prepared.adapter,
        tabId,
        controlled,
        signal,
        prepared.liveTargets,
      )) ?? undefined;
    }
    if (controlled) {
      if (signal.aborted) return this.tabCancellation(prepared.dispatch, "Browser tab mutation was interrupted before releasing the tab");
      prepared.session.tabs.set(tabId, { ...controlled, ownership: "released", disposition: "release" });
    }
    if (prepared.session.current?.tabId === tabId) prepared.session.current = null;
    return undefined;
  }

  private async finalizeTabs(
    prepared: PreparedTabMutation,
    signal: AbortSignal,
  ): Promise<BrowserAutomationResponse | undefined> {
    const plan = this.finalizationPlan(prepared.session, prepared.request.args.dispositions as Array<{ tabId: string; disposition: TabDisposition }>);
    for (const entry of plan) {
      const response = await this.settleFinalizedTab(prepared, entry, signal);
      if (response) return response;
    }
    const handoff = this.finalHandoff(prepared.session.current, plan);
    prepared.session.current = null;
    return this.activateFinalizedHandoff(prepared, handoff, signal);
  }

  private finalizationPlan(
    session: ProviderTabSession,
    entries: readonly { readonly tabId: string; readonly disposition: TabDisposition }[],
  ): FinalizationPlanEntry[] {
    const dispositions = new Map(entries.map((entry) => [entry.tabId, entry.disposition]));
    return [...session.tabs].map(([tabId, controlled]) => ({
      tabId,
      controlled,
      disposition: this.finalDisposition(controlled, dispositions.get(tabId)),
    }));
  }

  private finalDisposition(controlled: ControlledTab, requested: TabDisposition | undefined): TabDisposition {
    if (controlled.provenance !== "claimed-user") return requested ?? "close";
    return requested === "handoff" || requested === "deliverable" ? requested : "release";
  }

  private async settleFinalizedTab(
    prepared: PreparedTabMutation,
    entry: FinalizationPlanEntry,
    signal: AbortSignal,
  ): Promise<BrowserAutomationResponse | undefined> {
    if (entry.disposition === "close") {
      return (await this.closeControlledTab(
        prepared.dispatch,
        prepared.session,
        prepared.adapter,
        entry.tabId,
        entry.controlled,
        signal,
        prepared.liveTargets,
      )) ?? undefined;
    }
    if (signal.aborted) return this.tabCancellation(prepared.dispatch, "Browser tab mutation was interrupted before settling the next tab");
    prepared.session.tabs.set(entry.tabId, { ...entry.controlled, ownership: "released", disposition: entry.disposition });
    if (prepared.session.current?.tabId === entry.tabId) prepared.session.current = null;
    return undefined;
  }

  private activateFinalizedHandoff(
    prepared: PreparedTabMutation,
    handoff: ControlledTab | undefined,
    signal: AbortSignal,
  ): Promise<BrowserAutomationResponse | undefined> {
    if (!handoff) return Promise.resolve(undefined);
    if (!prepared.adapter?.activate) {
      return Promise.resolve(this.tabHandoffFailure(prepared.dispatch, new Error("Browser tab activation is unavailable"), signal));
    }
    return prepared.adapter.activate(handoff.target, prepared.session.workspaceId)
      .then(
        () => undefined,
        (cause: unknown) => this.tabHandoffFailure(prepared.dispatch, cause, signal),
      );
  }

  private finalHandoff(
    current: BrowserAutomationHostDispatchTarget | null,
    plan: readonly FinalizationPlanEntry[],
  ): ControlledTab | undefined {
    if (current && plan.find((entry) => entry.tabId === current.tabId)?.disposition === "handoff") {
      return plan.find((entry) => entry.tabId === current.tabId)?.controlled;
    }
    return plan.find((entry) => entry.disposition === "handoff")?.controlled;
  }

  private completeTabsMutation(
    prepared: PreparedTabMutation,
    signal: AbortSignal,
  ): BrowserAutomationResponse {
    if (signal.aborted) return this.tabCancellation(prepared.dispatch, "Browser tab mutation was interrupted before completion");
    this.publishLifecycleProjectionInternal();
    const observationRef = this.rememberTabsObservation(prepared);
    return this.tabsResponse(prepared, observationRef);
  }

  private rememberTabsObservation(prepared: PreparedTabMutation): string | undefined {
    const current = prepared.session.current;
    if (!current) return undefined;
    const observationRef = globalThis.crypto.randomUUID();
    this.observations.set(observationRef, {
      hostRevision: current.connectionGeneration,
      documentRevision: current.targetGeneration,
      controlRevision: prepared.dispatch.request.expectedControlEpoch,
      capabilityRevision: prepared.capabilityRevision,
      humanInteractionRevision: this.currentHumanInteractionRevisionForTarget(prepared.session.workspaceId, current.threadId, current.tabId),
      targetKey: observationTargetKey(prepared.session.workspaceId, current.threadId, current.tabId),
      workspaceId: prepared.dispatch.request.workspaceId,
      threadId: current.threadId,
      providerSessionId: prepared.dispatch.request.providerSessionId,
      providerInstanceId: prepared.dispatch.request.providerInstanceId,
      observationRevision: prepared.observation.observationRevision + 1,
      targets: new Map(prepared.liveTargets),
    });
    return observationRef;
  }

  private tabsResponse(prepared: PreparedTabMutation, observationRef: string | undefined): BrowserAutomationResponse {
    const current = prepared.session.current;
    return {
      contractVersion: prepared.request.contractVersion,
      requestId: prepared.request.requestId,
      sequence: prepared.request.sequence,
      ok: true,
      result: {
        operation: "tabs",
        action: prepared.request.args.action,
        ...(current ? { currentTabId: current.tabId } : {}),
        ...(observationRef ? { observationRef } : {}),
        tabs: [...prepared.session.tabs.values()].map(({ target: _target, ...tab }) => tab),
      },
    };
  }

  private isControlTakingOperation(operation: string): boolean {
    return CONTROL_TAKING_OPERATIONS.has(operation);
  }

  private claimSuccessfulTarget(dispatch: BrowserAutomationHostDispatch): void {
    this.claimOrUpdateTab(this.tabSession(dispatch), dispatch.target);
    this.publishLifecycleProjectionInternal();
  }

  private claimOrUpdateTab(session: ProviderTabSession, target: BrowserAutomationHostDispatchTarget): void {
    const controlled = session.tabs.get(target.tabId);
    session.current = target;
    session.tabs.set(target.tabId, controlled
      ? {
          ...controlled,
          ownership: controlled.provenance === "agent-created" ? "owned" : "claimed",
          disposition: undefined,
          target,
        }
      : {
          tabId: target.tabId,
          provenance: "claimed-user",
          ownership: "claimed",
          target,
        });
  }

  private async closeControlledTab(
    dispatch: BrowserAutomationHostDispatch,
    session: ProviderTabSession,
    adapter: BrowserSessionTabLifecycleAdapter | undefined,
    tabId: string,
    controlled: ControlledTab,
    signal: AbortSignal,
    liveTargets?: Map<string, BrowserAutomationHostDispatchTarget>,
  ): Promise<BrowserAutomationResponse | null> {
    if (signal.aborted) {
      return this.tabCancellation(dispatch, "Browser tab mutation was interrupted before closing the tab");
    }
    if (!adapter) {
      this.preserveControlledTab(session, tabId, controlled);
      return this.tabCloseFailure(dispatch, new Error("Browser tab lifecycle adapter is unavailable"), signal, "preserved");
    }
    let closeCause: unknown;
    try {
      await adapter.close(controlled.target, session.workspaceId);
    } catch (cause) {
      closeCause = cause;
    }
    const effect = await this.reconcileClosedTab(dispatch, session, adapter, tabId, controlled, liveTargets);
    if (effect === "preserved") {
      return this.tabCloseFailure(
        dispatch,
        closeCause ?? new Error("Browser tab close did not remove the target"),
        signal,
        effect,
      );
    }
    if (signal.aborted) {
      return this.tabCancellation(dispatch, "Browser tab mutation was interrupted after closing the tab", effect);
    }
    if (closeCause) return this.tabCloseFailure(dispatch, closeCause, signal, effect);
    return null;
  }

  private async reconcileClosedTab(
    dispatch: BrowserAutomationHostDispatch,
    session: ProviderTabSession,
    adapter: BrowserSessionTabLifecycleAdapter,
    tabId: string,
    controlled: ControlledTab,
    liveTargets?: Map<string, BrowserAutomationHostDispatchTarget>,
  ): Promise<"closed" | "preserved"> {
    let liveTargetList: readonly BrowserAutomationHostDispatchTarget[];
    try {
      liveTargetList = await adapter.list(dispatch);
    } catch {
      // A failed reconciliation cannot prove that the physical target closed.
      this.preserveControlledTab(session, tabId, controlled);
      return "preserved";
    }
    if (liveTargets) {
      liveTargets.clear();
      for (const target of liveTargetList) liveTargets.set(target.tabId, target);
    }
    const liveTarget = liveTargetList.find((target) => this.sameTargetIdentity(target, controlled.target));
    if (!liveTarget) {
      session.tabs.delete(tabId);
      if (session.current?.tabId === tabId) session.current = null;
      this.publishLifecycleProjectionInternal();
      return "closed";
    }
    this.preserveControlledTab(session, tabId, controlled, liveTarget);
    return "preserved";
  }

  private sameTargetIdentity(
    left: BrowserAutomationHostDispatchTarget,
    right: BrowserAutomationHostDispatchTarget,
  ): boolean {
    return left.desktopInstanceId === right.desktopInstanceId &&
      left.windowId === right.windowId &&
      left.connectionGeneration === right.connectionGeneration &&
      left.threadId === right.threadId &&
      left.tabId === right.tabId &&
      left.targetGeneration === right.targetGeneration;
  }

  private preserveControlledTab(
    session: ProviderTabSession,
    tabId: string,
    controlled: ControlledTab,
    target: BrowserAutomationHostDispatchTarget = controlled.target,
  ): void {
    session.tabs.set(tabId, { ...controlled, target });
    if (session.current?.tabId === tabId) session.current = target;
    this.publishLifecycleProjectionInternal();
  }

  private tabCloseFailure(
    dispatch: BrowserAutomationHostDispatch,
    cause: unknown,
    signal: AbortSignal,
    effect: "closed" | "preserved",
  ): BrowserAutomationResponse {
    if (signal.aborted || this.isCancellation(cause)) {
      return this.tabCancellation(dispatch, "Browser tab mutation was interrupted while closing the tab", effect);
    }
    const detail = sanitizePublicDetail(cause instanceof Error ? cause.message : cause);
    return {
      contractVersion: dispatch.request.contractVersion,
      requestId: dispatch.request.requestId,
      sequence: dispatch.request.sequence,
      ok: false,
      error: {
        code: "TAB_UNAVAILABLE",
        message: detail ? `Browser tab close failed: ${detail}` : "Browser tab close failed",
        retryable: true,
        stage: "effect",
        effect,
        recovery: "inspect",
      },
    };
  }

  private tabHandoffFailure(
    dispatch: BrowserAutomationHostDispatch,
    cause: unknown,
    signal: AbortSignal,
  ): BrowserAutomationResponse {
    if (signal.aborted || this.isCancellation(cause)) {
      return this.tabCancellation(dispatch, "Browser tab mutation was interrupted while handing off the tab", "preserved");
    }
    const detail = sanitizePublicDetail(cause instanceof Error ? cause.message : cause);
    return {
      contractVersion: dispatch.request.contractVersion,
      requestId: dispatch.request.requestId,
      sequence: dispatch.request.sequence,
      ok: false,
      error: {
        code: "TAB_UNAVAILABLE",
        message: detail ? `Browser tab handoff failed: ${detail}` : "Browser tab handoff failed",
        retryable: true,
        stage: "effect",
        effect: "preserved",
        recovery: "inspect",
      },
    };
  }

  private stepDispatch(dispatch: BrowserAutomationHostDispatch, step: BrowserAutomationActStep, deadline: number, index: number): BrowserAutomationHostDispatch {
    const { operation, ...args } = step as unknown as Record<string, unknown>;
    return {
      ...dispatch,
      request: {
        ...dispatch.request,
        requestId: `${dispatch.request.requestId}:step:${index}`,
        sequence: dispatch.request.sequence + index,
        deadline,
        operation,
        args,
      },
    } as unknown as BrowserAutomationHostDispatch;
  }

  private async executeAssertStep(
    dispatch: BrowserAutomationHostDispatch,
    step: Extract<BrowserAutomationActStep, { operation: "assert" }>,
    signal: AbortSignal,
    deadline: number,
  ): Promise<BrowserAutomationResponse> {
    const conditions: Array<Record<string, unknown>> = [];
    if (step.target) conditions.push({ target: step.target, state: "visible" });
    if (step.text) conditions.push({ text: step.text });
    if (step.url) conditions.push({ url: step.url });
    let response: BrowserAutomationResponse | null = null;
    for (let index = 0; index < conditions.length; index += 1) {
      const timeoutMs = Math.max(1, deadline - Date.now());
      const waitDispatch = {
        ...dispatch,
        request: {
          ...dispatch.request,
          requestId: `${dispatch.request.requestId}:assert:${index}`,
          operation: "waitFor",
          args: { ...conditions[index], timeoutMs },
        },
      } as BrowserAutomationHostDispatch;
      response = await this.executeAdapter(waitDispatch, signal, { implicitClaim: false });
      if (!response.ok) return response;
    }
    return response!;
  }

  private actFailure(dispatch: BrowserAutomationHostDispatch, code: "STALE_TARGET_GENERATION" | "CAPABILITY_CHANGED" | "UNSUPPORTED_OPERATION", message: string): BrowserAutomationResponse {
    return { contractVersion: dispatch.request.contractVersion, requestId: dispatch.request.requestId, sequence: dispatch.request.sequence, ok: false, error: { code, message, retryable: false, stage: "observation", effect: "none", recovery: "inspect" } };
  }

  private rememberObservation(response: BrowserAutomationResponse, dispatch: BrowserAutomationHostDispatch): BrowserAutomationResponse {
    const result = this.observableResult(response);
    if (!result?.observationRef) return response;
    this.observations.set(result.observationRef, this.observationRecord(dispatch, result.tabs));
    return response;
  }

  private observableResult(
    response: BrowserAutomationResponse,
  ): { readonly observationRef?: string; readonly tabs?: BrowserAutomationHostDispatchTarget[] } | undefined {
    return response.ok && response.result
      ? response.result as { observationRef?: string; tabs?: BrowserAutomationHostDispatchTarget[] }
      : undefined;
  }

  private observationRecord(
    dispatch: BrowserAutomationHostDispatch,
    tabs: readonly BrowserAutomationHostDispatchTarget[] | undefined,
  ): ObservationRecord {
    return {
      hostRevision: dispatch.connection?.connectionGeneration ?? 0,
      documentRevision: dispatch.target.targetGeneration,
      controlRevision: dispatch.request.expectedControlEpoch,
      capabilityRevision: dispatch.connection?.capabilityRevision ?? this.options.getCapabilityRevision?.() ?? 1,
      humanInteractionRevision: this.currentHumanInteractionRevision(dispatch),
      targetKey: observationTargetKey(dispatch.request.workspaceId, dispatch.target.threadId, dispatch.target.tabId),
      workspaceId: dispatch.request.workspaceId,
      threadId: dispatch.request.threadId,
      providerSessionId: dispatch.request.providerSessionId,
      providerInstanceId: dispatch.request.providerInstanceId,
      observationRevision: 0,
      targets: new Map((tabs ?? [dispatch.target]).map((target) => [target.tabId, target])),
    };
  }

  private currentObservationBinding(dispatch: BrowserAutomationHostDispatch, capabilityRevision: number): Pick<ObservationRecord, "hostRevision" | "documentRevision" | "controlRevision" | "capabilityRevision"> {
    return {
      hostRevision: this.options.getHostRevision?.(dispatch) ?? dispatch.connection?.connectionGeneration ?? 0,
      documentRevision: this.options.getDocumentRevision?.(dispatch) ?? dispatch.target.targetGeneration,
      controlRevision: this.options.getControlRevision?.(dispatch) ?? dispatch.request.expectedControlEpoch,
      capabilityRevision,
    };
  }

  private currentHumanInteractionRevision(dispatch: BrowserAutomationHostDispatch): number {
    this.humanInteractionScopes.set(
      observationTargetKey(dispatch.request.workspaceId, dispatch.target.threadId, dispatch.target.tabId),
      {
        workspaceId: dispatch.request.workspaceId,
        threadId: dispatch.target.threadId,
        providerSessionId: dispatch.request.providerSessionId,
      },
    );
    return this.currentHumanInteractionRevisionForTarget(
      dispatch.request.workspaceId,
      dispatch.target.threadId,
      dispatch.target.tabId,
      dispatch,
    );
  }

  private currentHumanInteractionRevisionForTarget(
    workspaceId: string,
    threadId: string,
    tabId: string,
    dispatch?: BrowserAutomationHostDispatch,
  ): number {
    const targetRevision = this.humanInteractionRevisions.get(observationTargetKey(workspaceId, threadId, tabId)) ?? 0;
    const externalRevision = dispatch ? this.options.getHumanInteractionRevision?.(dispatch) : undefined;
    return Math.max(targetRevision, externalRevision ?? 0);
  }

  private observationStillCurrent(dispatch: BrowserAutomationHostDispatch, observation: ObservationRecord): boolean {
    const current = this.currentObservationBinding(dispatch, observation.capabilityRevision);
    return current.hostRevision === observation.hostRevision && current.documentRevision === observation.documentRevision && current.controlRevision === observation.controlRevision && current.capabilityRevision === observation.capabilityRevision && this.currentHumanInteractionRevision(dispatch) === observation.humanInteractionRevision;
  }

  private clearObservations(predicate: (observation: ObservationRecord) => boolean): void {
    for (const [observationRef, observation] of this.observations) {
      if (predicate(observation)) this.observations.delete(observationRef);
    }
  }

  private clearHumanInteractionTarget(targetKey: string): void {
    this.humanInteractionRevisions.delete(targetKey);
    this.humanInteractionScopes.delete(targetKey);
  }

  private clearHumanInteractionScopes(
    predicate: (scope: HumanInteractionScope) => boolean,
  ): void {
    for (const [targetKey, scope] of this.humanInteractionScopes) {
      if (predicate(scope)) this.clearHumanInteractionTarget(targetKey);
    }
  }

  private revisionDrift(dispatch: BrowserAutomationHostDispatch): BrowserAutomationResponse | null {
    const expectedRevision = dispatch.connection?.capabilityRevision;
    const currentRevision = this.options.getCapabilityRevision?.();
    if (expectedRevision !== undefined && currentRevision !== undefined && expectedRevision !== currentRevision) {
      return {
        contractVersion: dispatch.request.contractVersion,
        requestId: dispatch.request.requestId,
        sequence: dispatch.request.sequence,
        ok: false,
        error: {
          code: "CAPABILITY_CHANGED",
          message: "Browser executor capabilities changed; inspect before retrying",
          retryable: false,
          stage: "validation",
          effect: "none",
          recovery: "inspect",
        },
      };
    }
    return null;
  }

  private pruneIdempotency(): void {
    const cutoff = Date.now() - IDEMPOTENCY_TTL_MS;
    for (const [key, record] of this.idempotency) {
      if (record.lastUsedAt < cutoff) this.idempotency.delete(key);
    }
    for (const [key, record] of this.tabIdempotency) {
      if (record.lastUsedAt < cutoff) this.tabIdempotency.delete(key);
    }
  }

  private sessionKey(dispatch: BrowserAutomationHostDispatch): string {
    return JSON.stringify([
      dispatch.request.workspaceId,
      dispatch.request.providerSessionId,
      dispatch.request.providerInstanceId,
    ]);
  }

  private tabSession(dispatch: BrowserAutomationHostDispatch): ProviderTabSession {
    const key = this.sessionKey(dispatch);
    let session = this.tabSessions.get(key);
    if (!session) {
      session = {
        workspaceId: dispatch.request.workspaceId,
        providerSessionId: dispatch.request.providerSessionId,
        providerInstanceId: dispatch.request.providerInstanceId,
        lastDispatch: dispatch,
        current: null,
        tabs: new Map(),
      };
      this.tabSessions.set(key, session);
    } else {
      session.lastDispatch = dispatch;
    }
    return session;
  }

  private tabAdapter(): BrowserSessionTabLifecycleAdapter | undefined {
    return this.isElectron() ? this.options.electronTabs : this.options.webTabs;
  }

  private async releaseSessions(predicate: (session: ProviderTabSession) => boolean): Promise<void> {
    const adapter = this.tabAdapter();
    for (const [key, session] of this.tabSessions) {
      if (!predicate(session)) continue;
      await this.releaseSession(key, session, adapter);
    }
    this.publishLifecycleProjectionInternal();
  }

  private async releaseSession(
    key: string,
    session: ProviderTabSession,
    adapter: BrowserSessionTabLifecycleAdapter | undefined,
  ): Promise<void> {
    this.clearSessionHumanInteraction(session);
    const retained = await this.releaseSessionTabs(session, adapter);
    if (retained.size === 0) {
      this.tabSessions.delete(key);
      return;
    }
    this.restoreRetainedSessionTabs(session, retained);
  }

  private clearSessionHumanInteraction(session: ProviderTabSession): void {
    if (session.current) this.clearTabHumanInteraction(session, session.current);
    for (const tab of session.tabs.values()) this.clearTabHumanInteraction(session, tab.target);
  }

  private clearTabHumanInteraction(
    session: ProviderTabSession,
    target: BrowserAutomationHostDispatchTarget,
  ): void {
    this.clearHumanInteractionTarget(observationTargetKey(session.workspaceId, target.threadId, target.tabId));
  }

  private async releaseSessionTabs(
    session: ProviderTabSession,
    adapter: BrowserSessionTabLifecycleAdapter | undefined,
  ): Promise<Map<string, ControlledTab>> {
    const retained = new Map<string, ControlledTab>();
    for (const tab of session.tabs.values()) {
      if (!this.isReleasableAgentTab(tab)) continue;
      const retainedTab = await this.releaseSessionTab(session, tab, adapter);
      if (retainedTab) retained.set(retainedTab.tabId, retainedTab);
    }
    return retained;
  }

  private isReleasableAgentTab(tab: ControlledTab): boolean {
    return tab.provenance === "agent-created" && tab.ownership !== "released";
  }

  private async releaseSessionTab(
    session: ProviderTabSession,
    tab: ControlledTab,
    adapter: BrowserSessionTabLifecycleAdapter | undefined,
  ): Promise<ControlledTab | undefined> {
    if (!adapter) return tab;
    await adapter.close(tab.target, session.workspaceId).then(() => undefined, () => undefined);
    const effect = await this.reconcileClosedTab(session.lastDispatch, session, adapter, tab.tabId, tab);
    return effect === "preserved" ? session.tabs.get(tab.tabId) ?? tab : undefined;
  }

  private restoreRetainedSessionTabs(session: ProviderTabSession, retained: ReadonlyMap<string, ControlledTab>): void {
    session.tabs.clear();
    for (const [tabId, tab] of retained) session.tabs.set(tabId, tab);
    if (!session.current || !retained.has(session.current.tabId)) session.current = null;
  }

  private publishLifecycleProjectionInternal(): void {
    const observer = this.options.onLifecycleChange;
    if (!observer) return;
    const tabs: BrowserSessionLifecycleTab[] = [];
    for (const session of this.tabSessions.values()) {
      for (const tab of session.tabs.values()) {
        if (tab.ownership === "released") continue;
        tabs.push({
          ...tab,
          workspaceId: session.workspaceId,
          threadId: tab.target.threadId,
          providerSessionId: session.providerSessionId,
          providerInstanceId: session.providerInstanceId,
        });
      }
    }
    observer(tabs.slice(0, MAX_LIFECYCLE_TABS));
  }

  private failure(
    dispatch: BrowserAutomationHostDispatch,
    code: "BROWSER_BUSY" | "IDEMPOTENCY_CONFLICT" | "STALE_TARGET_GENERATION",
    message: string,
    recovery: "wait" | "manual" | "inspect",
  ): BrowserAutomationResponse {
    return {
      contractVersion: dispatch.request.contractVersion,
      requestId: dispatch.request.requestId,
      sequence: dispatch.request.sequence,
      ok: false,
      error: {
        code,
        message,
        retryable: recovery === "wait",
        stage: code === "STALE_TARGET_GENERATION" ? "observation" : code === "BROWSER_BUSY" ? "allocation" : "validation",
        effect: "none",
        recovery,
      },
    };
  }

  private tabCancellation(
    dispatch: BrowserAutomationHostDispatch,
    message: string,
    effect: "none" | "closed" | "preserved" = "none",
  ): BrowserAutomationResponse {
    return {
      contractVersion: dispatch.request.contractVersion,
      requestId: dispatch.request.requestId,
      sequence: dispatch.request.sequence,
      ok: false,
      error: {
        code: "OPERATION_CANCELLED",
        message,
        retryable: false,
        stage: "effect",
        effect,
        recovery: "inspect",
      },
    };
  }
}
