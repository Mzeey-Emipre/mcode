import * as NodeEvents from "node:events";
import { inject, injectable } from "tsyringe";
import { logger } from "@mcode/shared";
import type {
  AgentEvent,
  IAgentProvider,
  ISessionEvictable,
  PermissionDecision,
  PermissionQuestion,
  PermissionRequest,
  PermissionResponseAnswers,
  ProviderId,
  ProviderModelInfo,
  ProviderIdentity,
  SessionForker,
  TurnRequest,
} from "@mcode/contracts";
import { AgentEventType, providerRuntimeEvent } from "@mcode/contracts";
import type { ProviderHostPorts } from "@mcode/providers";
import { SettingsService } from "../../../settings/settings-service.js";
import { EnvService } from "../../../../runtime/environment/env-service.js";
import { CleanForker } from "../../../handoff/index.js";
import {
  CanonicalLiveEventPublisher,
  type CanonicalLiveEventRouting,
} from "../../composition/canonical-live-event-publisher.js";
import { OpenCodeServerPool, type OpenCodePoolKey } from "./opencode-server-pool.js";
import {
  defaultOpenCodeHttpClient,
  OpenCodeReplySessionNotFoundError,
  type OpenCodeHttpClient,
  type OpenCodeRequestVersion,
} from "./opencode-http-client.js";
import { mapOpenCodeEnvelope, normalizeOpenCodeEnvelope, type OpenCodeMappedOutput } from "./opencode-event-mapper.js";
import {
  mapPermissionDecisionToReply,
  synthesizeOpenCodePermissionRequest,
  synthesizeOpenCodeQuestionRequest,
} from "./opencode-permission-mapper.js";
import { formatOpenCodeResumeCursor, parseOpenCodeResumeCursor } from "./opencode-resume-cursor.js";
import { probeOpenCodeCli } from "./opencode-cli.js";

const OPENCODE_SUPPORTED_CAPABILITIES = ["build", "plan", "permissions", "session-eviction"] as const;

/** Visible notice when a missing upstream session forces a fresh start. */
const OPENCODE_SESSION_INVALIDATED_SUBTYPE = "sdk_session_invalidated";

/** Loopback hostname every pooled serve binds to. Pool keys never vary it. */
const OPENCODE_SERVE_HOSTNAME = "127.0.0.1";

/** Largest retained per-thread notice set before pruning oldest. */
const MAX_SEEN_NOTICES_PER_THREAD = 64;

/** Delay between idle-confirmation status polls. */
const OPENCODE_IDLE_POLL_INTERVAL_MS = 2_000;
/** Consecutive idle polls with no new activity before the turn settles. */
const OPENCODE_IDLE_REQUIRED_POLLS = 3;
/** Longest an idle confirmation runs before settling anyway. */
const OPENCODE_IDLE_CONFIRM_TIMEOUT_MS = 60_000;
/** Consecutive failed status polls before the turn errors visibly. */
const OPENCODE_IDLE_MAX_POLL_ERRORS = 3;

/** Bounded idle-confirmation timings (overridable in tests). */
export interface OpenCodeIdleConfirm {
  intervalMs: number;
  requiredPolls: number;
  timeoutMs: number;
  maxPollErrors: number;
}

/** Mutable progress of one idle-confirmation loop. */
interface IdleConfirmProgress {
  startedActivity: number;
  idlePolls: number;
  pollErrors: number;
  deadline: number;
}

const DEFAULT_IDLE_CONFIRM: OpenCodeIdleConfirm = {
  intervalMs: OPENCODE_IDLE_POLL_INTERVAL_MS,
  requiredPolls: OPENCODE_IDLE_REQUIRED_POLLS,
  timeoutMs: OPENCODE_IDLE_CONFIRM_TIMEOUT_MS,
  maxPollErrors: OPENCODE_IDLE_MAX_POLL_ERRORS,
};

/** One upstream permission or question ask awaiting the user's decision. */
interface OpenCodePendingAsk {
  request: PermissionRequest;
  sessionId: string;
  upstreamSessionId: string;
  baseUrl: string;
  kind: "permission" | "question";
  version: OpenCodeRequestVersion;
  signal: AbortSignal;
  routing: CanonicalLiveEventRouting;
  replying: boolean;
}

interface OpenCodeTurnState {
  upstreamSessionId: string;
  poolKey: OpenCodePoolKey;
  abortController: AbortController;
  active: boolean;
  aborted: boolean;
  chain: Promise<void>;
  /** True while one idle confirmation is polling; prevents poll pileup. */
  idleConfirming: boolean;
  /** A newer idle arrived while confirming; the loop restarts its baseline. */
  idleRestart: boolean;
  /** In-flight idle confirmation; the stream-end fallback awaits it. */
  idleConfirmPromise: Promise<void> | null;
  /** Upstream message id to role, so user parts never become assistant deltas. */
  messageRoles: Map<string, string>;
  /** Text already forwarded per message, for exactly-once streaming. */
  forwardedText: Map<string, string>;
}

function nestedSessionId(holder: unknown): string | undefined {
  if (!holder || typeof holder !== "object" || Array.isArray(holder)) return undefined;
  const sessionID = (holder as Record<string, unknown>).sessionID;
  return typeof sessionID === "string" && sessionID.length > 0 && sessionID.length <= 512 ? sessionID : undefined;
}

/** Split a `provider/model` slug into the upstream model reference. */
export function toOpenCodeModelRef(model: string | undefined): { providerID: string; modelID: string } | { modelID: string } | undefined {
  const trimmed = model?.trim();
  if (!trimmed) return undefined;
  const slash = trimmed.indexOf("/");
  if (slash <= 0 || slash === trimmed.length - 1) return { modelID: trimmed };
  return { providerID: trimmed.slice(0, slash), modelID: trimmed.slice(slash + 1) };
}

function isMissingSessionError(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  return /\b404\b/.test(message);
}

function recordOf(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function trackedMessageRole(info: Record<string, unknown> | null): { id: string; role: "user" | "assistant" } | undefined {
  const id = info?.id;
  const role = info?.role;
  if (typeof id !== "string" || id.length === 0 || id.length > 512) return undefined;
  if (role !== "user" && role !== "assistant") return undefined;
  return { id, role };
}

/** Largest retained upstream message-role map per turn before pruning oldest. */
const MAX_TRACKED_MESSAGE_ROLES = 256;

function sessionIdOfNormalized(normalized: { properties: Record<string, unknown> }): string | undefined {
  return nestedSessionId(normalized.properties)
    ?? nestedSessionId(normalized.properties.info)
    ?? nestedSessionId(normalized.properties.part);
}

/** Canonical notices that can be replayed when the OpenCode SSE reconnects. */
function replayNoticeKey(event: AgentEvent): string | undefined {
  if (event.type === AgentEventType.ModelFallback) {
    return `model-fallback:${event.requestedModel}:${event.actualModel}`;
  }
  if (event.type === AgentEventType.System && event.subtype.startsWith("provider.notice.")) {
    return `notice:${event.subtype}:${event.message ?? ""}`;
  }
  return undefined;
}

function askVersion(type: string): OpenCodeRequestVersion {
  return type.endsWith(".v2.asked") ? "v2" : "legacy";
}

function isValidQuestionResponse(
  questions: PermissionQuestion[] | undefined,
  decision: PermissionDecision,
  answers: PermissionResponseAnswers | undefined,
): boolean {
  if (decision === "deny" || decision === "cancelled") return true;
  if (decision !== "allow" || !questions || !answers || answers.length !== questions.length) return false;
  return questions.every((question, index) => {
    const answer = answers[index];
    if (!Array.isArray(answer) || answer.length === 0 || answer.length > 10) return false;
    if (!question.multiple && answer.length !== 1) return false;
    const labels = new Set(question.options.map((option) => option.label));
    return answer.every((label) => (
      typeof label === "string"
      && label.length <= 100
      && label.trim().length > 0
      && (question.custom || labels.has(label))
    ));
  });
}

function waitForAbortableDelay(delayMs: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    const timer = setTimeout(done, delayMs);
    const onAbort = (): void => done();
    function done(): void {
      clearTimeout(timer);
      signal.removeEventListener("abort", onAbort);
      resolve();
    }
    if (signal.aborted) {
      done();
      return;
    }
    signal.addEventListener("abort", onAbort, { once: true });
  });
}

/** Extract the upstream session id an SSE envelope belongs to, if any. */
export function openCodeEnvelopeSessionId(envelope: unknown): string | undefined {
  const normalized = normalizeOpenCodeEnvelope(envelope);
  if (!normalized) return undefined;
  return sessionIdOfNormalized(normalized);
}

/** Resolve the tracked role of the message a part belongs to, if any. */
function partRoleOf(
  roles: ReadonlyMap<string, string>,
  normalized: { type: string; properties: Record<string, unknown> },
): string | undefined {
  if (normalized.type !== "message.part.updated" && normalized.type !== "message.part.delta") return undefined;
  // Deltas carry the message id at the top level; snapshots nest it in the part.
  const direct = typeof normalized.properties.messageID === "string" && normalized.properties.messageID.length <= 512
    ? normalized.properties.messageID
    : undefined;
  if (direct) return roles.get(direct);
  const part = recordOf(normalized.properties.part);
  const nested = typeof part?.messageID === "string" && part.messageID.length <= 512
    ? part.messageID
    : undefined;
  return nested ? roles.get(nested) : undefined;
}

/**
 * OpenCode provider over a pooled `opencode serve` child per working
 * directory. Two threads in one worktree share one serve process; a second
 * worktree gets its own. Turns stream over per-turn SSE into canonical
 * events; stop aborts the upstream session while the server stays warm.
 */
@injectable()
export class OpenCodeProvider extends NodeEvents.EventEmitter implements IAgentProvider, ISessionEvictable {
  readonly id: ProviderId = "opencode";
  readonly descriptor = Object.freeze({
    id: "opencode" as const,
    capabilities: OPENCODE_SUPPORTED_CAPABILITIES.map((name) => ({ name, support: "supported" as const })),
  });
  readonly supportsCompletion = false;
  readonly sessionForkOnResume = "unsupported" as const;
  readonly maxInputCharactersPerTurn = 16_000;
  readonly forker: SessionForker = new CleanForker(this);

  private readonly turns = new Map<string, OpenCodeTurnState>();
  private readonly canonicalRoutings = new Map<string, CanonicalLiveEventRouting>();
  private readonly canonicalEventPublisher: CanonicalLiveEventPublisher | undefined;
  private readonly pendingPermissions = new Map<string, OpenCodePendingAsk>();
  private readonly seenNotices = new Map<string, Set<string>>();
  private pool: OpenCodeServerPool;
  private http: OpenCodeHttpClient;
  private probeCli: (cliPath: string, platform: string) => Promise<{ binaryPath: string; version: string }>;
  private idleConfirm: OpenCodeIdleConfirm = { ...DEFAULT_IDLE_CONFIRM };

  constructor(
    @inject(SettingsService) private readonly settingsService: SettingsService,
    @inject(EnvService) private readonly envService: EnvService,
    @inject("ProviderHostPorts") private readonly host: ProviderHostPorts,
  ) {
    super();
    this.canonicalEventPublisher = this.host?.events
      ? new CanonicalLiveEventPublisher(this.id, this.host.events)
      : undefined;
    this.pool = OpenCodeServerPool.withDefaults({
      platform: this.host.runtime.platform,
      terminateTree: (pid) => this.host.processes.terminateTree(pid),
      env: () => ({ ...this.envService.getEnv() }),
    });
    this.http = defaultOpenCodeHttpClient;
    this.probeCli = probeOpenCodeCli;
  }

  /** Test seam: replace the pool, HTTP client, CLI probe, and idle timings without DI tokens. */
  configureTestSeams(seams: {
    pool?: OpenCodeServerPool;
    http?: OpenCodeHttpClient;
    probeCli?: (cliPath: string, platform: string) => Promise<{ binaryPath: string; version: string }>;
    idleConfirm?: Partial<OpenCodeIdleConfirm>;
  }): void {
    if (seams.pool) this.pool = seams.pool;
    if (seams.http) this.http = seams.http;
    if (seams.probeCli) this.probeCli = seams.probeCli;
    if (seams.idleConfirm) this.idleConfirm = { ...DEFAULT_IDLE_CONFIRM, ...seams.idleConfirm };
  }

  /** Run a handoff prompt without a pooled turn; the parent session is untouched. */
  async runSideChannelQuery(): Promise<string> {
    throw Object.assign(new Error("OpenCode side-channel query is not available in the minimal turn slice"), { code: "ETIMEDOUT" });
  }

  async listModels(): Promise<ProviderModelInfo[]> {
    const cliPath = this.cliPath();
    const entry = await this.pool.acquire({ binaryPath: cliPath, cwd: process.cwd(), hostname: OPENCODE_SERVE_HOSTNAME }).catch((error: unknown) => {
      logger.debug("OpenCode listModels pool acquire failed", { error: error instanceof Error ? error.message : String(error) });
      return null;
    });
    // Model discovery must not leak pooled servers; release the listing lease.
    if (entry) this.pool.release(entry.key);
    if (!entry) return [];
    try {
      return await this.http.listModels(entry.baseUrl);
    } catch (error) {
      logger.warn("OpenCode listModels failed", { error: error instanceof Error ? error.message : String(error) });
      return [];
    }
  }

  async sendTurn(req: TurnRequest<"opencode">): Promise<void> {
    const routing: CanonicalLiveEventRouting = {
      threadId: req.threadId,
      turnId: req.turnId,
      executionId: req.turnExecutionId,
      deliveryAttempt: req.deliveryAttempt ?? 1,
    };
    this.canonicalRoutings.set(routing.executionId, routing);
    const state = this.turnStateFor(req.sessionId);
    const scheduled = state.chain.then(() => this.runTurn(req, routing, state));
    state.chain = scheduled.then(() => {}, () => {});
    await scheduled;
  }

  async stopSession(sessionId: string): Promise<void> {
    const state = this.turns.get(sessionId);
    if (!state) return;
    state.aborted = true;
    this.drainPendingForSession(sessionId);
    state.abortController.abort();
    if (state.upstreamSessionId) {
      const entry = this.pool.entryFor(state.poolKey);
      if (entry) {
        await this.http.abortSession(entry.baseUrl, state.upstreamSessionId).catch((error: unknown) => {
          logger.debug("OpenCode abort failed", { sessionId, error: error instanceof Error ? error.message : String(error) });
        });
      }
    }
  }

  async discardSession(sessionId: string): Promise<void> {
    const state = this.turns.get(sessionId);
    if (!state) return;
    await this.stopSession(sessionId);
    // Force the next sendTurn onto a fresh upstream session instead of
    // re-adopting the discarded one.
    this.turns.delete(sessionId);
  }

  shutdown(): void {
    for (const [sessionId, state] of this.turns) {
      state.aborted = true;
      this.drainPendingForSession(sessionId);
      state.abortController.abort();
    }
    this.drainAllPending();
    this.turns.clear();
    void this.pool.shutdown().catch((err: unknown) => {
      logger.warn("OpenCode pool shutdown failed", { error: String(err) });
    });
  }

  /**
   * Relay one user decision to its pending upstream ask. The entry is marked
   * replying synchronously so a duplicate decision returns false without a
   * second upstream call; the entry leaves the map only after the reply
   * succeeds, so a failed POST stays answerable instead of stalling the turn.
   */
  resolvePermission(
    requestId: string,
    decision: PermissionDecision,
    answers?: PermissionResponseAnswers,
  ): boolean {
    const entry = this.pendingPermissions.get(requestId);
    if (!entry || entry.replying) return false;
    if (entry.kind === "question" && !isValidQuestionResponse(entry.request.questions, decision, answers)) return false;
    entry.replying = true;
    void this.relayDecision(entry, decision, answers);
    return true;
  }

  /** Return all pending permission and question cards for one thread. */
  listPendingPermissions(threadId: string): PermissionRequest[] {
    const out: PermissionRequest[] = [];
    for (const entry of this.pendingPermissions.values()) {
      if (entry.request.threadId === threadId) out.push(entry.request);
    }
    return out;
  }

  /**
   * Relay one user decision upstream, exactly once. Permission approvals use
   * `once`/`always` and denials use `reject`; question approvals relay the
   * exact selected labels and denials reject the request.
   */
  private async relayDecision(
    entry: OpenCodePendingAsk,
    decision: PermissionDecision,
    answers?: PermissionResponseAnswers,
  ): Promise<void> {
    try {
      if (!this.ownsPendingAsk(entry)) return;
      if (entry.kind === "permission") {
        await this.http.replyPermission(
          entry.baseUrl,
          entry.upstreamSessionId,
          entry.request.requestId,
          mapPermissionDecisionToReply(decision),
          entry.version,
          { signal: entry.signal },
        );
      } else if (decision === "allow") {
        if (!answers) {
          entry.replying = false;
          return;
        }
        await this.http.replyQuestion(
          entry.baseUrl,
          entry.upstreamSessionId,
          entry.request.requestId,
          answers,
          entry.version,
          { signal: entry.signal },
        );
      } else {
        await this.http.rejectQuestion(
          entry.baseUrl,
          entry.upstreamSessionId,
          entry.request.requestId,
          entry.version,
          { signal: entry.signal },
        );
      }
      this.resolvePendingAsk(entry, decision);
    } catch (error) {
      if (!this.ownsPendingAsk(entry)) return;
      if (error instanceof OpenCodeReplySessionNotFoundError) {
        this.invalidateReplySession(entry);
        return;
      }
      entry.replying = false;
      logger.error("OpenCode permission reply failed; the card stays answerable", {
        requestId: entry.request.requestId,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  /** Clear pending cards for one session without upstream calls (abort covers it). */
  private drainPendingForSession(sessionId: string): void {
    for (const entry of this.pendingPermissions.values()) {
      if (entry.sessionId !== sessionId) continue;
      this.resolvePendingAsk(entry, "cancelled");
    }
  }

  /** Clear every unresolved ask while the owning provider is shutting down. */
  private drainAllPending(): void {
    for (const entry of this.pendingPermissions.values()) this.resolvePendingAsk(entry, "cancelled");
  }

  /** True only while this turn still exclusively owns the upstream ask. */
  private ownsPendingAsk(entry: OpenCodePendingAsk): boolean {
    return this.pendingPermissions.get(entry.request.requestId) === entry && !entry.signal.aborted;
  }

  /** Remove one owned ask and publish its local outcome exactly once. */
  private resolvePendingAsk(entry: OpenCodePendingAsk, decision: PermissionDecision): boolean {
    if (this.pendingPermissions.get(entry.request.requestId) !== entry) return false;
    this.pendingPermissions.delete(entry.request.requestId);
    this.emit("permission_resolved", { requestId: entry.request.requestId, decision });
    return true;
  }

  /** Surface a typed missing reply-session through the canonical invalidation path. */
  private invalidateReplySession(entry: OpenCodePendingAsk): void {
    const state = this.turns.get(entry.sessionId);
    if (!state || state.abortController.signal !== entry.signal) return;
    const goneId = state.upstreamSessionId;
    state.upstreamSessionId = "";
    this.emitSessionInvalidatedNotice(
      (event) => this.publishTurnEvent(entry.routing, entry.sessionId, event),
      entry.routing.threadId,
      goneId,
    );
    state.aborted = true;
    this.drainPendingForSession(entry.sessionId);
    state.abortController.abort();
  }

  /**
   * Record one notice key per thread; true when first seen. Notices replayed
   * after a reconnect or retry share their key, so each renders once.
   */
  private markNoticeSeen(threadId: string, key: string): boolean {
    let seen = this.seenNotices.get(threadId);
    if (!seen) {
      seen = new Set();
      this.seenNotices.set(threadId, seen);
    }
    if (seen.has(key)) return false;
    seen.add(key);
    if (seen.size > MAX_SEEN_NOTICES_PER_THREAD) {
      const oldest = seen.values().next().value as string | undefined;
      if (oldest !== undefined) seen.delete(oldest);
    }
    return true;
  }

  /**
 * Emit the provider-neutral session-reset notice once per missing upstream session.
   * Keyed by the gone session id so a verify-404 and a later prompt-404 for
   * different sessions each stay visible, while exact replays collapse.
   */
  private emitSessionInvalidatedNotice(emit: (event: AgentEvent) => void, threadId: string, goneId: string): void {
    if (!this.markNoticeSeen(threadId, `${OPENCODE_SESSION_INVALIDATED_SUBTYPE}:${goneId}`)) return;
    emit({ type: AgentEventType.System, threadId, subtype: OPENCODE_SESSION_INVALIDATED_SUBTYPE } satisfies AgentEvent);
  }

  private cliPath(): string {
    return this.settingsService.get().provider.cli.opencode?.trim() || "opencode";
  }

  private threadIdFor(sessionId: string): string {
    return sessionId.startsWith("mcode-") ? sessionId.slice(6) : sessionId;
  }

  private turnStateFor(sessionId: string): OpenCodeTurnState {
    const existing = this.turns.get(sessionId);
    if (existing) return existing;
    const created: OpenCodeTurnState = {
      upstreamSessionId: "",
      poolKey: { binaryPath: "", cwd: "", hostname: OPENCODE_SERVE_HOSTNAME },
      abortController: new AbortController(),
      active: false,
      aborted: false,
      chain: Promise.resolve(),
      idleConfirming: false,
      idleRestart: false,
      idleConfirmPromise: null,
      messageRoles: new Map<string, string>(),
      forwardedText: new Map<string, string>(),
    };
    this.turns.set(sessionId, created);
    return created;
  }

  private publishTurnEvent(routing: CanonicalLiveEventRouting, sessionId: string, event: AgentEvent): void {
    const runtimeEvent = providerRuntimeEvent({ ...event, turnExecutionId: routing.executionId });
    if (!this.canonicalEventPublisher) {
      this.emit("event", runtimeEvent);
      return;
    }
    this.canonicalEventPublisher.publish(routing, runtimeEvent, this.sessionIdentities(sessionId));
  }

  private sessionIdentities(sessionId: string): ProviderIdentity[] {
    const state = this.turns.get(sessionId);
    if (!state?.upstreamSessionId) return [];
    return [{
      providerId: this.id,
      scope: "session",
      value: state.upstreamSessionId,
      provenance: "native",
    }];
  }

  private async waitForCanonicalExecution(executionId: string): Promise<void> {
    const routing = this.canonicalRoutings.get(executionId);
    if (!routing || !this.canonicalEventPublisher) return;
    try {
      await this.canonicalEventPublisher.waitForExecution(routing);
    } catch (error) {
      logger.error("OpenCode canonical event delivery failed", {
        executionId,
        error: error instanceof Error ? error.message : String(error),
      });
    } finally {
      this.canonicalRoutings.delete(executionId);
    }
  }

  private async runTurn(req: TurnRequest<"opencode">, routing: CanonicalLiveEventRouting, state: OpenCodeTurnState): Promise<void> {
    const threadId = this.threadIdFor(req.sessionId);
    const emit = (event: AgentEvent): void => this.publishTurnEvent(routing, req.sessionId, event);
    state.aborted = false;
    state.abortController = new AbortController();
    state.messageRoles.clear();
    state.forwardedText.clear();
    emit({ type: AgentEventType.TurnStarted, threadId } satisfies AgentEvent);
    const entry = await this.acquireTurnEntry(req, routing, state, emit);
    if (!entry) {
      this.drainPendingForSession(req.sessionId);
      return;
    }
    const settler = new OpenCodeTurnSettler(emit, threadId, req.turnExecutionId, state);
    state.abortController.signal.addEventListener("abort", settler.onAbort, { once: true });
    try {
      await this.streamTurn(req, state, entry, settler);
    } finally {
      this.drainPendingForSession(req.sessionId);
      state.abortController.signal.removeEventListener("abort", settler.onAbort);
      state.active = false;
      this.pool.release(state.poolKey);
      await this.waitForCanonicalExecution(routing.executionId);
    }
  }

  private async acquireTurnEntry(
    req: TurnRequest<"opencode">,
    routing: CanonicalLiveEventRouting,
    state: OpenCodeTurnState,
    emit: (event: AgentEvent) => void,
  ): Promise<{ baseUrl: string } | null> {
    const threadId = this.threadIdFor(req.sessionId);
    try {
      const probe = await this.probeCli(this.cliPath(), this.host.runtime.platform);
      state.poolKey = { binaryPath: probe.binaryPath, cwd: req.cwd, hostname: OPENCODE_SERVE_HOSTNAME };
      return await this.pool.acquire(state.poolKey);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      emit({ type: AgentEventType.Error, threadId, error: message } satisfies AgentEvent);
      emit({ type: AgentEventType.Ended, threadId, turnExecutionId: req.turnExecutionId, outcome: "errored" } satisfies AgentEvent);
      await this.waitForCanonicalExecution(routing.executionId);
      return null;
    }
  }

  private async streamTurn(
    req: TurnRequest<"opencode">,
    state: OpenCodeTurnState,
    entry: { baseUrl: string },
    settler: OpenCodeTurnSettler,
  ): Promise<void> {
    state.active = true;
    try {
      await this.promptUpstream(req, state, entry, settler, false);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      logger.error("OpenCodeProvider turn error", { sessionId: req.sessionId, error: message });
      settler.settle(state.aborted ? "cancelled" : "errored", state.aborted ? undefined : message);
    }
  }

  /**
   * Create (or re-adopt) the upstream session, subscribe, and send one async
   * prompt. Only a confirmed missing session (404) starts fresh, and only
   * once; any other failure propagates so a live thread never resets to
   * empty.
   */
  private async promptUpstream(
    req: TurnRequest<"opencode">,
    state: OpenCodeTurnState,
    entry: { baseUrl: string },
    settler: OpenCodeTurnSettler,
    retried: boolean,
  ): Promise<void> {
    const threadId = this.threadIdFor(req.sessionId);
    const emit = (event: AgentEvent): void => this.publishTurnEvent(
      { threadId: req.threadId, turnId: req.turnId, executionId: req.turnExecutionId, deliveryAttempt: req.deliveryAttempt ?? 1 },
      req.sessionId,
      event,
    );
    await this.ensureUpstreamSession(req, state, entry, emit, retried);
    const upstreamId = state.upstreamSessionId;
    const subscribe = this.http.subscribeEvents(entry.baseUrl, state.abortController.signal, (envelope) => {
      this.handleTurnEnvelope(envelope, req, state, entry.baseUrl, upstreamId, settler);
    }).catch((error: unknown) => {
      logger.debug("OpenCode event subscription ended", {
        sessionId: req.sessionId,
        error: error instanceof Error ? error.message : String(error),
      });
    });
    try {
      await this.http.promptAsync(entry.baseUrl, upstreamId, {
        model: toOpenCodeModelRef(req.model),
        parts: [{ type: "text", text: req.message }],
      });
      await subscribe;
      // The stream ended. An in-flight idle confirmation owns settling now;
      // otherwise settle only if nothing did: an abort cancels, while a dead
      // stream without terminal proof is an interruption, never a success.
      // (Settled turns no-op below.)
      if (state.idleConfirmPromise) await state.idleConfirmPromise.catch(() => {});
      if (!settler.isSettled()) {
        settler.settle(state.aborted ? "cancelled" : "errored", state.aborted ? undefined : "OpenCode event stream ended before the turn completed");
      }
    } catch (error) {
      if (!retried && !state.aborted && isMissingSessionError(error)) {
        logger.info("OpenCode upstream session missing; starting fresh", { sessionId: req.sessionId });
        this.emitSessionInvalidatedNotice(emit, threadId, upstreamId);
        state.upstreamSessionId = "";
        await this.promptUpstream(req, state, entry, settler, true);
        return;
      }
      throw error;
    }
  }

  /**
   * Resolve the upstream session for one turn. Warm in-memory state wins;
   * otherwise the durable resume cursor (`resumeFrom`) is re-adopted behind
   * the versioned parser and verified with one bounded history page. Only a
   * confirmed 404 starts fresh (with a visible notice); any other failure
   * propagates so a live thread never resets to empty.
   */
  private async ensureUpstreamSession(
    req: TurnRequest<"opencode">,
    state: OpenCodeTurnState,
    entry: { baseUrl: string },
    emit: (event: AgentEvent) => void,
    skipResume: boolean,
  ): Promise<void> {
    const threadId = this.threadIdFor(req.sessionId);
    if (state.upstreamSessionId) return;
    // A retried turn already proved the cursor missing; go straight to fresh
    // so the recreated notice fires exactly once.
    const resumed = skipResume ? undefined : parseOpenCodeResumeCursor(req.resumeFrom);
    if (resumed) {
      try {
        await this.http.listSessionMessages(entry.baseUrl, resumed, {
          limit: 1,
          signal: state.abortController.signal,
        });
        state.upstreamSessionId = resumed;
        emit({ type: AgentEventType.System, threadId, subtype: `sdk_session_id:${resumed}` } satisfies AgentEvent);
        return;
      } catch (error) {
        if (!isMissingSessionError(error)) throw error;
        logger.info("OpenCode upstream session missing; starting fresh", { sessionId: req.sessionId });
        this.emitSessionInvalidatedNotice(emit, threadId, resumed);
      }
    }
    const created = await this.http.createSession(entry.baseUrl, req.threadId);
    // Validate the upstream id before it becomes the durable resume cursor.
    state.upstreamSessionId = formatOpenCodeResumeCursor(created.id);
    emit({ type: AgentEventType.System, threadId, subtype: `sdk_session_id:${created.id}` } satisfies AgentEvent);
  }

  private handleTurnEnvelope(
    envelope: unknown,
    req: TurnRequest<"opencode">,
    state: OpenCodeTurnState,
    baseUrl: string,
    upstreamId: string,
    settler: OpenCodeTurnSettler,
  ): void {
    if (state.aborted) return;
    const threadId = this.threadIdFor(req.sessionId);
    const normalized = normalizeOpenCodeEnvelope(envelope);
    if (normalized) {
      this.trackMessageRole(state, normalized);
      const owner = sessionIdOfNormalized(normalized);
      if (owner && owner !== upstreamId) return;
    }
    const mapped = mapOpenCodeEnvelope(envelope, {
      threadId,
      turnExecutionId: req.turnExecutionId,
      requestedModel: req.model,
      partRole: normalized ? partRoleOf(state.messageRoles, normalized) : undefined,
      forwardedText: state.forwardedText,
    });
    this.dispatchMappedEnvelope(req, state, baseUrl, upstreamId, threadId, mapped, normalized, settler);
  }

  /** Route one mapped envelope to cards, canonical events, and settlement. */
  private dispatchMappedEnvelope(
    req: TurnRequest<"opencode">,
    state: OpenCodeTurnState,
    baseUrl: string,
    upstreamId: string,
    threadId: string,
    mapped: OpenCodeMappedOutput,
    normalized: { type: string; properties: Record<string, unknown> } | null,
    settler: OpenCodeTurnSettler,
  ): void {
    if (mapped.reason === "permission-request" || mapped.reason === "question-request") {
      this.maybeEmitAsk(req, baseUrl, upstreamId, normalized, mapped.reason);
    }
    this.forwardTurnEvents(mapped.events, req, threadId, settler);
    if (mapped.events.some((e) => e.type === AgentEventType.Error)) {
      settler.settle("errored");
    } else if (mapped.events.some((e) => e.type === AgentEventType.TurnComplete)) {
      void this.confirmIdleCompleted(req, state, baseUrl, upstreamId, settler);
    } else if (mapped.disposition === "mapped") {
      settler.noteActivity();
    }
  }

  /**
   * Settle a turn only after its idle persists. Upstream emits `session.idle`
   * between steps of a multi-step turn, so the first idle is never terminal
   * proof: poll live session status until idle persists across consecutive
   * polls with no new mapped activity, a pending ask appears (the user's
   * decision drives the turn from here), the session leaves idle, or the
   * bound lapses. A newer idle restarts the running loop instead of piling up
   * another one. Exactly one terminal outcome still wins via the settler.
   */
  private async confirmIdleCompleted(
    req: TurnRequest<"opencode">,
    state: OpenCodeTurnState,
    baseUrl: string,
    upstreamId: string,
    settler: OpenCodeTurnSettler,
  ): Promise<void> {
    if (state.idleConfirming) {
      state.idleRestart = true;
      return;
    }
    state.idleConfirming = true;
    const confirmation = this.pollIdleConfirmation(req, state, baseUrl, upstreamId, settler);
    state.idleConfirmPromise = confirmation;
    try {
      await confirmation;
    } finally {
      state.idleConfirming = false;
      if (state.idleConfirmPromise === confirmation) state.idleConfirmPromise = null;
    }
  }

  private async pollIdleConfirmation(
    req: TurnRequest<"opencode">,
    state: OpenCodeTurnState,
    baseUrl: string,
    upstreamId: string,
    settler: OpenCodeTurnSettler,
  ): Promise<void> {
    const confirm: IdleConfirmProgress = {
      startedActivity: settler.activityCount,
      idlePolls: 0,
      pollErrors: 0,
      deadline: Date.now() + this.idleConfirm.timeoutMs,
    };
    for (;;) {
      const gate = this.idleConfirmGate(req, state, settler, confirm);
      if (gate === "stop") return;
      if (gate === "restart") continue;
      await waitForAbortableDelay(this.idleConfirm.intervalMs, state.abortController.signal);
      const poll = await this.pollIdleStep(
        baseUrl,
        upstreamId,
        state.abortController.signal,
        Math.max(1, confirm.deadline - Date.now()),
      );
      const after = this.idleConfirmGate(req, state, settler, confirm);
      if (after === "restart") continue;
      if (after === "stop") return;
      const noted = this.noteIdlePoll(confirm, settler, poll);
      if (noted === "next") continue;
      if (noted === "stop") return;
      break;
    }
    settler.settle(state.aborted ? "cancelled" : "completed");
  }

  /**
   * Account one status poll: failed polls accumulate toward a visible error,
   * an active session abandons the loop, and enough consecutive quiet polls
   * (or the bound lapsing) settle the turn.
   */
  private noteIdlePoll(
    confirm: IdleConfirmProgress,
    settler: OpenCodeTurnSettler,
    poll: { kind: "error" } | { kind: "quiet" } | { kind: "active" },
  ): "settle" | "stop" | "next" {
    if (poll.kind === "error") {
      confirm.pollErrors += 1;
      if (confirm.pollErrors >= this.idleConfirm.maxPollErrors || Date.now() >= confirm.deadline) {
        settler.settle("errored", "OpenCode session status unavailable");
        return "settle";
      }
      return "next";
    }
    if (poll.kind === "active") return "stop";
    confirm.pollErrors = 0;
    confirm.idlePolls += 1;
    if (confirm.idlePolls >= this.idleConfirm.requiredPolls) return "settle";
    if (Date.now() >= confirm.deadline) return "settle";
    return "next";
  }

  /**
   * One idle-confirmation gate: restart re-baselines a newer idle, stop ends
   * the loop without settling (abort, settlement, new activity, pending ask),
   * and go advances it.
   */
  private idleConfirmGate(
    req: TurnRequest<"opencode">,
    state: OpenCodeTurnState,
    settler: OpenCodeTurnSettler,
    confirm: IdleConfirmProgress,
  ): "restart" | "stop" | "go" {
    if (state.aborted || settler.isSettled()) return "stop";
    if (state.idleRestart) {
      state.idleRestart = false;
      confirm.startedActivity = settler.activityCount;
      confirm.idlePolls = 0;
      confirm.pollErrors = 0;
      return "restart";
    }
    if (settler.activityCount !== confirm.startedActivity) return "stop";
    if (this.hasPendingAskForSession(req.sessionId)) return "stop";
    if (Date.now() >= confirm.deadline) {
      settler.settle("errored", "OpenCode session status confirmation timed out");
      return "stop";
    }
    return "go";
  }

  /** One live status read: quiet (idle or drained), active (busy work), or error. */
  private async pollIdleStep(
    baseUrl: string,
    upstreamId: string,
    signal: AbortSignal,
    timeoutMs: number,
  ): Promise<{ kind: "error" } | { kind: "quiet" } | { kind: "active" }> {
    try {
      const type = (await this.http.getSessionStatus(baseUrl, { signal, timeoutMs }))[upstreamId]?.type;
      // Drained sessions leave the status map: after an idle event, a missing
      // entry means the session stayed quiet, not that polling broke.
      if (type === undefined) return { kind: "quiet" };
      return type === "idle" ? { kind: "quiet" } : { kind: "active" };
    } catch {
      return { kind: "error" };
    }
  }

  /** True when a permission or question card still awaits the user for one session. */
  private hasPendingAskForSession(sessionId: string): boolean {
    for (const entry of this.pendingPermissions.values()) {
      if (entry.sessionId === sessionId) return true;
    }
    return false;
  }

  /**
   * Synthesize one inline card for an upstream ask and emit it through the
   * existing permission flow. A replayed envelope shares its upstream id, so
   * it never cards twice; an unusable ask becomes one bounded diagnostic
   * instead of stalling the turn silently.
   */
  private maybeEmitAsk(
    req: TurnRequest<"opencode">,
    baseUrl: string,
    upstreamId: string,
    normalized: { type: string; properties: Record<string, unknown> } | null,
    reason: "permission-request" | "question-request",
  ): void {
    if (!normalized) return;
    const threadId = this.threadIdFor(req.sessionId);
    const state = this.turns.get(req.sessionId);
    if (!state || state.abortController.signal.aborted) return;
    const routing: CanonicalLiveEventRouting = {
      threadId: req.threadId,
      turnId: req.turnId,
      executionId: req.turnExecutionId,
      deliveryAttempt: req.deliveryAttempt ?? 1,
    };
    if (reason === "permission-request") {
      const request = synthesizeOpenCodePermissionRequest({ threadId, properties: normalized.properties });
      if (!request) return this.emitAskDiagnostic(req, threadId);
      if (this.pendingPermissions.has(request.requestId)) return;
      this.pendingPermissions.set(request.requestId, {
        request, sessionId: req.sessionId, upstreamSessionId: upstreamId, baseUrl,
        kind: "permission", version: askVersion(normalized.type),
        signal: state.abortController.signal, routing, replying: false,
      });
      this.emit("permission_request", request);
      return;
    }
    const synthesized = synthesizeOpenCodeQuestionRequest({ threadId, properties: normalized.properties });
    if (!synthesized) return this.emitAskDiagnostic(req, threadId);
    if (this.pendingPermissions.has(synthesized.requestId)) return;
    this.pendingPermissions.set(synthesized.requestId, {
      request: synthesized, sessionId: req.sessionId, upstreamSessionId: upstreamId, baseUrl,
      kind: "question", version: askVersion(normalized.type),
      signal: state.abortController.signal, routing, replying: false,
    });
    this.emit("permission_request", synthesized);
  }

  private emitAskDiagnostic(
    req: TurnRequest<"opencode">,
    threadId: string,
  ): void {
    if (!this.markNoticeSeen(threadId, "notice:provider.notice.malformed-request")) return;
    const routing = {
      threadId: req.threadId,
      turnId: req.turnId,
      executionId: req.turnExecutionId,
      deliveryAttempt: req.deliveryAttempt ?? 1,
    };
    this.publishTurnEvent(routing, req.sessionId, {
      type: AgentEventType.System,
      threadId,
      subtype: "provider.notice.malformed-request",
      message: "A provider request could not be shown safely.",
    } satisfies AgentEvent);
  }

  /** Remember upstream message roles so user parts stay out of assistant text. */
  private trackMessageRole(
    state: OpenCodeTurnState,
    normalized: { type: string; properties: Record<string, unknown> },
  ): void {
    if (normalized.type !== "message.updated") return;
    const tracked = trackedMessageRole(recordOf(normalized.properties.info));
    if (tracked === undefined) return;
    state.messageRoles.set(tracked.id, tracked.role);
    if (state.messageRoles.size > MAX_TRACKED_MESSAGE_ROLES) {
      const oldest = state.messageRoles.keys().next();
      if (!oldest.done) state.messageRoles.delete(oldest.value);
    }
  }

  private forwardTurnEvents(
    events: AgentEvent[],
    req: TurnRequest<"opencode">,
    threadId: string,
    settler: OpenCodeTurnSettler,
  ): void {
    const routing = {
      threadId: req.threadId,
      turnId: req.turnId,
      executionId: req.turnExecutionId,
      deliveryAttempt: req.deliveryAttempt ?? 1,
    };
    for (const event of events) {
      if (event.type === AgentEventType.TurnComplete || event.type === AgentEventType.Error) continue;
      const noticeKey = replayNoticeKey(event);
      if (noticeKey && !this.markNoticeSeen(threadId, noticeKey)) continue;
      if (event.type === AgentEventType.TextDelta) settler.appendText(event.delta);
      this.publishTurnEvent(routing, req.sessionId, { ...event, threadId } as AgentEvent);
    }
  }
}

/** Owns one turn's terminal settlement so abort, completion, and error settle once. */
class OpenCodeTurnSettler {
  private settled = false;
  private assistantText = "";
  private activities = 0;

  readonly onAbort = (): void => {
    this.settle("cancelled");
  };

  constructor(
    private readonly emit: (event: AgentEvent) => void,
    private readonly threadId: string,
    private readonly turnExecutionId: string,
    private readonly state: OpenCodeTurnState,
  ) {}

  appendText(delta: string): void {
    this.assistantText += delta;
  }

  /** Record one mapped (non-terminal) envelope so idle confirmation sees it. */
  noteActivity(): void {
    this.activities += 1;
  }

  /** Mapped envelopes seen since the turn started (drives idle confirmation). */
  get activityCount(): number {
    return this.activities;
  }

  /** True once a terminal outcome has been emitted. */
  isSettled(): boolean {
    return this.settled;
  }

  settle(outcome: "completed" | "cancelled" | "errored", error?: string): void {
    if (this.settled) return;
    this.settled = true;
    if (error) this.emit({ type: AgentEventType.Error, threadId: this.threadId, error } satisfies AgentEvent);
    if (this.assistantText.trim().length > 0 && outcome !== "cancelled") {
      this.emit({ type: AgentEventType.Message, threadId: this.threadId, content: this.assistantText, tokens: null } satisfies AgentEvent);
    }
    if (outcome === "completed") {
      this.emit({
        type: AgentEventType.TurnComplete, threadId: this.threadId, reason: "end_turn",
        costUsd: null, tokensIn: 0, tokensOut: 0,
      } satisfies AgentEvent);
    }
    this.emit({ type: AgentEventType.Ended, threadId: this.threadId, turnExecutionId: this.turnExecutionId, outcome } satisfies AgentEvent);
    this.state.abortController.abort();
  }
}
