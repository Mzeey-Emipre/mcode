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
  return [
    "inspect",
    "act",
    "tabs",
    ...BROWSER_AUTOMATION_OPERATIONS.filter((operation) =>
      recordingAvailable || (operation !== "recordingStart" && operation !== "recordingStop"),
    ),
  ];
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
  readonly target: { threadId: string; tabId: string; windowId: number; targetGeneration: number };
  lastUsedAt: number;
  readonly promise: Promise<BrowserAutomationResponse>;
}

interface ObservationRecord {
  readonly hostRevision: number;
  readonly documentRevision: number;
  readonly controlRevision: number;
  readonly capabilityRevision: number;
  observationRevision: number;
  readonly targets: ReadonlyMap<string, BrowserAutomationHostDispatchTarget>;
}

interface TabReplayRecord {
  readonly fingerprint: string;
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
  current: BrowserAutomationHostDispatchTarget | null;
  readonly tabs: Map<string, ControlledTab>;
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
  close(target: BrowserAutomationHostDispatchTarget): Promise<void>;
}

/** Renderer-side adapter that forwards Browser v1 commands to Electron preload. */
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

/** Runtime selection inputs for the single Browser v1 command boundary. */
export interface BrowserSessionDriverOptions {
  readonly web: BrowserSessionRuntimeAdapter;
  readonly electron: BrowserSessionRuntimeAdapter;
  readonly isElectron?: () => boolean;
  readonly getCapabilityRevision?: () => number;
  readonly getHostRevision?: (dispatch: BrowserAutomationHostDispatch) => number;
  readonly getDocumentRevision?: (dispatch: BrowserAutomationHostDispatch) => number;
  readonly getControlRevision?: (dispatch: BrowserAutomationHostDispatch) => number;
  readonly supportedActOperations?: readonly string[] | (() => readonly string[]);
  readonly webTabs?: BrowserSessionTabLifecycleAdapter;
  readonly electronTabs?: BrowserSessionTabLifecycleAdapter;
  /** Receives the bounded lifecycle projection after ownership changes. */
  readonly onLifecycleChange?: (tabs: readonly BrowserSessionLifecycleTab[]) => void;
}

/**
 * Client orchestration boundary for Browser v1 commands. The driver chooses
 * the active runtime adapter; broker transport and native Electron mechanics
 * stay outside this class.
 */
export class BrowserSessionDriver {
  private readonly isElectron: () => boolean;
  private readonly idempotency = new Map<string, IdempotencyRecord>();
  private readonly tabIdempotency = new Map<string, TabReplayRecord>();
  private readonly observations = new Map<string, ObservationRecord>();
  private readonly tabSessions = new Map<string, ProviderTabSession>();
  private readonly activeTabMutations = new Set<string>();

  constructor(private readonly options: BrowserSessionDriverOptions) {
    this.isElectron = options.isElectron ?? (() => typeof window !== "undefined" && typeof window.desktopBridge?.preview === "object");
  }

  /** Dispatch one broker-authorized Browser v1 command through the active runtime adapter. */
  execute(
    dispatch: BrowserAutomationHostDispatch,
    signal: AbortSignal,
  ): Promise<BrowserAutomationResponse> {
    const initialDrift = this.revisionDrift(dispatch);
    if (initialDrift) return Promise.resolve(initialDrift);
    if (dispatch.request?.operation === "evaluate") return this.executeEvaluate(dispatch, signal);
    if (dispatch.request?.operation === "act") return this.executeAct(dispatch, signal);
    if (dispatch.request?.operation === "tabs") return this.executeTabs(dispatch, signal);
    if (dispatch.request?.operation !== "open") {
      return this.executeAdapter(dispatch, signal);
    }

    // Legacy/internal bootstrap callers without the v2 key retain the exact
    // dispatch object and adapter contract. Authenticated MCP opens always
    // carry idempotencyKey and enter the v2 lifecycle below.
    if (dispatch.request.args.idempotencyKey === undefined) {
      return this.executeAdapter(dispatch, signal);
    }

    this.pruneIdempotency();
    const request = dispatch.request;
    const key = request.args.idempotencyKey;
    const scopeKey = JSON.stringify([request.providerSessionId, request.providerInstanceId, key]);
    const fingerprint = JSON.stringify({
      url: request.args.url ?? null,
      workspaceId: request.workspaceId,
      threadId: request.threadId,
    });
    const existing = this.idempotency.get(scopeKey);
    if (existing) {
      const sameTarget = existing.target.threadId === request.threadId &&
        existing.target.tabId === dispatch.target.tabId &&
        existing.target.windowId === dispatch.target.windowId &&
        existing.target.targetGeneration === dispatch.target.targetGeneration;
      if (!sameTarget) {
        this.idempotency.delete(scopeKey);
      } else {
        existing.lastUsedAt = Date.now();
        if (existing.fingerprint !== fingerprint) {
          return Promise.resolve({
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
          });
        }
        return existing.promise.then((response) => ({
          ...response,
          requestId: request.requestId,
          sequence: request.sequence,
        }));
      }
    }

    const normalized = {
      ...dispatch,
      request: {
        ...request,
        args: {
          ...(request.args.url ? { url: request.args.url } : {}),
          idempotencyKey: key,
        },
      },
    } as OpenDispatch;
    const mutationKey = this.sessionKey(dispatch);
    if (this.activeTabMutations.has(mutationKey)) {
      return Promise.resolve(this.failure(dispatch, "BROWSER_BUSY", "Another browser mutation is active for this provider session", "wait"));
    }
    this.activeTabMutations.add(mutationKey);
    const session = this.tabSession(dispatch);
    if ([...session.tabs.values()].filter((tab) => tab.provenance === "agent-created" && tab.ownership !== "released").length >= 3) {
      this.activeTabMutations.delete(mutationKey);
      return Promise.resolve(this.failure(dispatch, "BROWSER_BUSY", "This provider session already owns three agent-created tabs", "wait"));
    }
    const promise = this.executeAdapter(normalized, signal)
      .then((response) => {
        if (response.ok) {
          session.current = dispatch.target;
          session.tabs.set(dispatch.target.tabId, {
            tabId: dispatch.target.tabId,
            provenance: "agent-created",
            ownership: "owned",
            target: dispatch.target,
          });
          this.publishLifecycleProjectionInternal();
        }
        return this.withObservationRef(response);
      })
      .finally(() => this.activeTabMutations.delete(mutationKey));
    this.idempotency.set(scopeKey, {
      fingerprint,
      target: {
        threadId: request.threadId,
        tabId: dispatch.target.tabId,
        windowId: dispatch.target.windowId,
        targetGeneration: dispatch.target.targetGeneration,
      },
      lastUsedAt: Date.now(),
      promise,
    });
    while (this.idempotency.size > MAX_IDEMPOTENCY_RECORDS) {
      const oldest = this.idempotency.keys().next().value as string | undefined;
      if (!oldest) break;
      this.idempotency.delete(oldest);
    }
    return promise;
  }

  /** Clears bounded replay state when a provider session or host is released. */
  clearIdempotency(): void {
    this.idempotency.clear();
    this.tabIdempotency.clear();
  }

  /** Publishes retained browser ownership after a host reconnects. */
  publishLifecycleProjection(): void {
    this.publishLifecycleProjectionInternal();
  }

  /** Clears replay state bound to one browser target after that target closes or is replaced. */
  clearIdempotencyForTarget(threadId: string, tabId: string): void {
    for (const [key, record] of this.idempotency) {
      if (record.target.threadId === threadId && record.target.tabId === tabId) this.idempotency.delete(key);
    }
    for (const session of this.tabSessions.values()) {
      if (session.current?.threadId === threadId && session.current.tabId === tabId) session.current = null;
      session.tabs.delete(tabId);
    }
    this.publishLifecycleProjectionInternal();
  }

  /** Returns the exact target selected by a successful lifecycle response. */
  responseTarget(dispatch: BrowserAutomationHostDispatch, response: BrowserAutomationResponse): BrowserAutomationHostDispatchTarget {
    if (!response.ok || response.result.operation !== "tabs") return dispatch.target;
    return this.tabSessions.get(this.sessionKey(dispatch))?.current ?? dispatch.target;
  }

  /** Settles every tab owned or claimed by one terminated provider session. */
  async releaseProviderSession(providerSessionId: string): Promise<void> {
    await this.releaseSessions((session) => session.providerSessionId === providerSessionId);
  }

  /** Settles every tab owned or claimed by one deleted thread. */
  async releaseThread(threadId: string): Promise<void> {
    await this.releaseSessions((session) => [...session.tabs.values()].some((tab) => tab.target.threadId === threadId));
  }

  /** Settles every tab owned or claimed by one deleted workspace. */
  async releaseWorkspace(workspaceId: string): Promise<void> {
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
    if (supported && request.args.steps.some((step: BrowserAutomationActStep) => !supported.includes(step.operation))) {
      return Promise.resolve(this.actFailure(dispatch, "UNSUPPORTED_OPERATION", "Browser runtime cannot execute every browser_act step"));
    }
    const currentBinding = this.currentObservationBinding(dispatch, capabilityRevision);
    const baseObservation = observation ?? {
      ...currentBinding,
      capabilityRevision,
      observationRevision: 0,
      targets: new Map([[dispatch.target.tabId, dispatch.target]]),
    };
    if (!observation || observation.hostRevision !== currentBinding.hostRevision || observation.documentRevision !== currentBinding.documentRevision || observation.controlRevision !== currentBinding.controlRevision || observation.capabilityRevision !== currentBinding.capabilityRevision) {
      return Promise.resolve(this.actFailure(dispatch, "STALE_TARGET_GENERATION", "Browser observation is stale; inspect before browser_act"));
    }
    this.observations.delete(request.args.observationRef);
    const deadline = Math.min(dispatch.request.deadline, Date.now() + request.args.deadlineMs);
    const receipts: Array<{ index: number; operation: string; status: "applied" | "satisfied" | "failed" | "interrupted" | "skipped"; message?: string }> = [];
    const nextObservationRef = globalThis.crypto.randomUUID();
    let effect: "none" | "partial" | "complete" = "none";
    let outcome: "completed" | "failed" | "interrupted" = "completed";
    let stoppingPosition = request.args.steps.length;
    let documentRevision = baseObservation.documentRevision;
    const run = async (): Promise<BrowserAutomationResponse> => {
      for (let index = 0; index < request.args.steps.length; index += 1) {
        const step = request.args.steps[index] as BrowserAutomationActStep;
        if (signal.aborted || Date.now() >= deadline) {
          outcome = "interrupted";
          stoppingPosition = index;
          receipts.push({ index, operation: step.operation, status: "interrupted", message: "Browser batch interrupted before the next effect" });
          for (let skipped = index + 1; skipped < request.args.steps.length; skipped += 1) receipts.push({ index: skipped, operation: request.args.steps[skipped]!.operation, status: "skipped" });
          break;
        }
        const drift = this.revisionDrift(dispatch);
        if (drift || !this.observationStillCurrent(dispatch, baseObservation)) {
          outcome = "interrupted";
          stoppingPosition = index;
          receipts.push({ index, operation: step.operation, status: "interrupted", message: "Browser capability revision changed" });
          for (let skipped = index + 1; skipped < request.args.steps.length; skipped += 1) receipts.push({ index: skipped, operation: request.args.steps[skipped]!.operation, status: "skipped" });
          break;
        }
        const stepDispatch = this.stepDispatch(dispatch, step, deadline, index);
        const response = await this.executeAdapter(stepDispatch, signal, { implicitClaim: false });
        if (!response.ok) {
          outcome = response.error.code === "OPERATION_CANCELLED" || response.error.code === "HUMAN_INTERRUPTED" || response.error.code === "DEADLINE_EXCEEDED" ? "interrupted" : "failed";
          stoppingPosition = index;
          receipts.push({ index, operation: step.operation, status: outcome === "interrupted" ? "interrupted" : "failed", message: sanitizePublicDetail(response.error.message) });
          for (let skipped = index + 1; skipped < request.args.steps.length; skipped += 1) receipts.push({ index: skipped, operation: request.args.steps[skipped]!.operation, status: "skipped" });
          break;
        }
        receipts.push({ index, operation: step.operation, status: step.operation === "assert" || step.operation === "wait" ? "satisfied" : "applied" });
        effect = "complete";
        if (step.operation === "navigate" || step.operation === "back" || step.operation === "forward" || step.operation === "reload") {
          documentRevision += 1;
          stoppingPosition = index + 1;
          for (let skipped = index + 1; skipped < request.args.steps.length; skipped += 1) receipts.push({ index: skipped, operation: request.args.steps[skipped]!.operation, status: "skipped" });
          break;
        }
      }
      if (outcome !== "completed" && effect === "complete") effect = "partial";
      if (outcome === "completed" && stoppingPosition < request.args.steps.length) outcome = "completed";
      const finalObservation = {
        observationRef: nextObservationRef,
        hostRevision: baseObservation.hostRevision,
        documentRevision,
        controlRevision: baseObservation.controlRevision,
        capabilityRevision,
        observationRevision: baseObservation.observationRevision + 1,
      };
      this.observations.set(nextObservationRef, { hostRevision: finalObservation.hostRevision, documentRevision: finalObservation.documentRevision, controlRevision: finalObservation.controlRevision, capabilityRevision, observationRevision: finalObservation.observationRevision, targets: baseObservation.targets });
      return {
        contractVersion: request.contractVersion,
        requestId: request.requestId,
        sequence: request.sequence,
        ok: true,
        result: { operation: "act", outcome, stoppingPosition, effect, recovery: outcome === "interrupted" ? "inspect" : "inspect", receipts, finalObservation, nextObservationRef },
      } as BrowserAutomationResponse;
    };
    const hasControlTakingStep = request.args.steps.some((step: BrowserAutomationActStep) => this.isControlTakingOperation(step.operation));
    return run().then((response) => {
      if (response.ok && response.result.operation === "act" && response.result.outcome === "completed" && hasControlTakingStep) {
        this.claimSuccessfulTarget(dispatch);
      }
      return response;
    });
  }

  private executeEvaluate(
    dispatch: BrowserAutomationHostDispatch,
    signal: AbortSignal,
  ): Promise<BrowserAutomationResponse> {
    if (!this.isElectron()) {
      return Promise.resolve(this.operationFailure(dispatch, "UNSUPPORTED_OPERATION", "Browser evaluation requires the Electron runtime"));
    }
    const request = dispatch.request as Extract<BrowserAutomationHostDispatch["request"], { operation: "evaluate" }>;
    const observation = this.observations.get(request.args.observationRef);
    const capabilityRevision = this.options.getCapabilityRevision?.() ?? dispatch.connection?.capabilityRevision ?? 1;
    const currentBinding = this.currentObservationBinding(dispatch, capabilityRevision);
    if (!observation) {
      return Promise.resolve(this.operationFailure(dispatch, "STALE_TARGET_GENERATION", "Browser observation is stale; inspect before browser_evaluate"));
    }
    if (
      observation.hostRevision !== currentBinding.hostRevision ||
      observation.documentRevision !== currentBinding.documentRevision ||
      observation.controlRevision !== currentBinding.controlRevision ||
      observation.capabilityRevision !== currentBinding.capabilityRevision
    ) {
      return Promise.resolve(this.operationFailure(dispatch, "STALE_TARGET_GENERATION", "Browser observation is stale; inspect before browser_evaluate"));
    }
    const deadline = Math.min(dispatch.request.deadline, Date.now() + request.args.deadlineMs);
    if (signal.aborted || Date.now() >= deadline) {
      this.observations.delete(request.args.observationRef);
      return Promise.resolve(this.evaluateEnvelope(dispatch, observation, {
        outcome: "interrupted",
        effect: "none",
        status: "interrupted",
        message: signal.aborted ? "Browser evaluation was interrupted before the effect" : "Browser evaluation deadline elapsed before the effect",
      }));
    }
    const finalDrift = this.revisionDrift(dispatch);
    if (finalDrift || !this.observationStillCurrent(dispatch, observation)) {
      return Promise.resolve(this.operationFailure(dispatch, "STALE_TARGET_GENERATION", "Browser observation changed before browser_evaluate"));
    }
    this.observations.delete(request.args.observationRef);
    const boundedDispatch: BrowserAutomationHostDispatch = {
      ...dispatch,
      request: { ...dispatch.request, deadline },
    };
    return this.options.electron.execute(boundedDispatch, signal)
      .then((response) => this.evaluateResponse(dispatch, observation, response, signal))
      .catch((cause: unknown) => this.evaluateEnvelope(dispatch, observation, {
        outcome: this.isCancellation(cause) ? "interrupted" : "failed",
        effect: "partial",
        status: this.isCancellation(cause) ? "interrupted" : "failed",
        message: sanitizePublicDetail(cause instanceof Error ? cause.message : cause),
      }));
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
    const sessionKey = this.sessionKey(dispatch);
    if (signal.aborted) {
      return Promise.resolve(this.tabCancellation(dispatch, "Browser tab mutation was interrupted before the effect"));
    }
    const replayKey = JSON.stringify([request.providerSessionId, request.providerInstanceId, request.args.idempotencyKey]);
    const fingerprint = JSON.stringify(request.args);
    const replay = this.tabIdempotency.get(replayKey);
    if (replay) {
      replay.lastUsedAt = Date.now();
      if (replay.fingerprint !== fingerprint) {
        return Promise.resolve(this.failure(dispatch, "IDEMPOTENCY_CONFLICT", "The idempotency key was already used with different browser_tabs arguments", "manual"));
      }
      return replay.promise.then((response) => ({ ...response, requestId: request.requestId, sequence: request.sequence }));
    }
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
    this.tabIdempotency.set(replayKey, { fingerprint, lastUsedAt: Date.now(), promise });
    this.pruneIdempotency();
    return promise;
  }

  private async applyTabsMutation(
    dispatch: BrowserAutomationHostDispatch,
    observation: ObservationRecord,
    capabilityRevision: number,
    signal: AbortSignal,
  ): Promise<BrowserAutomationResponse> {
    const request = dispatch.request as Extract<BrowserAutomationHostDispatch["request"], { operation: "tabs" }>;
    const session = this.tabSession(dispatch);
    const adapter = this.tabAdapter();
    if (signal.aborted) {
      return this.tabCancellation(dispatch, "Browser tab mutation was interrupted before enumeration");
    }
    const liveTargets = new Map((adapter ? await adapter.list(dispatch) : [dispatch.target]).map((target) => [target.tabId, target]));
    if (signal.aborted) {
      return this.tabCancellation(dispatch, "Browser tab mutation was interrupted before the next effect");
    }
    if (!this.observationStillCurrent(dispatch, observation)) {
      return this.failure(dispatch, "STALE_TARGET_GENERATION", "Browser generations changed before the next tab effect", "inspect");
    }
    const requestedTabId = request.args.action === "select" || request.args.action === "claim"
      ? request.args.tabId
      : request.args.action === "release" || request.args.action === "close"
        ? request.args.tabId ?? session.current?.tabId
        : undefined;
    const observedTarget = requestedTabId ? observation.targets.get(requestedTabId) : undefined;
    const liveTarget = requestedTabId ? liveTargets.get(requestedTabId) : undefined;
    if (requestedTabId && (!observedTarget || !liveTarget || observedTarget.targetGeneration !== liveTarget.targetGeneration || observedTarget.connectionGeneration !== liveTarget.connectionGeneration)) {
      return this.failure(dispatch, "STALE_TARGET_GENERATION", "The selected Browser tab changed after it was observed", "inspect");
    }
    if (request.args.action === "finalize") {
      const staleControlledTab = [...session.tabs.values()].find((controlled) => {
        const observed = observation.targets.get(controlled.tabId);
        const live = liveTargets.get(controlled.tabId);
        return !observed || !live || observed.targetGeneration !== live.targetGeneration || observed.connectionGeneration !== live.connectionGeneration;
      });
      if (staleControlledTab) {
        return this.failure(dispatch, "STALE_TARGET_GENERATION", "A controlled Browser tab changed after it was observed", "inspect");
      }
    }

    if (request.args.action === "select" && liveTarget) {
      session.current = liveTarget;
      const controlled = session.tabs.get(liveTarget.tabId);
      if (controlled) session.tabs.set(liveTarget.tabId, { ...controlled, target: liveTarget });
    } else if (request.args.action === "claim" && liveTarget) {
      this.claimOrUpdateTab(session, liveTarget);
    } else if ((request.args.action === "release" || request.args.action === "close") && requestedTabId) {
      const controlled = session.tabs.get(requestedTabId);
      if (request.args.action === "close" && controlled?.provenance === "agent-created") {
        const closeResult = await this.closeControlledTab(dispatch, session, adapter, requestedTabId, controlled, signal);
        if (closeResult) return closeResult;
      } else if (controlled) {
        if (signal.aborted) {
          return this.tabCancellation(dispatch, "Browser tab mutation was interrupted before releasing the tab");
        }
        session.tabs.set(requestedTabId, { ...controlled, ownership: "released", disposition: "release" });
      }
      if (session.current?.tabId === requestedTabId) session.current = null;
    } else if (request.args.action === "finalize") {
      type Disposition = "close" | "release" | "handoff" | "deliverable";
      const entries = request.args.dispositions as Array<{ tabId: string; disposition: Disposition }>;
      const dispositions = new Map<string, Disposition>(entries.map((entry) => [entry.tabId, entry.disposition]));
      for (const [tabId, controlled] of [...session.tabs]) {
        const requested = dispositions.get(tabId);
        const disposition = controlled.provenance === "claimed-user"
          ? requested === "handoff" || requested === "deliverable" ? requested : "release"
          : requested ?? "close";
        if (disposition === "close") {
          const closeResult = await this.closeControlledTab(dispatch, session, adapter, tabId, controlled, signal);
          if (closeResult) return closeResult;
        } else {
          if (signal.aborted) {
            return this.tabCancellation(dispatch, "Browser tab mutation was interrupted before settling the next tab");
          }
          session.tabs.set(tabId, { ...controlled, ownership: "released", disposition });
          if (session.current?.tabId === tabId) session.current = null;
        }
      }
      session.current = null;
    }

    if (signal.aborted) {
      return this.tabCancellation(dispatch, "Browser tab mutation was interrupted before completion");
    }
    this.publishLifecycleProjectionInternal();

    const nextObservationRef = session.current ? globalThis.crypto.randomUUID() : undefined;
    if (session.current && nextObservationRef) {
      this.observations.set(nextObservationRef, {
        hostRevision: session.current.connectionGeneration,
        documentRevision: session.current.targetGeneration,
        controlRevision: dispatch.request.expectedControlEpoch,
        capabilityRevision,
        observationRevision: observation.observationRevision + 1,
        targets: new Map(liveTargets),
      });
    }
    return {
      contractVersion: request.contractVersion,
      requestId: request.requestId,
      sequence: request.sequence,
      ok: true,
      result: {
        operation: "tabs",
        action: request.args.action,
        ...(session.current ? { currentTabId: session.current.tabId } : {}),
        ...(nextObservationRef ? { observationRef: nextObservationRef } : {}),
        tabs: [...session.tabs.values()].map(({ target: _target, ...tab }) => tab),
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
  ): Promise<BrowserAutomationResponse | null> {
    if (signal.aborted) {
      return this.tabCancellation(dispatch, "Browser tab mutation was interrupted before closing the tab");
    }
    try {
      await adapter?.close(controlled.target);
    } catch (cause) {
      return this.tabCloseFailure(dispatch, cause, signal);
    }
    session.tabs.delete(tabId);
    if (session.current?.tabId === tabId) session.current = null;
    if (signal.aborted) {
      return this.tabCancellation(dispatch, "Browser tab mutation was interrupted after closing the tab", "unknown");
    }
    return null;
  }

  private tabCloseFailure(
    dispatch: BrowserAutomationHostDispatch,
    cause: unknown,
    signal: AbortSignal,
  ): BrowserAutomationResponse {
    if (signal.aborted || this.isCancellation(cause)) {
      return this.tabCancellation(dispatch, "Browser tab mutation was interrupted while closing the tab", "unknown");
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
        effect: "unknown",
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

  private actFailure(dispatch: BrowserAutomationHostDispatch, code: "STALE_TARGET_GENERATION" | "CAPABILITY_CHANGED" | "UNSUPPORTED_OPERATION", message: string): BrowserAutomationResponse {
    return { contractVersion: dispatch.request.contractVersion, requestId: dispatch.request.requestId, sequence: dispatch.request.sequence, ok: false, error: { code, message, retryable: false, stage: "observation", effect: "none", recovery: "inspect" } };
  }

  private rememberObservation(response: BrowserAutomationResponse, dispatch: BrowserAutomationHostDispatch): BrowserAutomationResponse {
    if (!response.ok || !response.result) return response;
    const result = response.result as { observationRef?: string; tabs?: BrowserAutomationHostDispatchTarget[] };
    if (!result.observationRef) return response;
    this.observations.set(result.observationRef, {
      hostRevision: dispatch.connection?.connectionGeneration ?? 0,
      documentRevision: dispatch.target.targetGeneration,
      controlRevision: dispatch.request.expectedControlEpoch,
      capabilityRevision: dispatch.connection?.capabilityRevision ?? this.options.getCapabilityRevision?.() ?? 1,
      observationRevision: 0,
      targets: new Map((result.tabs ?? [dispatch.target]).map((target) => [target.tabId, target])),
    });
    return response;
  }

  private currentObservationBinding(dispatch: BrowserAutomationHostDispatch, capabilityRevision: number): Pick<ObservationRecord, "hostRevision" | "documentRevision" | "controlRevision" | "capabilityRevision"> {
    return {
      hostRevision: this.options.getHostRevision?.(dispatch) ?? dispatch.connection?.connectionGeneration ?? 0,
      documentRevision: this.options.getDocumentRevision?.(dispatch) ?? dispatch.target.targetGeneration,
      controlRevision: this.options.getControlRevision?.(dispatch) ?? dispatch.request.expectedControlEpoch,
      capabilityRevision,
    };
  }

  private observationStillCurrent(dispatch: BrowserAutomationHostDispatch, observation: ObservationRecord): boolean {
    const current = this.currentObservationBinding(dispatch, observation.capabilityRevision);
    return current.hostRevision === observation.hostRevision && current.documentRevision === observation.documentRevision && current.controlRevision === observation.controlRevision && current.capabilityRevision === observation.capabilityRevision;
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
    return JSON.stringify([dispatch.request.providerSessionId, dispatch.request.providerInstanceId]);
  }

  private tabSession(dispatch: BrowserAutomationHostDispatch): ProviderTabSession {
    const key = this.sessionKey(dispatch);
    let session = this.tabSessions.get(key);
    if (!session) {
      session = {
        workspaceId: dispatch.request.workspaceId,
        providerSessionId: dispatch.request.providerSessionId,
        providerInstanceId: dispatch.request.providerInstanceId,
        current: null,
        tabs: new Map(),
      };
      this.tabSessions.set(key, session);
    }
    return session;
  }

  private tabAdapter(): BrowserSessionTabLifecycleAdapter | undefined {
    return this.isElectron() ? this.options.electronTabs : this.options.webTabs;
  }

  private async releaseSessions(predicate: (session: ProviderTabSession) => boolean): Promise<void> {
    const adapter = this.tabAdapter();
    for (const [key, session] of [...this.tabSessions]) {
      if (!predicate(session)) continue;
      for (const tab of session.tabs.values()) {
        if (tab.provenance === "agent-created" && tab.ownership !== "released") {
          await adapter?.close(tab.target);
        }
      }
      this.tabSessions.delete(key);
    }
    this.publishLifecycleProjectionInternal();
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
    effect: "none" | "unknown" = "none",
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
