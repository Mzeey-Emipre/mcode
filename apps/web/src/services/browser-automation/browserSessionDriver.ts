import type {
  BrowserAutomationHostDispatch,
  BrowserAutomationResponse,
  BrowserAutomationActStep,
} from "@mcode/contracts";

const MAX_IDEMPOTENCY_RECORDS = 256;
const IDEMPOTENCY_TTL_MS = 30 * 60_000;

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
  readonly targetGeneration: number;
  readonly controlRevision: number;
  readonly capabilityRevision: number;
  observationRevision: number;
}

/** Runtime implementation used by the client BrowserSessionDriver. */
export interface BrowserSessionRuntimeAdapter {
  execute(
    dispatch: BrowserAutomationHostDispatch,
    signal: AbortSignal,
  ): Promise<BrowserAutomationResponse>;
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
}

/**
 * Client orchestration boundary for Browser v1 commands. The driver chooses
 * the active runtime adapter; broker transport and native Electron mechanics
 * stay outside this class.
 */
export class BrowserSessionDriver {
  private readonly isElectron: () => boolean;
  private readonly idempotency = new Map<string, IdempotencyRecord>();
  private readonly observations = new Map<string, ObservationRecord>();

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
    if (dispatch.request?.operation === "act") return this.executeAct(dispatch, signal);
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
    const promise = this.executeAdapter(normalized, signal)
      .then((response) => this.withObservationRef(response));
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
  }

  /** Clears replay state bound to one browser target after that target closes or is replaced. */
  clearIdempotencyForTarget(threadId: string, tabId: string): void {
    for (const [key, record] of this.idempotency) {
      if (record.target.threadId === threadId && record.target.tabId === tabId) this.idempotency.delete(key);
    }
  }

  private withObservationRef(response: BrowserAutomationResponse): BrowserAutomationResponse {
    if (!response.ok || response.result.operation !== "open" || response.result.observationRef) return response;
    return { ...response, result: { ...response.result, observationRef: globalThis.crypto.randomUUID() } };
  }

  private executeAdapter(
    dispatch: BrowserAutomationHostDispatch,
    signal: AbortSignal,
  ): Promise<BrowserAutomationResponse> {
    const drift = this.revisionDrift(dispatch);
    if (drift) return Promise.resolve(drift);
    return (this.isElectron() ? this.options.electron : this.options.web).execute(dispatch, signal)
      .then((response) => this.rememberObservation(response, dispatch));
  }

  private executeAct(
    dispatch: BrowserAutomationHostDispatch,
    signal: AbortSignal,
  ): Promise<BrowserAutomationResponse> {
    const request = dispatch.request as Extract<BrowserAutomationHostDispatch["request"], { operation: "act" }>;
    const observation = this.observations.get(request.args.observationRef);
    const capabilityRevision = this.options.getCapabilityRevision?.() ?? dispatch.connection?.capabilityRevision ?? 1;
    const baseObservation = observation ?? {
      targetGeneration: dispatch.target.targetGeneration,
      controlRevision: request.expectedControlEpoch,
      capabilityRevision,
      observationRevision: 0,
    };
    if (!observation || observation.targetGeneration !== dispatch.target.targetGeneration || observation.controlRevision !== request.expectedControlEpoch || observation.capabilityRevision !== capabilityRevision) {
      return Promise.resolve(this.actFailure(dispatch, "STALE_TARGET_GENERATION", "Browser observation is stale; inspect before browser_act"));
    }
    const deadline = Math.min(dispatch.request.deadline, Date.now() + request.args.deadlineMs);
    const receipts: Array<{ index: number; operation: string; status: "applied" | "satisfied" | "failed" | "interrupted" | "skipped"; message?: string }> = [];
    const nextObservationRef = globalThis.crypto.randomUUID();
    let effect: "none" | "partial" | "complete" = "none";
    let outcome: "completed" | "failed" | "interrupted" = "completed";
    let stoppingPosition = request.args.steps.length;
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
        if (drift) {
          outcome = "interrupted";
          stoppingPosition = index;
          receipts.push({ index, operation: step.operation, status: "interrupted", message: "Browser capability revision changed" });
          for (let skipped = index + 1; skipped < request.args.steps.length; skipped += 1) receipts.push({ index: skipped, operation: request.args.steps[skipped]!.operation, status: "skipped" });
          break;
        }
        const stepDispatch = this.stepDispatch(dispatch, step, deadline, index);
        const response = await this.executeAdapter(stepDispatch, signal);
        if (!response.ok) {
          outcome = response.error.code === "OPERATION_CANCELLED" || response.error.code === "HUMAN_INTERRUPTED" || response.error.code === "DEADLINE_EXCEEDED" ? "interrupted" : "failed";
          stoppingPosition = index;
          receipts.push({ index, operation: step.operation, status: outcome === "interrupted" ? "interrupted" : "failed", message: response.error.message });
          for (let skipped = index + 1; skipped < request.args.steps.length; skipped += 1) receipts.push({ index: skipped, operation: request.args.steps[skipped]!.operation, status: "skipped" });
          break;
        }
        receipts.push({ index, operation: step.operation, status: step.operation === "assert" || step.operation === "wait" ? "satisfied" : "applied" });
        effect = "complete";
        if (step.operation === "navigate" || step.operation === "back" || step.operation === "forward" || step.operation === "reload") {
          stoppingPosition = index + 1;
          for (let skipped = index + 1; skipped < request.args.steps.length; skipped += 1) receipts.push({ index: skipped, operation: request.args.steps[skipped]!.operation, status: "skipped" });
          break;
        }
      }
      if (outcome !== "completed" && effect === "complete") effect = "partial";
      if (outcome === "completed" && stoppingPosition < request.args.steps.length) outcome = "completed";
      const finalObservation = {
        observationRef: nextObservationRef,
        hostRevision: dispatch.target.targetGeneration,
        documentRevision: dispatch.target.targetGeneration,
        controlRevision: request.expectedControlEpoch,
        capabilityRevision,
        observationRevision: baseObservation.observationRevision + 1,
      };
      this.observations.set(nextObservationRef, { targetGeneration: finalObservation.hostRevision, controlRevision: finalObservation.controlRevision, capabilityRevision, observationRevision: finalObservation.observationRevision });
      return {
        contractVersion: request.contractVersion,
        requestId: request.requestId,
        sequence: request.sequence,
        ok: true,
        result: { operation: "act", outcome, stoppingPosition, effect, recovery: outcome === "interrupted" ? "inspect" : "inspect", receipts, finalObservation, nextObservationRef },
      } as BrowserAutomationResponse;
    };
    return run();
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

  private actFailure(dispatch: BrowserAutomationHostDispatch, code: "STALE_TARGET_GENERATION" | "CAPABILITY_CHANGED", message: string): BrowserAutomationResponse {
    return { contractVersion: dispatch.request.contractVersion, requestId: dispatch.request.requestId, sequence: dispatch.request.sequence, ok: false, error: { code, message, retryable: false, stage: "observation", effect: "none", recovery: "inspect" } };
  }

  private rememberObservation(response: BrowserAutomationResponse, dispatch: BrowserAutomationHostDispatch): BrowserAutomationResponse {
    if (!response.ok) return response;
    const result = response.result as { observationRef?: string };
    if (!result.observationRef) return response;
    this.observations.set(result.observationRef, {
      targetGeneration: dispatch.target.targetGeneration,
      controlRevision: dispatch.request.expectedControlEpoch,
      capabilityRevision: dispatch.connection?.capabilityRevision ?? this.options.getCapabilityRevision?.() ?? 1,
      observationRevision: 0,
    });
    return response;
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
  }

}
