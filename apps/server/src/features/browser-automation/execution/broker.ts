import type { WebSocket } from "ws";
import { createHash, randomUUID } from "node:crypto";
import {
  BROWSER_AUTOMATION_CONTRACT_VERSION,
  BROWSER_AUTOMATION_MAX_PENDING_REQUESTS,
  BrowserAutomationHostDispatchTargetSchema,
  BrowserAutomationHostDispatchSchema,
  BrowserAutomationHostRegistrationSchema,
  BrowserAutomationRequestSchema,
  BrowserAutomationResponseSchema,
  type BrowserAutomationErrorCode,
  type BrowserAutomationActStep,
  type BrowserAutomationHostRegistration,
  type BrowserAutomationHostDispatchTarget,
  type BrowserAutomationHostDispatch,
  type BrowserAutomationRequest,
  type BrowserAutomationResponse,
  type BrowserAutomationOperation,
  type BrowserAutomationPublicOperation,
  type BrowserAutomationRequestOperation,
} from "@mcode/contracts";
import { sendToClient } from "../../../transport/push.js";
import type { BrowserAutomationCredentialClaims } from "../access/credential-registry.js";
import {
  BrowserAutomationTelemetry,
  browserAutomationTerminalFields,
  type BrowserAutomationNightlyEvidenceReport,
  type BrowserAutomationTelemetryEvent,
  type BrowserAutomationTelemetryStage,
} from "../observability/telemetry.js";

interface RegisteredHost {
  socket: WebSocket;
  registration: BrowserAutomationHostRegistration;
  generation: number;
  lastHeartbeatAt: number;
  pending: number;
  heartbeatTimer?: ReturnType<typeof setTimeout>;
  targets: Map<string, BrowserAutomationHostDispatchTarget>;
  targetGenerationTombstones: Map<string, { generation: number; windowId: number }>;
}

interface PendingRequest {
  host: RegisteredHost;
  providerId: string;
  request: BrowserAutomationRequest;
  target?: BrowserAutomationHostDispatchTarget;
  dispatch?: BrowserAutomationHostDispatch;
  resolve: (response: BrowserAutomationResponse) => void;
  timer: ReturnType<typeof setTimeout>;
  startedAt: number;
  credentialOperations: readonly BrowserAutomationPublicOperation[];
}

interface OpenReplayRecord {
  readonly fingerprint: string;
  readonly promise: Promise<BrowserAutomationResponse>;
  host?: RegisteredHost;
  target?: BrowserAutomationHostDispatchTarget;
  lastUsedAt: number;
}

interface ActReplayRecord {
  readonly fingerprint: string;
  readonly promise: Promise<BrowserAutomationResponse>;
  lastUsedAt: number;
}

interface EvaluateReplayRecord {
  readonly fingerprint: string;
  readonly promise: Promise<BrowserAutomationResponse>;
  lastUsedAt: number;
}

interface TabsReplayRecord {
  readonly fingerprint: string;
  readonly promise: Promise<BrowserAutomationResponse>;
  lastUsedAt: number;
}

/** Content-free reliability counters for the browser automation broker. */
export interface BrowserAutomationReliabilityCounters {
  dispatched: number;
  succeeded: number;
  failed: number;
  timedOut: number;
  interrupted: number;
  truncated: number;
  hostLosses: number;
  capacityRejected: number;
  latencyTotalMs: number;
  latencyMaxMs: number;
  /** Round-trip timing from broker admission through host response settlement. */
  roundTripLatency: BrowserAutomationLatencyPercentiles;
}

/** Percentiles over the bounded Browser broker round-trip window. */
export interface BrowserAutomationLatencyPercentiles {
  samples: number;
  p50Ms: number | null;
  p95Ms: number | null;
  p99Ms: number | null;
}

/** Function used by the broker to deliver a directed, validated push event. */
export type BrowserAutomationDirectedSender = (
  socket: WebSocket,
  channel: "browserAutomation.bootstrap" | "browserAutomation.request" | "browserAutomation.cancel" | "browserAutomation.sessionRelease",
  data: unknown,
) => boolean;

/** Reason sent to a renderer when a provider-session-owned Browser lifecycle ends. */
export type BrowserAutomationSessionReleaseReason = "credential-revoked" | "provider-session-ended";

/** Server-derived identity and workspace scope expected for one renderer connection. */
export interface BrowserAutomationHostConnectionAuthorization {
  desktopInstanceId: string;
  worktreeIdentity: string;
  allowedWorkspaceIds: readonly string[];
  /** Whether this connection may register the development-only web runtime. */
  allowWebRuntime?: boolean;
}

/** Options controlling browser host routing, timing, and delivery. */
export interface BrowserAutomationBrokerOptions {
  send?: BrowserAutomationDirectedSender;
  now?: () => number;
  maxPendingRequests?: number;
  maxAssignments?: number;
  assignmentTtlMs?: number;
  hostHeartbeatTimeoutMs?: number;
  maxHosts?: number;
  maxTargets?: number;
  maxLatencySamples?: number;
  telemetry?: BrowserAutomationTelemetry;
}

const PUBLIC_OPERATIONS = new Set<string>(["open", "inspect", "act", "tabs", "evaluate"]);

function isPublicOperation(
  operation: BrowserAutomationRequestOperation,
): operation is BrowserAutomationPublicOperation {
  return PUBLIC_OPERATIONS.has(operation);
}
const MAX_LATENCY_SAMPLES = 256;
const MAX_LATENCY_SAMPLE_MS = 24 * 60 * 60 * 1_000;

function browserV2Recovery(code: BrowserAutomationErrorCode): "inspect" | "reopen" | "wait" | "yield_to_user" | "do_not_retry" {
  switch (code) {
    case "CAPABILITY_CHANGED":
    case "STALE_TARGET_GENERATION":
    case "STALE_CONTROL_EPOCH":
      return "inspect";
    case "TAB_UNAVAILABLE":
    case "TARGET_NOT_FOUND":
      return "reopen";
    case "HOST_UNAVAILABLE":
    case "BROWSER_BUSY":
    case "TIMEOUT":
      return "wait";
    case "HUMAN_INTERRUPTED":
      return "yield_to_user";
    default:
      return "do_not_retry";
  }
}

function failure(
  request: BrowserAutomationRequest,
  code: BrowserAutomationErrorCode,
  message: string,
  retryable: boolean,
): BrowserAutomationResponse {
  const recovery = browserV2Recovery(code);
  return {
    contractVersion: BROWSER_AUTOMATION_CONTRACT_VERSION,
    requestId: request.requestId,
    sequence: request.sequence,
    ok: false,
    error: {
      code,
      message,
      retryable,
      stage: code === "TAB_UNAVAILABLE" || code === "BROWSER_BUSY" ? "allocation" : "transport",
      effect: "none",
      recovery,
      correlationId: request.requestId,
    },
  };
}

function assignmentKeyParts(
  providerId: string,
  providerSessionId: string,
  worktreeIdentity: string,
  workspaceId: string,
  threadId: string,
): string {
  return JSON.stringify([
    providerId,
    providerSessionId,
    worktreeIdentity,
    workspaceId,
    threadId,
  ]);
}

function assignmentKey(claims: BrowserAutomationCredentialClaims): string {
  return assignmentKeyParts(
    claims.providerId,
    claims.providerSessionId,
    claims.worktreeIdentity,
    claims.workspaceId,
    claims.threadId,
  );
}

function pendingKey(host: RegisteredHost, requestId: string, sequence: number): string {
  return JSON.stringify([host.registration.hostId, host.generation, requestId, sequence]);
}

function targetKey(target: Pick<BrowserAutomationHostDispatchTarget, "threadId" | "tabId">): string {
  return JSON.stringify([target.threadId, target.tabId]);
}

function openReplayKey(
  providerId: string,
  request: Pick<BrowserAutomationRequest, "providerSessionId" | "workspaceId" | "threadId"> & {
    args?: { idempotencyKey?: string };
  },
): string | null {
  const key = request.args?.idempotencyKey;
  if (!key) return null;
  return JSON.stringify([providerId, request.providerSessionId, request.workspaceId, request.threadId, key]);
}

function actReplayKey(providerId: string, request: Extract<BrowserAutomationRequest, { operation: "act" }>): string {
  return JSON.stringify([providerId, request.providerSessionId, request.workspaceId, request.threadId, request.args.idempotencyKey]);
}

function evaluateReplayKey(providerId: string, request: Extract<BrowserAutomationRequest, { operation: "evaluate" }>): string {
  return JSON.stringify([providerId, request.providerSessionId, request.workspaceId, request.threadId, request.args.idempotencyKey]);
}

function hashExpression(expression: string): string {
  return createHash("sha256").update(expression, "utf8").digest("hex");
}

function tabsReplayKey(providerId: string, request: Extract<BrowserAutomationRequest, { operation: "tabs" }>): string {
  return JSON.stringify([providerId, request.providerSessionId, request.workspaceId, request.threadId, request.args.idempotencyKey]);
}

function sessionRoutingKey(providerId: string, providerSessionId: string): string {
  return JSON.stringify([providerId, providerSessionId]);
}

function targetsMatch(
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

function isExactTargetReplacement(
  oldTarget: BrowserAutomationHostDispatchTarget,
  replacement: BrowserAutomationHostDispatchTarget,
): boolean {
  return replacement.desktopInstanceId === oldTarget.desktopInstanceId &&
    replacement.windowId === oldTarget.windowId &&
    replacement.connectionGeneration === oldTarget.connectionGeneration &&
    replacement.targetGeneration === oldTarget.targetGeneration + 1;
}

function incrementBounded(value: number, amount = 1): number {
  return Math.min(Number.MAX_SAFE_INTEGER, value + Math.max(0, amount));
}

function latencyPercentile(sorted: readonly number[], quantile: number): number | null {
  if (sorted.length === 0) return null;
  const index = Math.max(0, Math.ceil(sorted.length * quantile) - 1);
  return sorted[index] ?? null;
}

function summarizeLatency(values: readonly number[]): BrowserAutomationLatencyPercentiles {
  const sorted = [...values].sort((left, right) => left - right);
  return {
    samples: sorted.length,
    p50Ms: latencyPercentile(sorted, 0.5),
    p95Ms: latencyPercentile(sorted, 0.95),
    p99Ms: latencyPercentile(sorted, 0.99),
  };
}

function responseWasTruncated(response: BrowserAutomationResponse): boolean {
  if (!response.ok) return false;
  const result = response.result as unknown as Record<string, unknown>;
  const snapshot = typeof result.snapshot === "object" && result.snapshot !== null
    ? result.snapshot as Record<string, unknown>
    : null;
  const screenshot = typeof result.screenshot === "object" && result.screenshot !== null
    ? result.screenshot as Record<string, unknown>
    : null;
  const snapshotScreenshot = snapshot && typeof snapshot.screenshot === "object" && snapshot.screenshot !== null
    ? snapshot.screenshot as Record<string, unknown>
    : null;
  const truncations = [
    result.truncation,
    screenshot?.truncation,
    snapshot?.visibleTextTruncation,
    snapshot?.elementsTruncation,
    snapshot?.accessibilityTruncation,
    snapshot?.consoleTruncation,
    snapshot?.networkTruncation,
    snapshot?.actionsTruncation,
    snapshotScreenshot?.truncation,
  ];
  return truncations.some((candidate) =>
    typeof candidate === "object" && candidate !== null && (candidate as { truncated?: unknown }).truncated === true,
  );
}

function requestWaitsForPage(request: BrowserAutomationRequest): boolean {
  if (request.operation !== "act") return false;
  return request.args.steps.some((step: BrowserAutomationActStep) =>
    step.operation === "wait" ||
    step.operation === "assert" ||
    step.operation === "navigate" ||
    step.operation === "reload" ||
    step.operation === "back" ||
    step.operation === "forward",
  );
}

function shapeNegotiatedResponse(
  response: BrowserAutomationResponse,
  pending: PendingRequest,
): BrowserAutomationResponse {
  if (!response.ok) return response;
  const descriptor = pending.host.registration.executorDescriptor;
  const allowed = new Set<string>(pending.credentialOperations);
  const liveHostCapabilities = new Set(
    pending.host.registration.capabilities
      .filter((capability) => capability.available)
      .map((capability) => capability.operation),
  );
  const negotiatedCapabilities = descriptor.operations.filter((operation): operation is BrowserAutomationPublicOperation =>
    allowed.has(operation) && liveHostCapabilities.has(operation),
  );
  if (response.result.operation === "inspect") {
    const hostObservationRef = typeof response.result.observationRef === "string" && response.result.observationRef.length > 0
      ? response.result.observationRef
      : undefined;
    const actReady = hostObservationRef !== undefined;
    const advertisedCapabilities = actReady || !negotiatedCapabilities.includes("act")
      ? negotiatedCapabilities
      : negotiatedCapabilities.filter((operation) => operation !== "act");
    const targetReady = pending.target !== undefined;
    const guidance = pending.target?.controller?.controller === "human"
      ? "Visible Preview under human control. Yield to user before effects."
      : `Visible browser executor (${descriptor.runtime}) supports: ${advertisedCapabilities.join(", ") || "none"}.`;
    const snapshot = response.result.snapshot && response.result.snapshot.visibleText.length > descriptor.constraints.maxSnapshotChars
      ? {
          ...response.result.snapshot,
          visibleText: response.result.snapshot.visibleText.slice(0, descriptor.constraints.maxSnapshotChars),
          visibleTextTruncation: {
            truncated: true as const,
            originalCount: response.result.snapshot.visibleText.length,
            reason: "character-limit" as const,
          },
        }
      : response.result.snapshot;
    const diagnostics = response.result.diagnostics?.slice(0, descriptor.constraints.maxDiagnostics);
    const inspectedTabs = pending.target
      ? [pending.target, ...response.result.tabs.filter((tab) => tab.tabId !== pending.target?.tabId)]
      : response.result.tabs;
    return {
      ...response,
      result: {
        ...response.result,
        readiness: !targetReady
          ? { ready: false, state: "target-unavailable", reason: "Visible browser target is unavailable" }
          : pending.target?.controller?.controller === "human"
            ? { ready: false, state: "human-control", reason: "Visible Preview is under human control" }
            : { ready: true, state: "ready" },
        target: pending.target
          ? { threadId: pending.target.threadId, tabId: pending.target.tabId, targetGeneration: pending.target.targetGeneration, sticky: true }
          : undefined,
        tabs: inspectedTabs.slice(0, descriptor.constraints.maxTabs),
        snapshot,
        ...(diagnostics ? { diagnostics } : {}),
        ...(hostObservationRef
          ? { observationRef: hostObservationRef }
          : !negotiatedCapabilities.includes("act")
            ? { observationRef: randomUUID() }
            : {}),
        capabilities: advertisedCapabilities,
        capabilityRevision: descriptor.capabilityRevision,
        guidance: guidance.slice(0, 4_000),
      },
    };
  }
  return response;
}

/** Routes scoped browser requests to one sticky, capability-compatible renderer host. */
export class BrowserAutomationBroker {
  private readonly hostsBySocket = new Map<WebSocket, RegisteredHost>();
  private readonly assignments = new Map<string, { host: RegisteredHost; targetKey: string; lastUsedAt: number }>();
  private readonly pending = new Map<string, PendingRequest>();
  private readonly send: BrowserAutomationDirectedSender;
  private readonly now: () => number;
  private readonly maxPendingRequests: number;
  private readonly maxAssignments: number;
  private readonly assignmentTtlMs: number;
  private readonly hostHeartbeatTimeoutMs: number;
  private readonly maxHosts: number;
  private readonly maxTargets: number;
  private readonly maxLatencySamples: number;
  private readonly telemetry: BrowserAutomationTelemetry;
  private readonly openReplay = new Map<string, OpenReplayRecord>();
  private readonly actReplay = new Map<string, ActReplayRecord>();
  private readonly evaluateReplay = new Map<string, EvaluateReplayRecord>();
  private readonly browserMutations = new Map<string, string>();
  private readonly tabsReplay = new Map<string, TabsReplayRecord>();
  private readonly sessionHosts = new Map<string, RegisteredHost>();
  private readonly latencySamples: number[] = [];
  private latencySampleCursor = 0;
  private nextGeneration = 1;
  private readonly reliability: BrowserAutomationReliabilityCounters = {
    dispatched: 0,
    succeeded: 0,
    failed: 0,
    timedOut: 0,
    interrupted: 0,
    truncated: 0,
    hostLosses: 0,
    capacityRejected: 0,
    latencyTotalMs: 0,
    latencyMaxMs: 0,
    roundTripLatency: { samples: 0, p50Ms: null, p95Ms: null, p99Ms: null },
  };

  constructor(options: BrowserAutomationBrokerOptions) {
    this.send = options.send ?? sendToClient;
    this.now = options.now ?? Date.now;
    this.maxPendingRequests = options.maxPendingRequests ?? BROWSER_AUTOMATION_MAX_PENDING_REQUESTS;
    this.maxAssignments = options.maxAssignments ?? 256;
    this.assignmentTtlMs = options.assignmentTtlMs ?? 30 * 60_000;
    this.hostHeartbeatTimeoutMs = options.hostHeartbeatTimeoutMs ?? 30_000;
    this.maxHosts = options.maxHosts ?? 8;
    this.maxTargets = options.maxTargets ?? 128;
    this.maxLatencySamples = options.maxLatencySamples ?? MAX_LATENCY_SAMPLES;
    this.telemetry = options.telemetry ?? new BrowserAutomationTelemetry();
    if (
      !Number.isInteger(this.maxPendingRequests) ||
      this.maxPendingRequests < 1 ||
      this.maxPendingRequests > BROWSER_AUTOMATION_MAX_PENDING_REQUESTS
    ) {
      throw new Error("Browser automation broker capacity is invalid");
    }
    if (!Number.isInteger(this.maxAssignments) || this.maxAssignments < 1 || this.maxAssignments > 4_096) {
      throw new Error("Browser automation assignment capacity is invalid");
    }
    if (!Number.isInteger(this.assignmentTtlMs) || this.assignmentTtlMs < 1_000 || this.assignmentTtlMs > 24 * 60 * 60_000) {
      throw new Error("Browser automation assignment TTL is invalid");
    }
    if (!Number.isInteger(this.hostHeartbeatTimeoutMs) || this.hostHeartbeatTimeoutMs < 1_000 || this.hostHeartbeatTimeoutMs > 5 * 60_000) {
      throw new Error("Browser automation heartbeat timeout is invalid");
    }
    if (!Number.isInteger(this.maxHosts) || this.maxHosts < 1 || this.maxHosts > 64) {
      throw new Error("Browser automation host capacity is invalid");
    }
    if (!Number.isInteger(this.maxTargets) || this.maxTargets < 1 || this.maxTargets > 4_096) {
      throw new Error("Browser automation target capacity is invalid");
    }
    if (!Number.isInteger(this.maxLatencySamples) || this.maxLatencySamples < 1 || this.maxLatencySamples > MAX_LATENCY_SAMPLES) {
      throw new Error("Browser automation latency sample capacity is invalid");
    }
  }

  /** Registers or replaces the single browser host owned by one WebSocket connection. */
  registerHost(
    socket: WebSocket,
    input: unknown,
    authorization: BrowserAutomationHostConnectionAuthorization | null,
  ): { generation: number; desktopInstanceId: string } {
    const registration = BrowserAutomationHostRegistrationSchema().parse(input);
    const rawDescriptor = typeof input === "object" && input !== null
      ? (input as { executorDescriptor?: { runtime?: unknown } }).executorDescriptor
      : undefined;
    if (rawDescriptor && rawDescriptor.runtime !== registration.runtime) {
      throw new Error("Browser automation executor descriptor runtime does not match host runtime");
    }
    if (registration.runtime === "web" && authorization?.allowWebRuntime !== true) {
      throw new Error("Browser automation web host registration is disabled");
    }
    if (registration.runtime !== "web" && registration.targetIdentity) {
      throw new Error("Browser automation target identity is reserved for web hosts");
    }
    if (
      !authorization ||
      registration.workspaceIds.some((workspaceId) => !authorization.allowedWorkspaceIds.includes(workspaceId))
    ) {
      throw new Error("Browser automation host registration is not authorized for this connection");
    }
    const trustedRegistration: BrowserAutomationHostRegistration = {
      ...registration,
      desktopInstanceId: authorization.desktopInstanceId,
      worktreeIdentity: authorization.worktreeIdentity,
    };
    if (
      trustedRegistration.targetIdentity &&
      trustedRegistration.targetIdentity.worktreeIdentity !== trustedRegistration.worktreeIdentity
    ) {
      throw new Error("Browser automation target identity does not match its authorized worktree");
    }
    if (
      trustedRegistration.targetIdentity &&
      trustedRegistration.targetIdentity.connectionId !== registration.desktopInstanceId &&
      trustedRegistration.targetIdentity.connectionId !== "pending-desktop"
    ) {
      throw new Error("Browser automation target identity does not match its connection");
    }
    if (
      trustedRegistration.targetIdentity &&
      !trustedRegistration.workspaceIds.includes(trustedRegistration.targetIdentity.workspaceId)
    ) {
      throw new Error("Browser automation target identity workspace is not authorized");
    }
    this.disconnect(socket);
    const existingOwner = [...this.hostsBySocket.values()].find(
      (host) => host.registration.hostId === trustedRegistration.hostId,
    );
    if (existingOwner) {
      if (
        existingOwner.registration.desktopInstanceId !== trustedRegistration.desktopInstanceId ||
        existingOwner.registration.worktreeIdentity !== trustedRegistration.worktreeIdentity
      ) {
        throw new Error("Browser automation host ID is already registered");
      }
      if (existingOwner.registration.executorDescriptor?.capabilityRevision !== registration.executorDescriptor?.capabilityRevision) {
        for (const [key, pending] of this.pending) {
          if (pending.host !== existingOwner) continue;
          this.settle(key, pending, failure(pending.request, "CAPABILITY_CHANGED", "Browser executor capabilities changed; inspect before retrying", false));
        }
      }
      this.disconnect(existingOwner.socket);
    }
    if (this.hostsBySocket.size >= this.maxHosts) {
      throw new Error("Browser automation host capacity is exhausted");
    }
    const generation = this.nextGeneration++;
    const host: RegisteredHost = {
      socket,
      registration: trustedRegistration,
      generation,
      lastHeartbeatAt: this.now(),
      pending: 0,
      targets: new Map(),
      targetGenerationTombstones: new Map(),
    };
    host.heartbeatTimer = this.scheduleHeartbeatExpiry(host);
    this.hostsBySocket.set(socket, host);
    return { generation, desktopInstanceId: authorization.desktopInstanceId };
  }

  /** Replaces the exact desktop-main-derived targets advertised by one authorized host. */
  updateTargets(
    socket: WebSocket,
    hostId: string,
    generation: number,
    input: unknown,
  ): void {
    const host = this.requireHost(socket, hostId, generation);
    const targets = BrowserAutomationHostDispatchTargetSchema().array().max(64).parse(input);
    const retainedByOtherHosts = [...this.hostsBySocket.values()].reduce(
      (count, candidate) => count + (candidate === host ? 0 : candidate.targets.size),
      0,
    );
    if (retainedByOtherHosts + targets.length > this.maxTargets) {
      throw new Error("Browser automation target capacity is exhausted");
    }
    const next = new Map<string, BrowserAutomationHostDispatchTarget>();
    for (const target of targets) {
      if (
        target.desktopInstanceId !== host.registration.desktopInstanceId ||
        target.connectionGeneration !== host.generation
      ) {
        throw new Error("Browser automation target identity does not match its authorized host");
      }
      const key = targetKey(target);
      if (next.has(key)) throw new Error("Browser automation targets must be unique by thread and tab");
      const prior = host.targetGenerationTombstones.get(key);
      if (
        prior &&
        (target.targetGeneration < prior.generation ||
          (target.targetGeneration === prior.generation && target.windowId !== prior.windowId))
      ) {
        throw new Error("Browser automation target generation is stale");
      }
      next.set(key, target);
    }

    for (const [key, oldTarget] of host.targets) {
      const replacement = next.get(key);
      if (replacement && replacement.targetGeneration === oldTarget.targetGeneration && replacement.windowId === oldTarget.windowId) continue;
      this.invalidateTarget(host, key, replacement !== undefined && isExactTargetReplacement(oldTarget, replacement));
    }
    for (const [key, target] of next) {
      host.targetGenerationTombstones.delete(key);
      host.targetGenerationTombstones.set(key, {
        generation: target.targetGeneration,
        windowId: target.windowId,
      });
    }
    while (host.targetGenerationTombstones.size > 128) {
      const oldest = host.targetGenerationTombstones.keys().next().value as string | undefined;
      if (!oldest) break;
      if (next.has(oldest)) {
        const current = host.targetGenerationTombstones.get(oldest)!;
        host.targetGenerationTombstones.delete(oldest);
        host.targetGenerationTombstones.set(oldest, current);
        continue;
      }
      host.targetGenerationTombstones.delete(oldest);
    }
    host.targets = next;
  }

  /** Records liveness for the current generation of one registered host. */
  heartbeat(socket: WebSocket, hostId: string, generation: number): void {
    const host = this.requireHost(socket, hostId, generation);
    host.lastHeartbeatAt = this.now();
    clearTimeout(host.heartbeatTimer);
    host.heartbeatTimer = this.scheduleHeartbeatExpiry(host);
  }

  /** Resolves a pending request only when host generation, request, and sequence all match. */
  respond(
    socket: WebSocket,
    hostId: string,
    generation: number,
    input: unknown,
    inputTarget?: unknown,
  ): void {
    const host = this.requireHost(socket, hostId, generation);
    const response = BrowserAutomationResponseSchema().parse(input);
    const responseTarget = inputTarget === undefined
      ? undefined
      : BrowserAutomationHostDispatchTargetSchema().parse(inputTarget);
    const key = pendingKey(host, response.requestId, response.sequence);
    const pending = this.pending.get(key);
    if (!pending) return;
    const negotiatedResponse = shapeNegotiatedResponse(response, pending);
    if (negotiatedResponse.ok && negotiatedResponse.result.operation !== pending.request.operation) {
      this.settle(
        key,
        pending,
        failure(pending.request, "INVALID_REQUEST", "Browser response operation does not match its request", false),
      );
      return;
    }
    if (
      negotiatedResponse.ok &&
      pending.request.operation === "evaluate" &&
      negotiatedResponse.result.operation === "evaluate" &&
      !("outcome" in negotiatedResponse.result)
    ) {
      this.settle(
        key,
        pending,
        failure(pending.request, "INVALID_REQUEST", "Browser evaluation response is missing its mutation envelope", false),
      );
      return;
    }
    if (negotiatedResponse.ok && !pending.target) {
      if (!responseTarget) {
        this.settle(
          key,
          pending,
          failure(pending.request, "INVALID_REQUEST", "Browser bootstrap response is missing its exact target", false),
        );
        return;
      }
      const targetError = this.adoptBootstrapTarget(pending, responseTarget);
      if (targetError) {
        this.settle(key, pending, failure(pending.request, "INVALID_REQUEST", targetError, false));
        return;
      }
      if (pending.request.operation === "open") {
        const replayKey = openReplayKey(pending.providerId, pending.request);
        if (replayKey) {
          const replay = this.openReplay.get(replayKey);
          if (replay) {
            replay.host = pending.host;
            replay.target = responseTarget;
          }
        }
      }
    } else if (responseTarget && pending.target && !targetsMatch(responseTarget, pending.target) && !this.isTabsResponseTarget(pending, responseTarget)) {
      this.settle(
        key,
        pending,
        failure(
          pending.request,
          targetKey(responseTarget) === targetKey(pending.target)
            ? "STALE_TARGET_GENERATION"
            : "INVALID_REQUEST",
          "Browser response target does not match its request",
          false,
        ),
      );
      return;
    }
    if (negotiatedResponse.ok && pending.request.operation === "tabs" && negotiatedResponse.result.operation === "tabs") {
      this.updateTabsAssignment(pending, negotiatedResponse.result, responseTarget);
    }
    this.settle(key, pending, negotiatedResponse);
  }

  /** Interrupts a pending request after a human or host-side stop signal. */
  cancelFromHost(
    socket: WebSocket,
    hostId: string,
    generation: number,
    requestId: string,
    sequence: number,
    reason: "human-interrupted" | "user-stopped" | "host-shutdown",
  ): void {
    const host = this.requireHost(socket, hostId, generation);
    const key = pendingKey(host, requestId, sequence);
    const pending = this.pending.get(key);
    if (!pending) return;
    const code = reason === "human-interrupted"
      ? "HUMAN_INTERRUPTED"
      : reason === "user-stopped"
        ? "OPERATION_CANCELLED"
        : "HOST_UNAVAILABLE";
    this.settle(
      key,
      pending,
      failure(pending.request, code, "Browser operation was interrupted", code !== "OPERATION_CANCELLED"),
    );
  }

  /** Cancels one exact in-flight request owned by an authenticated provider credential. */
  cancelFromProvider(
    claims: BrowserAutomationCredentialClaims,
    requestId: string,
    sequence: number,
  ): boolean {
    for (const [key, pending] of this.pending) {
      if (
        pending.providerId !== claims.providerId ||
        pending.request.providerSessionId !== claims.providerSessionId ||
        pending.request.providerInstanceId !== claims.mcodeSessionId ||
        pending.request.threadId !== claims.threadId ||
        pending.request.workspaceId !== claims.workspaceId ||
        pending.request.requestId !== requestId ||
        pending.request.sequence !== sequence
      ) continue;
      this.trySend(pending.host.socket, "browserAutomation.cancel", {
        hostId: pending.host.registration.hostId,
        generation: pending.host.generation,
        ...(pending.target ? { target: pending.target } : {}),
        requestId,
        sequence,
        reason: "provider-cancelled",
      });
      this.settle(
        key,
        pending,
        failure(pending.request, "OPERATION_CANCELLED", "Browser operation was cancelled by its provider", false),
      );
      return true;
    }
    return false;
  }

  /** Executes one validated request under credential and host scope constraints. */
  execute(claims: BrowserAutomationCredentialClaims, input: unknown): Promise<BrowserAutomationResponse> {
    const cutoff = this.now() - 30 * 60_000;
    for (const [replayKey, record] of this.openReplay) {
      if (record.lastUsedAt < cutoff) this.openReplay.delete(replayKey);
    }
    for (const [replayKey, record] of this.actReplay) {
      if (record.lastUsedAt < cutoff) this.actReplay.delete(replayKey);
    }
    for (const [replayKey, record] of this.tabsReplay) {
      if (record.lastUsedAt < cutoff) this.tabsReplay.delete(replayKey);
    }
    const parsed = BrowserAutomationRequestSchema().safeParse(input);
    if (!parsed.success) return this.executeInternal(claims, input);
    if (parsed.data.operation === "act") return this.executeAct(claims, parsed.data);
    if (parsed.data.operation === "evaluate") return this.executeEvaluate(claims, parsed.data);
    if (parsed.data.operation === "tabs") return this.executeTabs(claims, parsed.data);
    if (parsed.data.operation !== "open") return this.executeInternal(claims, input);
    const request = parsed.data;
    const key = request.args.idempotencyKey;
    if (!key) return this.executeInternal(claims, input);
    const replayKey = openReplayKey(claims.providerId, request);
    if (!replayKey) return this.executeInternal(claims, request);
    const fingerprint = JSON.stringify({ url: request.args.url ?? null });
    const existing = this.openReplay.get(replayKey);
    if (existing) {
      existing.lastUsedAt = this.now();
      if (existing.fingerprint !== fingerprint) {
        return this.finishWithoutDispatch(claims, request, failure(request, "IDEMPOTENCY_CONFLICT", "The idempotency key was already used with different browser_open arguments", false));
      }
      return existing.promise.then((response) => this.finishReplay(claims, request, response));
    }
    const sessionKey = sessionRoutingKey(claims.providerId, claims.providerSessionId);
    if (this.browserMutations.has(sessionKey)) {
      return this.finishWithoutDispatch(claims, request, failure(request, "BROWSER_BUSY", "Another browser mutation is active for this provider session", true));
    }
    const mutationToken = randomUUID();
    this.browserMutations.set(sessionKey, mutationToken);
    const releaseMutation = (): void => {
      if (this.browserMutations.get(sessionKey) === mutationToken) this.browserMutations.delete(sessionKey);
    };
    const bootstrapHost = this.resolveBootstrapHost(claims, request);
    if (!bootstrapHost) return this.executeInternal(claims, request).finally(releaseMutation);
    let resolveReplay!: (response: BrowserAutomationResponse) => void;
    const replayPromise = new Promise<BrowserAutomationResponse>((resolve) => {
      resolveReplay = resolve;
    });
    const replayRecord: OpenReplayRecord = {
      fingerprint,
      promise: replayPromise,
      host: bootstrapHost,
      lastUsedAt: this.now(),
    };
    this.openReplay.set(replayKey, replayRecord);
    while (this.openReplay.size > 256) {
      const oldest = this.openReplay.keys().next().value as string | undefined;
      if (!oldest) break;
      this.openReplay.delete(oldest);
    }
    const promise = this.executeInternal(claims, request).finally(releaseMutation);
    void promise.then((response) => {
      resolveReplay(response);
      if (!response.ok && this.openReplay.get(replayKey) === replayRecord) this.openReplay.delete(replayKey);
    });
    return promise;
  }

  private executeTabs(
    claims: BrowserAutomationCredentialClaims,
    request: Extract<BrowserAutomationRequest, { operation: "tabs" }>,
  ): Promise<BrowserAutomationResponse> {
    const replayKey = tabsReplayKey(claims.providerId, request);
    const fingerprint = JSON.stringify(request.args);
    const existing = this.tabsReplay.get(replayKey);
    if (existing) {
      existing.lastUsedAt = this.now();
      if (existing.fingerprint !== fingerprint) {
        return this.finishWithoutDispatch(claims, request, failure(request, "IDEMPOTENCY_CONFLICT", "The idempotency key was already used with different browser_tabs arguments", false));
      }
      return existing.promise.then((response) => this.finishReplay(claims, request, response));
    }
    const sessionKey = sessionRoutingKey(claims.providerId, claims.providerSessionId);
    if (this.browserMutations.has(sessionKey)) {
      return this.finishWithoutDispatch(claims, request, failure(request, "BROWSER_BUSY", "Another browser mutation is active for this provider session", true));
    }
    const token = randomUUID();
    this.browserMutations.set(sessionKey, token);
    const promise = this.executeInternal(claims, request)
      .catch(() => failure(request, "INTERNAL_ERROR", "Browser mutation failed before a terminal result was produced", false))
      .finally(() => {
        if (this.browserMutations.get(sessionKey) === token) this.browserMutations.delete(sessionKey);
      });
    this.tabsReplay.set(replayKey, { fingerprint, promise, lastUsedAt: this.now() });
    while (this.tabsReplay.size > 256) {
      const oldest = this.tabsReplay.keys().next().value as string | undefined;
      if (!oldest) break;
      this.tabsReplay.delete(oldest);
    }
    return promise;
  }

  private executeAct(
    claims: BrowserAutomationCredentialClaims,
    request: Extract<BrowserAutomationRequest, { operation: "act" }>,
  ): Promise<BrowserAutomationResponse> {
    const cutoff = this.now() - 30 * 60_000;
    for (const [key, record] of this.actReplay) {
      if (record.lastUsedAt < cutoff) this.actReplay.delete(key);
    }
    const replayKey = actReplayKey(claims.providerId, request);
    const fingerprint = JSON.stringify({
      observationRef: request.args.observationRef,
      deadlineMs: request.args.deadlineMs,
      steps: request.args.steps,
    });
    const existing = this.actReplay.get(replayKey);
    if (existing) {
      existing.lastUsedAt = this.now();
      if (existing.fingerprint !== fingerprint) {
        return this.finishWithoutDispatch(claims, request, failure(request, "IDEMPOTENCY_CONFLICT", "The idempotency key was already used with different browser_act arguments", false));
      }
      return existing.promise.then((response) => this.finishReplay(claims, request, response));
    }
    const sessionKey = sessionRoutingKey(claims.providerId, claims.providerSessionId);
    if (this.browserMutations.has(sessionKey)) {
      return this.finishWithoutDispatch(claims, request, failure(request, "BROWSER_BUSY", "Another browser mutation is active for this provider session", true));
    }
    const token = randomUUID();
    this.browserMutations.set(sessionKey, token);
    const promise = this.executeInternal(claims, request)
      .catch(() => failure(request, "INTERNAL_ERROR", "Browser mutation failed before a terminal result was produced", false))
      .finally(() => {
        if (this.browserMutations.get(sessionKey) === token) this.browserMutations.delete(sessionKey);
      });
    this.actReplay.set(replayKey, { fingerprint, promise, lastUsedAt: this.now() });
    while (this.actReplay.size > 256) {
      const oldest = this.actReplay.keys().next().value as string | undefined;
      if (!oldest) break;
      this.actReplay.delete(oldest);
    }
    return promise;
  }

  private executeEvaluate(
    claims: BrowserAutomationCredentialClaims,
    request: Extract<BrowserAutomationRequest, { operation: "evaluate" }>,
  ): Promise<BrowserAutomationResponse> {
    const cutoff = this.now() - 30 * 60_000;
    for (const [key, record] of this.evaluateReplay) {
      if (record.lastUsedAt < cutoff) this.evaluateReplay.delete(key);
    }
    const replayKey = evaluateReplayKey(claims.providerId, request);
    const fingerprint = JSON.stringify({
      observationRef: request.args.observationRef,
      deadlineMs: request.args.deadlineMs,
      awaitPromise: request.args.awaitPromise,
      timeoutMs: request.args.timeoutMs,
      expressionSha256: hashExpression(request.args.expression),
    });
    const existing = this.evaluateReplay.get(replayKey);
    if (existing) {
      existing.lastUsedAt = this.now();
      if (existing.fingerprint !== fingerprint) {
        return this.finishWithoutDispatch(claims, request, failure(request, "IDEMPOTENCY_CONFLICT", "The idempotency key was already used with different browser_evaluate arguments", false));
      }
      return existing.promise.then((response) => this.finishReplay(claims, request, response));
    }
    const sessionKey = JSON.stringify([claims.providerId, claims.providerSessionId]);
    if (this.browserMutations.has(sessionKey)) {
      return this.finishWithoutDispatch(claims, request, failure(request, "BROWSER_BUSY", "Another browser mutation is active for this provider session", true));
    }
    const token = randomUUID();
    this.browserMutations.set(sessionKey, token);
    const promise = this.executeInternal(claims, request)
      .catch(() => failure(request, "INTERNAL_ERROR", "Browser mutation failed before a terminal result was produced", false))
      .finally(() => {
        if (this.browserMutations.get(sessionKey) === token) this.browserMutations.delete(sessionKey);
      });
    this.evaluateReplay.set(replayKey, { fingerprint, promise, lastUsedAt: this.now() });
    while (this.evaluateReplay.size > 256) {
      const oldest = this.evaluateReplay.keys().next().value as string | undefined;
      if (!oldest) break;
      this.evaluateReplay.delete(oldest);
    }
    return promise;
  }

  private finishReplay(
    claims: BrowserAutomationCredentialClaims,
    request: BrowserAutomationRequest,
    response: BrowserAutomationResponse,
  ): Promise<BrowserAutomationResponse> {
    const replayed = { ...response, requestId: request.requestId, sequence: request.sequence };
    return this.finishWithoutDispatch(claims, request, replayed, false);
  }

  private finishWithoutDispatch(
    claims: BrowserAutomationCredentialClaims,
    request: BrowserAutomationRequest,
    response: BrowserAutomationResponse,
    countReliability = true,
  ): Promise<BrowserAutomationResponse> {
    this.recordLifecycle("configuration", claims.providerId, request, undefined, undefined, { outcome: "accepted" });
    this.recordLifecycle("admission", claims.providerId, request, undefined, undefined, { outcome: "accepted" });
    if (countReliability) {
      this.reliability.dispatched = incrementBounded(this.reliability.dispatched);
      this.recordOutcome(response, 0, false);
    }
    this.recordLifecycle("settlement", claims.providerId, request, undefined, undefined, {
      durationMs: 0,
      ...browserAutomationTerminalFields(response),
    });
    this.recordLifecycle("cleanup", claims.providerId, request, undefined, undefined, {
      durationMs: 0,
      outcome: response.ok ? "completed" : "failed",
      settlement: response.ok || response.error.effect !== "unknown" ? "complete" : "unknown",
    });
    return Promise.resolve(response);
  }

  private executeInternal(claims: BrowserAutomationCredentialClaims, input: unknown): Promise<BrowserAutomationResponse> {
    this.pruneExpiredState();
    const parsed = BrowserAutomationRequestSchema().safeParse(input);
    if (!parsed.success) {
      return Promise.reject(new Error("Browser automation request contract is invalid"));
    }
    const request = parsed.data;
    const startedAt = this.now();
    this.recordLifecycle("configuration", claims.providerId, request, undefined, undefined, {
      outcome: "accepted",
    });
    this.recordLifecycle("admission", claims.providerId, request, undefined, undefined, {
      outcome: "accepted",
    });
    this.reliability.dispatched = incrementBounded(this.reliability.dispatched);
    const finishImmediately = (response: BrowserAutomationResponse): Promise<BrowserAutomationResponse> => {
      const durationMs = Math.max(0, this.now() - startedAt);
      this.recordOutcome(response, durationMs, false);
      this.recordLifecycle("settlement", claims.providerId, request, undefined, undefined, {
        durationMs,
        ...browserAutomationTerminalFields(response),
      });
      this.recordLifecycle("cleanup", claims.providerId, request, undefined, undefined, {
        durationMs,
        outcome: response.ok ? "completed" : "failed",
        settlement: response.ok || response.error.effect !== "unknown" ? "complete" : "unknown",
      });
      return Promise.resolve(response);
    };
    if (
      request.threadId !== claims.threadId ||
      request.workspaceId !== claims.workspaceId ||
      request.providerSessionId !== claims.providerSessionId ||
      request.providerInstanceId !== claims.mcodeSessionId
    ) {
      return finishImmediately(failure(request, "FORBIDDEN", "Browser request scope does not match its credential", false));
    }
    if (!isPublicOperation(request.operation) || !claims.allowedOperations.includes(request.operation)) {
      return finishImmediately(failure(request, "FORBIDDEN", "Browser operation is not allowed by this credential", false));
    }
    if (request.operation === "evaluate" && claims.permissionCapability !== "privileged") {
      return finishImmediately(failure(request, "FORBIDDEN", "Browser evaluation requires privileged permission", false));
    }
    if (request.deadline <= this.now()) {
      return finishImmediately(failure(request, "DEADLINE_EXCEEDED", "Browser request deadline has elapsed", true));
    }
    if (this.pending.size >= this.maxPendingRequests) {
      this.reliability.capacityRejected = incrementBounded(this.reliability.capacityRejected);
      return finishImmediately(failure(request, "HOST_UNAVAILABLE", "Browser request capacity is exhausted", true));
    }

    // Each fresh keyed browser_open owns a new tab. Duplicate keys are
    // handled by openReplay before this path and continue to reuse the
    // original target.
    const assignment = request.operation === "open" && request.args.idempotencyKey !== undefined
      ? undefined
      : request.operation === "tabs"
        ? this.resolveTabsAssignment(claims, request)
        : this.resolveAssignment(claims, request);
    if (!assignment) {
      if (request.operation === "open") {
        const host = this.resolveBootstrapHost(claims, request);
        if (host) return this.executeBootstrap(host, claims.providerId, request);
      }
      if (!this.resolveSelectedHost(claims)) {
        return finishImmediately(failure(request, "HOST_UNAVAILABLE", "No authorized visible Browser host is available", true));
      }
      return finishImmediately(failure(request, "TAB_UNAVAILABLE", "No authorized visible browser tab is available", true));
    }
    const { host, target } = assignment;
    this.sessionHosts.set(sessionRoutingKey(claims.providerId, claims.providerSessionId), host);
    if (!this.supportsOperation(host, request)) {
      return finishImmediately(failure(
        request,
        "UNSUPPORTED_OPERATION",
        "The assigned browser target does not support this operation",
        false,
      ));
    }
    if (host.pending >= host.registration.maxPendingRequests) {
      this.reliability.capacityRejected = incrementBounded(this.reliability.capacityRejected);
      return finishImmediately(failure(
        request,
        "HOST_UNAVAILABLE",
        "The assigned browser target is temporarily at capacity",
        true,
      ));
    }
    const dispatch = BrowserAutomationHostDispatchSchema().parse({
      scope: {
        workspaceId: claims.workspaceId,
        threadId: claims.threadId,
        providerSessionId: claims.providerSessionId,
        providerInstanceId: claims.mcodeSessionId,
      },
      connection: {
        desktopInstanceId: target.desktopInstanceId,
        windowId: target.windowId,
        connectionGeneration: target.connectionGeneration,
        targetGeneration: target.targetGeneration,
        capabilityRevision: host.registration.executorDescriptor.capabilityRevision,
      },
      request,
      target,
    });
    const key = pendingKey(host, request.requestId, request.sequence);
    if (this.pending.has(key)) {
      return finishImmediately(failure(request, "INVALID_REQUEST", "Browser request correlation is already pending", false));
    }
    return new Promise((resolve) => {
      const timeoutMs = Math.max(1, Math.min(60_000, request.deadline - this.now()));
      const timer = setTimeout(() => {
        const pending = this.pending.get(key);
        if (!pending) return;
        this.trySend(host.socket, "browserAutomation.cancel", {
          hostId: host.registration.hostId,
          generation: host.generation,
          target,
          requestId: request.requestId,
          sequence: request.sequence,
          reason: "deadline-exceeded",
        });
        this.settle(key, pending, failure(request, "DEADLINE_EXCEEDED", "Browser request timed out", true));
      }, timeoutMs);
      timer.unref?.();
      const pending: PendingRequest = {
        host,
        providerId: claims.providerId,
        request,
        target,
        dispatch,
        resolve,
        timer,
        startedAt: this.now(),
        credentialOperations: claims.allowedOperations,
      };
      this.pending.set(key, pending);
      host.pending++;
      this.recordLifecycle("queueing", claims.providerId, request, host, target, { outcome: "queued" });
      const preflightError = this.revalidatePendingBeforeSend(pending);
      if (preflightError) {
        this.settle(key, pending, preflightError);
        return;
      }
      const sent = this.trySend(host.socket, "browserAutomation.request", {
        hostId: host.registration.hostId,
        generation: host.generation,
        dispatch,
      });
      if (!sent) {
        this.settle(key, pending, failure(request, "HOST_UNAVAILABLE", "Browser host disconnected before delivery", true));
        return;
      }
      this.recordLifecycle("execution", claims.providerId, request, host, target, { outcome: "dispatched" });
      if (requestWaitsForPage(request)) {
        this.recordLifecycle("page-waiting", claims.providerId, request, host, target, { outcome: "waiting" });
      }
    });
  }

  /** Removes a disconnected host and settles all work assigned to it. */
  disconnect(socket: WebSocket): void {
    const host = this.hostsBySocket.get(socket);
    if (!host) return;
    this.hostsBySocket.delete(socket);
    clearTimeout(host.heartbeatTimer);
    for (const [replayKey, record] of this.openReplay) {
      if (record.host === host) this.openReplay.delete(replayKey);
    }
    for (const [key, assigned] of this.assignments) {
      if (assigned.host === host) this.assignments.delete(key);
    }
    for (const [key, sessionHost] of this.sessionHosts) {
      if (sessionHost === host) this.sessionHosts.delete(key);
    }
    for (const [key, pending] of this.pending) {
      if (pending.host === host) {
        this.settle(
          key,
          pending,
          failure(pending.request, "HOST_UNAVAILABLE", "Visible browser host disconnected", true),
        );
      }
    }
  }

  /** Settles all pending work and releases every broker-owned lifecycle resource. */
  shutdown(): void {
    for (const socket of [...this.hostsBySocket.keys()]) this.disconnect(socket);
    this.assignments.clear();
    for (const pending of [...this.pending.values()]) {
      this.settle(
        pendingKey(pending.host, pending.request.requestId, pending.request.sequence),
        pending,
        failure(pending.request, "HOST_UNAVAILABLE", "Browser automation broker shut down", true),
      );
    }
    this.pending.clear();
    this.actReplay.clear();
    this.evaluateReplay.clear();
    this.browserMutations.clear();
    this.tabsReplay.clear();
    this.sessionHosts.clear();
  }

  /** Returns bounded broker counts for status and tests. */
  status(): { hosts: number; pending: number; assignments: number } {
    this.pruneExpiredState();
    return { hosts: this.hostsBySocket.size, pending: this.pending.size, assignments: this.assignments.size };
  }

  /** Returns a snapshot of bounded reliability counters without page or credential data. */
  reliabilityStatus(): BrowserAutomationReliabilityCounters {
    return {
      ...this.reliability,
      roundTripLatency: summarizeLatency(this.latencySamples),
    };
  }

  /** Returns privacy-safe Browser v2 evidence for health checks and release collection. */
  nightlyEvidenceStatus(): BrowserAutomationNightlyEvidenceReport {
    return this.telemetry.report();
  }

  /** Records MCP routing or receipt delivery with the broker's shared correlation collector. */
  recordMcpLifecycle(
    stage: "mcp-routing" | "receipt-delivery",
    providerId: string,
    request: BrowserAutomationRequest,
    fields: Partial<Pick<BrowserAutomationTelemetryEvent, "durationMs" | "outcome" | "settlement">> = {},
  ): void {
    this.recordLifecycle(stage, providerId, request, undefined, undefined, fields);
  }

  /** Returns the operations both the credential and its selected executor support. */
  availableOperations(
    claims: BrowserAutomationCredentialClaims,
  ): readonly BrowserAutomationPublicOperation[] {
    const host = this.resolveSelectedHost(claims);
    if (!host) return [];
    const descriptorOperations = new Set(host.registration.executorDescriptor.operations);
    const liveCapabilities = new Set(
      host.registration.capabilities
        .filter((capability) => capability.available)
        .map((capability) => capability.operation),
    );
    return claims.allowedOperations.filter((operation) =>
      descriptorOperations.has(operation) &&
      liveCapabilities.has(operation) &&
      (operation !== "evaluate" || (
        claims.permissionCapability === "privileged" &&
        host.registration.runtime === "electron"
      )),
    );
  }

  /** Releases sticky routing state when a provider session closes or rotates credentials. */
  releaseProviderSession(
    providerId: string,
    providerSessionId: string,
    reason: BrowserAutomationSessionReleaseReason = "credential-revoked",
  ): number {
    let removed = 0;
    const sessionKey = sessionRoutingKey(providerId, providerSessionId);
    const sessionHost = this.sessionHosts.get(sessionKey);
    if (sessionHost) {
      this.trySend(sessionHost.socket, "browserAutomation.sessionRelease", {
        hostId: sessionHost.registration.hostId,
        generation: sessionHost.generation,
        providerSessionId,
        reason,
      });
      this.sessionHosts.delete(sessionKey);
    }
    for (const key of this.assignments.keys()) {
      const [assignedProviderId, assignedProviderSessionId] = JSON.parse(key) as string[];
      if (
        assignedProviderId === providerId &&
        assignedProviderSessionId === providerSessionId
      ) {
        this.assignments.delete(key);
        removed++;
      }
    }
    for (const [key, pending] of this.pending) {
      if (
        pending.providerId !== providerId ||
        pending.request.providerSessionId !== providerSessionId
      ) continue;
      this.trySend(pending.host.socket, "browserAutomation.cancel", {
        hostId: pending.host.registration.hostId,
        generation: pending.host.generation,
        ...(pending.target ? { target: pending.target } : {}),
        requestId: pending.request.requestId,
        sequence: pending.request.sequence,
        reason: "client-disconnected",
      });
      this.settle(
        key,
        pending,
        failure(pending.request, "OPERATION_CANCELLED", "Browser credential was revoked", false),
      );
    }
    for (const key of this.openReplay.keys()) {
      const parts = JSON.parse(key) as string[];
      if (parts[0] === providerId && parts[1] === providerSessionId) this.openReplay.delete(key);
    }
    for (const key of this.actReplay.keys()) {
      const parts = JSON.parse(key) as string[];
      if (parts[0] === providerId && parts[1] === providerSessionId) this.actReplay.delete(key);
    }
    for (const key of this.evaluateReplay.keys()) {
      const parts = JSON.parse(key) as string[];
      if (parts[0] === providerId && parts[1] === providerSessionId) this.evaluateReplay.delete(key);
    }
    for (const key of this.tabsReplay.keys()) {
      const parts = JSON.parse(key) as string[];
      if (parts[0] === providerId && parts[1] === providerSessionId) this.tabsReplay.delete(key);
    }
    this.browserMutations.delete(sessionRoutingKey(providerId, providerSessionId));
    return removed;
  }

  /** Prunes expired hosts and sticky assignments at an explicit lifecycle checkpoint. */
  sweep(): void {
    this.pruneExpiredState();
  }

  private requireHost(socket: WebSocket, hostId: string, generation: number): RegisteredHost {
    const host = this.hostsBySocket.get(socket);
    if (!host || host.registration.hostId !== hostId || host.generation !== generation) {
      throw new Error("Browser automation host registration is stale or invalid");
    }
    return host;
  }

  private resolveAssignment(
    claims: BrowserAutomationCredentialClaims,
    request: BrowserAutomationRequest,
  ): { host: RegisteredHost; target: BrowserAutomationHostDispatchTarget } | undefined {
    const key = assignmentKey(claims);
    const assigned = this.assignments.get(key);
    const assignedTarget = assigned?.host.targets.get(assigned.targetKey);
    if (assigned && assignedTarget && this.matchesScope(assigned.host, claims)) {
      assigned.lastUsedAt = this.now();
      return { host: assigned.host, target: assignedTarget };
    }
    this.assignments.delete(key);
    const candidates = [...this.hostsBySocket.values()]
      .filter((host) => this.canAccept(host, claims, request))
      .flatMap((host) => [...host.targets.values()]
        .filter((target) => target.threadId === claims.threadId)
        .map((target) => ({ host, target })))
      .sort((a, b) =>
        Number(b.target.focused) - Number(a.target.focused) ||
        Number(b.target.active) - Number(a.target.active) ||
        b.target.lastUsedAt - a.target.lastUsedAt ||
        a.host.pending - b.host.pending ||
        a.host.generation - b.host.generation ||
        a.target.windowId - b.target.windowId ||
        a.target.tabId.localeCompare(b.target.tabId));
    const selected = candidates[0];
    if (selected) {
      while (this.assignments.size >= this.maxAssignments) this.evictOldestAssignment();
      this.assignments.set(key, {
        host: selected.host,
        targetKey: targetKey(selected.target),
        lastUsedAt: this.now(),
      });
    }
    return selected;
  }

  private resolveSelectedHost(
    claims: BrowserAutomationCredentialClaims,
  ): RegisteredHost | undefined {
    const key = assignmentKey(claims);
    const assigned = this.assignments.get(key);
    if (assigned) {
      const assignedTarget = assigned.host.targets.get(assigned.targetKey);
      if (assignedTarget && this.matchesScope(assigned.host, claims)) {
        assigned.lastUsedAt = this.now();
        return assigned.host;
      }
      this.assignments.delete(key);
    }
    return [...this.hostsBySocket.values()]
      .filter((host) => this.matchesScope(host, claims))
      .map((host) => ({
        host,
        target: [...host.targets.values()].find((target) => target.threadId === claims.threadId),
      }))
      .sort((left, right) =>
        Number(Boolean(right.target)) - Number(Boolean(left.target)) ||
        Number(right.target?.focused ?? false) - Number(left.target?.focused ?? false) ||
        Number(right.target?.active ?? false) - Number(left.target?.active ?? false) ||
        (right.target?.lastUsedAt ?? 0) - (left.target?.lastUsedAt ?? 0) ||
        left.host.pending - right.host.pending ||
        left.host.generation - right.host.generation,
      )[0]?.host;
  }

  private resolveTabsAssignment(
    claims: BrowserAutomationCredentialClaims,
    request: Extract<BrowserAutomationRequest, { operation: "tabs" }>,
  ): { host: RegisteredHost; target: BrowserAutomationHostDispatchTarget } | undefined {
    const action = request.args.action;
    const assigned = this.assignments.get(assignmentKey(claims));
    if (action !== "select" && action !== "claim" && assigned) {
      const assignedTarget = assigned.host.targets.get(assigned.targetKey);
      if (assignedTarget && this.matchesScope(assigned.host, claims)) {
        assigned.lastUsedAt = this.now();
        return { host: assigned.host, target: assignedTarget };
      }
      this.assignments.delete(assignmentKey(claims));
    }
    const requestedTabId = "tabId" in request.args ? request.args.tabId : undefined;
    if (!requestedTabId) return undefined;
    return this.resolveExplicitTarget(claims, request, requestedTabId);
  }

  private resolveExplicitTarget(
    claims: BrowserAutomationCredentialClaims,
    request: BrowserAutomationRequest,
    tabId: string,
  ): { host: RegisteredHost; target: BrowserAutomationHostDispatchTarget } | undefined {
    const sessionHost = this.sessionHosts.get(sessionRoutingKey(claims.providerId, claims.providerSessionId));
    const candidates = [...this.hostsBySocket.values()]
      .filter((host) => !sessionHost || host === sessionHost)
      .filter((host) => this.canAccept(host, claims, request))
      .flatMap((host) => [...host.targets.values()]
        .filter((target) => target.threadId === claims.threadId && target.tabId === tabId)
        .map((target) => ({ host, target })))
      .sort((a, b) =>
        Number(b.target.focused) - Number(a.target.focused) ||
        Number(b.target.active) - Number(a.target.active) ||
        b.target.lastUsedAt - a.target.lastUsedAt ||
        a.host.pending - b.host.pending ||
        a.host.generation - b.host.generation ||
        a.target.windowId - b.target.windowId);
    return candidates[0];
  }

  private canAccept(
    host: RegisteredHost,
    claims: BrowserAutomationCredentialClaims,
    request: BrowserAutomationRequest,
  ): boolean {
    return (
      this.matchesScope(host, claims) &&
      host.pending < host.registration.maxPendingRequests &&
      this.supportsOperation(host, request)
    );
  }

  private matchesScope(host: RegisteredHost, claims: BrowserAutomationCredentialClaims): boolean {
    return host.registration.worktreeIdentity === claims.worktreeIdentity &&
      host.registration.workspaceIds.includes(claims.workspaceId);
  }

  private supportsOperation(host: RegisteredHost, request: BrowserAutomationRequest): boolean {
    const descriptor = host.registration.executorDescriptor;
    if (request.operation === "evaluate" && host.registration.runtime !== "electron") return false;
    if (!descriptor.operations.some((operation) => operation === request.operation)) return false;
    return host.registration.capabilities.some(
      (capability) => capability.operation === request.operation && capability.available,
    );
  }

  private revalidatePendingBeforeSend(pending: PendingRequest): BrowserAutomationResponse | null {
    const host = pending.host;
    if (this.hostsBySocket.get(host.socket) !== host) {
      return failure(pending.request, "HOST_UNAVAILABLE", "Browser host changed before delivery", true);
    }
    if (!isPublicOperation(pending.request.operation) || !pending.credentialOperations.includes(pending.request.operation)) {
      return failure(pending.request, "FORBIDDEN", "Browser operation is no longer allowed by this credential", false);
    }
    if (pending.request.deadline <= this.now()) {
      return failure(pending.request, "DEADLINE_EXCEEDED", "Browser request deadline has elapsed", true);
    }
    if (pending.dispatch && pending.dispatch.connection.capabilityRevision !== host.registration.executorDescriptor.capabilityRevision) {
      return failure(pending.request, "CAPABILITY_CHANGED", "Browser executor capabilities changed; inspect before retrying", false);
    }
    if (!this.supportsOperation(host, pending.request)) {
      return failure(pending.request, "CAPABILITY_CHANGED", "Browser executor capabilities changed; inspect before retrying", false);
    }
    if (pending.target) {
      const currentTarget = host.targets.get(targetKey(pending.target));
      if (!currentTarget) return failure(pending.request, "TAB_UNAVAILABLE", "Browser target changed before delivery", true);
      if (!targetsMatch(currentTarget, pending.target)) {
        return failure(pending.request, "STALE_TARGET_GENERATION", "Browser target changed before delivery", true);
      }
      if (
        currentTarget.controller?.controller !== pending.target.controller?.controller ||
        currentTarget.controller?.controlEpoch !== pending.target.controller?.controlEpoch
      ) {
        return failure(pending.request, "HUMAN_INTERRUPTED", "Browser controller changed before delivery", true);
      }
    }
    return null;
  }

  private resolveBootstrapHost(
    claims: BrowserAutomationCredentialClaims,
    request: BrowserAutomationRequest,
  ): RegisteredHost | undefined {
    const sessionHost = this.sessionHosts.get(sessionRoutingKey(claims.providerId, claims.providerSessionId));
    if (sessionHost && this.hostsBySocket.get(sessionHost.socket) === sessionHost && this.canAccept(sessionHost, claims, request)) {
      return sessionHost;
    }
    return [...this.hostsBySocket.values()]
      .filter((host) => this.canAccept(host, claims, request))
      .sort((left, right) => left.pending - right.pending || left.generation - right.generation)[0];
  }

  private executeBootstrap(
    host: RegisteredHost,
    providerId: string,
    request: BrowserAutomationRequest,
  ): Promise<BrowserAutomationResponse> {
    this.sessionHosts.set(sessionRoutingKey(providerId, request.providerSessionId), host);
    const key = pendingKey(host, request.requestId, request.sequence);
    if (this.pending.has(key)) {
      const response = failure(request, "INVALID_REQUEST", "Browser request correlation is already pending", false);
      this.recordOutcome(response, 0, false);
      return Promise.resolve(response);
    }
    return new Promise((resolve) => {
      const timeoutMs = Math.max(1, Math.min(60_000, request.deadline - this.now()));
      const timer = setTimeout(() => {
        const pending = this.pending.get(key);
        if (!pending) return;
        this.trySend(host.socket, "browserAutomation.cancel", {
          hostId: host.registration.hostId,
          generation: host.generation,
          requestId: request.requestId,
          sequence: request.sequence,
          reason: "deadline-exceeded",
        });
        this.settle(key, pending, failure(request, "DEADLINE_EXCEEDED", "Browser request timed out", true));
      }, timeoutMs);
      timer.unref?.();
      const pending: PendingRequest = { host, providerId, request, resolve, timer, startedAt: this.now(), credentialOperations: [request.operation as BrowserAutomationPublicOperation] };
      this.pending.set(key, pending);
      host.pending++;
      this.recordLifecycle("queueing", providerId, request, host, undefined, { outcome: "queued" });
      const preflightError = this.revalidatePendingBeforeSend(pending);
      if (preflightError) {
        this.settle(key, pending, preflightError);
        return;
      }
      const sent = this.trySend(host.socket, "browserAutomation.bootstrap", {
        hostId: host.registration.hostId,
        generation: host.generation,
        request,
      });
      if (!sent) {
        this.settle(key, pending, failure(request, "HOST_UNAVAILABLE", "Browser host disconnected before delivery", true));
        return;
      }
      this.recordLifecycle("execution", providerId, request, host, undefined, { outcome: "dispatched" });
    });
  }

  private settle(key: string, pending: PendingRequest, response: BrowserAutomationResponse): void {
    if (!this.pending.delete(key)) return;
    clearTimeout(pending.timer);
    pending.host.pending = Math.max(0, pending.host.pending - 1);
    const boundedResponse = response;
    const latencyMs = Math.max(0, this.now() - pending.startedAt);
    this.recordOutcome(boundedResponse, latencyMs);
    this.recordLifecycle("settlement", pending.providerId, pending.request, pending.host, pending.target, {
      durationMs: latencyMs,
      ...browserAutomationTerminalFields(boundedResponse),
    });
    this.recordLifecycle("cleanup", pending.providerId, pending.request, pending.host, pending.target, {
      durationMs: latencyMs,
      outcome: boundedResponse.ok ? "completed" : "failed",
      settlement: boundedResponse.ok || boundedResponse.error.effect !== "unknown" ? "complete" : "unknown",
    });
    pending.resolve(boundedResponse);
  }

  private updateTabsAssignment(
    pending: PendingRequest,
    result: Extract<BrowserAutomationResponse, { ok: true }>['result'] & { operation: "tabs" },
    responseTarget: BrowserAutomationHostDispatchTarget | undefined,
  ): void {
    const key = assignmentKeyParts(
      pending.providerId,
      pending.request.providerSessionId,
      pending.host.registration.worktreeIdentity,
      pending.request.workspaceId,
      pending.request.threadId,
    );
    const target = responseTarget ?? pending.target;
    if (target && pending.host.targets.has(targetKey(target))) {
      pending.host.targets.set(targetKey(target), target);
    }
    if (result.action === "select" || result.action === "claim") {
      const selectedTarget = result.currentTabId
        ? pending.host.targets.get(JSON.stringify([pending.request.threadId, result.currentTabId])) ??
          (target?.tabId === result.currentTabId ? target : undefined)
        : target;
      if (selectedTarget) this.storeAssignment(key, pending.host, selectedTarget);
      else this.assignments.delete(key);
      return;
    }
    if (!result.currentTabId) {
      this.assignments.delete(key);
      return;
    }
    const currentTarget = pending.host.targets.get(JSON.stringify([pending.request.threadId, result.currentTabId]));
    if (currentTarget) {
      this.storeAssignment(key, pending.host, currentTarget);
    } else if (target?.tabId === result.currentTabId) {
      this.storeAssignment(key, pending.host, target);
    } else {
      this.assignments.delete(key);
    }
  }

  private isTabsResponseTarget(
    pending: PendingRequest,
    responseTarget: BrowserAutomationHostDispatchTarget,
  ): boolean {
    if (pending.request.operation !== "tabs") return false;
    if (
      responseTarget.desktopInstanceId !== pending.host.registration.desktopInstanceId ||
      responseTarget.connectionGeneration !== pending.host.generation ||
      responseTarget.threadId !== pending.request.threadId
    ) return false;
    const advertised = pending.host.targets.get(targetKey(responseTarget));
    return advertised !== undefined && targetsMatch(advertised, responseTarget);
  }

  private storeAssignment(
    key: string,
    host: RegisteredHost,
    target: BrowserAutomationHostDispatchTarget,
  ): void {
    while (this.assignments.size >= this.maxAssignments && !this.assignments.has(key)) this.evictOldestAssignment();
    this.assignments.set(key, { host, targetKey: targetKey(target), lastUsedAt: this.now() });
  }

  private recordOutcome(response: BrowserAutomationResponse, latencyMs: number, recordLatency = true): void {
    this.reliability.latencyTotalMs = incrementBounded(this.reliability.latencyTotalMs, latencyMs);
    this.reliability.latencyMaxMs = Math.max(this.reliability.latencyMaxMs, latencyMs);
    if (recordLatency) this.recordLatencySample(latencyMs);
    if (response.ok) {
      this.reliability.succeeded = incrementBounded(this.reliability.succeeded);
      if (responseWasTruncated(response)) {
        this.reliability.truncated = incrementBounded(this.reliability.truncated);
      }
    } else {
      this.reliability.failed = incrementBounded(this.reliability.failed);
      if (response.error.code === "DEADLINE_EXCEEDED") {
        this.reliability.timedOut = incrementBounded(this.reliability.timedOut);
      }
      if (response.error.code === "HUMAN_INTERRUPTED" || response.error.code === "OPERATION_CANCELLED") {
        this.reliability.interrupted = incrementBounded(this.reliability.interrupted);
      }
      if (response.error.code === "HOST_UNAVAILABLE" || response.error.code === "TAB_UNAVAILABLE") {
        this.reliability.hostLosses = incrementBounded(this.reliability.hostLosses);
      }
    }
  }

  private recordLatencySample(latencyMs: number): void {
    if (!Number.isFinite(latencyMs)) return;
    const bounded = Math.min(MAX_LATENCY_SAMPLE_MS, Math.max(0, latencyMs));
    if (this.latencySamples.length < this.maxLatencySamples) {
      this.latencySamples.push(bounded);
      return;
    }
    this.latencySamples[this.latencySampleCursor] = bounded;
    this.latencySampleCursor = (this.latencySampleCursor + 1) % this.maxLatencySamples;
  }

  private recordLifecycle(
    stage: BrowserAutomationTelemetryStage,
    providerId: string,
    request: BrowserAutomationRequest,
    host: RegisteredHost | undefined,
    target: BrowserAutomationHostDispatchTarget | undefined,
    fields: Partial<Omit<BrowserAutomationTelemetryEvent,
      "timestampMs" | "correlationId" | "stage" | "provider" | "operation" | "contractVersion" | "runtime" |
      "capabilityRevision" | "connectionGeneration" | "targetGeneration"
    >>,
  ): void {
    this.telemetry.record({
      timestampMs: this.now(),
      correlationId: request.requestId,
      stage,
      provider: providerId,
      operation: request.operation as BrowserAutomationOperation,
      contractVersion: request.contractVersion,
      ...(host ? {
        runtime: host.registration.runtime,
        capabilityRevision: host.registration.executorDescriptor.capabilityRevision,
        connectionGeneration: host.generation,
      } : {}),
      ...(target ? { targetGeneration: target.targetGeneration } : {}),
      ...fields,
    });
  }

  private adoptBootstrapTarget(
    pending: PendingRequest,
    target: BrowserAutomationHostDispatchTarget,
  ): string | null {
    const host = pending.host;
    if (
      target.desktopInstanceId !== host.registration.desktopInstanceId ||
      target.connectionGeneration !== host.generation ||
      target.threadId !== pending.request.threadId
    ) {
      return "Browser bootstrap target identity does not match its authorized request";
    }
    const key = targetKey(target);
    const prior = host.targetGenerationTombstones.get(key);
    if (
      prior &&
      (target.targetGeneration < prior.generation ||
        (target.targetGeneration === prior.generation && target.windowId !== prior.windowId))
    ) {
      return "Browser bootstrap target generation is stale";
    }
    const retainedTargets = [...this.hostsBySocket.values()].reduce(
      (count, candidate) => count + candidate.targets.size,
      0,
    );
    if (!host.targets.has(key) && (host.targets.size >= 64 || retainedTargets >= this.maxTargets)) {
      return "Browser automation target capacity is exhausted";
    }
    const existing = host.targets.get(key);
    if (
      existing &&
      (existing.targetGeneration !== target.targetGeneration || existing.windowId !== target.windowId)
    ) {
      this.invalidateTarget(host, key);
    }
    host.targets.set(key, target);
    host.targetGenerationTombstones.delete(key);
    host.targetGenerationTombstones.set(key, {
      generation: target.targetGeneration,
      windowId: target.windowId,
    });
    while (host.targetGenerationTombstones.size > 128) {
      const oldest = host.targetGenerationTombstones.keys().next().value as string | undefined;
      if (!oldest) break;
      if (host.targets.has(oldest)) {
        const retained = host.targetGenerationTombstones.get(oldest)!;
        host.targetGenerationTombstones.delete(oldest);
        host.targetGenerationTombstones.set(oldest, retained);
        continue;
      }
      host.targetGenerationTombstones.delete(oldest);
    }
    while (this.assignments.size >= this.maxAssignments) this.evictOldestAssignment();
    this.assignments.set(
      assignmentKeyParts(
        pending.providerId,
        pending.request.providerSessionId,
        host.registration.worktreeIdentity,
        pending.request.workspaceId,
        pending.request.threadId,
      ),
      { host, targetKey: key, lastUsedAt: this.now() },
    );
    pending.target = target;
    return null;
  }

  private invalidateTarget(
    host: RegisteredHost,
    removedTargetKey: string,
    preserveTargetTransition = false,
  ): void {
    for (const [replayKey, record] of this.openReplay) {
      if (record.host === host && record.target && targetKey(record.target) === removedTargetKey) {
        this.openReplay.delete(replayKey);
      }
    }
    for (const [key, assignment] of this.assignments) {
      if (assignment.host === host && assignment.targetKey === removedTargetKey) this.assignments.delete(key);
    }
    for (const [key, pending] of this.pending) {
      if (pending.host === host && pending.target && targetKey(pending.target) === removedTargetKey) {
        const targetRemovalIsRequested = pending.request.operation === "tabs" &&
          (pending.request.args.action === "close" || pending.request.args.action === "finalize");
        if (
          targetRemovalIsRequested ||
          (preserveTargetTransition &&
            (pending.request.operation === "open" || pending.request.operation === "navigate"))
        ) continue;
        this.settle(
          key,
          pending,
          failure(pending.request, "TAB_UNAVAILABLE", "Visible browser target was removed or replaced", true),
        );
      }
    }
  }

  private trySend(
    socket: WebSocket,
    channel: "browserAutomation.bootstrap" | "browserAutomation.request" | "browserAutomation.cancel" | "browserAutomation.sessionRelease",
    data: unknown,
  ): boolean {
    try {
      return this.send(socket, channel, data);
    } catch {
      return false;
    }
  }

  private scheduleHeartbeatExpiry(host: RegisteredHost): ReturnType<typeof setTimeout> {
    const timer = setTimeout(() => {
      const current = this.hostsBySocket.get(host.socket);
      if (current !== host) return;
      if (this.now() - host.lastHeartbeatAt >= this.hostHeartbeatTimeoutMs) {
        this.disconnect(host.socket);
        return;
      }
      host.heartbeatTimer = this.scheduleHeartbeatExpiry(host);
    }, this.hostHeartbeatTimeoutMs);
    timer.unref?.();
    return timer;
  }

  private pruneExpiredState(): void {
    const now = this.now();
    for (const host of [...this.hostsBySocket.values()]) {
      if (now - host.lastHeartbeatAt >= this.hostHeartbeatTimeoutMs) this.disconnect(host.socket);
    }
    for (const [key, assignment] of this.assignments) {
      if (now - assignment.lastUsedAt >= this.assignmentTtlMs) this.assignments.delete(key);
    }
  }

  private evictOldestAssignment(): void {
    let oldest: [string, { host: RegisteredHost; targetKey: string; lastUsedAt: number }] | undefined;
    for (const entry of this.assignments) {
      if (!oldest || entry[1].lastUsedAt < oldest[1].lastUsedAt) oldest = entry;
    }
    if (oldest) this.assignments.delete(oldest[0]);
  }
}
