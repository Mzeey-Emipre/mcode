import * as NodeEvents from "node:events";
import { inject, injectable } from "tsyringe";
import { logger } from "@mcode/shared";
import type {
  AgentEvent,
  IAgentProvider,
  ISessionEvictable,
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
import { defaultOpenCodeHttpClient, type OpenCodeHttpClient } from "./opencode-http-client.js";
import { mapOpenCodeEnvelope, normalizeOpenCodeEnvelope } from "./opencode-event-mapper.js";
import { probeOpenCodeCli } from "./opencode-cli.js";

const OPENCODE_SUPPORTED_CAPABILITIES = ["build", "plan", "permissions", "session-eviction"] as const;

/** Loopback hostname every pooled serve binds to. Pool keys never vary it. */
const OPENCODE_SERVE_HOSTNAME = "127.0.0.1";

interface OpenCodeTurnState {
  upstreamSessionId: string;
  poolKey: OpenCodePoolKey;
  abortController: AbortController;
  active: boolean;
  aborted: boolean;
  chain: Promise<void>;
  /** Upstream message id to role, so user parts never become assistant deltas. */
  messageRoles: Map<string, string>;
}

function nestedSessionId(holder: unknown): string | undefined {
  if (!holder || typeof holder !== "object" || Array.isArray(holder)) return undefined;
  const sessionID = (holder as Record<string, unknown>).sessionID;
  return typeof sessionID === "string" && sessionID.length > 0 ? sessionID : undefined;
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

/** Largest retained upstream message-role map per turn before pruning oldest. */
const MAX_TRACKED_MESSAGE_ROLES = 256;

function sessionIdOfNormalized(normalized: { properties: Record<string, unknown> }): string | undefined {
  return nestedSessionId(normalized.properties)
    ?? nestedSessionId(normalized.properties.info)
    ?? nestedSessionId(normalized.properties.part);
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
  const direct = typeof normalized.properties.messageID === "string" ? normalized.properties.messageID : undefined;
  if (direct) return roles.get(direct);
  const part = recordOf(normalized.properties.part);
  const nested = typeof part?.messageID === "string" ? part.messageID : undefined;
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
  private pool: OpenCodeServerPool;
  private http: OpenCodeHttpClient;
  private probeCli: (cliPath: string, platform: string) => Promise<{ binaryPath: string; version: string }>;

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

  /** Test seam: replace the pool, HTTP client, and CLI probe without DI tokens. */
  configureTestSeams(seams: {
    pool?: OpenCodeServerPool;
    http?: OpenCodeHttpClient;
    probeCli?: (cliPath: string, platform: string) => Promise<{ binaryPath: string; version: string }>;
  }): void {
    if (seams.pool) this.pool = seams.pool;
    if (seams.http) this.http = seams.http;
    if (seams.probeCli) this.probeCli = seams.probeCli;
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
    for (const [, state] of this.turns) state.abortController.abort();
    this.turns.clear();
    void this.pool.shutdown().catch((err: unknown) => {
      logger.warn("OpenCode pool shutdown failed", { error: String(err) });
    });
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
      messageRoles: new Map<string, string>(),
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
    emit({ type: AgentEventType.TurnStarted, threadId } satisfies AgentEvent);
    const entry = await this.acquireTurnEntry(req, routing, state, emit);
    if (!entry) return;
    const settler = new OpenCodeTurnSettler(emit, threadId, req.turnExecutionId, state);
    state.abortController.signal.addEventListener("abort", settler.onAbort, { once: true });
    try {
      await this.streamTurn(req, state, entry, settler);
    } finally {
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
    if (!state.upstreamSessionId) {
      const created = await this.http.createSession(entry.baseUrl, req.threadId);
      state.upstreamSessionId = created.id;
      emit({ type: AgentEventType.System, threadId, subtype: `sdk_session_id:${created.id}` } satisfies AgentEvent);
    }
    const upstreamId = state.upstreamSessionId;
    const subscribe = this.http.subscribeEvents(entry.baseUrl, state.abortController.signal, (envelope) => {
      this.handleTurnEnvelope(envelope, req, state, upstreamId, settler);
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
      settler.settle(state.aborted ? "cancelled" : "completed");
    } catch (error) {
      if (!retried && !state.aborted && isMissingSessionError(error)) {
        logger.info("OpenCode upstream session missing; starting fresh", { sessionId: req.sessionId });
        state.upstreamSessionId = "";
        await this.promptUpstream(req, state, entry, settler, true);
        return;
      }
      throw error;
    }
  }

  private handleTurnEnvelope(
    envelope: unknown,
    req: TurnRequest<"opencode">,
    state: OpenCodeTurnState,
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
      partRole: normalized ? partRoleOf(state.messageRoles, normalized) : undefined,
    });
    this.forwardTurnEvents(mapped.events, req, threadId, settler);
    if (mapped.events.some((e) => e.type === AgentEventType.Error)) settler.settle("errored");
    else if (mapped.events.some((e) => e.type === AgentEventType.TurnComplete)) settler.settle("completed");
  }

  /** Remember upstream message roles so user parts stay out of assistant text. */
  private trackMessageRole(
    state: OpenCodeTurnState,
    normalized: { type: string; properties: Record<string, unknown> },
  ): void {
    if (normalized.type !== "message.updated") return;
    const info = recordOf(normalized.properties.info);
    const id = typeof info?.id === "string" ? info.id : undefined;
    const role = typeof info?.role === "string" ? info.role : undefined;
    if (!id || !role) return;
    state.messageRoles.set(id, role);
    if (state.messageRoles.size > MAX_TRACKED_MESSAGE_ROLES) {
      const oldest = state.messageRoles.keys().next().value as string | undefined;
      if (oldest !== undefined) state.messageRoles.delete(oldest);
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
      if (event.type === AgentEventType.TextDelta) settler.appendText(event.delta);
      this.publishTurnEvent(routing, req.sessionId, { ...event, threadId } as AgentEvent);
    }
  }
}

/** Owns one turn's terminal settlement so abort, completion, and error settle once. */
class OpenCodeTurnSettler {
  private settled = false;
  private assistantText = "";

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
